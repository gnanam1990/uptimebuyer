// Telemetry storage, binding resolution, classification and freshness projection (M03: FR-02, FR-22, INV-01,
// INV-11, INV-16, NFR-03, NFR-04).
// - Ingestion runs under a server-issued DEVICE context only; the tenant, site, asset and every revision come from
//   the authenticated device and the registry, never from the payload.
// - Each sample resolves exactly one assignment (not superseded) and one channel revision effective at its SOURCE
//   event time (rows are locked FOR SHARE so a concurrent rebind cannot slip underneath), is normalized against
//   that revision, classified LIVE | LATE | BACKFILL under the pinned lateness policy, and inserted once per
//   (channel, boot, sequence): a duplicate is idempotent and a conflicting duplicate is rejected, never written.
// - The per-channel health projection only advances on LIVE flag-free samples; reads re-evaluate it against the
//   clock, so stale data never reads as healthy even before the sweeper persists the transition.
import {
  DeviceIdSchema,
  DomainError,
  UtcInstantSchema,
  newId,
  type DeviceId,
  type SiteId,
  type TenantId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import {
  DEFAULT_FRESHNESS_POLICY,
  DEFAULT_LATENESS_POLICY,
  FreshnessPolicySchema,
  LatenessPolicySchema,
  TelemetryBatchSchema,
  classifyIngestion,
  evaluateFreshness,
  freshnessPolicyDigest,
  freshnessSeverity,
  latenessPolicyDigest,
  normalizeSample,
  rollupFreshness,
  verifyTelemetryBody,
  type ChannelKind,
  type Freshness,
  type FreshnessPolicy,
  type FreshnessView,
  type IngestionClass,
  type InputOrigin,
  type LatenessPolicy,
  type OverflowAggregate,
  type QualityFlag,
  type SignatureVerdict,
  type TelemetryBatchInput,
  type WireUnit,
} from '@uptimebuyer/telemetry';
import type { CredentialResolver } from './auth.js';
import { authorize, requireAuthorized } from './authz.js';
import { Denial, recordAudit, resourceUnavailable, tenantCommand, unavailable, type CommandMeta } from './command.js';
import { assertTenantContext, issueWorkerContext, withTenantTransaction, type TenantContext } from './context.js';
import { iso, isoNN, lockKey, pgCode, sha256Digest, type Db, type Tx } from './db.js';
import { newDataId, type SensorChannelId, type TelemetryBatchId, type TelemetrySampleId } from './ids.js';
import { appendOutboxEvent } from './outbox.js';

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

export const TELEMETRY_REJECTION_REASONS = Object.freeze([
  'BINDING_MISSING',
  'BINDING_OVERLAPPING',
  'BINDING_SUPERSEDED',
  'CHANNEL_UNKNOWN',
  'CHANNEL_RETIRED',
  'CHANNEL_REVISION_MISSING',
  'CHANNEL_REVISION_OVERLAPPING',
  'UNIT_MISMATCH',
  'VALUE_OUT_OF_CONTRACT',
  'FUTURE_EVENT_TIME',
  'EVENT_OUTSIDE_ACCEPTANCE_WINDOW',
  'DUPLICATE_CONFLICT',
] as const);
export type TelemetryRejectionReason = (typeof TELEMETRY_REJECTION_REASONS)[number];

/** Rejections of a current (live-lag) observation that make the channel's current state INVALID. */
const INVALIDATING: ReadonlySet<string> = new Set([
  'BINDING_MISSING',
  'BINDING_OVERLAPPING',
  'BINDING_SUPERSEDED',
  'CHANNEL_RETIRED',
  'CHANNEL_REVISION_MISSING',
  'CHANNEL_REVISION_OVERLAPPING',
  'UNIT_MISMATCH',
  'VALUE_OUT_OF_CONTRACT',
  'FUTURE_EVENT_TIME',
]);

export interface IngestTelemetryInput {
  /** Re-validated here against the strict schema. */
  batch: TelemetryBatchInput;
  /** Gateway receipt time (injected clock) as a canonical UTC instant, captured when the request arrived. */
  receivedAt: string;
  /** The verified signing timestamp (defaults to receivedAt). */
  signedAt?: string;
  /** sha256 of the exact request body bytes. */
  bodyDigest: string;
}

export interface IngestTelemetryOptions {
  latenessPolicy?: LatenessPolicy;
  freshnessPolicy?: FreshnessPolicy;
}

export type SampleStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
export interface SampleOutcome {
  bootId: string;
  sequence: number;
  channel: string;
  status: SampleStatus;
  reasonCode: TelemetryRejectionReason | null;
  sampleId: TelemetrySampleId | null;
  ingestionClass: IngestionClass | null;
}

export interface TelemetryIngestResult {
  batchId: TelemetryBatchId;
  receivedAt: string;
  accepted: number;
  duplicates: number;
  rejected: number;
  classCounts: Record<IngestionClass, number>;
  disclosures: { recorded: number; duplicate: number };
  results: SampleOutcome[];
}

interface ChannelRow {
  id: SensorChannelId;
  status: 'ACTIVE' | 'RETIRED';
}

interface HealthEffect {
  basis?: { sampleId: string; eventAt: string; receivedAt: string };
  invalid?: { reason: string; at: string };
  lastReceivedAt?: string;
  lastClass?: IngestionClass;
}

const qualityFlagOf = (q: string): QualityFlag | null => (q === 'GOOD' ? null : (q as QualityFlag));

/** Ingest one authenticated, signature-verified batch for the calling device. */
export async function ingestTelemetryBatch(
  pool: Db,
  ctx: TenantContext,
  input: IngestTelemetryInput,
  opts: IngestTelemetryOptions = {},
): Promise<TelemetryIngestResult> {
  assertTenantContext(ctx);
  const lateness = LatenessPolicySchema.parse(opts.latenessPolicy ?? DEFAULT_LATENESS_POLICY);
  const freshness = FreshnessPolicySchema.parse(opts.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY);
  const parsed = TelemetryBatchSchema.safeParse(input.batch);
  if (!parsed.success) throw validation('TELEMETRY_BATCH_INVALID');
  const batch = parsed.data;
  if (!/^sha256:[0-9a-f]{64}$/.test(input.bodyDigest)) throw validation('BODY_DIGEST_INVALID');
  if (!UtcInstantSchema.safeParse(input.receivedAt).success) throw validation('RECEIVED_AT_INVALID');
  if (input.signedAt !== undefined && !UtcInstantSchema.safeParse(input.signedAt).success)
    throw validation('SIGNED_AT_INVALID');
  const receivedAtMs = Date.parse(input.receivedAt);
  const p = ctx.principal;
  const deviceId = (p.kind === 'DEVICE' ? p.id : batch.deviceId) as DeviceId;
  const meta: CommandMeta = { action: 'telemetry.ingest', resourceType: 'device', resourceId: deviceId };

  return tenantCommand(pool, ctx, meta, async (c) => {
    // Only a device principal may ingest, only at its own site, and only for itself.
    requireAuthorized(ctx, { action: 'telemetry.ingest', siteId: p.kind === 'DEVICE' ? p.siteId : null }, undefined, {
      type: 'device',
      id: deviceId,
    });
    if (batch.deviceId !== deviceId)
      throw new Denial(
        new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
          reasonCode: 'DEVICE_MISMATCH',
        }),
        { ...meta, reasonCode: 'DEVICE_MISMATCH' },
      );
    await lockKey(c, `telemetry:${ctx.tenantId}:${deviceId}`);
    const dev = await c.query<{ site_id: SiteId; status: string; input_class: 'PHYSICAL_SENSOR' | 'SIMULATOR' }>(
      `SELECT site_id, status, input_class FROM devices WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, deviceId],
    );
    const device = dev.rows[0];
    if (!device) throw unavailable(meta);
    if (device.status === 'REVOKED')
      throw new Denial(
        new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
          reasonCode: 'DEVICE_REVOKED',
        }),
        { ...meta, reasonCode: 'DEVICE_REVOKED' },
      );
    requireAuthorized(ctx, { action: 'telemetry.ingest', siteId: device.site_id }, undefined, {
      type: 'device',
      id: deviceId,
    });

    const requested = [...new Set(batch.messages.flatMap((m) => m.samples.map((s) => s.channel)))];
    const chRows = await c.query<ChannelRow>(
      `SELECT id, status FROM sensor_channels WHERE tenant_id = $1 AND device_id = $2 AND id = ANY($3::text[])`,
      [ctx.tenantId, deviceId, requested],
    );
    const channels = new Map(chRows.rows.map((r) => [r.id as string, r]));
    const batchId = newDataId('telemetryBatch') as TelemetryBatchId;
    const latenessDigest = latenessPolicyDigest(lateness);
    const results: SampleOutcome[] = [];
    const effects = new Map<string, HealthEffect>();
    const classCounts: Record<IngestionClass, number> = { LIVE: 0, LATE: 0, BACKFILL: 0 };
    const origins = new Set<InputOrigin>();
    const acceptedChannels = new Set<string>();
    const acceptedTimes: string[] = [];
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let sampleCount = 0;
    const maxSeq = new Map<string, number | null>();
    const effect = (ch: string) => {
      let e = effects.get(ch);
      if (!e) effects.set(ch, (e = {}));
      return e;
    };

    // Deterministic processing order: by boot, then sequence (gap detection relies on it).
    const messages = [...batch.messages].sort((a, b) =>
      a.bootId === b.bootId ? a.sequence - b.sequence : a.bootId < b.bootId ? -1 : 1,
    );
    for (const m of messages) {
      // ---- sequence-gap tracking (per device and boot, after the first observed sequence)
      if (!maxSeq.has(m.bootId)) {
        const r = await c.query<{ m: string | null }>(
          `SELECT max(seq) AS m FROM (
             SELECT max(sequence) AS seq FROM telemetry_samples WHERE tenant_id = $1 AND device_id = $2 AND boot_id = $3
             UNION ALL
             SELECT max(sequence) FROM telemetry_rejections WHERE tenant_id = $1 AND device_id = $2 AND boot_id = $3) x`,
          [ctx.tenantId, deviceId, m.bootId],
        );
        maxSeq.set(m.bootId, r.rows[0]?.m === null || r.rows[0]?.m === undefined ? null : Number(r.rows[0].m));
      }
      const prevMax = maxSeq.get(m.bootId) ?? null;
      if (prevMax !== null && m.sequence > prevMax + 1)
        await c.query(
          `INSERT INTO telemetry_sequence_gaps (tenant_id, id, device_id, boot_id, from_sequence, to_sequence, detected_at, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, device_id, boot_id, from_sequence) DO NOTHING`,
          [
            ctx.tenantId,
            newDataId('telemetrySequenceGap'),
            deviceId,
            m.bootId,
            prevMax + 1,
            m.sequence - 1,
            input.receivedAt,
            batchId,
          ],
        );
      if (prevMax === null || m.sequence > prevMax) maxSeq.set(m.bootId, m.sequence);

      const eventAtMs = Date.parse(m.eventAt);
      const cls = classifyIngestion(eventAtMs, receivedAtMs, batch.delivery, lateness);
      // ---- binding at source time: exactly one assignment, not superseded, locked against concurrent rebinding
      let binding:
        | { ok: true; assignmentId: string; assetId: string; assetRevisionId: string }
        | { ok: false; reason: TelemetryRejectionReason }
        | null = null;
      const resolveBinding = async () => {
        if (binding) return binding;
        const a = await c.query<{
          id: string;
          asset_id: string;
          asset_revision_id: string;
          superseded_at: Date | null;
        }>(
          `SELECT a.id, a.asset_id, a.asset_revision_id, r.superseded_at
             FROM device_asset_assignments a
             JOIN asset_revisions r ON r.tenant_id = a.tenant_id AND r.asset_id = a.asset_id AND r.id = a.asset_revision_id
            WHERE a.tenant_id = $1 AND a.device_id = $2 AND a.valid_from <= $3 AND (a.valid_to IS NULL OR a.valid_to > $3)
            ORDER BY a.id FOR SHARE OF a, r`,
          [ctx.tenantId, deviceId, m.eventAt],
        );
        if (a.rows.length === 0) binding = { ok: false, reason: 'BINDING_MISSING' };
        else if (a.rows.length > 1) binding = { ok: false, reason: 'BINDING_OVERLAPPING' };
        else if (a.rows[0]!.superseded_at !== null && a.rows[0]!.superseded_at.getTime() <= eventAtMs)
          binding = { ok: false, reason: 'BINDING_SUPERSEDED' };
        else
          binding = {
            ok: true,
            assignmentId: a.rows[0]!.id,
            assetId: a.rows[0]!.asset_id,
            assetRevisionId: a.rows[0]!.asset_revision_id,
          };
        return binding;
      };

      for (const s of m.samples) {
        sampleCount++;
        const channel = channels.get(s.channel);
        const reject = async (reason: TelemetryRejectionReason) => {
          rejected++;
          results.push({
            bootId: m.bootId,
            sequence: m.sequence,
            channel: s.channel,
            status: 'REJECTED',
            reasonCode: reason,
            sampleId: null,
            ingestionClass: null,
          });
          await c.query(
            `INSERT INTO telemetry_rejections (tenant_id, id, batch_id, device_id, channel_id, requested_channel_digest, boot_id,
                                               sequence, event_at, received_at, delivery, reason_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              ctx.tenantId,
              newDataId('telemetryRejection'),
              batchId,
              deviceId,
              channel ? channel.id : null,
              sha256Digest(s.channel),
              m.bootId,
              m.sequence,
              m.eventAt,
              input.receivedAt,
              batch.delivery,
              reason,
            ],
          );
          // A rejected *current* observation makes the channel's current state invalid.
          const current = cls.ok ? cls.ingestionClass === 'LIVE' : reason === 'FUTURE_EVENT_TIME';
          if (channel && current && INVALIDATING.has(reason)) {
            const at = reason === 'FUTURE_EVENT_TIME' ? input.receivedAt : m.eventAt;
            const e = effect(channel.id);
            if (!e.invalid || e.invalid.at <= at) e.invalid = { reason, at };
          }
        };

        if (!cls.ok) {
          await reject(cls.reasonCode);
          continue;
        }
        if (!channel) {
          await reject('CHANNEL_UNKNOWN');
          continue;
        }
        if (channel.status !== 'ACTIVE') {
          await reject('CHANNEL_RETIRED');
          continue;
        }
        const b = await resolveBinding();
        if (!b.ok) {
          await reject(b.reason);
          continue;
        }
        const rev = await c.query<{
          id: string;
          kind: ChannelKind;
          unit: string;
          source_unit: 'CELSIUS' | 'FAHRENHEIT' | 'KELVIN' | null;
          calibration_revision: number;
          calibration_offset_milli: number;
        }>(
          `SELECT id, kind, unit, source_unit, calibration_revision, calibration_offset_milli
             FROM sensor_channel_revisions
            WHERE tenant_id = $1 AND channel_id = $2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
            ORDER BY id FOR SHARE`,
          [ctx.tenantId, channel.id, m.eventAt],
        );
        if (rev.rows.length === 0) {
          await reject('CHANNEL_REVISION_MISSING');
          continue;
        }
        if (rev.rows.length > 1) {
          await reject('CHANNEL_REVISION_OVERLAPPING');
          continue;
        }
        const r = rev.rows[0]!;
        const n = normalizeSample(s.unit as WireUnit, s.valueInt, {
          kind: r.kind,
          unit: r.unit,
          sourceUnit: r.source_unit,
          calibrationOffsetMilli: r.calibration_offset_milli,
        });
        if (!n.ok) {
          await reject(n.reasonCode);
          continue;
        }
        const flags = [
          ...new Set([...(qualityFlagOf(s.quality) ? [qualityFlagOf(s.quality)!] : []), ...n.flags]),
        ].sort();
        const origin: InputOrigin =
          device.input_class === 'SIMULATOR' || s.label === 'SIMULATED_INPUT' ? 'SIMULATED_INPUT' : 'PHYSICAL_SENSOR';
        // Digest of the device's claim only (not of server-derived classification or receipt time).
        const sampleDigest = canonicalDigest('telemetry-sample', 1, {
          tenantId: ctx.tenantId,
          deviceId,
          channelId: channel.id,
          bootId: m.bootId,
          sequence: m.sequence,
          eventAt: m.eventAt,
          unit: s.unit,
          valueInt: s.valueInt,
          quality: s.quality,
          label: s.label ?? null,
        });
        const sampleId = newDataId('telemetrySample') as TelemetrySampleId;
        const ins = await c.query<{ id: TelemetrySampleId }>(
          `INSERT INTO telemetry_samples (tenant_id, id, batch_id, device_id, channel_id, channel_revision_id, calibration_revision,
                                          device_assignment_id, asset_id, asset_revision_id, boot_id, sequence, event_at, received_at,
                                          kind, unit, value_int, raw_value_int, source_unit, source_value_int, conversion, quality_flags,
                                          ingestion_class, lateness_ms, lateness_policy_version, lateness_policy_digest, delivery,
                                          input_origin, sample_digest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                   $24, $25, $26, $27, $28, $29)
           ON CONFLICT (tenant_id, channel_id, boot_id, sequence) DO NOTHING
           RETURNING id`,
          [
            ctx.tenantId,
            sampleId,
            batchId,
            deviceId,
            channel.id,
            r.id,
            r.calibration_revision,
            b.assignmentId,
            b.assetId,
            b.assetRevisionId,
            m.bootId,
            m.sequence,
            m.eventAt,
            input.receivedAt,
            r.kind,
            r.unit,
            n.valueInt,
            n.rawValueInt,
            s.unit,
            s.valueInt,
            n.conversion,
            flags,
            cls.ingestionClass,
            cls.latenessMs,
            lateness.policyVersion,
            latenessDigest,
            batch.delivery,
            origin,
            sampleDigest,
          ],
        );
        if (!ins.rows[0]) {
          const existing = await c.query<{
            id: TelemetrySampleId;
            sample_digest: string;
            ingestion_class: IngestionClass;
          }>(
            `SELECT id, sample_digest, ingestion_class FROM telemetry_samples
              WHERE tenant_id = $1 AND channel_id = $2 AND boot_id = $3 AND sequence = $4`,
            [ctx.tenantId, channel.id, m.bootId, m.sequence],
          );
          const row = existing.rows[0];
          if (row && row.sample_digest === sampleDigest) {
            duplicates++;
            results.push({
              bootId: m.bootId,
              sequence: m.sequence,
              channel: s.channel,
              status: 'DUPLICATE',
              reasonCode: null,
              sampleId: row.id,
              ingestionClass: row.ingestion_class,
            });
          } else await reject('DUPLICATE_CONFLICT');
          continue;
        }
        accepted++;
        acceptedTimes.push(m.eventAt);
        classCounts[cls.ingestionClass]++;
        origins.add(origin);
        acceptedChannels.add(channel.id);
        results.push({
          bootId: m.bootId,
          sequence: m.sequence,
          channel: s.channel,
          status: 'ACCEPTED',
          reasonCode: null,
          sampleId,
          ingestionClass: cls.ingestionClass,
        });
        const e = effect(channel.id);
        if (!e.lastReceivedAt || e.lastReceivedAt <= input.receivedAt) {
          e.lastReceivedAt = input.receivedAt;
          e.lastClass = cls.ingestionClass;
        }
        if (cls.ingestionClass === 'LIVE') {
          if (flags.length === 0) {
            if (!e.basis || e.basis.eventAt < m.eventAt)
              e.basis = { sampleId, eventAt: m.eventAt, receivedAt: input.receivedAt };
          } else {
            const reason = `QUALITY_${flags[0]}`;
            if (!e.invalid || e.invalid.at <= m.eventAt) e.invalid = { reason, at: m.eventAt };
          }
        }
      }
    }

    // ---- overflow disclosures (idempotent per device, boot and dropped range)
    let recorded = 0;
    let dupDisclosures = 0;
    for (const d of batch.disclosures) {
      const r = await c.query(
        `INSERT INTO telemetry_drop_disclosures (tenant_id, id, device_id, batch_id, boot_id, dropped_total, dropped_messages,
                                                 from_sequence, to_sequence, first_event_at, last_event_at, aggregates,
                                                 received_at, input_origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, device_id, boot_id, from_sequence, to_sequence) DO NOTHING`,
        [
          ctx.tenantId,
          newDataId('telemetryDropDisclosure'),
          deviceId,
          batchId,
          d.bootId,
          d.droppedTotal,
          d.droppedMessages,
          d.fromSequence,
          d.toSequence,
          d.firstEventAt,
          d.lastEventAt,
          JSON.stringify(d.aggregates),
          input.receivedAt,
          device.input_class === 'SIMULATOR' ? 'SIMULATED_INPUT' : 'PHYSICAL_SENSOR',
        ],
      );
      if (r.rowCount === 1) recorded++;
      else dupDisclosures++;
    }

    const eventTimes = batch.messages.map((m) => m.eventAt).sort();
    await c.query(
      `INSERT INTO telemetry_batches (tenant_id, id, device_id, delivery, received_at, signed_at, sent_at, message_count,
                                      sample_count, accepted_count, duplicate_count, rejected_count, disclosure_count,
                                      min_event_at, max_event_at, body_digest, firmware, battery_mv, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        ctx.tenantId,
        batchId,
        deviceId,
        batch.delivery,
        input.receivedAt,
        input.signedAt ?? input.receivedAt,
        batch.sentAt,
        batch.messages.length,
        sampleCount,
        accepted,
        duplicates,
        rejected,
        batch.disclosures.length,
        eventTimes[0],
        eventTimes.at(-1),
        input.bodyDigest,
        batch.firmware ?? null,
        batch.batteryMv ?? null,
        ctx.correlationId,
      ],
    );

    // ---- health projection (channels in a stable order; row locks after the device lock)
    for (const channelId of [...effects.keys()].sort())
      await applyHealth(c, ctx, deviceId, channelId, effects.get(channelId)!, receivedAtMs, freshness, device.status);

    if (accepted > 0) {
      const origin = origins.size === 1 ? [...origins][0]! : 'MIXED';
      acceptedTimes.sort();
      await appendOutboxEvent(c, ctx, {
        eventType: 'telemetry.accepted.v1',
        aggregateType: 'device',
        aggregateId: deviceId,
        aggregateVersion: await nextDeviceEventVersion(c, ctx.tenantId, deviceId, 'telemetry.accepted.v1'),
        payload: {
          deviceId,
          batchId,
          receivedAt: input.receivedAt,
          delivery: batch.delivery,
          acceptedCount: accepted,
          duplicateCount: duplicates,
          rejectedCount: rejected,
          classCounts,
          minEventAt: acceptedTimes[0]!,
          maxEventAt: acceptedTimes.at(-1)!,
          channelIds: [...acceptedChannels].sort().slice(0, 64),
          inputOrigin: origin,
        },
        correlationId: ctx.correlationId,
        causationId: newId('command'),
      });
    }

    return {
      batchId,
      receivedAt: input.receivedAt,
      accepted,
      duplicates,
      rejected,
      classCounts,
      disclosures: { recorded, duplicate: dupDisclosures },
      results,
    };
  });
}

async function nextDeviceEventVersion(c: Tx, tenantId: TenantId, deviceId: string, eventType: string): Promise<number> {
  const { rows } = await c.query<{ v: number }>(
    `SELECT coalesce(max(aggregate_version), 0)::int + 1 AS v FROM outbox_events
      WHERE tenant_id = $1 AND aggregate_type = 'device' AND aggregate_id = $2 AND event_type = $3`,
    [tenantId, deviceId, eventType],
  );
  return rows[0]!.v;
}

interface HealthRow {
  id: string;
  freshness: Freshness;
  status_reason: string;
  source_time: Date | null;
  receipt_time: Date | null;
  basis_sample_id: string | null;
  invalid_reason: string | null;
  invalid_at: Date | null;
  last_received_at: Date | null;
  last_ingestion_class: IngestionClass | null;
  freshness_threshold_ms: string;
  offline_threshold_ms: string;
  freshness_policy_version: string;
  freshness_policy_digest: string;
  version: number;
}

const policyOfRow = (
  r: Pick<HealthRow, 'freshness_policy_version' | 'freshness_threshold_ms' | 'offline_threshold_ms'>,
) =>
  FreshnessPolicySchema.parse({
    policyVersion: r.freshness_policy_version,
    staleAfterMs: Number(r.freshness_threshold_ms),
    offlineAfterMs: Number(r.offline_threshold_ms),
    maxFutureSkewMs: DEFAULT_FRESHNESS_POLICY.maxFutureSkewMs,
  });

const basisOfRow = (r: HealthRow | undefined, deviceRevoked: boolean, channelRetired: boolean) => ({
  sourceTime: r ? iso(r.source_time) : null,
  receiptTime: r ? iso(r.receipt_time) : null,
  invalidReason: r?.invalid_reason ?? null,
  invalidAt: r ? iso(r.invalid_at) : null,
  deviceRevoked,
  channelRetired,
});

/** Apply one batch's effects to a channel projection, re-evaluate at receipt time, persist, emit on worsening. */
async function applyHealth(
  c: Tx,
  ctx: TenantContext,
  deviceId: DeviceId,
  channelId: string,
  e: HealthEffect,
  nowMs: number,
  policy: FreshnessPolicy,
  deviceStatus: string,
): Promise<void> {
  const cur = await c.query<HealthRow>(
    `SELECT * FROM telemetry_channel_health WHERE tenant_id = $1 AND channel_id = $2 FOR UPDATE`,
    [ctx.tenantId, channelId],
  );
  const row = cur.rows[0];
  let sourceTime = row ? iso(row.source_time) : null;
  let receiptTime = row ? iso(row.receipt_time) : null;
  let basisSampleId = row?.basis_sample_id ?? null;
  let invalidReason = row?.invalid_reason ?? null;
  let invalidAt = row ? iso(row.invalid_at) : null;
  if (e.basis && (sourceTime === null || e.basis.eventAt > sourceTime)) {
    sourceTime = e.basis.eventAt as UtcInstant;
    receiptTime = e.basis.receivedAt as UtcInstant;
    basisSampleId = e.basis.sampleId;
  }
  if (e.invalid && (invalidAt === null || e.invalid.at >= invalidAt)) {
    invalidReason = e.invalid.reason;
    invalidAt = e.invalid.at as UtcInstant;
  }
  // A newer good LIVE sample clears an older invalidation.
  if (invalidAt !== null && sourceTime !== null && invalidAt < sourceTime) {
    invalidReason = null;
    invalidAt = null;
  }
  const view = evaluateFreshness(
    { sourceTime, receiptTime, invalidReason, invalidAt, deviceRevoked: deviceStatus === 'REVOKED' },
    nowMs,
    policy,
  );
  const lastReceivedAt = e.lastReceivedAt ?? (row ? iso(row.last_received_at) : null);
  const lastClass = e.lastClass ?? row?.last_ingestion_class ?? null;
  if (!row) {
    await c.query(
      `INSERT INTO telemetry_channel_health (tenant_id, id, device_id, channel_id, freshness, status_reason, source_time,
                                             receipt_time, basis_sample_id, invalid_reason, invalid_at, last_received_at,
                                             last_ingestion_class, freshness_threshold_ms, offline_threshold_ms,
                                             freshness_policy_version, freshness_policy_digest, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        ctx.tenantId,
        newDataId('telemetryChannelHealth'),
        deviceId,
        channelId,
        view.freshness,
        view.statusReason,
        sourceTime,
        receiptTime,
        basisSampleId,
        invalidReason,
        invalidAt,
        lastReceivedAt,
        lastClass,
        policy.staleAfterMs,
        policy.offlineAfterMs,
        policy.policyVersion,
        freshnessPolicyDigest(policy),
        view.evaluatedAt,
      ],
    );
  } else {
    await c.query(
      `UPDATE telemetry_channel_health
          SET freshness = $3, status_reason = $4, source_time = $5, receipt_time = $6, basis_sample_id = $7,
              invalid_reason = $8, invalid_at = $9, last_received_at = $10, last_ingestion_class = $11,
              freshness_threshold_ms = $12, offline_threshold_ms = $13, freshness_policy_version = $14,
              freshness_policy_digest = $15, evaluated_at = $16, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        row.id,
        view.freshness,
        view.statusReason,
        sourceTime,
        receiptTime,
        basisSampleId,
        invalidReason,
        invalidAt,
        lastReceivedAt,
        lastClass,
        policy.staleAfterMs,
        policy.offlineAfterMs,
        policy.policyVersion,
        freshnessPolicyDigest(policy),
        view.evaluatedAt,
      ],
    );
  }
  const previous: Freshness = row ? row.freshness : 'FRESH';
  if (row && freshnessSeverity(view.freshness) > freshnessSeverity(previous))
    await emitStale(c, ctx, deviceId, channelId, previous, view);
  if (!row && view.freshness === 'INVALID') await emitStale(c, ctx, deviceId, channelId, 'OFFLINE', view);
}

async function emitStale(
  c: Tx,
  ctx: TenantContext,
  deviceId: string,
  channelId: string,
  previous: Freshness,
  view: FreshnessView,
): Promise<void> {
  if (view.freshness === 'FRESH') return;
  await appendOutboxEvent(c, ctx, {
    eventType: 'telemetry.stale.v1',
    aggregateType: 'device',
    aggregateId: deviceId,
    aggregateVersion: await nextDeviceEventVersion(c, ctx.tenantId, deviceId, 'telemetry.stale.v1'),
    payload: {
      deviceId,
      channelId,
      previousFreshness: previous,
      freshness: view.freshness,
      statusReason: view.statusReason,
      sourceTime: view.sourceTime,
      receiptTime: view.receiptTime,
      freshnessThresholdMs: view.freshnessThresholdMs,
      offlineThresholdMs: view.offlineThresholdMs,
      evaluatedAt: view.evaluatedAt,
      freshnessPolicyVersion: view.freshnessPolicyVersion,
    },
    correlationId: ctx.correlationId,
    causationId: newId('command'),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Request signature verification (the credential key never leaves this package)

/**
 * Verify the HMAC body signature for the authenticated device (gateway boundary). A failure is audited in the
 * device's tenant with its reason; the device credential is resolved through the CredentialResolver port.
 */
export async function verifyDeviceBodySignature(
  pool: Db,
  ctx: TenantContext,
  resolver: CredentialResolver,
  input: { timestampMs: number; body: Uint8Array; signature: string | undefined; nowMs: number; maxSkewMs: number },
): Promise<SignatureVerdict | { ok: false; reasonCode: 'SIGNATURE_MISSING' | 'CREDENTIAL_UNAVAILABLE' }> {
  assertTenantContext(ctx);
  const p = ctx.principal;
  const deny = async (reasonCode: string) => {
    await recordAudit(pool, ctx, {
      action: 'telemetry.ingest',
      resourceType: 'device',
      resourceId: p.id,
      result: 'DENIED',
      reasonCode,
    });
  };
  if (p.kind !== 'DEVICE') {
    await deny('PRINCIPAL_KIND_NOT_PERMITTED');
    return { ok: false, reasonCode: 'SIGNATURE_INVALID' };
  }
  if (input.signature === undefined || input.signature === '') {
    await deny('SIGNATURE_MISSING');
    return { ok: false, reasonCode: 'SIGNATURE_MISSING' };
  }
  const { rows } = await pool.query<{ credential_ref: string }>(
    `SELECT credential_ref FROM devices WHERE tenant_id = $1 AND id = $2 AND status <> 'REVOKED'`,
    [ctx.tenantId, p.id],
  );
  const key = rows[0] ? await resolver.resolveSigningKey(rows[0].credential_ref) : undefined;
  if (!key || key.byteLength < 32) {
    await deny('CREDENTIAL_UNAVAILABLE');
    return { ok: false, reasonCode: 'CREDENTIAL_UNAVAILABLE' };
  }
  const verdict = verifyTelemetryBody({
    key,
    timestampMs: input.timestampMs,
    deviceId: p.id,
    body: input.body,
    signature: input.signature,
    nowMs: input.nowMs,
    maxSkewMs: input.maxSkewMs,
  });
  if (!verdict.ok) await deny(verdict.reasonCode === 'SIGNATURE_MALFORMED' ? 'SIGNATURE_INVALID' : verdict.reasonCode);
  return verdict;
}

// ---------------------------------------------------------------------------------------------------------------
// Reads (telemetry.read at the device's site; foreign and missing ids are indistinguishable)

/**
 * Freshness is evaluated at the later of the requested time and the server clock: a caller may look ahead (tests,
 * simulations) but can never rewind the clock to make stale telemetry read or persist as FRESH (INV-11).
 */
function evaluationTime(requested: string | undefined): number {
  const server = Date.now();
  return requested === undefined ? server : Math.max(Date.parse(requested), server);
}

async function requireTelemetryReadable(c: Tx, ctx: TenantContext, deviceId: string, meta: CommandMeta) {
  if (!DeviceIdSchema.safeParse(deviceId).success) throw unavailable(meta);
  const { rows } = await c.query<{ site_id: SiteId; status: string }>(
    `SELECT site_id, status FROM devices WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, deviceId],
  );
  if (!rows[0]) throw unavailable(meta);
  const d = authorize(ctx, { action: 'telemetry.read', siteId: rows[0].site_id });
  if (!d.allowed)
    throw new Denial(resourceUnavailable(), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      reasonCode: d.reasonCode,
    });
  return rows[0];
}

