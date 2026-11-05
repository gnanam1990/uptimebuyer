// Incident and plan consequences of order/job facts (picked up from M09: incident AWAITING_APPROVAL -> EXECUTING and
// escalation after possible egress, plan EXECUTING -> COMPLETED). Everything goes through M04's public engine command
// (advanceIncident: legality, compare-and-set, idempotency receipts) and M08's planning lifecycle; the target is
// recomputed from current durable state, so replayed or reordered facts converge and a stale command is a no-op.
//   - linearized (an attempt exists) and the incident is AWAITING_APPROVAL      -> EXECUTING
//   - blocked by a material change or a post-egress revocation                  -> ESCALATED (re-enters planning only
//     through the accepted owner after revalidation, M04)
//   - every live order/job of the plan reports completion (delivered / work reported complete / verified)
//                                                                               -> VERIFYING (never RECOVERED: M11 owns
//     recovery; completion is not recovery proof, INV-14)
//   - every live order/job of the plan VERIFIED and its payment terminal-reconciled -> plan COMPLETED
// A pre-egress definite-no-effect failure changes nothing: the incident awaits a fresh approval (linked successor).
import { DomainError } from '@uptimebuyer/contracts';
import { advanceIncident } from '@uptimebuyer/incidents';
import {
  consumeOnce,
  requireAuthorized,
  sha256Digest,
  tenantCommand,
  type Db,
  type TenantContext,
} from '@uptimebuyer/data';
import { completeExecutingPlanInTx } from '@uptimebuyer/planning';
import type { DomainEventEnvelope } from '@uptimebuyer/contracts';
import { mirrorIntentInTx } from './apply.js';
import { KIND, kindOfId, lockOrder, readOrder } from './internal.js';
import { COMPLETION_REPORTED_STATES, type OrderKind } from './vocabulary.js';

export interface IncidentSyncResult {
  orderId: string;
  incidentState: string;
  moves: string[];
  planState: string;
}

const ACTIVE = ['DETECTED', 'TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING'];

