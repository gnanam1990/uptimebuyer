// THE sanctioned path to RECOVERED (INV-01, INV-14). This is the only production module that imports M04's
// non-exported recovery hook. It hands the hook a MODULE-PRIVATE evaluator that, inside the hook's own transaction
// (after M04 has locked the incident, honoured its Idempotency-Key and compare-and-set its version), re-derives the
// evaluation binding, re-runs every gate under lock at the database clock (or a later bounded instant), pins the exact
// samples and signoffs, moves the evaluation OBSERVING -> PASSED, writes the one closeout with its complete manifest
// and signed decision, the ledger entry, the events and the CMMS closeout update. M04 then commits the RECOVERED
// transition naming that evaluation in the same transaction, so a closeout and its transition exist together or not at
// all, and concurrent assessors serialize on the incident row. Nothing here is exported from the package index.
import { newId } from '@uptimebuyer/contracts';
import {
  appendOutboxEvent,
  appendSystemEvidence,
  dbNow,
  sha256Digest,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalDigest, canonicalize } from '@uptimebuyer/domain';
import { recoverIncidentWithEvaluation, type RecoveryEvaluator } from '../../incidents/src/recovery.js';
import { enqueueCmmsUpdate } from './cmms.js';
import { computeGates, desiredBinding, loadRule, pinnedChannels, type EvaluationRow } from './evaluation.js';
import {
  actorFor,
  isoOf,
  ms,
  newRecoveryId,
  seal,
  writeReceipt,
  type IncidentRow,
  type RecoverySigning,
} from './internal.js';
import { loadPolicy } from './policy.js';
import type { RecoveryAssessmentResult } from './assess.js';

export interface CloseoutArgs {
  incidentId: string;
  evaluationId: string;
  expectedVersion: number;
  hookIdempotencyKey: string;
  receipt: { key: string; digest: string };
  asOfMs: number | undefined;
}

export interface CloseoutFaults {
  /** Thrown from here simulates the assessor dying after writing the closeout and before the commit. */
  afterCloseout?(): void;
}

export const CLOSEOUT_SEAL_DOMAIN = 'recovery-closeout-decision.v1';

export async function closeoutWithEvaluation(
  pool: Db,
  ctx: TenantContext,
  args: CloseoutArgs,
  signing: RecoverySigning,
  faults?: CloseoutFaults,
): Promise<RecoveryAssessmentResult> {
  let result: RecoveryAssessmentResult | null = null;
  const evaluator: RecoveryEvaluator = {
    async loadPassedEvaluation(c, hookCtx, incident, recoveryEvaluationId) {
      result = await finalize(c, hookCtx, incident, recoveryEvaluationId, args, signing, faults);
      if (!result) return null;
      return {
        recoveryEvaluationId,
        incidentId: incident.incidentId,
        state: 'PASSED',
        evidenceDigest: result.manifestDigest!,
      };
    },
  };
  await recoverIncidentWithEvaluation(
    pool,
    ctx,
    args.incidentId,
    {
      recoveryEvaluationId: args.evaluationId,
      reasonCode: 'RECOVERY_PASSED',
      expectedVersion: args.expectedVersion,
      idempotencyKey: args.hookIdempotencyKey,
    },
    evaluator,
  );
  return result!;
}