export interface ChannelHealthView extends FreshnessView {
  channelId: SensorChannelId;
  basisSampleId: TelemetrySampleId | null;
  lastReceivedAt: UtcInstant | null;
  lastIngestionClass: IngestionClass | null;
  invalidReason: string | null;
  storedFreshness: Freshness | null;
}

export interface DeviceHealthView extends FreshnessView {
  deviceId: DeviceId;
  siteId: SiteId;
  channels: ChannelHealthView[];
}

/**
 * Health of a device and each of its channels, re-evaluated at `now` (default: system time) from the stored basis
 * and the policy pinned on each projection. Never healthy unless FRESH; always carries source time, receipt time,
 * freshness threshold and status reason (INV-11).
 */
export async function getDeviceHealth(
  pool: Db,
  ctx: TenantContext,
  deviceId: DeviceId,
  opts: { now?: string } = {},
): Promise<DeviceHealthView> {
  if (opts.now !== undefined && !UtcInstantSchema.safeParse(opts.now).success) throw validation('NOW_INVALID');
  const nowMs = evaluationTime(opts.now);
  const meta = { action: 'telemetry.health.read', resourceType: 'device', resourceId: deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const dev = await requireTelemetryReadable(c, ctx, deviceId, meta);
    const { rows } = await c.query<HealthRow & { channel_id: SensorChannelId; channel_status: string }>(
      `SELECT h.*, s.id AS channel_id, s.status AS channel_status
         FROM sensor_channels s
         LEFT JOIN telemetry_channel_health h ON h.tenant_id = s.tenant_id AND h.channel_id = s.id
        WHERE s.tenant_id = $1 AND s.device_id = $2 ORDER BY s.id`,
      [ctx.tenantId, deviceId],
    );
    const revoked = dev.status === 'REVOKED';
    const channels: ChannelHealthView[] = rows.map((r) => {
      const has = r.id !== null;
      const policy = has ? policyOfRow(r) : DEFAULT_FRESHNESS_POLICY;
      const v = evaluateFreshness(
        basisOfRow(has ? r : undefined, revoked, r.channel_status !== 'ACTIVE'),
        nowMs,
        policy,
      );
      return {
        ...v,
        channelId: r.channel_id,
        basisSampleId: has ? (r.basis_sample_id as TelemetrySampleId | null) : null,
        lastReceivedAt: has ? iso(r.last_received_at) : null,
        lastIngestionClass: has ? r.last_ingestion_class : null,
        invalidReason: has ? r.invalid_reason : null,
        storedFreshness: has ? r.freshness : null,
      };
    });
    const policy = channels.length > 0 && rows[0]!.id !== null ? policyOfRow(rows[0]!) : DEFAULT_FRESHNESS_POLICY;
    const roll = rollupFreshness(channels, policy);
    const device = revoked
      ? evaluateFreshness({ ...basisOfRow(undefined, true, false) }, nowMs, policy)
      : { ...roll, evaluatedAt: new Date(nowMs).toISOString() };
    return { ...device, deviceId, siteId: dev.site_id, channels };
  });
}

