// Device telemetry wire contract (HARDWARE-IOT §3, API-EVENT-SPEC POST /v1/device/telemetry:batch).
// The batch is strict: asset, tenant, assignment, revision and ingestion-class claims are not part of the contract,
// so the gateway can only derive them from the authenticated device identity and the registry. Every collection,
// string and number is bounded (NFR-04).
import { UtcInstantSchema } from '@uptimebuyer/contracts';
import { z } from 'zod';

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Hard request bounds enforced by the gateway before and during decoding. */
export const TELEMETRY_LIMITS = Object.freeze({
  maxBodyBytes: 256 * 1024,
  maxMessagesPerBatch: 200,
  maxSamplesPerMessage: 16,
  maxDisclosuresPerBatch: 16,
  maxAggregatesPerDisclosure: 16,
  /** Bound on |gateway clock - signing timestamp|. */
  maxSkewMs: 300_000,
});

/** Integer wire units: milli-degrees in the channel's source scale, milli-amperes, milli-watts, booleans, none. */
export const WIRE_UNITS = Object.freeze(['mC', 'mF', 'mK', 'mA', 'mW', 'bool', 'none'] as const);
export type WireUnit = (typeof WIRE_UNITS)[number];

export const QUALITY_FLAGS = Object.freeze(['UNCALIBRATED', 'OUT_OF_RANGE', 'SENSOR_FAULT'] as const);
export type QualityFlag = (typeof QUALITY_FLAGS)[number];
/** Device-reported quality. GOOD carries no flag; anything else maps to exactly one quality flag. */
export const DEVICE_QUALITIES = Object.freeze(['GOOD', ...QUALITY_FLAGS] as const);
export type DeviceQuality = (typeof DEVICE_QUALITIES)[number];

export const DELIVERY_MODES = Object.freeze(['LIVE', 'BACKFILL'] as const);
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const INGESTION_CLASSES = Object.freeze(['LIVE', 'LATE', 'BACKFILL'] as const);
export type IngestionClass = (typeof INGESTION_CLASSES)[number];

export const INPUT_ORIGINS = Object.freeze(['PHYSICAL_SENSOR', 'SIMULATED_INPUT'] as const);
export type InputOrigin = (typeof INPUT_ORIGINS)[number];
export const SIMULATED_INPUT = 'SIMULATED_INPUT' as const;

const BODY = '[A-Za-z0-9][A-Za-z0-9-]{3,63}';
export const BootIdSchema = z.string().regex(new RegExp(`^boot_${BODY}$`));
export const ChannelRefSchema = z.string().regex(new RegExp(`^chn_${BODY}$`));
export const DeviceRefSchema = z.string().regex(new RegExp(`^dev_${BODY}$`));
export const SequenceSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Integer value bound: comfortably inside int64 and exact in JavaScript. */
const ValueIntSchema = z.int().min(-1_000_000_000_000).max(1_000_000_000_000);

export const TelemetrySampleSchema = z.strictObject({
  channel: ChannelRefSchema,
  valueInt: ValueIntSchema,
  unit: z.enum(WIRE_UNITS),
  quality: z.enum(DEVICE_QUALITIES).default('GOOD'),
  /** The only label a device may assert; it can only downgrade a sample to simulated input. */
  label: z.literal(SIMULATED_INPUT).optional(),
});
export type TelemetrySample = z.input<typeof TelemetrySampleSchema>;

export const DeviceMessageSchema = z.strictObject({
  bootId: BootIdSchema,
  sequence: SequenceSchema,
  eventAt: UtcInstantSchema,
  samples: z.array(TelemetrySampleSchema).min(1).max(TELEMETRY_LIMITS.maxSamplesPerMessage),
});
export type DeviceMessage = z.input<typeof DeviceMessageSchema>;
export type DecodedDeviceMessage = z.output<typeof DeviceMessageSchema>;

