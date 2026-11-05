// Intervention milestones (FR-14, FR-15, INV-01, INV-03). A milestone is created only from policy-authorized onsite
// evidence: a verified CMMS work-order signoff from an active integration of the incident's site, or an attestation by
// a human holding a role the recovery policy names. It binds tenant, incident, immutable asset revision, recovery
// cycle, plan, plan action and action digest of an approved live action, the policy-designated type, the normalized
// occurred time (which becomes the observation boundary), observed and verified times and an HMAC signature.
// Provider self-report, receipts, model output and free text are refused by kind; forged (unsealed), disputed,
// cross-incident, wrong-asset, wrong-action, wrong-type, future-skewed, backdated-beyond-policy and pre-execution
// evidence is refused by rule; the database re-derives the same binding (UB204).
import { DomainError } from '@uptimebuyer/contracts';
import {
  appendOutboxEvent,
  dbNow,
  recordAudit,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { newId } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { attesterStillAuthorized, evidenceSealValid, loadEvidence } from './evidence.js';
import { activeIntegrations, approvedActions, disputedIds, executingSince } from './facts.js';
import {
  IdempotencyKey,
  actorFor,
  hold,
  isoOf,
  loadIncident,
  ms,
  newRecoveryId,
  parseInput,
  readReceipt,
  requestDigest,
  seal,
  writeReceipt,
  type RecoverySigning,
} from './internal.js';
import { effectivePolicy, num } from './policy.js';

const MilestoneSchema = z.strictObject({
  incidentId: z.string().max(128),
  evidenceId: z.string().max(128),
  idempotencyKey: IdempotencyKey,
});

export interface MilestoneResult extends Record<string, unknown> {
  interventionMilestoneId: string;
  incidentId: string;
  milestoneType: string;
  occurredAt: string;
  created: boolean;
}

const REFUSED_KIND: Record<string, string> = {
  PROVIDER_COMPLETION: 'PROVIDER_SELF_REPORT_INSUFFICIENT',
  RECEIPT: 'RECEIPT_INSUFFICIENT',
  MODEL_ASSERTION: 'MODEL_OUTPUT_NOT_AUTHORITY',
  OPERATOR_NOTE: 'UNATTESTED_OPERATOR_TEXT',
  TECHNICIAN_RECORD: 'NOT_A_MILESTONE_SOURCE',
  INSTALLED_PART: 'NOT_A_MILESTONE_SOURCE',
};

export const MILESTONE_SEAL_DOMAIN = 'intervention-milestone-signature.v1';

export async function recordInterventionMilestone(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof MilestoneSchema>,
  signing: RecoverySigning,
): Promise<MilestoneResult> {
  const input = parseInput(MilestoneSchema, raw);
  const meta = { action: 'recovery.milestone.record', resourceType: 'incident', resourceId: input.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const engine = ctx.principal.kind === 'SERVICE' || ctx.principal.kind === 'WORKER';
    const inc = await loadIncident(c, ctx, meta, input.incidentId, {
      action: engine ? 'recovery.engine' : 'recovery.evidence',
      lock: 'UPDATE',
    });
    const digest = requestDigest(ctx, 'recovery.milestone.v1', { incidentId: inc.id, evidenceId: input.evidenceId });
    const prior = await readReceipt<MilestoneResult>(c, ctx, input.idempotencyKey, digest);
    if (prior) return { ...prior, created: false };
    const ev = await loadEvidence(c, ctx.tenantId, input.evidenceId);
    if (!ev) throw unavailable({ ...meta, resourceType: 'recovery_evidence' }, input.evidenceId);
    if (ev.incident_id !== inc.id) throw hold('EVIDENCE_INCIDENT_MISMATCH');
    const existing = await c.query<{ id: string; milestone_type: string; occurred_at: Date }>(
      `SELECT id, milestone_type, occurred_at FROM intervention_milestones WHERE tenant_id = $1 AND source_evidence_id = $2`,
      [ctx.tenantId, ev.id],
    );
    if (existing.rows[0]) {
      const m = existing.rows[0];
      return writeReceipt(c, ctx, input.idempotencyKey, 'recovery.milestone.v1', digest, {
        interventionMilestoneId: m.id,
        incidentId: inc.id,
        milestoneType: m.milestone_type,
        occurredAt: isoOf(m.occurred_at),
        created: false,
      });
    }
    if (inc.state !== 'EXECUTING' && inc.state !== 'VERIFYING')
      throw new DomainError(
        'STATE_TRANSITION_INVALID',
        'Milestones are recorded only during execution or verification.',
        {
          reasonCode: 'INCIDENT_NOT_IN_EXECUTION',
          currentState: inc.state,
        },
      );
    const refused = REFUSED_KIND[ev.kind];
    if (refused) throw hold(refused, 'This evidence cannot establish an intervention milestone.');
    if ((await disputedIds(c, ctx.tenantId, [ev.id])).has(ev.id)) throw hold('EVIDENCE_DISPUTED');
    // The policy in force for the incident's scope when the evidence was observed (the database re-derives the same).
    const policy = await effectivePolicy(c, ctx.tenantId, inc.site_id, ev.observed_at);
    if (!policy) throw hold('RECOVERY_POLICY_MISSING');
    if (!policy.milestone_sources.includes(ev.source_kind as 'CMMS')) throw hold('MILESTONE_SOURCE_NOT_PERMITTED');
    if (!evidenceSealValid(signing, ev)) throw hold('EVIDENCE_SEAL_INVALID');
    if (ev.source_kind === 'CMMS') {
      const active = await activeIntegrations(c, ctx.tenantId);
      if (!ev.cmms_integration_id || active.get(ev.cmms_integration_id) !== inc.site_id)
        throw hold('CMMS_AUTHORITY_REVOKED');
    } else {
      if (!(await attesterStillAuthorized(c, ctx.tenantId, ev, inc.site_id, policy.attestation_roles)))
        throw hold('ATTESTER_ROLE_NOT_PERMITTED');
    }
    if (ev.milestone_type !== policy.completion_milestone_type) throw hold('WRONG_MILESTONE_TYPE');
    if (
      ev.claimed_asset_id !== null &&
      (ev.claimed_asset_id !== inc.asset_id || ev.claimed_asset_revision_id !== inc.asset_revision_id)
    )
      throw hold('WRONG_ASSET');
    const action = (await approvedActions(c, ctx.tenantId, inc.id)).find(
      (a) => a.plan_id === ev.plan_id && a.action_digest === ev.action_digest,
    );
    if (!action) throw hold('WRONG_ACTION');
    const occurred = ms(ev.occurred_at);
    const observed = ms(ev.observed_at);
    if (occurred > observed + num(policy.max_future_skew_ms)) throw hold('FUTURE_SKEWED');
    if (occurred < observed - num(policy.max_backdate_ms)) throw hold('BACKDATED_BEYOND_POLICY');
    const since = await executingSince(c, ctx.tenantId, inc.id);
    if (!since || occurred < since.getTime()) throw hold('WORK_BEFORE_EXECUTION');

    const id = newRecoveryId('milestone');
    const actor = actorFor(ctx);
    const fields = {
      tenantId: ctx.tenantId,
      interventionMilestoneId: id,
      incidentId: inc.id,
      assetId: inc.asset_id,
      assetRevisionId: inc.asset_revision_id,
      recoveryCycle: inc.reopen_count,
      planId: action.plan_id,
      planActionId: action.plan_action_id,
      actionDigest: action.action_digest,
      milestoneType: policy.completion_milestone_type,
      sourceEvidenceId: ev.id,
      sourceKind: ev.source_kind,
      recoveryPolicyRevisionId: policy.id,
      occurredAt: isoOf(occurred),
      observedAt: isoOf(observed),
    };
    const sig = seal(signing, MILESTONE_SEAL_DOMAIN, fields);
    const verifiedAt = await dbNow(c);
    await c.query(
      `INSERT INTO intervention_milestones (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
         plan_id, plan_action_id, action_digest, milestone_type, source_evidence_id, source_kind,
         recovery_policy_revision_id, occurred_at, observed_at, verified_at, signature, signature_key_id, milestone_digest,
         verified_by_kind, verified_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        ctx.tenantId,
        id,
        inc.id,
        inc.site_id,
        inc.asset_id,
        inc.asset_revision_id,
        inc.reopen_count,
        action.plan_id,
        action.plan_action_id,
        action.action_digest,
        policy.completion_milestone_type,
        ev.id,
        ev.source_kind,
        policy.id,
        fields.occurredAt,
        fields.observedAt,
        verifiedAt,
        sig.signature,
        sig.keyId,
        canonicalDigest('intervention-milestone', 1, fields),
        actor.kind === 'INTEGRATION' ? 'SERVICE' : actor.kind,
        actor.id,
      ],
    );
    await appendOutboxEvent(c, ctx, {
      eventType: 'intervention.milestone_recorded.v1',
      aggregateType: 'intervention_milestone',
      aggregateId: id,
      aggregateVersion: 1,
      payload: {
        interventionMilestoneId: id,
        incidentId: inc.id,
        actionDigest: action.action_digest,
        milestoneType: policy.completion_milestone_type,
        occurredAt: fields.occurredAt,
        sourceKind: ev.source_kind,
        sourceEvidenceId: ev.id,
        recoveryCycle: inc.reopen_count,
      },
      correlationId: inc.correlation_id,
      causationId: newId('command'),
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { interventionMilestoneId: id } });
    return writeReceipt(c, ctx, input.idempotencyKey, 'recovery.milestone.v1', digest, {
      interventionMilestoneId: id,
      incidentId: inc.id,
      milestoneType: policy.completion_milestone_type,
      occurredAt: fields.occurredAt,
      created: true,
    });
  });
}
