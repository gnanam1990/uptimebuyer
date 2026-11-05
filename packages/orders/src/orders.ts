// Purchase-order and service-job creation and reads (FR-13, INV-07, NFR-03). `requestOrder` creates (or returns) the
// ONE M09 commercial intent for an issued execution authority through M09's own idempotent creation (stable action
// digest + immutable authority identity; successor only behind FAILED predecessors, enforced by M09's partial unique
// index) and, in the same transaction, the ONE order/job bound to it, whose kind comes from the authority's semantic
// operation (PURCHASE -> purchase order, SERVICE_BOOKING -> service job; nothing else is an order). The order copies
// the intent's pre-egress client operation identity and pinned provider-account revision. Nothing is sent here.
import {
  DomainError,
  ExecutionAuthorityIdSchema,
  IdempotencyKeySchema,
  IncidentIdSchema,
  decodeWire,
  encodeWire,
  newId,
} from '@uptimebuyer/contracts';
import { createCommercialIntentInTx, issueReference, type ReferenceSigner } from '@uptimebuyer/commerce';
import {
  lockKey,
  pgCode,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { CommercialIntentRequestSchema, type SignedExecutionReference } from '@uptimebuyer/kite-contracts';
import { z } from 'zod';
import { mirrorIntentInTx } from './apply.js';
import { KIND, actorFields, hold, invalid, lockOrder, planningLock, readOrder } from './internal.js';
import { loadOrderViewInTx, type OrderView } from './views.js';
import { COMPLETION_REPORTED_STATES, type OrderKind } from './vocabulary.js';

const RequestSchema = z.strictObject({
  executionAuthorityId: ExecutionAuthorityIdSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export interface RequestOrderResult {
  order: OrderView;
  /** Signed COMMERCIAL_INTENT reference for the broker (dispatchOrder mints a fresh one when it needs to). */
  executionReference: SignedExecutionReference;
  created: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function requestOrder(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof RequestSchema>,
  signer: ReferenceSigner,
): Promise<RequestOrderResult> {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_ORDER_REQUEST');
  const input = parsed.data;
  const meta = {
    action: 'orders.request',
    resourceType: 'execution_authority',
    resourceId: input.executionAuthorityId,
  };
  const out = await tenantCommand(pool, ctx, meta, async (c) => {
    const x = (
      await c.query(`SELECT * FROM execution_authorities WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        input.executionAuthorityId,
      ])
    ).rows[0];
    if (!x) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'orders.request', siteId: x.site_id }, undefined, {
      type: 'execution_authority',
      id: x.id,
    });
    const kind: OrderKind | null =
      x.subject_type !== 'PLAN_ACTION'
        ? null
        : x.semantic_operation === 'PURCHASE'
          ? 'PURCHASE_ORDER'
          : x.semantic_operation === 'SERVICE_BOOKING'
            ? 'SERVICE_JOB'
            : null;
    if (!kind) throw hold('NOT_AN_ORDER_OR_JOB', { semanticOperation: x.semantic_operation });
    const binding = (
      await c.query(
        `SELECT b.plan_id, b.plan_action_id, pa.recovery_eta_at, ca.quantity
           FROM plan_approval_bindings b
           JOIN plan_actions pa ON pa.tenant_id = b.tenant_id AND pa.plan_id = b.plan_id AND pa.id = b.plan_action_id
           JOIN candidate_actions ca ON ca.tenant_id = pa.tenant_id AND ca.id = pa.candidate_action_id
          WHERE b.tenant_id = $1 AND b.approval_id = $2 AND pa.candidate_action_id = $3`,
        [ctx.tenantId, x.approval_id, x.subject_id],
      )
    ).rows[0];
    if (!binding) throw hold('PLAN_ACTION_BINDING_MISSING');
    const request = decodeWire(
      CommercialIntentRequestSchema,
      encodeWire(CommercialIntentRequestSchema, {
        tenantId: x.tenant_id,
        incidentId: x.incident_id,
        assetRevisionId: x.asset_revision_id,
        evidenceRevisionId: x.evidence_revision_id,
        policyRevisionId: x.policy_revision_id,
        planHash: x.plan_hash,
        actionDigest: x.action_digest,
        approvalId: x.approval_id,
        executionAuthorityId: x.id,
        providerAccountRevisionId: x.provider_account_revision_id,
        subject: { type: 'PLAN_ACTION', id: x.subject_id },
        semanticOperation: x.semantic_operation,
        expectedMax: { amountMinor: BigInt(x.per_action_limit_minor), currency: x.currency },
        requestedBy:
          ctx.principal.kind === 'HUMAN'
            ? { kind: 'USER', userId: ctx.principal.id }
            : {
                kind: 'SERVICE',
                serviceIdentityId: ctx.principal.kind === 'SERVICE' ? ctx.principal.id : 'svc_order-engine',
              },
        correlationId: ctx.correlationId,
        idempotencyKey: input.idempotencyKey,
      } as never),
    );
    // Global lock order (planning -> authority -> intent -> order), the broker linearization's and revokeOrder's: the
    // planning lock is taken before M09 locks any intent row of this digest.
    await lockKey(c, planningLock(ctx.tenantId, x.incident_id));
    const { row: intent } = await createCommercialIntentInTx(c, ctx, request, meta);
    const k = KIND[kind];
    const existing = (
      await c.query(`SELECT id FROM ${k.table} WHERE tenant_id = $1 AND commercial_intent_id = $2`, [
        ctx.tenantId,
        intent.id,
      ])
    ).rows[0];
    if (existing) return { kind, orderId: existing.id as string, intentId: intent.id as string, created: false };
    // Predecessors whose intent is FAILED carry definite-no-effect proof once mirrored; mirror any that lag.
    const priors = (
      await c.query(
        `SELECT id FROM ${k.table} WHERE tenant_id = $1 AND action_digest = $2 AND no_effect_proven_at IS NULL ORDER BY id`,
        [ctx.tenantId, x.action_digest],
      )
    ).rows;
    for (const p of priors) {
      const locked = await lockOrder(c, ctx, meta, p.id);
      await mirrorIntentInTx(c, ctx, locked.kind, locked.row);
    }
    const latest = (
      await c.query(
        `SELECT id FROM ${k.table} WHERE tenant_id = $1 AND action_digest = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ctx.tenantId, x.action_digest],
      )
    ).rows[0];
    const actor = actorFields(ctx);
    const orderId: string = newId(kind === 'PURCHASE_ORDER' ? 'purchaseOrder' : 'serviceJob');
    try {
      await c.query('SAVEPOINT order_insert');
      await c.query(
        `INSERT INTO ${k.table} (tenant_id, id, incident_id, site_id, plan_id, plan_action_id, candidate_action_id,
           commercial_intent_id, execution_authority_id, approval_id, action_digest, provider_account_id,
           provider_account_revision_id, client_operation_id, idempotency_key, request_idempotency_key, state,
           approved_quantity, approved_amount_minor, currency, approved_eta_at, supersedes_order_id, correlation_id,
           created_by_kind, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'REQUESTED', $17, $18, $19, $20,
                 $21, $22, $23, $24)`,
        [
          ctx.tenantId,
          orderId,
          intent.incident_id,
          intent.site_id,
          binding.plan_id,
          binding.plan_action_id,
          intent.subject_id,
          intent.id,
          intent.execution_authority_id,
          intent.approval_id,
          intent.action_digest,
          intent.provider_account_id,
          intent.provider_account_revision_id,
          intent.client_operation_id,
          intent.idempotency_key,
          input.idempotencyKey,
          binding.quantity,
          intent.max_amount_minor,
          intent.currency,
          binding.recovery_eta_at,
          latest?.id ?? null,
          ctx.correlationId,
          actor.kind,
          actor.id,
        ],
      );
      await c.query('RELEASE SAVEPOINT order_insert');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT order_insert');
      const code = pgCode(e);
      if (code === '23505' || code === 'UB102')
        throw new DomainError('INTENT_SUCCESSOR_BLOCKED', 'A prior order for this action may have had an effect.', {
          reasonCode: 'PRIOR_ORDER_POSSIBLY_EFFECTIVE',
        });
      if (code && /^UB10[1-4]$/.test(code)) throw hold(`DB_GUARD_${code}`);
      throw e;
    }
    await recordAudit(c, ctx, {
      action: 'orders.request',
      resourceType: k.aggregateType,
      resourceId: orderId,
      result: 'SUCCEEDED',
    });
    return { kind, orderId, intentId: intent.id as string, created: true };
  });
  const order = await getOrder(pool, ctx, out.orderId, 'orders.request');
  return {
    order,
    executionReference: issueReference(signer, ctx.tenantId, {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: out.intentId,
    } as never),
    created: out.created,
  };
}

export async function getOrder(
  pool: Db,
  ctx: TenantContext,
  orderId: string,
  action: 'orders.read' | 'orders.request' = 'orders.read',
): Promise<OrderView> {
  const meta = { action, resourceType: 'order', resourceId: String(orderId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { kind, row } = await readOrder(c, ctx, meta, orderId);
    requireAuthorized(ctx, { action, siteId: row.site_id }, undefined, { type: KIND[kind].aggregateType, id: row.id });
    return (await loadOrderViewInTx(c, ctx.tenantId, kind, row.id))!;
  });
}

export async function listIncidentOrders(pool: Db, ctx: TenantContext, incidentId: string): Promise<OrderView[]> {
  const meta = { action: 'orders.read', resourceType: 'incident', resourceId: String(incidentId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!IncidentIdSchema.safeParse(incidentId).success) throw unavailable(meta, null);
    const inc = (
      await c.query(`SELECT site_id FROM incidents WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, incidentId])
    ).rows[0];
    if (!inc) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'orders.read', siteId: inc.site_id }, undefined, {
      type: 'incident',
      id: incidentId,
    });
    const out: OrderView[] = [];
    for (const kind of ['PURCHASE_ORDER', 'SERVICE_JOB'] as const) {
      const { rows } = await c.query(
        `SELECT id FROM ${KIND[kind].table} WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at, id`,
        [ctx.tenantId, incidentId],
      );
      for (const r of rows) out.push((await loadOrderViewInTx(c, ctx.tenantId, kind, r.id))!);
    }
    return out;
  });
}

export interface FulfillmentGate {
  orderId: string;
  /** True only for an unblocked, operator-VERIFIED delivery/work; installation or the next action may proceed. */
  installable: boolean;
  reasons: string[];
  /** Always false: order/job completion never proves asset recovery or releases completion-dependent value. */
  provesRecovery: false;
  releasesValue: false;
}

/** The installation / next-action gate M11 and the UI consult. Fulfillment evidence only, never recovery. */
export async function getFulfillmentGate(pool: Db, ctx: TenantContext, orderId: string): Promise<FulfillmentGate> {
  const meta = { action: 'orders.read', resourceType: 'order', resourceId: String(orderId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { kind, row } = await readOrder(c, ctx, meta, orderId);
    requireAuthorized(ctx, { action: 'orders.read', siteId: row.site_id }, undefined, {
      type: KIND[kind].aggregateType,
      id: row.id,
    });
    return gateOf(c, ctx.tenantId, kind, row);
  });
}

export async function gateOf(c: Tx, tenantId: string, kind: OrderKind, row: any): Promise<FulfillmentGate> {
  const reasons: string[] = [];
  if (row.blocked_reason) reasons.push(`BLOCKED_${row.blocked_reason}`);
  if (row.state !== 'VERIFIED')
    reasons.push(COMPLETION_REPORTED_STATES[kind].includes(row.state) ? 'AWAITING_VERIFICATION' : `STATE_${row.state}`);
  const i = (
    await c.query(`SELECT state FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      row.commercial_intent_id,
    ])
  ).rows[0];
  if (i.state !== 'CONFIRMED') reasons.push(`PAYMENT_${i.state}`);
  return { orderId: row.id, installable: reasons.length === 0, reasons, provesRecovery: false, releasesValue: false };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
