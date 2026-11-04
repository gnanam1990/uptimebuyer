// T-017 (unit) — threshold/window evaluation on event time over LIVE samples only: hysteresis, duration, minimum
// samples, channel quorum, gap (stale-data) behaviour and bounded evaluation lag. Isolated noise never qualifies.
import { describe, expect, it } from 'vitest';
import { evaluateRuleWindow, type RuleWindowSpec, type WindowSample } from '../src/index.js';

const spec: RuleWindowSpec = {
  comparator: 'ABOVE',
  thresholdInt: 8_000,
  hysteresisInt: 500,
  durationMs: 120_000,
  minSamples: 4,
  quorumChannels: 1,
  maxGapMs: 60_000,
  maxEvaluationLagMs: 60_000,
};

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
let n = 0;
const s = (offsetS: number, valueInt: number, extra: Partial<WindowSample> = {}): WindowSample => ({
  sampleId: `tsm_unit-${++n}`,
  channelId: 'chn_unit-a',
  eventAtMs: T0 + offsetS * 1000,
  receivedAtMs: T0 + offsetS * 1000 + 50,
  valueInt,
  ingestionClass: 'LIVE',
  qualityFlags: [],
  inputOrigin: 'PHYSICAL_SENSOR',
  ...extra,
});
const at = (offsetS: number) => T0 + offsetS * 1000;