async function finalize(
  c: Tx,
  ctx: TenantContext,
  incident: { incidentId: string; assetRevisionId: string; version: number },
  evaluationId: string,
  args: CloseoutArgs,
  signing: RecoverySigning,
  faults?: CloseoutFaults,
): Promise<RecoveryAssessmentResult | null> {
  const inc = (
    await c.query<IncidentRow>(`SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      incident.incidentId,
    ])
  ).rows[0]!;
  const { rows } = await c.query<EvaluationRow>(
    `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2 AND incident_id = $3 FOR UPDATE`,
    [ctx.tenantId, evaluationId, inc.id],
  );
  const ev = rows[0];
  if (!ev || ev.state !== 'OBSERVING' || ev.asset_revision_id !== incident.assetRevisionId) return null;
  const desired = await desiredBinding(c, inc, signing);
  if (typeof desired === 'string' || desired.bindingDigest !== ev.binding_digest) return null;
  const now = ms(await dbNow(c));
  const atMs = Math.max(now, args.asOfMs ?? now);
  if (atMs > ev.expires_at.getTime()) return null;
  const pins = await pinnedChannels(c, ctx.tenantId, ev.id);
  const policy = await loadPolicy(c, ctx.tenantId, ev.recovery_policy_revision_id);
  const rule = await loadRule(c, ctx.tenantId, ev.rule_revision_id);
  const gates = await computeGates(c, ctx, inc, ev, pins, policy, rule, atMs, signing);
  if (!gates.passed || !gates.window.passed) return null;
  const w = gates.window;

  for (const [i, sampleId] of w.sampleIds.entries())
    await c.query(
      `INSERT INTO recovery_evaluation_samples (tenant_id, evaluation_id, sample_id, ordinal) VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, ev.id, sampleId, i + 1],
    );
  for (const s of gates.signoffs)
    await c.query(
      `INSERT INTO recovery_evaluation_signoffs (tenant_id, evaluation_id, requirement, evidence_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [ctx.tenantId, ev.id, s.requirement, s.evidenceId],
    );
  const actor = actorFor(ctx);
  const decidedAt = await dbNow(c);
  await c.query(
    `UPDATE recovery_evaluations SET state = 'PASSED', decided_at = $3, version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, ev.id, decidedAt],
  );
  await c.query(
    `INSERT INTO recovery_evaluation_transitions (tenant_id, id, evaluation_id, sequence, from_state, to_state, reason_code,
       actor_kind, actor_id)
     SELECT $1, $2, $3, coalesce(max(sequence), 0) + 1, 'OBSERVING', 'PASSED', 'RECOVERY_GATES_PASSED', $4, $5
       FROM recovery_evaluation_transitions WHERE tenant_id = $1 AND evaluation_id = $3`,
    [ctx.tenantId, newRecoveryId('evaluationTransition'), ev.id, actor.kind, actor.id],
  );
  const milestone = (
    await c.query(`SELECT * FROM intervention_milestones WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      ev.milestone_id,
    ])
  ).rows[0];
  const own = gates.actions.filter((a) => a.plan_id === ev.plan_id);
  const signoffEvidenceIds = [...new Set(gates.signoffs.map((s) => s.evidenceId))].sort();
  const manifest = {
    schema: 'recovery-closeout-manifest.v1',
    tenantId: ctx.tenantId,
    incidentId: inc.id,
    siteId: inc.site_id,
    assetId: inc.asset_id,
    assetRevisionId: ev.asset_revision_id,
    recoveryCycle: ev.recovery_cycle,
    planId: ev.plan_id,
    planHash: own[0]?.plan_hash ?? null,
    planActionId: ev.plan_action_id,
    actionDigest: ev.action_digest,
    evidenceRevisionId: ev.evidence_revision_id,
    recoveryPolicyRevisionId: ev.recovery_policy_revision_id,
    ruleRevisionId: ev.rule_revision_id,
    recoveryEvaluationId: ev.id,
    bindingDigest: ev.binding_digest,
    milestone: {
      interventionMilestoneId: milestone.id,
      milestoneType: milestone.milestone_type,
      occurredAt: isoOf(milestone.occurred_at),
      sourceEvidenceId: milestone.source_evidence_id,
      sourceKind: milestone.source_kind,
      signature: milestone.signature,
    },
    observationBoundaryAt: isoOf(ev.observation_boundary_at),
    channels: pins.map((p) => ({
      deviceId: p.device_id,
      deviceAssignmentId: p.device_assignment_id,
      channelId: p.channel_id,
      channelRevisionId: p.channel_revision_id,
      calibrationRevision: Number(p.calibration_revision),
      assetRevisionId: p.asset_revision_id,
    })),
    sampleIds: [...w.sampleIds],
    window: {
      firstSampleAt: isoOf(w.firstAtMs),
      lastSampleAt: isoOf(w.lastAtMs),
      sampleCount: w.sampleCount,
      stableMs: w.stableMs,
    },
    signoffEvidenceIds,
    signoffs: gates.signoffs.map((s) => {
      const e = gates.signoffEvidence.find((x) => x.id === s.evidenceId)!;
      return {
        requirement: s.requirement,
        evidenceId: s.evidenceId,
        kind: e.kind,
        trust: e.trust,
        sourceKind: e.source_kind,
        cmmsIntegrationId: e.cmms_integration_id,
        externalRecordId: e.external_record_id,
        occurredAt: isoOf(e.occurred_at),
      };
    }),
    installedPart: gates.installedPart,
    orders: own.map((a) => ({
      orderKind: a.order_kind,
      orderId: a.order_id,
      state: a.order_state,
      commercialIntentId: a.commercial_intent_id,
      economicState: a.economic_state,
      approvedAmountMinor: a.approved_amount_minor,
      currency: a.currency,
    })),
    evaluatedAt: isoOf(atMs),
    decidedAt,
  };
  const manifestDigest = canonicalDigest('recovery-closeout', 1, manifest);
  const closeoutId = newRecoveryId('closeout');
  const decision = seal(signing, CLOSEOUT_SEAL_DOMAIN, {
    tenantId: ctx.tenantId,
    closeoutId,
    incidentId: inc.id,
    recoveryEvaluationId: ev.id,
    recoveryCycle: ev.recovery_cycle,
    actionDigest: ev.action_digest,
    manifestDigest,
    decision: 'RECOVERED',
  });
  await c.query(
    `INSERT INTO recovery_assessments (tenant_id, id, evaluation_id, incident_id, sequence, outcome, reason_codes,
       evaluated_at, as_of, window_first_at, window_last_at, sample_count, stable_ms, assessment_digest, actor_kind, actor_id)
     SELECT $1, $2, $3, $4, coalesce(max(sequence), 0) + 1, 'PASSED', '{}', $5, $6, $7, $8, $9, $10, $11, $12, $13
       FROM recovery_assessments WHERE tenant_id = $1 AND evaluation_id = $3`,
    [
      ctx.tenantId,
      newRecoveryId('assessment'),
      ev.id,
      inc.id,
      decidedAt,
      isoOf(atMs),
      isoOf(w.firstAtMs),
      isoOf(w.lastAtMs),
      w.sampleCount,
      w.stableMs,
      canonicalDigest('recovery-assessment', 1, { evaluationId: ev.id, outcome: 'PASSED', manifestDigest }),
      actor.kind,
      actor.id,
    ],
  );
  await c.query(
    `INSERT INTO recovery_closeouts (tenant_id, id, incident_id, site_id, evaluation_id, recovery_cycle, plan_id,
       action_digest, milestone_id, manifest, manifest_digest, decision_signature, signature_key_id, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ctx.tenantId,
      closeoutId,
      inc.id,
      inc.site_id,
      ev.id,
      ev.recovery_cycle,
      ev.plan_id,
      ev.action_digest,
      ev.milestone_id,
      JSON.stringify(manifest),
      manifestDigest,
      decision.signature,
      decision.keyId,
      decidedAt,
    ],
  );
  await appendSystemEvidence(c, ctx, {
    kind: 'RECOVERY_DECISION',
    trust: 'AUTHORITATIVE',
    subject: { aggregateType: 'recovery_evaluation', aggregateId: ev.id },
    incidentId: inc.id,
    payloadSchema: 'recovery.closeout.v1',
    payloadDigest: sha256Digest(canonicalize(manifest)),
    payloadRef: null,
    supersedesEvidenceId: null,
  });
  await appendOutboxEvent(c, ctx, {
    eventType: 'recovery.assessed.v1',
    aggregateType: 'recovery_evaluation',
    aggregateId: ev.id,
    aggregateVersion: ev.version + 1,
    payload: { recoveryEvaluationId: ev.id, incidentId: inc.id, from: 'OBSERVING', to: 'PASSED', reasonCode: null },
    correlationId: inc.correlation_id,
    causationId: newId('command'),
  });
  await appendOutboxEvent(c, ctx, {
    eventType: 'incident.recovered.v1',
    aggregateType: 'incident',
    aggregateId: inc.id,
    aggregateVersion: incident.version + 1,
    payload: {
      incidentId: inc.id,
      recoveryEvaluationId: ev.id,
      closeoutId,
      recoveryCycle: ev.recovery_cycle,
      actionDigest: ev.action_digest,
      manifestDigest,
    },
    correlationId: inc.correlation_id,
    causationId: newId('command'),
  });
  await enqueueCmmsUpdate(c, ctx.tenantId, {
    incidentId: inc.id,
    siteId: inc.site_id,
    updateKind: 'CLOSEOUT',
    sourceType: 'recovery_closeout',
    sourceId: closeoutId,
    sourceVersion: 1,
    payload: {
      status: 'RECOVERED',
      decision: {
        outcome: 'PASSED',
        closeoutId,
        recoveryEvaluationId: ev.id,
        decidedAt,
        manifestDigest,
        signature: decision.signature,
      },
      evidence: {
        milestoneId: milestone.id,
        observationBoundaryAt: manifest.observationBoundaryAt,
        sampleCount: w.sampleCount,
        window: manifest.window,
        signoffEvidenceIds,
      },
      approvedPlan: {
        planId: ev.plan_id,
        planHash: manifest.planHash,
        planActionId: ev.plan_action_id,
        actionDigest: ev.action_digest,
      },
      costs: own.map((a) => ({
        orderId: a.order_id,
        approvedAmountMinor: a.approved_amount_minor,
        currency: a.currency,
      })),
      receipts: own.map((a) => ({
        orderId: a.order_id,
        commercialIntentId: a.commercial_intent_id,
        economicState: a.economic_state,
      })),
      installedPart: gates.installedPart,
    },
  });
  const res: RecoveryAssessmentResult = {
    incidentId: inc.id,
    recoveryEvaluationId: ev.id,
    outcome: 'PASSED',
    reasonCodes: [],
    closeoutId,
    manifestDigest,
    incidentState: 'RECOVERED',
    incidentVersion: incident.version + 1,
    window: manifest.window,
  };
  await writeReceipt(c, ctx, args.receipt.key, 'recovery.assess.v1', args.receipt.digest, res as never);
  faults?.afterCloseout?.();
  return res;
}