export interface TelemetrySampleRecord {
  sampleId: TelemetrySampleId;
  batchId: TelemetryBatchId;
  deviceId: DeviceId;
  channelId: SensorChannelId;
  channelRevisionId: string;
  calibrationRevision: number;
  deviceAssignmentId: string;
  assetId: string;
  assetRevisionId: string;
  bootId: string;
  sequence: number;
  eventAt: UtcInstant;
  receivedAt: UtcInstant;
  kind: ChannelKind;
  unit: string;
  valueInt: number;
  rawValueInt: number;
  sourceUnit: WireUnit;
  sourceValueInt: number;
  conversion: 'EXACT' | 'ROUNDED_HALF_EVEN';
  qualityFlags: QualityFlag[];
  ingestionClass: IngestionClass;
  latenessMs: number;
  latenessPolicyVersion: string;
  latenessPolicyDigest: string;
  delivery: 'LIVE' | 'BACKFILL';
  inputOrigin: InputOrigin;
  sampleDigest: string;
}

const MAX_SAMPLE_PAGE = 5_000;

/** Samples of one channel by source time (keyset cursor `after`), optionally filtered by ingestion class. */
export async function listTelemetrySamples(
  pool: Db,
  ctx: TenantContext,
  filter: {
    channelId: SensorChannelId;
    fromEventAt?: string;
    toEventAt?: string;
    ingestionClasses?: readonly IngestionClass[];
    after?: { eventAt: string; sampleId: string };
    limit?: number;
  },
): Promise<TelemetrySampleRecord[]> {
  const limit = filter.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SAMPLE_PAGE) throw validation('LIMIT_OUT_OF_RANGE');
  const classes = filter.ingestionClasses ? [...filter.ingestionClasses] : null;
  for (const t of [filter.fromEventAt, filter.toEventAt, filter.after?.eventAt])
    if (t !== undefined && !UtcInstantSchema.safeParse(t).success) throw validation('TIME_FILTER_INVALID');
  if (classes && !classes.every((k) => k === 'LIVE' || k === 'LATE' || k === 'BACKFILL'))
    throw validation('INGESTION_CLASS_INVALID');
  const meta = { action: 'telemetry.samples.read', resourceType: 'sensor_channel', resourceId: filter.channelId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!/^chn_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(filter.channelId)) throw unavailable(meta);
    const ch = await c.query<{ device_id: string }>(
      `SELECT device_id FROM sensor_channels WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, filter.channelId],
    );
    if (!ch.rows[0]) throw unavailable(meta);
    await requireTelemetryReadable(c, ctx, ch.rows[0].device_id, meta);
    const { rows } = await c.query(
      `SELECT * FROM telemetry_samples
        WHERE tenant_id = $1 AND channel_id = $2
          AND ($3::timestamptz IS NULL OR event_at >= $3) AND ($4::timestamptz IS NULL OR event_at <= $4)
          AND ($5::text[] IS NULL OR ingestion_class = ANY($5))
          AND ($6::timestamptz IS NULL OR (event_at, id) > ($6, $7))
        ORDER BY event_at, id LIMIT $8`,
      [
        ctx.tenantId,
        filter.channelId,
        filter.fromEventAt ?? null,
        filter.toEventAt ?? null,
        classes,
        filter.after?.eventAt ?? null,
        filter.after?.sampleId ?? null,
        limit,
      ],
    );
    return rows.map(toSampleRecord);
  });
}

function toSampleRecord(r: Record<string, unknown>): TelemetrySampleRecord {
  return {
    sampleId: r.id as TelemetrySampleId,
    batchId: r.batch_id as TelemetryBatchId,
    deviceId: r.device_id as DeviceId,
    channelId: r.channel_id as SensorChannelId,
    channelRevisionId: r.channel_revision_id as string,
    calibrationRevision: r.calibration_revision as number,
    deviceAssignmentId: r.device_assignment_id as string,
    assetId: r.asset_id as string,
    assetRevisionId: r.asset_revision_id as string,
    bootId: r.boot_id as string,
    sequence: Number(r.sequence),
    eventAt: isoNN(r.event_at as Date),
    receivedAt: isoNN(r.received_at as Date),
    kind: r.kind as ChannelKind,
    unit: r.unit as string,
    valueInt: Number(r.value_int),
    rawValueInt: Number(r.raw_value_int),
    sourceUnit: r.source_unit as WireUnit,
    sourceValueInt: Number(r.source_value_int),
    conversion: r.conversion as 'EXACT' | 'ROUNDED_HALF_EVEN',
    qualityFlags: r.quality_flags as QualityFlag[],
    ingestionClass: r.ingestion_class as IngestionClass,
    latenessMs: Number(r.lateness_ms),
    latenessPolicyVersion: r.lateness_policy_version as string,
    latenessPolicyDigest: r.lateness_policy_digest as string,
    delivery: r.delivery as 'LIVE' | 'BACKFILL',
    inputOrigin: r.input_origin as InputOrigin,
    sampleDigest: r.sample_digest as string,
  };
}

export interface SequenceGapRecord {
  gapId: string;
  bootId: string;
  fromSequence: number;
  toSequence: number;
  detectedAt: UtcInstant;
  /** Sub-ranges still never received (inclusive). */
  outstanding: [number, number][];
  /** Every outstanding range is covered by an edge overflow disclosure. */
  disclosed: boolean;
}

const MAX_GAPS = 1_000;

export async function listSequenceGaps(pool: Db, ctx: TenantContext, deviceId: DeviceId): Promise<SequenceGapRecord[]> {
  const meta = { action: 'telemetry.gaps.read', resourceType: 'device', resourceId: deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    await requireTelemetryReadable(c, ctx, deviceId, meta);
    const gaps = await c.query(
      `SELECT * FROM telemetry_sequence_gaps WHERE tenant_id = $1 AND device_id = $2
        ORDER BY detected_at DESC, boot_id, from_sequence LIMIT $3`,
      [ctx.tenantId, deviceId, MAX_GAPS],
    );
    const out: SequenceGapRecord[] = [];
    for (const g of gaps.rows) {
      const from = Number(g.from_sequence);
      const to = Number(g.to_sequence);
      const seen = await c.query<{ s: string }>(
        `SELECT DISTINCT sequence AS s FROM (
           SELECT sequence FROM telemetry_samples WHERE tenant_id = $1 AND device_id = $2 AND boot_id = $3 AND sequence BETWEEN $4 AND $5
           UNION ALL
           SELECT sequence FROM telemetry_rejections WHERE tenant_id = $1 AND device_id = $2 AND boot_id = $3 AND sequence BETWEEN $4 AND $5) x
          ORDER BY 1`,
        [ctx.tenantId, deviceId, g.boot_id, from, to],
      );
      const outstanding: [number, number][] = [];
      let cursor = from;
      for (const { s } of seen.rows) {
        const n = Number(s);
        if (n > cursor) outstanding.push([cursor, n - 1]);
        cursor = n + 1;
      }
      if (cursor <= to) outstanding.push([cursor, to]);
      const disc = await c.query<{ f: string; t: string }>(
        `SELECT from_sequence AS f, to_sequence AS t FROM telemetry_drop_disclosures
          WHERE tenant_id = $1 AND device_id = $2 AND boot_id = $3 AND to_sequence >= $4 AND from_sequence <= $5`,
        [ctx.tenantId, deviceId, g.boot_id, from, to],
      );
      const ranges = disc.rows.map((d) => [Number(d.f), Number(d.t)] as const);
      const covered = (lo: number, hi: number) => {
        let at = lo;
        for (const [f, t] of [...ranges].sort((a, b) => a[0] - b[0])) {
          if (f > at) break;
          if (t >= at) at = t + 1;
          if (at > hi) return true;
        }
        return at > hi;
      };
      out.push({
        gapId: g.id,
        bootId: g.boot_id,
        fromSequence: from,
        toSequence: to,
        detectedAt: isoNN(g.detected_at),
        outstanding,
        disclosed: outstanding.every(([lo, hi]) => covered(lo, hi)),
      });
    }
    return out.sort((a, b) => (a.bootId === b.bootId ? a.fromSequence - b.fromSequence : a.bootId < b.bootId ? -1 : 1));
  });
}

export interface DropDisclosureRecord {
  disclosureId: string;
  batchId: TelemetryBatchId;
  bootId: string;
  droppedTotal: number;
  droppedMessages: number;
  fromSequence: number;
  toSequence: number;
  firstEventAt: UtcInstant;
  lastEventAt: UtcInstant;
  aggregates: OverflowAggregate[];
  receivedAt: UtcInstant;
  inputOrigin: InputOrigin;
}

export async function listDropDisclosures(
  pool: Db,
  ctx: TenantContext,
  deviceId: DeviceId,
): Promise<DropDisclosureRecord[]> {
  const meta = { action: 'telemetry.disclosures.read', resourceType: 'device', resourceId: deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    await requireTelemetryReadable(c, ctx, deviceId, meta);
    const { rows } = await c.query(
      `SELECT * FROM telemetry_drop_disclosures WHERE tenant_id = $1 AND device_id = $2
        ORDER BY boot_id, from_sequence LIMIT 1000`,
      [ctx.tenantId, deviceId],
    );
    return rows.map((r) => ({
      disclosureId: r.id,
      batchId: r.batch_id,
      bootId: r.boot_id,
      droppedTotal: Number(r.dropped_total),
      droppedMessages: Number(r.dropped_messages),
      fromSequence: Number(r.from_sequence),
      toSequence: Number(r.to_sequence),
      firstEventAt: isoNN(r.first_event_at),
      lastEventAt: isoNN(r.last_event_at),
      aggregates: r.aggregates,
      receivedAt: isoNN(r.received_at),
      inputOrigin: r.input_origin,
    }));
  });
}

export interface TelemetryRejectionRecord {
  rejectionId: string;
  batchId: TelemetryBatchId;
  channelId: SensorChannelId | null;
  bootId: string;
  sequence: number;
  eventAt: UtcInstant;
  receivedAt: UtcInstant;
  delivery: 'LIVE' | 'BACKFILL';
  reasonCode: TelemetryRejectionReason;
}

export async function listTelemetryRejections(
  pool: Db,
  ctx: TenantContext,
  deviceId: DeviceId,
): Promise<TelemetryRejectionRecord[]> {
  const meta = { action: 'telemetry.rejections.read', resourceType: 'device', resourceId: deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    await requireTelemetryReadable(c, ctx, deviceId, meta);
    const { rows } = await c.query(
      `SELECT * FROM telemetry_rejections WHERE tenant_id = $1 AND device_id = $2
        ORDER BY received_at, boot_id, sequence, id LIMIT 1000`,
      [ctx.tenantId, deviceId],
    );
    return rows.map((r) => ({
      rejectionId: r.id,
      batchId: r.batch_id,
      channelId: r.channel_id,
      bootId: r.boot_id,
      sequence: Number(r.sequence),
      eventAt: isoNN(r.event_at),
      receivedAt: isoNN(r.received_at),
      delivery: r.delivery,
      reasonCode: r.reason_code,
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness sweeper (platform worker; each row keeps its own tenant)

export interface FreshnessTransition {
  tenantId: TenantId;
  deviceId: DeviceId;
  channelId: SensorChannelId;
  from: Freshness;
  to: Freshness;
  statusReason: string;
}

/**
 * Re-evaluate projections that can worsen with time (FRESH, STALE) or whose device was revoked, persist changes
 * and emit `telemetry.stale.v1` for every worsening. Each row is handled in its own transaction under the same
 * device lock ingestion takes, with a worker context bound to the row's tenant.
 */
export async function sweepTelemetryFreshness(
  pool: Db,
  opts: { now: string; limit?: number; workerId?: string },
): Promise<{ evaluated: number; transitions: FreshnessTransition[] }> {
  if (!UtcInstantSchema.safeParse(opts.now).success) throw validation('NOW_INVALID');
  const nowMs = evaluationTime(opts.now);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5_000);
  const candidates = await pool.query<{ tenant_id: TenantId; device_id: DeviceId; channel_id: SensorChannelId }>(
    `SELECT h.tenant_id, h.device_id, h.channel_id
       FROM telemetry_channel_health h
       JOIN devices d ON d.tenant_id = h.tenant_id AND d.id = h.device_id
       JOIN sensor_channels s ON s.tenant_id = h.tenant_id AND s.id = h.channel_id
      WHERE h.freshness IN ('FRESH', 'STALE')
         OR ((d.status = 'REVOKED' OR s.status <> 'ACTIVE') AND h.freshness <> 'INVALID')
      ORDER BY h.source_time NULLS FIRST, h.tenant_id, h.channel_id
      LIMIT $1`,
    [limit],
  );
  const transitions: FreshnessTransition[] = [];
  for (const cand of candidates.rows) {
    const ctx = issueWorkerContext(cand.tenant_id, {
      kind: 'WORKER',
      id: opts.workerId ?? 'telemetry-freshness-sweeper',
      source: 'JOB',
      sourceId: cand.channel_id,
    });
    const t = await withTenantTransaction(pool, ctx, async (c) => {
      await lockKey(c, `telemetry:${cand.tenant_id}:${cand.device_id}`);
      const { rows } = await c.query<HealthRow & { device_status: string; channel_status: string }>(
        `SELECT h.*, d.status AS device_status, s.status AS channel_status
           FROM telemetry_channel_health h
           JOIN devices d ON d.tenant_id = h.tenant_id AND d.id = h.device_id
           JOIN sensor_channels s ON s.tenant_id = h.tenant_id AND s.id = h.channel_id
          WHERE h.tenant_id = $1 AND h.channel_id = $2 FOR UPDATE OF h`,
        [cand.tenant_id, cand.channel_id],
      );
      const row = rows[0];
      if (!row) return null;
      const view = evaluateFreshness(
        basisOfRow(row, row.device_status === 'REVOKED', row.channel_status !== 'ACTIVE'),
        nowMs,
        policyOfRow(row),
      );
      if (view.freshness === row.freshness && view.statusReason === row.status_reason) return null;
      await c.query(
        `UPDATE telemetry_channel_health SET freshness = $3, status_reason = $4, evaluated_at = $5, version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [cand.tenant_id, row.id, view.freshness, view.statusReason, view.evaluatedAt],
      );
      if (freshnessSeverity(view.freshness) > freshnessSeverity(row.freshness))
        await emitStale(c, ctx, cand.device_id, cand.channel_id, row.freshness, view);
      return {
        tenantId: cand.tenant_id,
        deviceId: cand.device_id,
        channelId: cand.channel_id,
        from: row.freshness,
        to: view.freshness,
        statusReason: view.statusReason,
      } satisfies FreshnessTransition;
    }).catch((e: unknown) => {
      // A row whose basis was concurrently replaced fails its CHECK/guard; it is re-evaluated on the next sweep.
      if (pgCode(e) === '23514' || pgCode(e) === 'UB031') return null;
      throw e;
    });
    if (t) transitions.push(t);
  }
  return { evaluated: candidates.rows.length, transitions };
}
