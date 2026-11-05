// Shared persistence helpers for M10: per-kind table metadata, identifiers, typed errors, actor fields and the single
// lock order every order/job write follows (planning lock -> [authority -> intent] -> order row), which is the M09
// broker's own linearization order, so order commands, observations and the broker can never deadlock.
import { randomUUID } from 'node:crypto';
import { DomainError, PurchaseOrderIdSchema, ServiceJobIdSchema } from '@uptimebuyer/contracts';
import { actorOf, lockKey, unavailable, type CommandMeta, type TenantContext, type Tx } from '@uptimebuyer/data';
import type { OrderKind } from './vocabulary.js';

export const KIND = Object.freeze({
  PURCHASE_ORDER: Object.freeze({
    table: 'purchase_orders',
    transitions: 'purchase_order_transitions',
    fk: 'purchase_order_id',
    transitionPrefix: 'pot',
    semanticOperation: 'PURCHASE',
    eventType: 'purchase_order.state_changed.v1',
    aggregateType: 'purchase_order',
    payloadKey: 'purchaseOrderId',
  }),
  SERVICE_JOB: Object.freeze({
    table: 'service_jobs',
    transitions: 'service_job_transitions',
    fk: 'service_job_id',
    transitionPrefix: 'sjt',
    semanticOperation: 'SERVICE_BOOKING',
    eventType: 'service_job.state_changed.v1',
    aggregateType: 'service_job',
    payloadKey: 'serviceJobId',
  }),
} as const);

export const ORDERS_ID_PREFIXES = Object.freeze({
  observation: 'fob',
  changeProposal: 'fcp',
  purchaseOrderTransition: 'pot',
  serviceJobTransition: 'sjt',
} as const);
export const newOrdersId = (kind: keyof typeof ORDERS_ID_PREFIXES) => `${ORDERS_ID_PREFIXES[kind]}_${randomUUID()}`;

/** The order kind named by an id's prefix, or null for anything that is not a well-formed order/job id. */
export function kindOfId(id: unknown): OrderKind | null {
  if (PurchaseOrderIdSchema.safeParse(id).success) return 'PURCHASE_ORDER';
  if (ServiceJobIdSchema.safeParse(id).success) return 'SERVICE_JOB';
  return null;
}

export const hold = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('POLICY_HOLD', 'This order or job cannot proceed in its current state.', { reasonCode, ...details });
export const invalid = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });
export const transitionInvalid = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('STATE_TRANSITION_INVALID', 'The order or job cannot make this transition.', {
    reasonCode,
    ...details,
  });

export function actorFields(ctx: TenantContext): { kind: 'HUMAN' | 'SERVICE' | 'WORKER'; id: string } {
  const a = actorOf(ctx);
  const kind = ctx.principal.kind === 'WORKER' ? 'WORKER' : ctx.principal.kind === 'HUMAN' ? 'HUMAN' : 'SERVICE';
  return { kind, id: String(a.id).slice(0, 128) };
}

/** Shared with M08 planning and the M09 broker linearization. */
export const planningLock = (tenantId: string, incidentId: string) => `planning:${tenantId}:${incidentId}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lock one order/job for a write in the global lock order. Absent, foreign and malformed ids are the same audited
 * RESOURCE_UNAVAILABLE denial (no IDOR oracle).
 */
export async function lockOrder(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  orderId: unknown,
): Promise<{ kind: OrderKind; row: any }> {
  const kind = kindOfId(orderId);
  if (!kind) throw unavailable(meta, null);
  const t = KIND[kind].table;
  const peek = (await c.query(`SELECT incident_id FROM ${t} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, orderId]))
    .rows[0];
  if (!peek) throw unavailable(meta);
  await lockKey(c, planningLock(ctx.tenantId, peek.incident_id));
  const row = (
    await c.query(`SELECT * FROM ${t} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [ctx.tenantId, orderId])
  ).rows[0];
  return { kind, row };
}

/** Read one order/job without locking (absent/foreign/malformed -> RESOURCE_UNAVAILABLE). */
export async function readOrder(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  orderId: unknown,
): Promise<{ kind: OrderKind; row: any }> {
  const kind = kindOfId(orderId);
  if (!kind) throw unavailable(meta, null);
  const row = (
    await c.query(`SELECT * FROM ${KIND[kind].table} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, orderId])
  ).rows[0];
  if (!row) throw unavailable(meta);
  return { kind, row };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