describe('T-017 rule window evaluation', () => {
  it('a sustained breach of at least the duration with enough LIVE samples qualifies, with its exact run', () => {
    const run = [s(0, 9_000), s(30, 9_100), s(60, 9_200), s(90, 9_300), s(120, 9_400)];
    const out = evaluateRuleWindow(spec, [s(-30, 4_000), ...run], at(125));
    expect(out.qualified).toBe(true);
    if (!out.qualified) return;
    expect(out.reasonCode).toBe('QUALIFIED');
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]!.samples.map((x) => x.sampleId)).toEqual(run.map((x) => x.sampleId));
    expect(out.onsetAtMs).toBe(run[0]!.eventAtMs);
    expect(out.lastEventAtMs).toBe(run[4]!.eventAtMs);
    expect(out.peakValueInt).toBe(9_400);
  });

  it('isolated noise does not qualify: a single spike, a short burst, or a run broken by a normal reading', () => {
    expect(evaluateRuleWindow(spec, [s(0, 4_000), s(30, 12_000), s(60, 4_000)], at(61))).toMatchObject({
      qualified: false,
    });
    expect(evaluateRuleWindow(spec, [s(0, 12_000)], at(1)).reasonCode).toBe('DURATION_NOT_MET');
    expect(evaluateRuleWindow(spec, [s(0, 9_000), s(30, 9_000), s(60, 9_000)], at(61)).reasonCode).toBe(
      'DURATION_NOT_MET',
    );
    const broken = [s(0, 9_000), s(30, 9_000), s(60, 4_000), s(90, 9_000), s(120, 9_000), s(150, 9_000)];
    expect(evaluateRuleWindow(spec, broken, at(151)).reasonCode).toBe('DURATION_NOT_MET');
    expect(evaluateRuleWindow(spec, [s(0, 4_000), s(30, 5_000)], at(31)).reasonCode).toBe('NOT_IN_BREACH');
  });

  it('hysteresis: once in breach, readings above threshold minus hysteresis keep the run; onset needs the threshold', () => {
    const held = [s(0, 8_200), s(30, 7_700), s(60, 7_600), s(90, 8_100), s(120, 7_800)];
    expect(evaluateRuleWindow(spec, held, at(121)).qualified).toBe(true);
    const neverOver = [s(0, 7_900), s(30, 7_900), s(60, 7_900), s(90, 7_900), s(120, 7_900)];
    expect(evaluateRuleWindow(spec, neverOver, at(121)).reasonCode).toBe('NOT_IN_BREACH');
    const dropsBelowBand = [s(0, 9_000), s(30, 9_000), s(60, 7_400), s(90, 9_000), s(120, 9_000)];
    expect(evaluateRuleWindow(spec, dropsBelowBand, at(121)).qualified).toBe(false);
  });

  it('BELOW rules mirror the threshold and hysteresis', () => {
    const below: RuleWindowSpec = { ...spec, comparator: 'BELOW', thresholdInt: 2_000 };
    const run = [s(0, 1_500), s(30, 2_400), s(60, 1_800), s(90, 1_900), s(120, 2_300)];
    expect(evaluateRuleWindow(below, run, at(121)).qualified).toBe(true);
    expect(evaluateRuleWindow(below, run.slice(1), at(121)).qualified).toBe(false);
  });

  it('only LIVE, flag-free samples count: LATE, BACKFILL and flagged readings never open as live', () => {
    const run = (extra: Partial<WindowSample>) => [0, 30, 60, 90, 120].map((o) => s(o, 9_500, extra));
    expect(evaluateRuleWindow(spec, run({ ingestionClass: 'LATE' }), at(121)).reasonCode).toBe('NO_LIVE_SAMPLES');
    expect(evaluateRuleWindow(spec, run({ ingestionClass: 'BACKFILL' }), at(121)).reasonCode).toBe('NO_LIVE_SAMPLES');
    expect(evaluateRuleWindow(spec, run({ qualityFlags: ['SENSOR_FAULT'] }), at(121)).reasonCode).toBe(
      'NO_LIVE_SAMPLES',
    );
    const mixed = [
      s(0, 9_500),
      s(30, 9_500, { ingestionClass: 'BACKFILL' }),
      s(60, 9_500),
      s(90, 9_500),
      s(120, 9_500),
    ];
    const out = evaluateRuleWindow(spec, mixed, at(121));
    expect(out.qualified).toBe(true);
    if (out.qualified) expect(out.runs[0]!.samples.every((x) => x.ingestionClass === 'LIVE')).toBe(true);
  });

  it('stale-data behaviour: a gap longer than maxGap breaks the run, and a tail older than the lag bound is STALE', () => {
    const gapped = [s(0, 9_000), s(30, 9_000), s(120, 9_000), s(150, 9_000), s(180, 9_000)];
    expect(evaluateRuleWindow(spec, gapped, at(181)).qualified).toBe(false);
    const run = [s(0, 9_000), s(30, 9_000), s(60, 9_000), s(90, 9_000), s(120, 9_000)];
    expect(evaluateRuleWindow(spec, run, at(180)).qualified).toBe(true);
    expect(evaluateRuleWindow(spec, run, at(181)).reasonCode).toBe('STALE_SIGNAL');
    expect(evaluateRuleWindow(spec, [], at(0)).reasonCode).toBe('NO_LIVE_SAMPLES');
  });

  it('samples after the evaluation instant are ignored (event time, never arrival order)', () => {
    const run = [s(0, 9_000), s(30, 9_000), s(60, 9_000), s(90, 9_000), s(120, 9_000)];
    const shuffled = [run[3]!, run[0]!, run[4]!, run[2]!, run[1]!];
    expect(evaluateRuleWindow(spec, shuffled, at(121)).qualified).toBe(true);
    expect(evaluateRuleWindow(spec, run, at(100)).qualified).toBe(false);
  });

  it('channel quorum: a single breaching channel does not satisfy a two-channel quorum', () => {
    const quorum: RuleWindowSpec = { ...spec, quorumChannels: 2 };
    const a = [0, 30, 60, 90, 120].map((o) => s(o, 9_000));
    const b = [0, 30, 60, 90, 120].map((o) => s(o, 4_000, { channelId: 'chn_unit-b' }));
    const bHot = [0, 30, 60, 90, 120].map((o) => s(o, 9_000, { channelId: 'chn_unit-b' }));
    expect(evaluateRuleWindow(quorum, [...a, ...b], at(121)).reasonCode).toBe('QUORUM_NOT_MET');
    const out = evaluateRuleWindow(quorum, [...a, ...bHot], at(121));
    expect(out.qualified).toBe(true);
    if (out.qualified) expect(out.runs.map((r) => r.channelId).sort()).toEqual(['chn_unit-a', 'chn_unit-b']);
  });

  it('minimum samples: a long breach carried by too few readings does not qualify', () => {
    const sparse: RuleWindowSpec = { ...spec, minSamples: 6 };
    const run = [s(0, 9_000), s(40, 9_000), s(80, 9_000), s(120, 9_000)];
    expect(evaluateRuleWindow(sparse, run, at(121)).reasonCode).toBe('MIN_SAMPLES_NOT_MET');
  });
});
