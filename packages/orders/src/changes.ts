// Operator commands: revocation at the egress linearization point, and receiving inspection / work verification.
//
// Revocation (STATE-MACHINES §4/§5) serializes with the broker's linearization by taking the same locks in the same
// order (planning lock -> authority -> intent -> order). If it commits first, the execution authority is REVOKED, so
// the broker's linearization fails closed and the intent becomes definite-no-effect FAILED; the order is then
// CANCELLED with no-effect proof and the plan stays APPROVED, so a fresh authority may create the linked successor
// (INV-07). If the linearization committed first, the possibly in-flight effect is preserved: nothing is erased or
// re-sent, the authority is still revoked against any further reserve, the order is blocked with a cancellation
// request and a REVOCATION change proposal, the executing plan is invalidated with in-flight reconciliation and the
// effect keeps reconciling to its authoritative outcome. Provider-side cancellation is never attempted here (no
// adapter proves it safe).
//
// Verification (VERIFIED / DISPUTED) is the operator's receiving inspection of a delivered order or reported work.
// It is fulfillment evidence only: it never proves recovery, and a blocked (materially changed) order cannot be
// verified as the approved fulfillment.
import { DomainError, IdempotencyKeySchema } from '@uptimebuyer/contracts';
import { transitionAuthorityInTx } from '@uptimebuyer/commerce';
import {
  lockKey,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { applyObservationInTx, recordMaterialChange } from './apply.js';
import { KIND, hold, invalid, kindOfId, planningLock, transitionInvalid } from './internal.js';
import { loadOrderViewInTx, type OrderView } from './views.js';

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const RevokeSchema = z.strictObject({ orderId: z.string().max(128), reasonCode: Code });

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function revokeOrder(pool: Db, ctx: TenantContext, raw: z.input<typeof RevokeSchema>): Promise<OrderView> {
  const parsed = RevokeSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_REVOCATION');
  const input = parsed.data;
  const meta = { action: 'orders.manage', resourceType: 'order', resourceId: input.orderId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const kind = kindOfId(input.orderId);
    if (!kind) throw unavailable(meta, null);
    const k = KIND[kind];
    const peek = (
      await c.query(`SELECT * FROM ${k.table} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.orderId])
    ).rows[0];
    if (!peek) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'orders.manage', siteId: peek.site_id }, undefined, {
      type: k.aggregateType,
      id: peek.id,
    });
    // The broker's linearization lock order.
    await lockKey(c, planningLock(ctx.tenantId, peek.incident_id));
    const x = (
      await c.query(`SELECT * FROM execution_authorities WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        peek.execution_authority_id,
      ])
    ).rows[0];
    const i = (
      await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        peek.commercial_intent_id,
      ])
    ).rows[0];
    const o = (
      await c.query(`SELECT * FROM ${k.table} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        peek.id,
      ])
    ).rows[0];
    if (x.status === 'ACTIVE' || x.status === 'SUSPENDED')
      await transitionAuthorityInTx(c, ctx, x, 'REVOKED', input.reasonCode);
    if (o.cancel_requested_at === null) {
      const possibleEgress = i.state !== 'CREATED' && i.state !== 'FAILED';
      const up = (
        await c.query(
          `UPDATE ${k.table} SET cancel_requested_at = clock_timestamp(), version = version + 1,
                  blocked_reason = coalesce(blocked_reason, $3), updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [ctx.tenantId, o.id, possibleEgress ? 'REVOKED_AFTER_EGRESS' : 'REVOKED'],
        )
      ).rows[0];
      await recordMaterialChange(
        c,
        ctx,
        kind,
        up,
        'REVOCATION',
        null,
        { reasonCode: input.reasonCode, intentState: i.state },
        {
          invalidatePlan: possibleEgress,
        },
      );
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
    return (await loadOrderViewInTx(c, ctx.tenantId, kind, o.id))!;
  });
}

const VerifySchema = z.strictObject({
  orderId: z.string().max(128),
  outcome: z.enum(['VERIFIED', 'DISPUTED']),
  idempotencyKey: IdempotencyKeySchema,
  reasonCode: Code.optional(),
});

export async function recordFulfillmentVerification(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof VerifySchema>,
): Promise<OrderView> {
  const parsed = VerifySchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_VERIFICATION');
  const input = parsed.data;
  const meta = { action: 'orders.verify', resourceType: 'order', resourceId: input.orderId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const kind = kindOfId(input.orderId);
    if (!kind) throw unavailable(meta, null);
    const k = KIND[kind];
    const peek = (
      await c.query(`SELECT incident_id, site_id FROM ${k.table} WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        input.orderId,
      ])
    ).rows[0];
    if (!peek) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'orders.verify', siteId: peek.site_id }, undefined, {
      type: k.aggregateType,
      id: input.orderId,
    });
    await lockKey(c, planningLock(ctx.tenantId, peek.incident_id));
    const o: any = (
      await c.query(`SELECT * FROM ${k.table} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        input.orderId,
      ])
    ).rows[0];
    const key = `operator:${input.idempotencyKey}`;
    const prior = await c.query(
      `SELECT raw_status FROM fulfillment_observations WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_event_key = $3
          AND ${k.fk} = $4`,
      [ctx.tenantId, o.provider_account_id, key, o.id],
    );
    if (prior.rows[0] && prior.rows[0].raw_status !== input.outcome.toLowerCase())
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different verification.');
    if (prior.rowCount === 0) {
      if (o.blocked_reason && input.outcome === 'VERIFIED')
        throw hold('FULFILLMENT_BLOCKED', { blockedReason: o.blocked_reason });
      const r = await applyObservationInTx(c, ctx, kind, o, {
        source: 'OPERATOR',
        providerEventKey: key,
        rawStatus: input.outcome.toLowerCase(),
        observedAt: new Date().toISOString(),
        sequence: null,
        details: {},
        providerAccountRevisionId: o.provider_account_revision_id,
      });
      if (!r.transitioned && !r.duplicate) throw transitionInvalid('STATE_TRANSITION_INVALID', { state: o.state });
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode ?? input.outcome });
    return (await loadOrderViewInTx(c, ctx.tenantId, kind, o.id))!;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
