// T-051 (faceplate readout, PR #25 review): the faceplate uses the same device and series as the Telemetry panel and
// labels a SIMULATOR device's value as SIMULATED_INPUT exactly as the panel does. A simulated value is never styled as
// a live operational reading, however fresh it is.
import { describe, expect, it } from 'vitest';
import type { Telemetry } from '@uptimebuyer/api-client';
import { readoutModel, selectReading } from '../src/views/incident/readout.js';

const sample = (valueInt: number, eventAt: string) => ({
  sampleId: `smp_${valueInt}_${eventAt}`,
  eventAt,
  receivedAt: eventAt,
  valueInt,
  unit: 'MILLI_CELSIUS',
  qualityFlags: [],
  ingestionClass: 'LIVE' as const,
  inputOrigin: 'SIMULATOR',
});
const device = (deviceId: string, inputClass: 'PHYSICAL_SENSOR' | 'SIMULATOR', series: unknown[]) => ({
  deviceId,
  inputClass,
  freshness: 'FRESH',
  healthy: true,
  statusReason: null,
  sourceTime: '2026-11-13T12:29:55.000Z',
  receiptTime: '2026-11-13T12:29:56.000Z',
  ageMs: 5000,
  freshnessThresholdMs: 120_000,
  offlineThresholdMs: 600_000,
  evaluatedAt: '2026-11-13T12:30:00.000Z',
  channels: [],
  series,
});
const withDevices = (devices: unknown[]) =>
  ({
    assetId: 'ast_test-0002',
    windowStart: '2026-11-13T12:00:00.000Z',
    asOf: '2026-11-13T12:30:00.000Z',
    devices,
    threshold: { comparator: 'ABOVE', thresholdInt: 8000, unit: 'MILLI_CELSIUS', ruleRevisionId: 'rul_test-0002' },
  }) as unknown as Telemetry;

describe('T-051 faceplate readout for simulated input', () => {
  it('selects the first device and its TEMPERATURE series, as the Telemetry panel does', () => {
    const t = withDevices([
      device('dev_sim-0001', 'SIMULATOR', [
        { channelId: 'chn_door', kind: 'DOOR', unit: 'STATE', samples: [sample(1, '2026-11-13T12:29:58.000Z')] },
        {
          channelId: 'chn_temp',
          kind: 'TEMPERATURE',
          unit: 'MILLI_CELSIUS',
          samples: [sample(4100, '2026-11-13T12:29:55.000Z')],
        },
      ]),
      device('dev_phys-0002', 'PHYSICAL_SENSOR', [
        {
          channelId: 'chn_t2',
          kind: 'TEMPERATURE',
          unit: 'MILLI_CELSIUS',
          samples: [sample(9900, '2026-11-13T12:29:59.000Z')],
        },
      ]),
    ]);
    const r = selectReading(t);
    expect(r.device?.deviceId).toBe('dev_sim-0001');
    expect(r.series?.channelId).toBe('chn_temp');
    expect(r.last?.valueInt).toBe(4100);
    expect(r.simulated).toBe(true);
  });

  it('a fresh SIMULATOR reading is labelled simulated and is never a live reading', () => {
    const t = withDevices([
      device('dev_sim-0001', 'SIMULATOR', [
        {
          channelId: 'chn_temp',
          kind: 'TEMPERATURE',
          unit: 'MILLI_CELSIUS',
          samples: [sample(4100, '2026-11-13T12:29:55.000Z')],
        },
      ]),
    ]);
    const m = readoutModel({ telemetry: t, freshness: 'FRESH', paused: false, refreshError: null });
    expect(m.simulated).toBe(true);
    expect(m.live).toBe(false);
    expect(m.label).toMatch(/simulated/i);
    expect(m.label).not.toBe('Newest temperature');
    // Freshness is still reported on its own axis; it is the input origin that keeps the value from reading as live.
    expect(m.freshness).toBe('FRESH');
  });

  it('a physical sensor reading is not marked simulated', () => {
    const t = withDevices([
      device('dev_phys-0001', 'PHYSICAL_SENSOR', [
        {
          channelId: 'chn_temp',
          kind: 'TEMPERATURE',
          unit: 'MILLI_CELSIUS',
          samples: [sample(4100, '2026-11-13T12:29:55.000Z')],
        },
      ]),
    ]);
    const m = readoutModel({ telemetry: t, freshness: 'FRESH', paused: false, refreshError: null });
    expect(m.simulated).toBe(false);
    expect(m.live).toBe(true);
  });
});
