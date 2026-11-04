// Commercial ledger writes (INV-05), shared by the broker's reconciliation and the human manual-resolution command. Every movement is one append-only row in the tenant/provider-account event
// namespace; the database trigger is the only writer of the account, intent and capture projections and enforces both
// conservation equations at all three levels. A duplicate provider event (same namespaced key) inserts nothing and
// moves no money. Receipts record payment observations only; they never prove delivery, work or recovery.
import { createHash } from 'node:crypto';
import type { TenantContext, Tx } from '@uptimebuyer/data';
import { emitBudgetMovement } from './events.js';
import { actorFields, mapGuardError, newCommerceId } from './internal.js';

/** The observation a receipt digests (the broker's normalized adapter outcome, or a reviewed manual record). */
export interface ObservedOutcome {
  kind: string;
  rawProviderStatus: string | null;
  rawResponseDigest: string | null;
  observedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function insertMovement(
  c: Tx,
  ctx: TenantContext,
  m: {
    account: any;
    intent: any;
    movementType: 'RESERVE' | 'RELEASE' | 'CAPTURE' | 'REFUND' | 'REVERSAL';
    amountMinor: bigint;
    providerEventKey: string;
    captureEntryId?: string;
    reasonCode: string;
  },
): Promise<any | null> {
  if (m.amountMinor <= 0n) return null;
  let entry: any;
  try {
    entry = (
      await c.query(
        `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, intent_id, movement_type, amount_minor,
           currency, provider_account_id, provider_account_revision_id, provider_event_key, capture_entry_id, reason_code,
           actor_kind, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, provider_account_id, provider_event_key) WHERE provider_event_key IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          ctx.tenantId,
          newCommerceId('ledgerEntry'),
          m.account.id,
          m.intent.id,
          m.movementType,
          m.amountMinor.toString(),
          m.intent.currency,
          m.intent.provider_account_id,
          m.intent.provider_account_revision_id,
          m.providerEventKey,
          m.captureEntryId ?? null,
          m.reasonCode,
          actorFields(ctx).kind,
          actorFields(ctx).id,
        ],
      )
    ).rows[0];
  } catch (e) {
    mapGuardError(e);
  }
  if (!entry) return null;
  const after = (
    await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, m.account.id])
  ).rows[0];
  await emitBudgetMovement(c, ctx, entry, after, m.intent.correlation_id);
  return entry;
}

export async function recordReceipt(
  c: Tx,
  ctx: TenantContext,
  attempt: any,
  intent: any,
  kind:
    'PROVIDER_ACCEPTANCE' | 'PAYMENT_SETTLEMENT' | 'REFUND' | 'REVERSAL' | 'NO_EFFECT_PROOF' | 'PAYMENT_NEGOTIATION',
  origin: string,
  o: ObservedOutcome,
  discriminator = '',
): Promise<void> {
  const normalized = `sha256:${createHash('sha256')
    .update(
      `receipt.v1\n${kind}\n${attempt.client_operation_id}\n${o.kind}\n${o.rawResponseDigest ?? ''}\n${discriminator}`,
    )
    .digest('hex')}`;
  await c.query(
    `INSERT INTO external_receipts (tenant_id, id, attempt_id, intent_id, kind, result_origin, normalized_digest,
       raw_response_digest, provider_status, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, attempt_id, kind, normalized_digest) DO NOTHING`,
    [
      ctx.tenantId,
      newCommerceId('receipt'),
      attempt.id,
      intent.id,
      kind,
      origin,
      normalized,
      o.rawResponseDigest,
      o.rawProviderStatus,
      o.observedAt,
    ],
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
