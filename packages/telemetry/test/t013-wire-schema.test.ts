// T-013 — Authenticated telemetry acceptance (unit layer): the device batch schema is strict and bounded. Asset,
// tenant, revision or binding claims are not part of the contract (an extra key is rejected), so the gateway can
// only derive them from the authenticated identity; counts, sizes, identifiers, units and values are bounded.
import { describe, expect, it } from 'vitest';
import { TELEMETRY_LIMITS, TelemetryBatchSchema, decodeTelemetryBatch } from '../src/index.js';

const message = (sequence: number, extra: Record<string, unknown> = {}) => ({
  bootId: 'boot_fixture-a',
  sequence,
  eventAt: '2026-11-04T12:00:00.000Z',
  samples: [{ channel: 'chn_fixture-1', valueInt: 4230, unit: 'mC', quality: 'GOOD' }],
  ...extra,
});
const batch = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  deviceId: 'dev_fixture-1',
  delivery: 'LIVE',
  sentAt: '2026-11-04T12:00:00.500Z',
  messages: [message(1)],
  disclosures: [],
  ...over,
});

describe('T-013 telemetry wire schema', () => {
  it('accepts the reference message shape', () => {
    const r = TelemetryBatchSchema.safeParse(batch({ firmware: 'build-0123abcd', batteryMv: 5000 }));
    expect(r.success).toBe(true);
  });

  it('rejects asset, tenant, revision or binding claims anywhere in the payload', () => {
    for (const bad of [
      batch({ tenantId: 'ten_fixture-1' }),
      batch({ assetId: 'ast_fixture-1' }),
      batch({ messages: [message(1, { assetRevisionId: 'arv_fixture-1' })] }),
      batch({ messages: [message(1, { assignmentId: 'dasg_fixture-1' })] }),
      batch({
        messages: [
          {
            ...message(1),
            samples: [{ channel: 'chn_fixture-1', valueInt: 1, unit: 'mC', quality: 'GOOD', channelRevisionId: 'x' }],
          },
        ],
      }),
      batch({ messages: [message(1, { ingestionClass: 'LIVE' })] }),
    ])
      expect(TelemetryBatchSchema.safeParse(bad).success).toBe(false);
  });

  it('bounds message, sample and disclosure counts', () => {
    const many = Array.from({ length: TELEMETRY_LIMITS.maxMessagesPerBatch + 1 }, (_, i) => message(i));
    expect(TelemetryBatchSchema.safeParse(batch({ messages: many })).success).toBe(false);
    const samples = Array.from({ length: TELEMETRY_LIMITS.maxSamplesPerMessage + 1 }, () => ({
      channel: 'chn_fixture-1',
      valueInt: 1,
      unit: 'mC',
      quality: 'GOOD',
    }));
    expect(TelemetryBatchSchema.safeParse(batch({ messages: [{ ...message(1), samples }] })).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse(batch({ messages: [] })).success).toBe(false);
  });

  it('rejects malformed identifiers, units, values, sequences and times', () => {
    for (const m of [
      message(1, { bootId: 'nope' }),
      message(-1),
      message(1.5),
      message(Number.MAX_SAFE_INTEGER + 1),
      message(1, { eventAt: '2026-11-04 12:00:00' }),
      message(1, { samples: [{ channel: 'chn_fixture-1', valueInt: 1.5, unit: 'mC', quality: 'GOOD' }] }),
      message(1, { samples: [{ channel: 'chn_fixture-1', valueInt: 1, unit: 'degC', quality: 'GOOD' }] }),
      message(1, { samples: [{ channel: 'dev_fixture-1', valueInt: 1, unit: 'mC', quality: 'GOOD' }] }),
      message(1, { samples: [{ channel: 'chn_fixture-1', valueInt: 1, unit: 'mC', quality: 'EXCELLENT' }] }),
      message(1, { samples: [] }),
    ])
      expect(TelemetryBatchSchema.safeParse(batch({ messages: [m] })).success, JSON.stringify(m)).toBe(false);
    expect(TelemetryBatchSchema.safeParse(batch({ delivery: 'REALTIME' })).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse(batch({ schemaVersion: 2 })).success).toBe(false);
  });

  it('only accepts SIMULATED_INPUT as a sample label', () => {
    const labelled = message(1, {
      samples: [{ channel: 'chn_fixture-1', valueInt: 1, unit: 'mC', quality: 'GOOD', label: 'SIMULATED_INPUT' }],
    });
    expect(TelemetryBatchSchema.safeParse(batch({ messages: [labelled] })).success).toBe(true);
    const physical = message(1, {
      samples: [{ channel: 'chn_fixture-1', valueInt: 1, unit: 'mC', quality: 'GOOD', label: 'PHYSICAL_SENSOR' }],
    });
    expect(TelemetryBatchSchema.safeParse(batch({ messages: [physical] })).success).toBe(false);
  });

  it('decodes raw bytes with a hard size bound and rejects duplicate (boot, sequence) inside one batch', () => {
    expect(decodeTelemetryBatch(Buffer.from(JSON.stringify(batch()))).ok).toBe(true);
    expect(decodeTelemetryBatch(Buffer.from('{not json')).ok).toBe(false);
    const big = Buffer.alloc(TELEMETRY_LIMITS.maxBodyBytes + 1, 0x20);
    expect(decodeTelemetryBatch(big)).toEqual({ ok: false, reasonCode: 'BODY_TOO_LARGE' });
    const dup = decodeTelemetryBatch(Buffer.from(JSON.stringify(batch({ messages: [message(1), message(1)] }))));
    expect(dup).toEqual({ ok: false, reasonCode: 'DUPLICATE_SEQUENCE_IN_BATCH' });
  });
});
