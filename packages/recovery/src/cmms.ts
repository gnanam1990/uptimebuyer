// Replay-safe CMMS writes (FR-17, NFR-02, NFR-03, INV-08, INV-12). Every work-order update is a durable row keyed by a
// deterministic idempotency key, written in the same transaction as the fact it reports (closeout, reopen, M10
// order/job state change), so a replayed event, a retried worker or a restart can never create a second update.
// Workers claim due rows with FOR UPDATE SKIP LOCKED under a lease, stamp the durable send marker BEFORE handing the
// update to the adapter, and record the normalized EXTERNAL_ACTION outcome afterwards. A row found with the marker but
// no outcome (crash after send) or UNKNOWN is resolved by lookup under the same key before any re-send; an adapter
// without credentials is UNSUPPORTED (pre-egress) and nothing is claimed as written.
import { DomainError, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import { consumeOnce, sha256Digest, tenantCommand, type Db, type TenantContext, type Tx } from '@uptimebuyer/data';
import { canonicalize } from '@uptimebuyer/domain';
import { getOrder } from '@uptimebuyer/orders';
import type { CmmsAdapter, CmmsLookupOutcome, CmmsWriteOutcome } from './cmms-adapter.js';
import { recordProviderEvidenceInTx } from './evidence.js';
import { newRecoveryId, requireAt, validation } from './internal.js';

export interface CmmsUpdateInput {
  incidentId: string;
  siteId: string;
  updateKind: 'ORDER_FACT' | 'JOB_FACT' | 'CLOSEOUT' | 'REOPEN';
  sourceType: 'purchase_order' | 'service_job' | 'recovery_closeout';
  sourceId: string;
  sourceVersion: number;
  payload: Record<string, unknown>;
}

/** Queue one CMMS update in the caller's transaction; the deterministic key makes a replay a no-op. */
export async function enqueueCmmsUpdate(c: Tx, tenantId: string, u: CmmsUpdateInput): Promise<string | null> {
  const key = `cmms:${tenantId}:${u.updateKind.toLowerCase()}:${u.sourceId}:v${u.sourceVersion}`;
  const canonical = canonicalize(u.payload);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO cmms_work_order_updates (tenant_id, id, incident_id, site_id, update_kind, source_type, source_id,
       source_version, idempotency_key, work_order_key, payload, payload_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $10, $11)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      tenantId,
      newRecoveryId('cmmsUpdate'),
      u.incidentId,
      u.siteId,
      u.updateKind,
      u.sourceType,
      u.sourceId,
      u.sourceVersion,
      key,
      canonical,
      sha256Digest(canonical),
    ],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// M10 order/job facts

export const RECOVERY_FACT_CONSUMER = 'recovery-cmms-facts.v1';
const PROVIDER_COMPLETION: Record<string, string> = {
  'purchase_order.state_changed.v1': 'DELIVERED',
  'service_job.state_changed.v1': 'WORK_REPORTED_COMPLETE',
};

/**
 * Consume `purchase_order.state_changed.v1` / `service_job.state_changed.v1` once per event: queue the order/job fact for
 * the CMMS (from the M10 order view, since the event's raw evidence is null) and record provider-reported completion as
 * PROVIDER_REPORTED evidence (never a milestone or signoff).
 */
export async function handleOrderFactEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE'> {
  return consumeOnce(pool, RECOVERY_FACT_CONSUMER, envelope, async (c, ctx) => {
    if (!(envelope.eventType in PROVIDER_COMPLETION)) return;
    const payload = envelope.payload as { from?: string; to?: string; rawStatus?: string | null };
    const view = await getOrder(pool, ctx, envelope.aggregateId);
    const { rows } = await c.query<{ id: string; site_id: string; asset_id: string }>(
      `SELECT id, site_id, asset_id FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, view.incidentId],
    );
    const inc = rows[0];
    if (!inc) return;
    const job = envelope.eventType === 'service_job.state_changed.v1';
    await enqueueCmmsUpdate(c, ctx.tenantId, {
      incidentId: inc.id,
      siteId: inc.site_id,
      updateKind: job ? 'JOB_FACT' : 'ORDER_FACT',
      sourceType: job ? 'service_job' : 'purchase_order',
      sourceId: envelope.aggregateId,
      sourceVersion: envelope.aggregateVersion,
      payload: {
        status: payload.to ?? view.state,
        from: payload.from ?? null,
        orderKind: view.orderKind,
        orderId: view.orderId,
        orderVersion: envelope.aggregateVersion,
        planId: view.planId,
        actionDigest: view.actionDigest,
        providerRef: view.providerRef,
        approved: {
          quantity: view.approved.quantity,
          amountMinor: view.approved.amountMinor.toString(),
          currency: view.approved.currency,
        },
        economicState: view.economic.state,
        observationDigests: view.observations.map((o) => o.rawBodyDigest).filter((d) => d !== null),
        sourceEventId: envelope.eventId,
        provesRecovery: false,
      },
    });
    if (payload.to === PROVIDER_COMPLETION[envelope.eventType])
      await recordProviderEvidenceInTx(c, ctx, inc, {
        kind: 'PROVIDER_COMPLETION',
        occurredAt: envelope.occurredAt,
        sourceRef: envelope.aggregateId,
        body: {
          eventId: envelope.eventId,
          orderId: view.orderId,
          to: payload.to,
          rawStatus: payload.rawStatus ?? null,
        },
      });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Writer

interface UpdateRow {
  tenant_id: string;
  id: string;
  incident_id: string;
  update_kind: string;
  idempotency_key: string;
  work_order_key: string;
  payload: Record<string, unknown>;
  payload_digest: string;
  external_outcome_state: string;
  adapter_capability: string;
  send_started_at: Date | null;
  attempts: number;
  version: number;
}

export interface CmmsWriteFaults {
  /** Thrown from here simulates a worker dying after the adapter call and before the outcome is recorded. */
  afterSend?(): void;
}

export interface CmmsWriteRunResult {
  claimed: number;
  confirmed: number;
  unknown: number;
  failed: number;
  unsupported: number;
}

/** Path of single-step EXTERNAL_ACTION edges from `from` to the normalized outcome (all edges are legal). */
function pathTo(from: string, outcome: 'CONFIRMED' | 'UNKNOWN' | 'FAILED'): string[] {
  if (from === 'UNKNOWN') return outcome === 'UNKNOWN' ? [] : [outcome];
  if (from === 'AUTHORIZED')
    return outcome === 'CONFIRMED' ? ['REQUESTED', 'ACCEPTED', 'CONFIRMED'] : ['REQUESTED', outcome];
  if (from === 'REQUESTED') return outcome === 'CONFIRMED' ? ['ACCEPTED', 'CONFIRMED'] : [outcome];
  if (from === 'ACCEPTED') return [outcome];
  return [];
}

export async function runCmmsWrites(
  pool: Db,
  ctx: TenantContext,
  opts: {
    adapter: CmmsAdapter;
    workerId: string;
    limit?: number;
    leaseMs?: number;
    reconcileDelayMs?: number;
    faults?: CmmsWriteFaults;
  },
): Promise<CmmsWriteRunResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(opts.workerId)) throw validation('WORKER_ID_INVALID');
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const leaseMs = Math.max(20, Math.min(opts.leaseMs ?? 30_000, 600_000));
  const delayMs = Math.max(0, Math.min(opts.reconcileDelayMs ?? 30_000, 3_600_000));
  const meta = { action: 'recovery.cmms.write', resourceType: 'cmms_work_order_update', resourceId: null };
  const claimed = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'recovery.engine', null);
    const { rows } = await c.query<UpdateRow>(
      `UPDATE cmms_work_order_updates u
          SET lease_owner = $2, lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond',
              version = u.version + 1, updated_at = clock_timestamp()
        WHERE (u.tenant_id, u.id) IN (
          SELECT tenant_id, id FROM cmms_work_order_updates
           WHERE tenant_id = $1 AND external_outcome_state IN ('AUTHORIZED', 'UNKNOWN')
             AND next_attempt_at <= clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
           ORDER BY next_attempt_at, created_at, id
           LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING u.*`,
      [ctx.tenantId, opts.workerId, leaseMs, limit],
    );
    return rows;
  });
  const out: CmmsWriteRunResult = { claimed: claimed.length, confirmed: 0, unknown: 0, failed: 0, unsupported: 0 };
  for (const row of claimed) {
    const r = await processOne(pool, ctx, row, opts.adapter, opts.workerId, delayMs, opts.faults);
    out[r]++;
  }
  return out;
}

type Tally = 'confirmed' | 'unknown' | 'failed' | 'unsupported';

/** Version-checked update of one claimed row held by `worker`; refuses if the lease was lost. */
async function step(
  c: Tx,
  row: { tenant_id: string; id: string },
  worker: string,
  set: string,
  params: unknown[],
): Promise<UpdateRow> {
  const { rows } = await c.query<UpdateRow>(
    `UPDATE cmms_work_order_updates SET ${set}, version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 RETURNING *`,
    [row.tenant_id, row.id, worker, ...params],
  );
  if (!rows[0])
    throw new DomainError('VERSION_CONFLICT', 'The CMMS update lease was lost.', { reasonCode: 'LEASE_LOST' });
  return rows[0];
}

async function processOne(
  pool: Db,
  ctx: TenantContext,
  row: UpdateRow,
  adapter: CmmsAdapter,
  worker: string,
  delayMs: number,
  faults?: CmmsWriteFaults,
): Promise<Tally> {
  const meta = { action: 'recovery.cmms.write', resourceType: 'cmms_work_order_update', resourceId: row.id };
  const record = (mode: 'WRITE' | 'LOOKUP', result: CmmsWriteOutcome | CmmsLookupOutcome): Promise<Tally> =>
    tenantCommand(pool, ctx, meta, async (c) => {
      let cur = await step(c, row, worker, 'attempts = attempts + 1', []);
      await c.query(
        `INSERT INTO cmms_write_attempts (tenant_id, id, update_id, attempt, mode, adapter_kind, adapter_label, outcome,
           external_update_ref, reason_code, worker_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          ctx.tenantId,
          newRecoveryId('cmmsAttempt'),
          row.id,
          cur.attempts,
          mode,
          adapter.adapterKind,
          adapter.label,
          result.outcome,
          result.outcome === 'CONFIRMED' ? result.externalUpdateRef : null,
          'reasonCode' in result ? result.reasonCode.slice(0, 64) : null,
          worker,
        ],
      );
      if (result.outcome === 'UNSUPPORTED') {
        await step(
          c,
          cur,
          worker,
          `adapter_capability = 'UNSUPPORTED', capability_reason = $4, lease_owner = NULL, lease_expires_at = NULL`,
          [result.reasonCode],
        );
        return 'unsupported';
      }
      if (result.outcome === 'NOT_FOUND') throw new DomainError('INTERNAL', 'NOT_FOUND is resolved before recording.');
      for (const to of pathTo(cur.external_outcome_state, result.outcome)) {
        const ref = to === 'CONFIRMED' && result.outcome === 'CONFIRMED' ? result.externalUpdateRef : null;
        cur = await step(
          c,
          cur,
          worker,
          `external_outcome_state = $4, external_update_ref = coalesce($5, external_update_ref)`,
          [to, ref],
        );
      }
      const reason = 'reasonCode' in result ? result.reasonCode.slice(0, 64) : null;
      await step(
        c,
        cur,
        worker,
        `adapter_capability = 'ELIGIBLE', last_reason_code = $4, lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = clock_timestamp() + $5 * interval '1 millisecond'`,
        [reason, result.outcome === 'UNKNOWN' ? delayMs : 0],
      );
      return result.outcome === 'CONFIRMED' ? 'confirmed' : result.outcome === 'UNKNOWN' ? 'unknown' : 'failed';
    });

  if (adapter.capability() === 'UNSUPPORTED') {
    const r = row.send_started_at ? await adapter.lookup(row.idempotency_key) : await adapter.write(toUpdate(row));
    return record(row.send_started_at ? 'LOOKUP' : 'WRITE', r.outcome === 'NOT_FOUND' ? UNSUPPORTED_LOOKUP : r);
  }
  // In doubt (sent before, outcome unknown or never recorded): authoritative lookup under the same key first.
  if (row.send_started_at !== null || row.external_outcome_state === 'UNKNOWN') {
    const found = await adapter.lookup(row.idempotency_key);
    faults?.afterSend?.();
    if (found.outcome !== 'NOT_FOUND') return record('LOOKUP', found);
    // Not applied: the adapter's same-key replay is safe, so send again under the same idempotency key.
  } else {
    await tenantCommand(pool, ctx, meta, async (c) => {
      await step(c, row, worker, `send_started_at = clock_timestamp(), adapter_capability = 'ELIGIBLE'`, []);
    });
  }
  const result = await adapter.write(toUpdate(row));
  faults?.afterSend?.();
  return record('WRITE', result);
}

const UNSUPPORTED_LOOKUP = { outcome: 'UNSUPPORTED', reasonCode: 'CMMS_LOOKUP_UNSUPPORTED' } as const;

const toUpdate = (row: UpdateRow) => ({
  idempotencyKey: row.idempotency_key,
  tenantId: row.tenant_id,
  incidentId: row.incident_id,
  workOrderKey: row.work_order_key,
  updateKind: row.update_kind,
  payload: row.payload,
  payloadDigest: row.payload_digest,
});
