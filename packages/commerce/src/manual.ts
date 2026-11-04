// Manual resolution of an UNKNOWN effect (INV-08, STATE-MACHINES §6). Only when autonomous reconciliation is
// UNSUPPORTED (no authoritative lookup and no provider-guaranteed same-key replay) does a finance approver record the
// outcome of an out-of-band review, citing the reviewed evidence digest. NO_EFFECT_PROVED atomically RELEASEs the
// reservation and fails the intent; CAPTURED appends the proved CAPTURE (never above the open reservation), releases
// any remainder and confirms. It never re-sends, never creates a replacement attempt and is idempotent per intent.
import { CommercialIntentIdSchema } from '@uptimebuyer/contracts';
import {
  dbNow,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { emitAttemptEvent, emitIntentStateChanged, recordIntentTransition } from './events.js';
import { hold, invalid } from './internal.js';
import { insertMovement, recordReceipt } from './ledger.js';
import { loadIntentViewInTx, type CommercialIntentView } from './intents.js';

const ManualSchema = z.discriminatedUnion('resolution', [
  z.strictObject({
    commercialIntentId: CommercialIntentIdSchema,
    resolution: z.literal('NO_EFFECT_PROVED'),
    evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
  z.strictObject({
    commercialIntentId: CommercialIntentIdSchema,
    resolution: z.literal('CAPTURED'),
    capturedMinor: z.bigint().min(1n),
    evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
]);
export type ManualResolutionInput = z.input<typeof ManualSchema>;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function patchRow(c: any, table: string, row: any, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  const { rows } = await c.query(
    `UPDATE ${table} SET ${cols.map((k, n) => `${k} = $${n + 4}`).join(', ')}, version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [row.tenant_id, row.id, row.version, ...cols.map((k) => fields[k])],
  );
  if (!rows[0]) throw hold('VERSION_MOVED');
  return rows[0];
}

export async function resolveUnknownIntentManually(
  pool: Db,
  ctx: TenantContext,
  raw: ManualResolutionInput,
): Promise<CommercialIntentView> {
  const parsed = ManualSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_MANUAL_RESOLUTION');
  const input = parsed.data;
  const meta = {
    action: 'commerce.manual_resolve',
    resourceType: 'commercial_intent',
    resourceId: input.commercialIntentId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const peek = (
      await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        input.commercialIntentId,
      ])
    ).rows[0];
    if (!peek) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.manual_resolve', siteId: peek.site_id }, undefined, {
      type: 'commercial_intent',
      id: peek.id,
    });
    await c.query(`SELECT 1 FROM execution_authorities WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
      ctx.tenantId,
      peek.execution_authority_id,
    ]);
    let i = (
      await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        peek.id,
      ])
    ).rows[0];
    let a = (
      await c.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2 FOR NO KEY UPDATE`, [
        ctx.tenantId,
        peek.id,
      ])
    ).rows[0];
    if (i.state !== 'UNKNOWN') throw hold('INTENT_NOT_UNKNOWN', { state: i.state });
    if (!a || a.adapter_capability !== 'UNSUPPORTED') throw hold('AUTONOMOUS_RECONCILIATION_AVAILABLE');
    const observed = {
      kind: input.resolution,
      rawProviderStatus: `manual_${input.reasonCode.toLowerCase()}`.slice(0, 64),
      rawResponseDigest: input.evidenceDigest,
      observedAt: await dbNow(c),
    };
    const account = async () =>
      (
        await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [
          ctx.tenantId,
          i.budget_account_id,
        ])
      ).rows[0];
    const reload = async () =>
      (i = (await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, i.id]))
        .rows[0]);
    const open = BigInt(i.open_reserved_minor);
    if (input.resolution === 'CAPTURED') {
      if (input.capturedMinor > open) throw hold('CAPTURE_OUTSIDE_RESERVATION');
      a = await patchRow(c, 'external_attempts', a, {
        external_outcome_state: 'CONFIRMED',
        reason_code: input.reasonCode,
      });
      await recordReceipt(c, ctx, a, i, 'PAYMENT_SETTLEMENT', a.result_origin, observed, 'manual');
      await insertMovement(c, ctx, {
        account: await account(),
        intent: i,
        movementType: 'CAPTURE',
        amountMinor: input.capturedMinor,
        providerEventKey: `capture:${i.client_operation_id}`,
        reasonCode: input.reasonCode,
      });
      await reload();
      if (BigInt(i.open_reserved_minor) > 0n)
        await insertMovement(c, ctx, {
          account: await account(),
          intent: i,
          movementType: 'RELEASE',
          amountMinor: BigInt(i.open_reserved_minor),
          providerEventKey: `release:${i.client_operation_id}`,
          reasonCode: input.reasonCode,
        });
      await reload();
      const up = await patchRow(c, 'commercial_intents', i, { state: 'CONFIRMED', reason_code: input.reasonCode });
      await recordIntentTransition(c, ctx, i.id, 'UNKNOWN', 'CONFIRMED', input.reasonCode);
      await emitIntentStateChanged(c, ctx, up, 'UNKNOWN', a, input.reasonCode);
    } else {
      a = await patchRow(c, 'external_attempts', a, {
        external_outcome_state: 'FAILED',
        reason_code: input.reasonCode,
      });
      await recordReceipt(c, ctx, a, i, 'NO_EFFECT_PROOF', a.result_origin, observed, 'manual');
      await insertMovement(c, ctx, {
        account: await account(),
        intent: i,
        movementType: 'RELEASE',
        amountMinor: open,
        providerEventKey: `release:${i.client_operation_id}`,
        reasonCode: input.reasonCode,
      });
      await reload();
      const up = await patchRow(c, 'commercial_intents', i, { state: 'FAILED', reason_code: input.reasonCode });
      await recordIntentTransition(c, ctx, i.id, 'UNKNOWN', 'FAILED', input.reasonCode);
      await emitIntentStateChanged(c, ctx, up, 'UNKNOWN', a, input.reasonCode);
    }
    await emitAttemptEvent(c, ctx, 'external_attempt.reconciled.v1', i, a);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
    return (await loadIntentViewInTx(c, ctx.tenantId, i.id))!;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
