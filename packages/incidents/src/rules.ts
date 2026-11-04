// Pure threshold/window evaluation (FR-03, INV-11). Runs on source EVENT time, never arrival order, over LIVE
// flag-free samples only: LATE, BACKFILL and quality-flagged readings are discarded before any decision, so they can
// neither open an incident as live nor (later, M11) prove recovery. A channel qualifies when its newest live run of
// breaching readings (onset strictly beyond the threshold, continued while beyond threshold minus hysteresis, no gap
// longer than maxGap) spans at least `durationMs` with at least `minSamples` readings and ends within the bounded
// evaluation lag; the rule qualifies when `quorumChannels` channels do.

export type Comparator = 'ABOVE' | 'BELOW';

export interface RuleWindowSpec {
  readonly comparator: Comparator;
  readonly thresholdInt: number;
  readonly hysteresisInt: number;
  readonly durationMs: number;
  readonly minSamples: number;
  readonly quorumChannels: number;
  readonly maxGapMs: number;
  /** Bounded lateness: the newest live reading must be at most this old at the evaluation instant. */
  readonly maxEvaluationLagMs: number;
}

export interface WindowSample {
  readonly sampleId: string;
  readonly channelId: string;
  readonly eventAtMs: number;
  readonly receivedAtMs: number;
  readonly valueInt: number;
  readonly ingestionClass: 'LIVE' | 'LATE' | 'BACKFILL';
  readonly qualityFlags: readonly string[];
  readonly inputOrigin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT';
}

export interface ChannelRun {
  readonly channelId: string;
  readonly samples: readonly WindowSample[];
  readonly startAtMs: number;
  readonly endAtMs: number;
}

export type NotQualifiedReason =
  'NO_LIVE_SAMPLES' | 'STALE_SIGNAL' | 'NOT_IN_BREACH' | 'DURATION_NOT_MET' | 'MIN_SAMPLES_NOT_MET' | 'QUORUM_NOT_MET';

export type WindowOutcome =
  | {
      readonly qualified: true;
      readonly reasonCode: 'QUALIFIED';
      readonly runs: readonly ChannelRun[];
      /** Earliest breach onset (event time) across the qualifying channels. */
      readonly onsetAtMs: number;
      /** Newest qualifying reading (event time). */
      readonly lastEventAtMs: number;
      readonly lastReceivedAtMs: number;
      readonly peakValueInt: number;
      readonly inputOrigin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT';
    }
  | { readonly qualified: false; readonly reasonCode: NotQualifiedReason };

type ChannelStatus = { kind: 'QUALIFIED'; run: ChannelRun } | { kind: Exclude<NotQualifiedReason, 'QUORUM_NOT_MET'> };

/** Rank of a non-qualifying channel status: the "closest to qualifying" reason is reported. */
const RANK: Record<string, number> = {
  NO_LIVE_SAMPLES: 0,
  STALE_SIGNAL: 1,
  NOT_IN_BREACH: 2,
  DURATION_NOT_MET: 3,
  MIN_SAMPLES_NOT_MET: 4,
};

const isLive = (s: WindowSample) => s.ingestionClass === 'LIVE' && s.qualityFlags.length === 0;

function evaluateChannel(spec: RuleWindowSpec, samples: WindowSample[], atMs: number): ChannelStatus {
  if (samples.length === 0) return { kind: 'NO_LIVE_SAMPLES' };
  const last = samples[samples.length - 1]!;
  if (atMs - last.eventAtMs > spec.maxEvaluationLagMs) return { kind: 'STALE_SIGNAL' };
  const above = spec.comparator === 'ABOVE';
  const onset = (v: number) => (above ? v > spec.thresholdInt : v < spec.thresholdInt);
  const holds = (v: number) =>
    above ? v > spec.thresholdInt - spec.hysteresisInt : v < spec.thresholdInt + spec.hysteresisInt;
  let run: WindowSample[] = [];
  let prev: WindowSample | undefined;
  for (const s of samples) {
    if (prev && s.eventAtMs - prev.eventAtMs > spec.maxGapMs) run = [];
    if (run.length === 0) {
      if (onset(s.valueInt)) run = [s];
    } else if (holds(s.valueInt)) run.push(s);
    else run = [];
    prev = s;
  }
  if (run.length === 0 || run[run.length - 1] !== last) return { kind: 'NOT_IN_BREACH' };
  const startAtMs = run[0]!.eventAtMs;
  if (last.eventAtMs - startAtMs < spec.durationMs) return { kind: 'DURATION_NOT_MET' };
  if (run.length < spec.minSamples) return { kind: 'MIN_SAMPLES_NOT_MET' };
  return { kind: 'QUALIFIED', run: { channelId: last.channelId, samples: run, startAtMs, endAtMs: last.eventAtMs } };
}

export function evaluateRuleWindow(
  spec: RuleWindowSpec,
  samples: readonly WindowSample[],
  atMs: number,
): WindowOutcome {
  const byChannel = new Map<string, WindowSample[]>();
  for (const s of samples) {
    if (!isLive(s) || s.eventAtMs > atMs) continue;
    const list = byChannel.get(s.channelId) ?? [];
    list.push(s);
    byChannel.set(s.channelId, list);
  }
  if (byChannel.size === 0) return { qualified: false, reasonCode: 'NO_LIVE_SAMPLES' };
  const statuses = [...byChannel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, list]) =>
      evaluateChannel(
        spec,
        list.sort((a, b) => a.eventAtMs - b.eventAtMs || (a.sampleId < b.sampleId ? -1 : 1)),
        atMs,
      ),
    );
  const runs = statuses.flatMap((s) => (s.kind === 'QUALIFIED' ? [s.run] : []));
  if (runs.length >= spec.quorumChannels) {
    const all = runs.flatMap((r) => r.samples);
    const newest = all.reduce((a, b) => (b.eventAtMs > a.eventAtMs ? b : a));
    const peak = all.reduce(
      (a, b) => (spec.comparator === 'ABOVE' ? Math.max(a, b.valueInt) : Math.min(a, b.valueInt)),
      all[0]!.valueInt,
    );
    return {
      qualified: true,
      reasonCode: 'QUALIFIED',
      runs,
      onsetAtMs: Math.min(...runs.map((r) => r.startAtMs)),
      lastEventAtMs: newest.eventAtMs,
      lastReceivedAtMs: Math.max(...all.map((s) => s.receivedAtMs)),
      peakValueInt: peak,
      inputOrigin: all.some((s) => s.inputOrigin === 'SIMULATED_INPUT') ? 'SIMULATED_INPUT' : 'PHYSICAL_SENSOR',
    };
  }
  if (runs.length > 0) return { qualified: false, reasonCode: 'QUORUM_NOT_MET' };
  const best = statuses.reduce((a, b) => (RANK[b.kind]! > RANK[a.kind]! ? b : a));
  return { qualified: false, reasonCode: best.kind as NotQualifiedReason };
}