export const OverflowAggregateSchema = z.strictObject({
  channel: ChannelRefSchema,
  unit: z.enum(WIRE_UNITS),
  count: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  min: ValueIntSchema,
  max: ValueIntSchema,
  /** Exact integer sum as a decimal string (it may exceed 2^53). */
  sum: z.string().regex(/^-?(0|[1-9][0-9]{0,30})$/),
});
export type OverflowAggregate = z.output<typeof OverflowAggregateSchema>;

/** Explicit disclosure of messages the edge buffer evicted on overflow (HARDWARE-IOT §5). */
export const DropDisclosureSchema = z
  .strictObject({
    bootId: BootIdSchema,
    /** Cumulative dropped-message counter for this boot. */
    droppedTotal: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Messages covered by this disclosure. */
    droppedMessages: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    fromSequence: SequenceSchema,
    toSequence: SequenceSchema,
    firstEventAt: UtcInstantSchema,
    lastEventAt: UtcInstantSchema,
    aggregates: z.array(OverflowAggregateSchema).max(TELEMETRY_LIMITS.maxAggregatesPerDisclosure),
  })
  .refine((d) => d.fromSequence <= d.toSequence, { path: ['toSequence'], message: 'Sequence range is inverted.' })
  .refine((d) => d.droppedMessages <= d.droppedTotal, { path: ['droppedMessages'], message: 'Exceeds the total.' })
  .refine((d) => d.firstEventAt <= d.lastEventAt, { path: ['lastEventAt'], message: 'Time range is inverted.' });
export type DropDisclosure = z.output<typeof DropDisclosureSchema>;

export const TelemetryBatchSchema = z.strictObject({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  deviceId: DeviceRefSchema,
  /** How the device delivers these messages: LIVE as recorded, or BACKFILL from its offline buffer. */
  delivery: z.enum(DELIVERY_MODES),
  sentAt: UtcInstantSchema,
  messages: z.array(DeviceMessageSchema).min(1).max(TELEMETRY_LIMITS.maxMessagesPerBatch),
  disclosures: z.array(DropDisclosureSchema).max(TELEMETRY_LIMITS.maxDisclosuresPerBatch).default([]),
  firmware: z
    .string()
    .regex(/^[A-Za-z0-9._:+-]{1,128}$/)
    .optional(),
  batteryMv: z.int().min(0).max(100_000).optional(),
});
export type TelemetryBatch = z.output<typeof TelemetryBatchSchema>;
export type TelemetryBatchInput = z.input<typeof TelemetryBatchSchema>;

export type DecodeResult =
  | { ok: true; batch: TelemetryBatch }
  | {
      ok: false;
      reasonCode: 'BODY_TOO_LARGE' | 'BODY_NOT_JSON' | 'SCHEMA_INVALID' | 'DUPLICATE_SEQUENCE_IN_BATCH';
      fieldErrors?: { path: string; issue: string }[];
    };

/** Decode raw request bytes: size bound first, then JSON, then the strict schema, then in-batch uniqueness. */
export function decodeTelemetryBatch(body: Uint8Array): DecodeResult {
  if (body.byteLength > TELEMETRY_LIMITS.maxBodyBytes) return { ok: false, reasonCode: 'BODY_TOO_LARGE' };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'));
  } catch {
    return { ok: false, reasonCode: 'BODY_NOT_JSON' };
  }
  const r = TelemetryBatchSchema.safeParse(json);
  if (!r.success)
    return {
      ok: false,
      reasonCode: 'SCHEMA_INVALID',
      fieldErrors: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 256), issue: i.code })),
    };
  const seen = new Set<string>();
  for (const m of r.data.messages) {
    const key = `${m.bootId}\u0000${m.sequence}`;
    if (seen.has(key)) return { ok: false, reasonCode: 'DUPLICATE_SEQUENCE_IN_BATCH' };
    seen.add(key);
  }
  return { ok: true, batch: r.data };
}
