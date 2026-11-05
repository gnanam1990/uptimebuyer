// Recovery-plan lifecycle (STATE-MACHINES §4, INV-03, INV-10). A plan row is immutable except its state projection;
// every move is one legal edge of the domain transition table (also enforced by the database guard) with an
// append-only transition record. Invalidation never deletes: an open plan whose bound inputs changed moves to
// INVALIDATED (an EXECUTING plan additionally flags IN_FLIGHT_RECONCILIATION, so a possible external effect keeps
// reconciling under its pinned authority), its prepared approval requests and the unexecuted approvals bound to its
// plan hash are invalidated in the same transaction, and plan.invalidated.v1 is emitted on the incident's plan scope.
import { newId } from '@uptimebuyer/contracts';
import { transition } from '@uptimebuyer/domain';
import { appendOutboxEvent, lockKey, recordAudit, type TenantContext, type Tx } from '@uptimebuyer/data';
import { actorFields, newPlanningId, planningLock } from './internal.js';

export const STALE_INPUTS = Object.freeze([
  'EVIDENCE',
  'ASSET',
  'POLICY',
  'DEADLINE',
  'QUOTE',
  'DECISION',
  'RISK_ESTIMATE',
  'INVENTORY',
  'RECOMPUTE',
  'EXECUTION',
] as const);
export type StaleInput = (typeof STALE_INPUTS)[number];

const REASON_FOR: Record<StaleInput, string> = {
  EVIDENCE: 'EVIDENCE_REVISION_CHANGED',
  ASSET: 'ASSET_REVISION_SUPERSEDED',
  POLICY: 'POLICY_REVISION_CHANGED',
  DEADLINE: 'DEADLINE_CHANGED',
  QUOTE: 'QUOTE_CHANGED',
  DECISION: 'DECISION_SUPERSEDED',
  RISK_ESTIMATE: 'RISK_ESTIMATE_CHANGED',
  INVENTORY: 'INVENTORY_VALUE_CHANGED',
  RECOMPUTE: 'PLAN_STALE',
  EXECUTION: 'EXECUTION_CHANGED',
};

