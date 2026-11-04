// Typed payloads for the telemetry events of API-EVENT-SPEC §6 (emitted by @uptimebuyer/data through the outbox;
// consumed by M04 incident detection). Both are device-aggregate events with their own per-device version sequence.
import { DeviceIdSchema, UtcInstantSchema, defineDomainEvent } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { FRESHNESS_STATES } from './policy.js';
import { ChannelRefSchema, INPUT_ORIGINS } from './protocol.js';

const Count = z.int().min(0).max(1_000_000);
const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

/** `telemetry.accepted.v1`: authenticated samples persisted for one batch. */
export const TelemetryAcceptedPayloadSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  batchId: z.string().regex(/^tbt_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  receivedAt: UtcInstantSchema,
  delivery: z.enum(['LIVE', 'BACKFILL']),
  acceptedCount: Count,
  duplicateCount: Count,
  rejectedCount: Count,
  classCounts: z.strictObject({ LIVE: Count, LATE: Count, BACKFILL: Count }),
  minEventAt: UtcInstantSchema,
  maxEventAt: UtcInstantSchema,
  channelIds: z.array(ChannelRefSchema).min(1).max(64),
  inputOrigin: z.enum([...INPUT_ORIGINS, 'MIXED']),
});
export type TelemetryAcceptedPayload = z.output<typeof TelemetryAcceptedPayloadSchema>;
export const TelemetryAcceptedEventSchema = defineDomainEvent(
  'telemetry.accepted.v1',
  TelemetryAcceptedPayloadSchema,
  'deviceId',
);

/** `telemetry.stale.v1`: a channel's projection worsened from FRESH (or a better state) to STALE/OFFLINE/INVALID. */
export const TelemetryStalePayloadSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  channelId: ChannelRefSchema,
  previousFreshness: z.enum(FRESHNESS_STATES),
  freshness: z.enum(['STALE', 'OFFLINE', 'INVALID']),
  statusReason: ReasonCode,
  sourceTime: UtcInstantSchema.nullable(),
  receiptTime: UtcInstantSchema.nullable(),
  freshnessThresholdMs: z.int().min(1),
  offlineThresholdMs: z.int().min(1),
  evaluatedAt: UtcInstantSchema,
  freshnessPolicyVersion: z.string().regex(/^telemetry-freshness\.v[1-9][0-9]*$/),
});
export type TelemetryStalePayload = z.output<typeof TelemetryStalePayloadSchema>;
export const TelemetryStaleEventSchema = defineDomainEvent(
  'telemetry.stale.v1',
  TelemetryStalePayloadSchema,
  'deviceId',
);
