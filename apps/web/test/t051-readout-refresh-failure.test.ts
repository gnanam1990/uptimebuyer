// T-051 (faceplate readout, PR #25 review): after a telemetry refresh fails, the incident faceplate must not keep
// presenting the retained reading as current. It reads "Last known temperature, not live", carries the refresh error
// and never shows the retained FRESH freshness, on every tab (the faceplate heads every incident section).
import { describe, expect, it } from 'vitest';
import type { Telemetry } from '@uptimebuyer/api-client';
import { readoutModel } from '../src/views/incident/readout.js';

const sample = (valueInt: number, eventAt: string) => ({
  sampleId: `smp_${eventAt}`,
  eventAt,
  receivedAt: eventAt,
  valueInt,
  unit: 'MILLI_CELSIUS',
  qualityFlags: [],
  ingestionClass: 'LIVE' as const,
  inputOrigin: 'PHYSICAL_SENSOR',
});
const telemetry = (inputClass: 'PHYSICAL_SENSOR' | 'SIMULATOR', freshness = 'FRESH') =>
  ({
    assetId: 'ast_test-0001',
    windowStart: '2026-11-13T12:00:00.000Z',
    asOf: '2026-11-13T12:30:00.000Z',
    devices: [
      {
        deviceId: 'dev_test-0001',
        inputClass,
        freshness,
        healthy: freshness === 'FRESH',
        statusReason: null,
        sourceTime: '2026-11-13T12:29:55.000Z',
        receiptTime: '2026-11-13T12:29:56.000Z',
        ageMs: 5000,
        freshnessThresholdMs: 120_000,
        offlineThresholdMs: 600_000,
        evaluatedAt: '2026-11-13T12:30:00.000Z',
        channels: [],
        series: [
          {
            channelId: 'chn_test-0001',
            kind: 'TEMPERATURE',
            unit: 'MILLI_CELSIUS',
            samples: [sample(3800, '2026-11-13T12:29:50.000Z'), sample(4100, '2026-11-13T12:29:55.000Z')],
          },
        ],
      },
    ],
    threshold: { comparator: 'ABOVE', thresholdInt: 8000, unit: 'MILLI_CELSIUS', ruleRevisionId: 'rul_test-0001' },
  }) as unknown as Telemetry;

describe('T-051 faceplate readout after a failed telemetry refresh', () => {
  it('a fresh physical reading that refreshed successfully reads as the newest, live reading', () => {
    const m = readoutModel({
      telemetry: telemetry('PHYSICAL_SENSOR'),
      freshness: 'FRESH',
      paused: false,
      refreshError: null,
    });
    expect(m.live).toBe(true);
    expect(m.label).toBe('Newest temperature');
    expect(m.freshness).toBe('FRESH');
    expect(m.last?.valueInt).toBe(4100);
    expect(m.refreshError).toBeNull();
  });

  it('a failed refresh makes the retained reading last-known, not live, with the error and without FRESH', () => {
    const m = readoutModel({
      telemetry: telemetry('PHYSICAL_SENSOR'),
      freshness: 'FRESH',
      paused: false,
      refreshError: 'The request could not be completed. Check the connection and retry.',
    });
    expect(m.live).toBe(false);
    expect(m.label).toBe('Last known temperature, not live');
    expect(m.refreshError).toContain('could not be completed');
    expect(m.freshness).not.toBe('FRESH');
    expect(m.freshness).toBeNull();
    // The retained value is still shown, as last known: nothing is hidden and nothing is invented.
    expect(m.last?.valueInt).toBe(4100);
  });

  it('a failed first load has no reading and still carries the error', () => {
    const m = readoutModel({ telemetry: null, freshness: null, paused: false, refreshError: 'Telemetry unavailable.' });
    expect(m.live).toBe(false);
    expect(m.last).toBeNull();
    expect(m.freshness).toBeNull();
    expect(m.refreshError).toBe('Telemetry unavailable.');
  });
});
