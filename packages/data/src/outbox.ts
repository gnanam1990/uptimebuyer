// Transactional outbox (NFR-02, ADR 0001 §3). A domain change and its event commit in one transaction; a lease-based
// publisher claims unpublished rows with `FOR UPDATE SKIP LOCKED`, delivers them at least once and acknowledges
// them by stamping `published_at`. A crash at any point leaves the row unpublished (or its lease expires), so it is
// delivered again; consumers use `consumeOnce`, whose receipt commits with the consumer's own effects, so each
// event is applied once logically (logical idempotency key = eventId; one event per aggregate version and type).
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CausationIdSchema,
  CorrelationIdSchema,
  DomainError,
  DomainEventEnvelopeSchema,
  EVENT_CATALOG,
  OpaqueIdSchema,
  decodeWire,
  newId,
  type CausationId,
  type CorrelationId,
  type DomainEventEnvelope,
  type EventId,
  type EventType,
  type TenantId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import { isoNN, sha256Digest, versionConflict, withTransaction, type Db, type Tx } from './db.js';
import { assertTenantContext, issueWorkerContext, type TenantContext } from './context.js';

export interface OutboxEventInput {
  eventType: EventType;
  aggregateType: (typeof EVENT_CATALOG)[EventType];
  aggregateId: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
  correlationId: CorrelationId | string;
  causationId: CausationId | string;
  occurredAt?: UtcInstant;
}

const invalid = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Outbox event failed contract validation.', { reasonCode });

/**
 * Append an event inside the caller's domain transaction. Re-appending the identical event for the same aggregate
 * version is idempotent (returns the original eventId); a different payload for that version is a VERSION_CONFLICT.
 */
export async function appendOutboxEvent(client: Tx, ctx: TenantContext, input: OutboxEventInput): Promise<EventId> {
  assertTenantContext(ctx);
  if (!Object.hasOwn(EVENT_CATALOG, input.eventType)) throw invalid('UNKNOWN_EVENT_TYPE');
  if (EVENT_CATALOG[input.eventType] !== input.aggregateType) throw invalid('AGGREGATE_TYPE_MISMATCH');
  if (!OpaqueIdSchema.safeParse(input.aggregateId).success) throw invalid('AGGREGATE_ID_INVALID');
  if (!Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion < 1) throw invalid('VERSION_INVALID');
  if (!CorrelationIdSchema.safeParse(input.correlationId).success) throw invalid('CORRELATION_INVALID');
  if (!CausationIdSchema.safeParse(input.causationId).success) throw invalid('CAUSATION_INVALID');
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload))
    throw invalid('PAYLOAD_NOT_OBJECT');
  let canonical: string;
  try {
    canonical = canonicalize(input.payload);
  } catch {
    throw invalid('PAYLOAD_NOT_CANONICAL');
  }
  const payloadDigest = sha256Digest(canonical);
  const eventId = newId('event');
  const { rows } = await client.query<{ id: EventId }>(
    `INSERT INTO outbox_events (tenant_id, id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version,
                                payload, payload_digest, correlation_id, causation_id, occurred_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, date_trunc('milliseconds', clock_timestamp())))
     ON CONFLICT (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING
     RETURNING id`,
    [
      ctx.tenantId,
      eventId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
      canonical,
      payloadDigest,
      input.correlationId,
      input.causationId,
      input.occurredAt ?? null,
    ],
  );
  if (rows[0]) return rows[0].id;
  const existing = await client.query<{ id: EventId; payload_digest: string }>(
    `SELECT id, payload_digest FROM outbox_events WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
       AND aggregate_version = $4 AND event_type = $5`,
    [ctx.tenantId, input.aggregateType, input.aggregateId, input.aggregateVersion, input.eventType],
  );
  const row = existing.rows[0];
  if (row && row.payload_digest === payloadDigest) return row.id;
  throw versionConflict('AGGREGATE_VERSION_ALREADY_EMITTED');
}

export interface OutboxSink {
  publish(event: DomainEventEnvelope): Promise<void>;
}

/** Fault-injection hooks for restart tests: throwing from a hook simulates the process dying at that point. */
export interface OutboxFaults {
  afterClaim?(events: readonly DomainEventEnvelope[]): void;
  beforeAck?(event: DomainEventEnvelope): void;
}

export interface OutboxPublisherOptions {
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  faults?: OutboxFaults;
}

interface OutboxRow {
  tenant_id: TenantId;
  id: EventId;
  seq: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string;
  occurred_at: Date;
}

function toEnvelope(r: OutboxRow): DomainEventEnvelope {
  return decodeWire(DomainEventEnvelopeSchema, {
    eventId: r.id,
    eventType: r.event_type,
    occurredAt: isoNN(r.occurred_at),
    tenantId: r.tenant_id,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    schemaVersion: 1,
    payload: r.payload,
  });
}

