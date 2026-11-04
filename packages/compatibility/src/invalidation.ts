// Invalidation of unexecuted decisions and approvals (FR-21, INV-03, INV-10, T-028, T-024 downstream). Nothing is
// edited: decisions move CURRENT -> SUPERSEDED in their lifecycle column, authority records and approvals receive a
// single append-only INVALIDATED event (an approval that already has an event, e.g. CONSUMED by M09, is untouched).
// A policy activation runs once per effective AUTHORITY revision and emits plan.invalidated.v1 per affected
// incident; the evidence consumer always reads the incident's latest evidence revision, so out-of-order delivery
// can never supersede a decision bound to the newest revision.
import { DomainEventEnvelopeSchema, decodeWire, newId, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import {
  Denial,
  actorOf,
  appendOutboxEvent,
  authorize,
  consumeOnce,
  lockKey,
  notPermitted,
  recordAudit,
  tenantCommand,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { EvidenceRevisionCommittedPayloadSchema, PlanInvalidatedPayloadSchema } from '@uptimebuyer/evidence';
import { effectiveAuthorityRevisionId, latestEvidenceRevision, newCompatibilityId } from './internal.js';

export const COMPATIBILITY_INVALIDATION_CONSUMER = 'compatibility-invalidation.v1';

const actorKind = (ctx: TenantContext) => (ctx.principal.kind === 'WORKER' ? 'WORKER' : ctx.principal.kind);

export async function invalidateAuthorityRecords(
  c: Tx,
  ctx: TenantContext,
  where: string,
  params: unknown[],
  reasonCode: string,
): Promise<string[]> {
  const actor = actorOf(ctx);
  const { rows } = await c.query<{ authority_record_id: string }>(
    `INSERT INTO compatibility_authority_events (tenant_id, id, authority_record_id, event_type, reason_code, actor_kind, actor_id)
     SELECT a.tenant_id, 'cae_' || gen_random_uuid(), a.id, 'INVALIDATED', $2, $3, $4
       FROM compatibility_authority_records a
      WHERE a.tenant_id = $1 AND ${where}
        AND NOT EXISTS (SELECT 1 FROM compatibility_authority_events e WHERE e.tenant_id = a.tenant_id AND e.authority_record_id = a.id)
     ON CONFLICT (tenant_id, authority_record_id) DO NOTHING
     RETURNING authority_record_id`,
    [ctx.tenantId, reasonCode, actorKind(ctx), actor.id.slice(0, 128), ...params],
  );
  return rows.map((r) => r.authority_record_id).sort();
}

async function invalidateApprovals(
  c: Tx,
  ctx: TenantContext,
  where: string,
  params: unknown[],
  reasonCode: string,
): Promise<{ id: string; incident_id: string; policy_revision_id: string }[]> {
  const actor = actorOf(ctx);
  const { rows } = await c.query<{ id: string; incident_id: string; policy_revision_id: string }>(
    `WITH ins AS (
       INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
       SELECT a.tenant_id, 'ape_' || gen_random_uuid(), a.id, 'INVALIDATED', $2, $3, $4
         FROM approvals a
        WHERE a.tenant_id = $1 AND ${where} AND a.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id)
       ON CONFLICT (tenant_id, approval_id) DO NOTHING
       RETURNING approval_id)
     SELECT a.id, a.incident_id, a.policy_revision_id FROM ins JOIN approvals a ON a.tenant_id = $1 AND a.id = ins.approval_id`,
    [ctx.tenantId, reasonCode, actorKind(ctx), actor.id.slice(0, 128), ...params],
  );
  return rows;
}

export interface ActivationResult {
  policyRevisionId: string | null;
  previousPolicyRevisionId: string | null;
  activated: boolean;
  supersededDecisionIds: string[];
  invalidatedAuthorityIds: string[];
  invalidatedApprovalIds: string[];
  incidentIds: string[];
}

/**
 * Apply the currently effective AUTHORITY policy revision once: supersede every CURRENT decision, and invalidate
 * every unexecuted authority record and approval, bound to another revision; emit plan.invalidated.v1 per incident.
 * Idempotent. Callers: the compatibility engine (scheduled sweep, so a future-dated revision is applied once it
 * is effective) and the publishing administrator.
 */
export async function activateEffectivePolicy(pool: Db, ctx: TenantContext): Promise<ActivationResult> {
  const meta = { action: 'compatibility.policy_activate', resourceType: 'policy_revision', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const engine = authorize(ctx, { action: 'compatibility.engine', siteId: null });
    const admin = authorize(ctx, { action: 'policy.publish', siteId: null });
    if (!engine.allowed && !admin.allowed)
      throw new Denial(notPermitted(engine.reasonCode), { ...meta, reasonCode: engine.reasonCode });
    await lockKey(c, `compatibility-policy:${ctx.tenantId}`);
    const eff = await effectiveAuthorityRevisionId(c, ctx.tenantId);
    const none: ActivationResult = {
      policyRevisionId: eff,
      previousPolicyRevisionId: null,
      activated: false,
      supersededDecisionIds: [],
      invalidatedAuthorityIds: [],
      invalidatedApprovalIds: [],
      incidentIds: [],
    };
    if (eff === null) return none;
    const done = await c.query(
      `SELECT 1 FROM compatibility_policy_activations WHERE tenant_id = $1 AND policy_revision_id = $2`,
      [ctx.tenantId, eff],
    );
    if (done.rowCount) return none;
    const prev = await c.query<{ policy_revision_id: string }>(
      `SELECT policy_revision_id FROM compatibility_policy_activations WHERE tenant_id = $1 ORDER BY activated_at DESC LIMIT 1`,
      [ctx.tenantId],
    );
    const decisions = await c.query<{ id: string; incident_id: string; policy_revision_id: string }>(
      `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED', superseded_at = clock_timestamp(),
              superseded_reason = 'POLICY_REVISION_CHANGED'
        WHERE tenant_id = $1 AND lifecycle = 'CURRENT' AND policy_revision_id <> $2
        RETURNING id, incident_id, policy_revision_id`,
      [ctx.tenantId, eff],
    );
    const authorityRows = await c.query<{ id: string; incident_id: string; policy_revision_id: string }>(
      `SELECT a.id, a.incident_id, a.policy_revision_id FROM compatibility_authority_records a
        WHERE a.tenant_id = $1 AND a.policy_revision_id <> $2
          AND NOT EXISTS (SELECT 1 FROM compatibility_authority_events e WHERE e.tenant_id = a.tenant_id AND e.authority_record_id = a.id)`,
      [ctx.tenantId, eff],
    );
    const authorities = await invalidateAuthorityRecords(
      c,
      ctx,
      'a.policy_revision_id <> $5',
      [eff],
      'POLICY_REVISION_CHANGED',
    );
    const approvals = await invalidateApprovals(c, ctx, 'a.policy_revision_id <> $5', [eff], 'POLICY_REVISION_CHANGED');

    const byIncident = new Map<string, { old: Set<string>; d: string[]; a: string[]; p: string[] }>();
    const slot = (incident: string) => {
      let s = byIncident.get(incident);
      if (!s) byIncident.set(incident, (s = { old: new Set(), d: [], a: [], p: [] }));
      return s;
    };
    for (const r of decisions.rows) {
      slot(r.incident_id).d.push(r.id);
      slot(r.incident_id).old.add(r.policy_revision_id);
    }
    for (const r of authorityRows.rows)
      if (authorities.includes(r.id)) {
        slot(r.incident_id).a.push(r.id);
        slot(r.incident_id).old.add(r.policy_revision_id);
      }
    for (const r of approvals) {
      slot(r.incident_id).p.push(r.id);
      slot(r.incident_id).old.add(r.policy_revision_id);
    }

    for (const [incidentId, s] of [...byIncident.entries()].sort()) {
      await lockKey(c, `evidence-revision:${ctx.tenantId}:${incidentId}`);
      const v = await c.query<{ next: number }>(
        `SELECT coalesce(max(aggregate_version), 0) + 1 AS next FROM outbox_events
          WHERE tenant_id = $1 AND aggregate_type = 'plan' AND aggregate_id = $2 AND event_type = 'plan.invalidated.v1'`,
        [ctx.tenantId, incidentId],
      );
      await appendOutboxEvent(c, ctx, {
        eventType: 'plan.invalidated.v1',
        aggregateType: 'plan',
        aggregateId: incidentId,
        aggregateVersion: v.rows[0]!.next,
        payload: {
          incidentId,
          reasonCode: 'POLICY_REVISION_CHANGED',
          supersededPolicyRevisionId: [...s.old].sort()[0]!,
          policyRevisionId: eff,
          supersededDecisionIds: s.d.sort(),
          invalidatedAuthorityIds: s.a.sort(),
          invalidatedApprovalIds: s.p.sort(),
        },
        correlationId: ctx.correlationId,
        causationId: newId('command'),
      });
    }
    const actor = actorOf(ctx);
    await c.query(
      `INSERT INTO compatibility_policy_activations (tenant_id, id, policy_revision_id, previous_policy_revision_id,
         superseded_decision_count, invalidated_authority_count, invalidated_approval_count, activated_by_kind, activated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        newCompatibilityId('policyActivation'),
        eff,
        prev.rows[0]?.policy_revision_id ?? null,
        decisions.rowCount ?? 0,
        authorities.length,
        approvals.length,
        actorKind(ctx),
        actor.id.slice(0, 128),
      ],
    );
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: eff,
      result: 'SUCCEEDED',
      metadata: { supersededDecisions: decisions.rowCount ?? 0, invalidatedApprovals: approvals.length },
    });
    return {
      policyRevisionId: eff,
      previousPolicyRevisionId: prev.rows[0]?.policy_revision_id ?? null,
      activated: true,
      supersededDecisionIds: decisions.rows.map((r) => r.id).sort(),
      invalidatedAuthorityIds: authorities,
      invalidatedApprovalIds: approvals.map((r) => r.id).sort(),
      incidentIds: [...byIncident.keys()].sort(),
    };
  });
}

/** Supersede everything of `incidentId` not bound to its latest evidence revision (inside the caller's tx). */
export async function invalidateForEvidence(c: Tx, ctx: TenantContext, incidentId: string, reasonCode: string) {
  const latest = await latestEvidenceRevision(c, ctx.tenantId, incidentId);
  if (!latest) return { supersededDecisionIds: [], invalidatedAuthorityIds: [], invalidatedApprovalIds: [] };
  const d = await c.query<{ id: string }>(
    `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED', superseded_at = clock_timestamp(), superseded_reason = $4
      WHERE tenant_id = $1 AND incident_id = $2 AND lifecycle = 'CURRENT' AND evidence_revision_id <> $3 RETURNING id`,
    [ctx.tenantId, incidentId, latest.id, reasonCode],
  );
  const a = await invalidateAuthorityRecords(
    c,
    ctx,
    'a.incident_id = $5 AND a.evidence_revision_id <> $6',
    [incidentId, latest.id],
    reasonCode,
  );
  const p = await invalidateApprovals(
    c,
    ctx,
    `a.incident_id = $5 AND a.approval_kind = 'PLAN_ACTION' AND a.evidence_revision_id <> $6`,
    [incidentId, latest.id],
    reasonCode,
  );
  return {
    supersededDecisionIds: d.rows.map((r) => r.id).sort(),
    invalidatedAuthorityIds: a,
    invalidatedApprovalIds: p.map((r) => r.id).sort(),
  };
}

/**
 * Consumer of M05's plan.invalidated.v1 and evidence.revision_committed.v1 (once per event id). Policy-reason
 * plan.invalidated.v1 events are M06's own and need no work. Other event types are ignored.
 */
export async function handleInvalidationEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED'> {
  const e = decodeWire(DomainEventEnvelopeSchema, envelope);
  if (e.eventType !== 'plan.invalidated.v1' && e.eventType !== 'evidence.revision_committed.v1') return 'IGNORED';
  return consumeOnce(pool, COMPATIBILITY_INVALIDATION_CONSUMER, e, async (c, ctx) => {
    if (e.eventType === 'plan.invalidated.v1') {
      const p = decodeWire(PlanInvalidatedPayloadSchema, e.payload);
      if (p.reasonCode === 'POLICY_REVISION_CHANGED') return;
      await invalidateForEvidence(c, ctx, p.incidentId, p.reasonCode);
      return;
    }
    const p = decodeWire(EvidenceRevisionCommittedPayloadSchema, e.payload);
    if (p.previousRevisionId === null) return;
    await invalidateForEvidence(c, ctx, p.incidentId, 'EVIDENCE_REVISION_CHANGED');
  });
}
