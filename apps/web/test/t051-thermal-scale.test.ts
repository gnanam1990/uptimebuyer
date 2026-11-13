// T-051 (faceplate thermal scale, studio redesign): the scale drawn on the incident faceplate follows the readout's
// honesty rules. Only a live reading is drawn live; a FRESH simulator value is drawn as simulated; stale, paused,
// last-known and failed-refresh readings are drawn as held. The reading and threshold land on the scale in the right
// places and the scale stays bounded for any reported value.
import { describe, expect, it } from 'vitest';
import type { Telemetry } from '@uptimebuyer/api-client';
import { readoutModel } from '../src/views/incident/readout.js';
import { scaleModel } from '../src/views/incident/thermalScale.js';
import { MAX_GRID_TICKS } from '../src/views/incident/chartTicks.js';

const telemetry = (inputClass: 'PHYSICAL_SENSOR' | 'SIMULATOR', valueInt: number, comparator = 'ABOVE') =>
  ({
    assetId: 'ast_test-0003',
    windowStart: '2026-11-13T12:00:00.000Z',
    asOf: '2026-11-13T12:30:00.000Z',
    threshold: { comparator, thresholdInt: 8000, unit: 'MILLI_CELSIUS', ruleRevisionId: 'rul_test-0003' },
    devices: [
      {
        deviceId: 'dev_test-0003',
        inputClass,
        freshness: 'FRESH',
        series: [
          {
            channelId: 'chn_temp',
            kind: 'TEMPERATURE',
            unit: 'MILLI_CELSIUS',
            samples: [
              {
                sampleId: 'smp_1',
                eventAt: '2026-11-13T12:29:55.000Z',
                receivedAt: '2026-11-13T12:29:56.000Z',
                valueInt,
                unit: 'MILLI_CELSIUS',
                qualityFlags: [],
                ingestionClass: 'LIVE',
                inputOrigin: inputClass === 'SIMULATOR' ? 'SIMULATOR' : 'SENSOR',
              },
            ],
          },
        ],
      },
    ],
  }) as unknown as Telemetry;

const scale = (
  t: Telemetry | null,
  { freshness = 'FRESH', paused = false, refreshError = null as string | null } = {},
) => scaleModel(readoutModel({ telemetry: t, freshness, paused, refreshError }));

describe('T-051 faceplate thermal scale', () => {
  it('is live only for a fresh, physical, unpaused reading after a successful refresh', () => {
    expect(scale(telemetry('PHYSICAL_SENSOR', 4300))!.state).toBe('live');
    expect(scale(telemetry('PHYSICAL_SENSOR', 4300), { paused: true })!.state).toBe('held');
    for (const freshness of ['STALE', 'OFFLINE', 'INVALID', 'NO_SIGNAL'])
      expect(scale(telemetry('PHYSICAL_SENSOR', 4300), { freshness })!.state).toBe('held');
    expect(scale(telemetry('PHYSICAL_SENSOR', 4300), { refreshError: 'Network error.' })!.state).toBe('held');
  });

  it('never draws a simulator value as live, however fresh it is', () => {
    expect(scale(telemetry('SIMULATOR', 4300))!.state).toBe('simulated');
    expect(scale(telemetry('SIMULATOR', 4300), { paused: true })!.state).toBe('simulated');
    expect(scale(telemetry('SIMULATOR', 4300), { freshness: 'STALE' })!.state).toBe('held');
    expect(scale(telemetry('SIMULATOR', 4300), { refreshError: 'Network error.' })!.state).toBe('held');
  });

  it('places the reading and the threshold in order and marks a reading beyond the threshold', () => {
    const below = scale(telemetry('PHYSICAL_SENSOR', 4300))!;
    expect(below.at).toBeGreaterThan(0);
    expect(below.at).toBeLessThan(below.thresholdAt);
    expect(below.thresholdAt).toBeLessThan(1);
    expect(below.beyond).toBe(false);
    expect(below.danger).toBe('above');
    const above = scale(telemetry('PHYSICAL_SENSOR', 9600))!;
    expect(above.at).toBeGreaterThan(above.thresholdAt);
    expect(above.beyond).toBe(true);
    const freezer = scale(telemetry('PHYSICAL_SENSOR', 4300, 'BELOW'))!;
    expect(freezer.danger).toBe('below');
    expect(freezer.beyond).toBe(true);
  });

  it('has no scale without a reading or a pinned threshold', () => {
    expect(scale(null)).toBeNull();
    const t = telemetry('PHYSICAL_SENSOR', 4300);
    expect(scale({ ...t, threshold: null } as unknown as Telemetry)).toBeNull();
  });

  it('stays bounded for absurd reported values', () => {
    for (const v of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1e12]) {
      const s = scale(telemetry('PHYSICAL_SENSOR', v))!;
      expect(s.at).toBeGreaterThanOrEqual(0);
      expect(s.at).toBeLessThanOrEqual(1);
      expect(s.ticks.length).toBeLessThanOrEqual(MAX_GRID_TICKS);
    }
  });
});