const CLAIM_SQL = `
  UPDATE outbox_events o
     SET lease_owner = $1,
         lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000),
         publish_attempts = o.publish_attempts + 1
   WHERE o.id IN (
     SELECT id FROM outbox_events
      WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
      ORDER BY seq
      LIMIT $3
      FOR UPDATE SKIP LOCKED)
  RETURNING o.*`;

export class OutboxPublisher {
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly pool: Db,
    private readonly sink: OutboxSink,
    private readonly opts: OutboxPublisherOptions,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(opts.workerId)) throw invalid('WORKER_ID_INVALID');
    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? 50, 1000));
    this.leaseMs = Math.max(50, Math.min(opts.leaseMs ?? 30_000, 3_600_000));
  }

  /** Claim one batch, deliver it in order and acknowledge each delivered event. */
  async runOnce(): Promise<{ claimed: number; published: number }> {
    const { rows } = await this.pool.query<OutboxRow>(CLAIM_SQL, [this.opts.workerId, this.leaseMs, this.batchSize]);
    rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    const events = rows.map(toEnvelope);
    this.opts.faults?.afterClaim?.(events);
    let published = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      try {
        await this.sink.publish(event);
      } catch (error) {
        // A sink failure (unlike a crash) releases the remaining leases so another publisher can retry promptly.
        await this.pool.query(
          `UPDATE outbox_events SET lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'SINK_FAILED'
            WHERE id = ANY($1) AND lease_owner = $2 AND published_at IS NULL`,
          [events.slice(i).map((e) => e.eventId), this.opts.workerId],
        );
        throw error;
      }
      this.opts.faults?.beforeAck?.(event);
      const ack = await this.pool.query(
        `UPDATE outbox_events SET published_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND lease_owner = $2 AND published_at IS NULL`,
        [event.eventId, this.opts.workerId],
      );
      published += ack.rowCount ?? 0;
    }
    return { claimed: events.length, published };
  }

  /** Run until no claimable rows remain; with `waitForLeases`, until nothing at all is unpublished. */
  async drain(opts: { waitForLeases?: boolean; timeoutMs?: number; pollMs?: number } = {}): Promise<number> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let total = 0;
    for (;;) {
      const r = await this.runOnce();
      total += r.published;
      if (r.claimed > 0) continue;
      if (!opts.waitForLeases) return total;
      const { rows } = await this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`,
      );
      if (rows[0]!.n === 0) return total;
      if (Date.now() > deadline)
        throw new DomainError('DEPENDENCY_FAILED', 'Outbox drain timed out with unpublished events.', {
          reasonCode: 'OUTBOX_DRAIN_TIMEOUT',
        });
      await sleep(opts.pollMs ?? 50);
    }
  }
}

/**
 * Idempotent consumer. The envelope must match its durable outbox row (tenant, type, aggregate); the handler runs
 * in one transaction with the receipt, under a worker context derived from that row. Returns DUPLICATE (and does
 * nothing) when this consumer already processed the event.
 */
export async function consumeOnce(
  pool: Db,
  consumer: string,
  envelope: DomainEventEnvelope,
  handler: (client: Tx, ctx: TenantContext) => Promise<void>,
): Promise<'PROCESSED' | 'DUPLICATE'> {
  const event = decodeWire(DomainEventEnvelopeSchema, envelope);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(consumer)) throw invalid('CONSUMER_NAME_INVALID');
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<OutboxRow>(`SELECT * FROM outbox_events WHERE id = $1`, [event.eventId]);
    const row = rows[0];
    if (
      !row ||
      row.tenant_id !== event.tenantId ||
      row.event_type !== event.eventType ||
      row.aggregate_type !== event.aggregateType ||
      row.aggregate_id !== event.aggregateId ||
      row.aggregate_version !== event.aggregateVersion
    )
      throw new DomainError('FORBIDDEN', 'The event does not match a durable outbox record.', {
        reasonCode: 'EVENT_NOT_DURABLE',
      });
    const receipt = await client.query(
      `INSERT INTO outbox_consumer_receipts (tenant_id, consumer, event_id) VALUES ($1, $2, $3)
       ON CONFLICT (consumer, event_id) DO NOTHING RETURNING event_id`,
      [row.tenant_id, consumer, row.id],
    );
    if (receipt.rowCount === 0) return 'DUPLICATE';
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id]);
    const ctx = issueWorkerContext(
      row.tenant_id,
      { kind: 'WORKER', id: consumer, source: 'OUTBOX', sourceId: row.id },
      row.correlation_id as CorrelationId,
    );
    await handler(client, ctx);
    return 'PROCESSED';
  });
}