async function snapshot(pool: Db, ctx: TenantContext, orderId: string) {
  const meta = { action: 'orders.engine', resourceType: 'order', resourceId: String(orderId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { kind, row } = await readOrder(c, ctx, meta, orderId);
    requireAuthorized(ctx, { action: 'orders.engine', siteId: null }, undefined, {
      type: KIND[kind].aggregateType,
      id: row.id,
    });
    const attempt = (
      await c.query(`SELECT 1 FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [
        ctx.tenantId,
        row.commercial_intent_id,
      ])
    ).rows[0];
    const inc = (
      await c.query(`SELECT state, version FROM incidents WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        row.incident_id,
      ])
    ).rows[0];
    const plan = (
      await c.query(`SELECT state FROM recovery_plans WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, row.plan_id])
    ).rows[0];
    const siblings: { kind: OrderKind; state: string; blocked: string | null; intentState: string }[] = [];
    for (const k of ['PURCHASE_ORDER', 'SERVICE_JOB'] as const) {
      const { rows } = await c.query(
        `SELECT o.state, o.blocked_reason, i.state AS intent_state FROM ${KIND[k].table} o
           JOIN commercial_intents i ON i.tenant_id = o.tenant_id AND i.id = o.commercial_intent_id
          WHERE o.tenant_id = $1 AND o.plan_id = $2 AND o.no_effect_proven_at IS NULL`,
        [ctx.tenantId, row.plan_id],
      );
      for (const r of rows)
        siblings.push({ kind: k, state: r.state, blocked: r.blocked_reason, intentState: r.intent_state });
    }
    return { kind, row, attempt: !!attempt, inc, planState: plan.state as string, siblings };
  });
}

function nextMove(s: Awaited<ReturnType<typeof snapshot>>): string | null {
  const st = s.inc.state as string;
  if (!s.attempt) return null; // nothing may have happened externally
  if (s.row.blocked_reason !== null) return ACTIVE.includes(st) ? 'ESCALATED' : null;
  if (st === 'AWAITING_APPROVAL') return 'EXECUTING';
  const allComplete =
    s.siblings.length > 0 &&
    s.siblings.every((o) => o.blocked === null && COMPLETION_REPORTED_STATES[o.kind].includes(o.state));
  if (st === 'EXECUTING' && allComplete) return 'VERIFYING';
  return null;
}

/** Recompute and apply the incident/plan consequence of one order/job (engine principals only). */
export async function syncIncidentForOrder(pool: Db, ctx: TenantContext, orderId: string): Promise<IncidentSyncResult> {
  const moves: string[] = [];
  let s = await snapshot(pool, ctx, orderId);
  for (let guard = 0; guard < 6; guard++) {
    const to = nextMove(s);
    if (!to) break;
    try {
      await advanceIncident(pool, ctx, s.row.incident_id, {
        expectedVersion: s.inc.version,
        idempotencyKey: `m10-${sha256Digest(`${orderId}|${to}|${s.inc.version}`).slice(7, 47)}`,
        to: to as never,
        reasonCode:
          to === 'ESCALATED'
            ? `ORDER_${s.row.blocked_reason}`.slice(0, 64)
            : to === 'EXECUTING'
              ? 'ORDER_LINEARIZED'
              : 'FULFILLMENT_REPORTED_COMPLETE',
        guardRef: s.row.id,
      });
      moves.push(to);
    } catch (e) {
      const code = e instanceof DomainError ? e.code : undefined;
      if (code !== 'VERSION_CONFLICT' && code !== 'IDEMPOTENCY_KEY_REUSED') {
        if (code === 'STATE_TRANSITION_INVALID') break;
        throw e;
      }
    }
    s = await snapshot(pool, ctx, orderId);
  }
  let planState = s.planState;
  const allVerified =
    s.siblings.length > 0 &&
    s.siblings.every(
      (o) =>
        o.state === 'VERIFIED' && o.blocked === null && ['CONFIRMED', 'REFUNDED', 'REVERSED'].includes(o.intentState),
    );
  if (planState === 'EXECUTING' && allVerified) {
    const meta = { action: 'orders.engine', resourceType: 'recovery_plan', resourceId: s.row.plan_id };
    const done = await tenantCommand(pool, ctx, meta, (c) =>
      completeExecutingPlanInTx(c, ctx, s.row.incident_id, s.row.plan_id, 'EVERY_ACTION_RECONCILED_AND_VERIFIED'),
    );
    if (done) planState = 'COMPLETED';
  }
  return { orderId, incidentState: s.inc.state, moves, planState };
}

export const ORDERS_INTENT_CONSUMER = 'orders-intent-mirror.v1';
export const ORDERS_FACT_CONSUMER = 'orders-incident-driver.v1';

/**
 * Outbox consumer of commercial_intent.state_changed.v1 (once per event id): mirror the intent onto its order/job,
 * then drive the incident. Replay-safe because the mirror reads current state.
 */
export async function handleCommercialIntentEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED'> {
  if (envelope.eventType !== 'commercial_intent.state_changed.v1') return 'IGNORED';
  let worker: TenantContext | null = null;
  let orderId: string | null = null;
  const r = await consumeOnce(pool, ORDERS_INTENT_CONSUMER, envelope, async (c, ctx) => {
    worker = ctx;
    for (const k of ['PURCHASE_ORDER', 'SERVICE_JOB'] as const) {
      const row = (
        await c.query(`SELECT id FROM ${KIND[k].table} WHERE tenant_id = $1 AND commercial_intent_id = $2`, [
          ctx.tenantId,
          envelope.aggregateId,
        ])
      ).rows[0];
      if (!row) continue;
      const locked = await lockOrder(c, ctx, { action: 'orders.engine', resourceType: 'order' }, row.id);
      await mirrorIntentInTx(c, ctx, locked.kind, locked.row);
      orderId = row.id;
    }
  });
  if (r === 'PROCESSED' && worker && orderId) await syncIncidentForOrder(pool, worker, orderId);
  return r;
}

/** Outbox consumer of purchase_order/service_job.state_changed.v1: drive the incident and plan (replay-safe). */
export async function handleOrderStateEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED'> {
  if (envelope.eventType !== 'purchase_order.state_changed.v1' && envelope.eventType !== 'service_job.state_changed.v1')
    return 'IGNORED';
  if (!kindOfId(envelope.aggregateId)) return 'IGNORED';
  let worker: TenantContext | null = null;
  const r = await consumeOnce(pool, ORDERS_FACT_CONSUMER, envelope, async (_c, ctx) => {
    worker = ctx;
  });
  if (r === 'PROCESSED' && worker) await syncIncidentForOrder(pool, worker, envelope.aggregateId);
  return r;
}