export async function transitionPlan(
  c: Tx,
  ctx: TenantContext,
  plan: { id: string; state: string; version: number },
  to: string,
  reasonCode: string,
  extra: { inFlight?: boolean } = {},
): Promise<{ state: string; version: number }> {
  transition('RECOVERY_PLAN', plan.state, to);
  const invalidated = to === 'INVALIDATED';
  const { rows } = await c.query<{ version: number }>(
    `UPDATE recovery_plans SET state = $3, version = version + 1,
            invalidated_at = CASE WHEN $4 THEN clock_timestamp() ELSE invalidated_at END,
            invalidated_reason = CASE WHEN $4 THEN $5 ELSE invalidated_reason END,
            in_flight_reconciliation = in_flight_reconciliation OR $6
      WHERE tenant_id = $1 AND id = $2 AND version = $7 RETURNING version`,
    [ctx.tenantId, plan.id, to, invalidated, reasonCode, extra.inFlight === true, plan.version],
  );
  if (!rows[0]) throw new Error('recovery plan version moved under the planning lock');
  const seq = await c.query<{ n: number }>(
    `SELECT coalesce(max(sequence), 0) + 1 AS n FROM recovery_plan_transitions WHERE tenant_id = $1 AND plan_id = $2`,
    [ctx.tenantId, plan.id],
  );
  const actor = actorFields(ctx);
  await c.query(
    `INSERT INTO recovery_plan_transitions (tenant_id, id, plan_id, sequence, from_state, to_state, reason_code, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ctx.tenantId,
      newPlanningId('planTransition'),
      plan.id,
      seq.rows[0]!.n,
      plan.state,
      to,
      reasonCode,
      actor.kind,
      actor.id,
    ],
  );
  return { state: to, version: rows[0].version };
}

export interface InvalidationResult {
  invalidatedPlanIds: string[];
  inFlightPlanIds: string[];
  invalidatedApprovalRequestIds: string[];
  invalidatedApprovalIds: string[];
}

/**
 * Invalidate the given open plans of one incident (caller holds the planning lock) and emit one plan.invalidated.v1.
 * `reason` is PLAN_INPUT_STALE (with the stale inputs) or PLAN_SUPERSEDED_BY_REVISION.
 */
export async function invalidatePlans(
  c: Tx,
  ctx: TenantContext,
  incidentId: string,
  plans: { id: string; state: string; version: number; plan_hash: string; stale: StaleInput[] }[],
  reason: 'PLAN_INPUT_STALE' | 'PLAN_SUPERSEDED_BY_REVISION',
): Promise<InvalidationResult> {
  const out: InvalidationResult = {
    invalidatedPlanIds: [],
    inFlightPlanIds: [],
    invalidatedApprovalRequestIds: [],
    invalidatedApprovalIds: [],
  };
  if (plans.length === 0) return out;
  const actor = actorFields(ctx);
  const staleAll = new Set<StaleInput>();
  for (const p of [...plans].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const code = reason === 'PLAN_SUPERSEDED_BY_REVISION' ? 'SUPERSEDED_BY_NEW_PLAN' : REASON_FOR[p.stale[0]!];
    p.stale.forEach((s) => staleAll.add(s));
    const inFlight = p.state === 'EXECUTING';
    await transitionPlan(c, ctx, p, 'INVALIDATED', code, { inFlight });
    out.invalidatedPlanIds.push(p.id);
    if (inFlight) out.inFlightPlanIds.push(p.id);
    const reqs = await c.query<{ id: string }>(
      `UPDATE plan_approval_requests SET invalidated_at = clock_timestamp(), invalidated_reason = $3
        WHERE tenant_id = $1 AND plan_id = $2 AND invalidated_at IS NULL RETURNING id`,
      [ctx.tenantId, p.id, code],
    );
    out.invalidatedApprovalRequestIds.push(...reqs.rows.map((r) => r.id));
    // Unexecuted approvals bound to this plan hash cannot float to a regenerated plan (STATE-MACHINES §4).
    const apr = await c.query<{ approval_id: string }>(
      `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
       SELECT a.tenant_id, 'ape_' || gen_random_uuid(), a.id, 'INVALIDATED', 'PLAN_INVALIDATED', $4, $5
         FROM approvals a
        WHERE a.tenant_id = $1 AND a.incident_id = $2 AND a.plan_hash = $3 AND a.approval_kind = 'PLAN_ACTION'
          AND a.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id)
       ON CONFLICT (tenant_id, approval_id) DO NOTHING
       RETURNING approval_id`,
      [ctx.tenantId, incidentId, p.plan_hash, actor.kind === 'HUMAN' ? 'HUMAN' : actor.kind, actor.id],
    );
    out.invalidatedApprovalIds.push(...apr.rows.map((r) => r.approval_id));
  }
  out.invalidatedApprovalRequestIds.sort();
  out.invalidatedApprovalIds.sort();
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
      reasonCode: reason,
      staleInputs: STALE_INPUTS.filter((s) => staleAll.has(s)),
      ...out,
    },
    correlationId: ctx.correlationId,
    causationId: newId('command'),
  });
  await recordAudit(c, ctx, {
    action: 'planning.invalidate',
    resourceType: 'incident',
    resourceId: incidentId,
    result: 'SUCCEEDED',
    reasonCode: reason,
    metadata: { plans: out.invalidatedPlanIds.length, approvals: out.invalidatedApprovalIds.length },
  });
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Which bound inputs of an open plan are no longer current (SQL probes inside the caller's transaction). */
export async function staleInputsOf(c: Tx, tenantId: string, plan: any): Promise<StaleInput[]> {
  const { rows } = await c.query(
    `SELECT
       (SELECT e.id FROM evidence_revisions e WHERE e.tenant_id = $1 AND e.incident_id = $2 ORDER BY e.revision DESC LIMIT 1)
         AS evidence_id,
       (SELECT a.current_revision_id FROM assets a WHERE a.tenant_id = $1 AND a.id = $3) AS asset_revision_id,
       (SELECT r.id FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
         WHERE r.tenant_id = $1 AND p.policy_key = 'AUTHORITY' AND r.effective_at <= clock_timestamp()
         ORDER BY r.effective_at DESC LIMIT 1) AS policy_id,
       i.current_response_deadline_at, i.deadline_status,
       (SELECT max(d.sequence) FROM incident_deadline_events d WHERE d.tenant_id = $1 AND d.incident_id = $2) AS deadline_seq,
       (SELECT t.id FROM tenant_risk_estimates t WHERE t.tenant_id = $1 AND (t.site_id = i.site_id OR t.site_id IS NULL)
          AND t.effective_at <= clock_timestamp() ORDER BY (t.site_id IS NULL), t.effective_at DESC, t.revision DESC LIMIT 1)
         AS risk_id,
       (SELECT g.id FROM registry_revisions g WHERE g.tenant_id = $1 AND g.entity_kind = 'FOOD_AT_RISK' AND g.entity_id = $3
         ORDER BY g.revision DESC LIMIT 1) AS inventory_id,
       EXISTS (SELECT 1 FROM plan_actions pa JOIN compatibility_decisions d ON d.tenant_id = pa.tenant_id
                 AND d.id = pa.compatibility_decision_id
                WHERE pa.tenant_id = $1 AND pa.plan_id = $4 AND d.lifecycle <> 'CURRENT') AS decision_stale,
       EXISTS (SELECT 1 FROM plan_actions pa JOIN provider_quotes q ON q.tenant_id = pa.tenant_id AND q.id = pa.quote_id
                 JOIN provider_contact_requests r ON r.tenant_id = q.tenant_id AND r.id = q.contact_request_id
                WHERE pa.tenant_id = $1 AND pa.plan_id = $4
                  AND (r.invalidated_at IS NOT NULL OR (q.valid_until IS NOT NULL AND q.valid_until <= clock_timestamp())
                       OR EXISTS (SELECT 1 FROM provider_quotes n WHERE n.tenant_id = q.tenant_id
                                   AND n.contact_request_id = q.contact_request_id AND n.revision > q.revision)))
         AS quote_stale
     FROM incidents i WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, plan.incident_id, plan.asset_id, plan.id],
  );
  const r = rows[0];
  if (!r) return ['RECOMPUTE'];
  const stale: StaleInput[] = [];
  if (r.evidence_id !== plan.evidence_revision_id) stale.push('EVIDENCE');
  if (r.asset_revision_id !== plan.asset_revision_id) stale.push('ASSET');
  if (r.policy_id !== plan.policy_revision_id) stale.push('POLICY');
  if (
    plan.deadline_at === null ||
    new Date(r.current_response_deadline_at).getTime() !== new Date(plan.deadline_at).getTime() ||
    r.deadline_status !== plan.deadline_status ||
    (r.deadline_seq ?? 1) !== plan.deadline_event_sequence
  )
    stale.push('DEADLINE');
  if (r.quote_stale) stale.push('QUOTE');
  if (r.decision_stale) stale.push('DECISION');
  if ((r.risk_id ?? null) !== plan.risk_estimate_id) stale.push('RISK_ESTIMATE');
  if ((r.inventory_id ?? null) !== plan.inventory_registry_revision_id) stale.push('INVENTORY');
  return stale;
}

