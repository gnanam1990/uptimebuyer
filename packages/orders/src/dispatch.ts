// Dispatch and reconciliation through the exclusive broker (INV-06, INV-07, INV-08). M10 never reaches paid egress:
// `dispatchOrder` hands a fresh signed COMMERCIAL_INTENT reference to the broker's `execute` only while the intent is
// still CREATED (the broker itself linearizes reserve + SEND_STARTED and never re-sends a started intent), and
// `reconcileOrder` uses the broker's `reconcile` (authoritative lookup by provider reference or the pre-egress client
// operation key, or provider-guaranteed same-key replay) with all of M09's rules: an UNSUPPORTED adapter leaves the
// effect UNKNOWN for manual review and nothing here ever retries autonomously or reads a "not sent" refusal as proof.
// Every path then mirrors the intent onto the order/job under the global lock order.
import { issueReference, type ReferenceSigner } from '@uptimebuyer/commerce';
import { requireAuthorized, tenantCommand, type Db, type TenantContext } from '@uptimebuyer/data';
import { mirrorIntentInTx } from './apply.js';
import { lockOrder, readOrder } from './internal.js';
import { loadOrderViewInTx, type OrderView } from './views.js';

/** The broker port subset M10 uses (KiteBrokerPort in production; the in-process broker in tests). */
export interface OrderBrokerPort {
  execute(reference: unknown): Promise<unknown>;
  reconcile(reference: unknown): Promise<unknown>;
}
export interface DispatchDeps {
  broker: OrderBrokerPort;
  referenceSigner: ReferenceSigner;
}

type Action = 'orders.request' | 'orders.engine';
const actionFor = (ctx: TenantContext): Action =>
  ctx.principal.kind === 'WORKER' || ctx.principal.kind === 'SERVICE' ? 'orders.engine' : 'orders.request';

async function prepare(pool: Db, ctx: TenantContext, orderId: string, action: string) {
  const meta = { action, resourceType: 'order', resourceId: String(orderId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { kind, row } = await readOrder(c, ctx, meta, orderId);
    if (action === 'orders.engine')
      requireAuthorized(ctx, { action: 'orders.engine', siteId: null }, undefined, { type: 'order', id: row.id });
    else
      requireAuthorized(ctx, { action: 'orders.request', siteId: row.site_id }, undefined, {
        type: 'order',
        id: row.id,
      });
    void kind;
    const i = (
      await c.query(`SELECT state FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        row.commercial_intent_id,
      ])
    ).rows[0];
    return { kind, intentId: row.commercial_intent_id as string, intentState: i.state as string };
  });
}

/** Mirror the current intent onto the order and return its view. */
export async function mirrorOrder(pool: Db, ctx: TenantContext, orderId: string): Promise<OrderView> {
  const meta = { action: 'orders.mirror', resourceType: 'order', resourceId: String(orderId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { kind, row } = await lockOrder(c, ctx, meta, orderId);
    await mirrorIntentInTx(c, ctx, kind, row);
    return (await loadOrderViewInTx(c, ctx.tenantId, kind, row.id))!;
  });
}

async function viaBroker(
  pool: Db,
  ctx: TenantContext,
  orderId: string,
  deps: DispatchDeps,
  op: 'execute' | 'reconcile',
): Promise<OrderView> {
  const p = await prepare(pool, ctx, orderId, actionFor(ctx));
  const shouldCall = op === 'execute' ? p.intentState === 'CREATED' : p.intentState === 'UNKNOWN';
  let failure: unknown = null;
  if (shouldCall) {
    const reference = issueReference(deps.referenceSigner, ctx.tenantId, {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: p.intentId,
    } as never);
    try {
      await deps.broker[op](reference);
    } catch (e) {
      failure = e;
    }
  }
  // Whatever the broker answered (or if it did not answer), the order reflects only the durable intent state.
  const view = await mirrorOrder(pool, ctx, orderId);
  if (failure && !isTransientHold(failure)) throw failure;
  return view;
}

const isTransientHold = (e: unknown) => (e as { code?: string })?.code === 'POLICY_HOLD';

/** Hand the order's CREATED intent to the broker once; otherwise only mirror. Never re-sends. */
export function dispatchOrder(pool: Db, ctx: TenantContext, orderId: string, deps: DispatchDeps): Promise<OrderView> {
  return viaBroker(pool, ctx, orderId, deps, 'execute');
}

/** Reconcile an UNKNOWN order through the broker's authoritative lookup / same-key replay; otherwise only mirror. */
export function reconcileOrder(pool: Db, ctx: TenantContext, orderId: string, deps: DispatchDeps): Promise<OrderView> {
  return viaBroker(pool, ctx, orderId, deps, 'reconcile');
}