/**
 * Re-check every open plan of `incidentId` and invalidate the stale ones. Idempotent; callers are the planning
 * consumer, the asset-revision job and risk-estimate publication (all already authorized), inside their transaction.
 */
export async function revalidateIncidentPlans(
  c: Tx,
  ctx: TenantContext,
  incidentId: string,
  _opts: { engine: boolean } = { engine: true },
): Promise<InvalidationResult> {
  await lockKey(c, planningLock(ctx.tenantId, incidentId));
  const { rows } = await c.query(
    `SELECT * FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2
        AND state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING')
      ORDER BY revision FOR UPDATE`,
    [ctx.tenantId, incidentId],
  );
  const stale: { id: string; state: string; version: number; plan_hash: string; stale: StaleInput[] }[] = [];
  for (const p of rows) {
    const s = await staleInputsOf(c, ctx.tenantId, p);
    if (s.length > 0) stale.push({ id: p.id, state: p.state, version: p.version, plan_hash: p.plan_hash, stale: s });
  }
  return invalidatePlans(c, ctx, incidentId, stale, 'PLAN_INPUT_STALE');
}

/**
 * M10: a material order/job change (partial fill, substitute, quantity/price/ETA/stock change, cancellation, provider
 * failure, reschedule/no-show, scope change, dispute) or an order revocation invalidates the bound plan: an EXECUTING
 * plan becomes INVALIDATED with IN_FLIGHT_RECONCILIATION (its possible external effect keeps reconciling), an APPROVED
 * plan becomes INVALIDATED before any egress; unexecuted approvals bound to its hash are invalidated with it, so no new
 * reserve can happen. Idempotent: a plan already out of the open states is left alone. Caller is authorized.
 */
export async function invalidatePlanForExecutionChange(
  c: Tx,
  ctx: TenantContext,
  incidentId: string,
  planId: string,
): Promise<InvalidationResult> {
  await lockKey(c, planningLock(ctx.tenantId, incidentId));
  const { rows } = await c.query(
    `SELECT * FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 AND id = $3
        AND state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING') FOR UPDATE`,
    [ctx.tenantId, incidentId, planId],
  );
  const p = rows[0];
  if (!p) return invalidatePlans(c, ctx, incidentId, [], 'PLAN_INPUT_STALE');
  return invalidatePlans(
    c,
    ctx,
    incidentId,
    [{ id: p.id, state: p.state, version: p.version, plan_hash: p.plan_hash, stale: ['EXECUTION'] }],
    'PLAN_INPUT_STALE',
  );
}

/**
 * M10: EXECUTING -> COMPLETED once every executed plan action reached a terminal reconciled outcome (the caller checks
 * that). Completion is fulfillment bookkeeping only: it never moves the incident to RECOVERED or releases value.
 */
export async function completeExecutingPlanInTx(
  c: Tx,
  ctx: TenantContext,
  incidentId: string,
  planId: string,
  reasonCode: string,
): Promise<boolean> {
  await lockKey(c, planningLock(ctx.tenantId, incidentId));
  const { rows } = await c.query(
    `SELECT id, state, version FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 AND id = $3 FOR UPDATE`,
    [ctx.tenantId, incidentId, planId],
  );
  const p = rows[0];
  if (!p || p.state !== 'EXECUTING') return false;
  await transitionPlan(c, ctx, p, 'COMPLETED', reasonCode);
  await recordAudit(c, ctx, {
    action: 'planning.complete',
    resourceType: 'recovery_plan',
    resourceId: planId,
    result: 'SUCCEEDED',
    reasonCode,
  });
  return true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
