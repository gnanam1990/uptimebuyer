// Pure stable-window evaluator (FR-15, INV-01, INV-11). Given the frozen observation boundary, the evaluation instant,
// the pinned channel bindings and the incident rule's safe predicate, every pinned channel must end in a continuous run
// of qualifying samples (exact pinned revisions, LIVE and live-delivered, flag-free, physical unless allowed, in the
// safe range, not linked to a sibling incident) whose first sample is STRICTLY after the boundary, spanning at least
// the stable window with enough samples, no gap beyond policy, and a currently fresh tail. Any disqualifying sample
// resets the run, so late/backfilled data (even followed by a fresh LIVE tail) can never complete a window by itself.
// Deterministic and order-independent; no wall clock is read.

export interface WindowPin {
  readonly channelId: string;
  readonly channelRevisionId: string;
  readonly deviceAssignmentId: string;
  readonly assetId: string;
  readonly assetRevisionId: string;
}

export interface WindowSample {
  readonly id: string;
  readonly eventAtMs: number;
  readonly channelId: string;
  readonly channelRevisionId: string;
  readonly deviceAssignmentId: string;
  readonly assetId: string;
  readonly assetRevisionId: string;
  readonly ingestionClass: 'LIVE' | 'LATE' | 'BACKFILL';
  readonly delivery: 'LIVE' | 'BACKFILL';
  readonly qualityFlags: readonly string[];
  readonly inputOrigin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT';
  readonly valueInt: bigint | number;
  readonly linkedIncidentIds?: readonly string[];
  /** The sample's device is revoked (never contributes proof). */
  readonly deviceRevoked?: boolean;
}

export interface WindowSpec {
  readonly incidentId: string;
  readonly boundaryAtMs: number;
  readonly asOfMs: number;
  readonly stableWindowMs: number;
  readonly maxGapMs: number;
  readonly minSamples: number;
  readonly maxTailAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly allowSimulatedInput: boolean;
  readonly safe: {
    readonly comparator: 'ABOVE' | 'BELOW';
    readonly thresholdInt: bigint;
    readonly hysteresisInt: bigint;
  };
  readonly pins: readonly WindowPin[];
}

export interface ChannelWindow {
  readonly channelId: string;
  readonly passed: boolean;
  readonly sampleIds: readonly string[];
  readonly firstAtMs: number | null;
  readonly lastAtMs: number | null;
  readonly stableMs: number;
  readonly reasonCodes: readonly string[];
}

export type WindowResult =
  | {
      readonly passed: true;
      readonly sampleIds: readonly string[];
      readonly firstAtMs: number;
      readonly lastAtMs: number;
      readonly sampleCount: number;
      readonly stableMs: number;
      readonly channels: readonly ChannelWindow[];
      readonly reasonCodes: readonly [];
    }
  | { readonly passed: false; readonly reasonCodes: readonly string[]; readonly channels: readonly ChannelWindow[] };

const order = (a: WindowSample, b: WindowSample) =>
  a.eventAtMs - b.eventAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function isSafe(spec: WindowSpec, v: bigint | number): boolean {
  const value = typeof v === 'bigint' ? v : BigInt(v);
  return spec.safe.comparator === 'ABOVE'
    ? value <= spec.safe.thresholdInt - spec.safe.hysteresisInt
    : value >= spec.safe.thresholdInt + spec.safe.hysteresisInt;
}

/** The first reason a sample on a pinned channel cannot qualify, or null. */
function disqualify(spec: WindowSpec, pin: WindowPin, s: WindowSample): string | null {
  if (
    s.channelRevisionId !== pin.channelRevisionId ||
    s.deviceAssignmentId !== pin.deviceAssignmentId ||
    s.assetId !== pin.assetId ||
    s.assetRevisionId !== pin.assetRevisionId
  )
    return 'REVISION_MISMATCH';
  if (s.deviceRevoked) return 'DEVICE_REVOKED';
  if (s.ingestionClass !== 'LIVE' || s.delivery !== 'LIVE') return 'NON_LIVE_SAMPLE';
  if (s.qualityFlags.length > 0) return 'QUALITY_FLAGGED';
  if (s.inputOrigin !== 'PHYSICAL_SENSOR' && !spec.allowSimulatedInput) return 'SIMULATED_INPUT';
  if ((s.linkedIncidentIds ?? []).some((id) => id !== spec.incidentId)) return 'SIBLING_INCIDENT_SAMPLE';
  if (!isSafe(spec, s.valueInt)) return 'SAFE_RANGE_EXCURSION';
  return null;
}

function evaluateChannel(spec: WindowSpec, pin: WindowPin, all: readonly WindowSample[]): ChannelWindow {
  const reasons = new Set<string>();
  const onChannel = all.filter((s) => s.channelId === pin.channelId).sort(order);
  if (onChannel.some((s) => s.eventAtMs === spec.boundaryAtMs)) reasons.add('BOUNDARY_EQUAL_SAMPLE');
  const futureLimit = spec.asOfMs + spec.maxFutureSkewMs;
  const considered: WindowSample[] = [];
  for (const s of onChannel) {
    if (s.eventAtMs <= spec.boundaryAtMs) continue;
    if (s.eventAtMs > futureLimit) {
      reasons.add('FUTURE_SAMPLE');
      continue;
    }
    considered.push(s);
  }
  if (considered.length === 0) {
    reasons.add('NO_POST_BOUNDARY_SAMPLE');
    return {
      channelId: pin.channelId,
      passed: false,
      sampleIds: [],
      firstAtMs: null,
      lastAtMs: null,
      stableMs: 0,
      reasonCodes: [...reasons],
    };
  }
  let run: WindowSample[] = [];
  for (const s of considered) {
    const why = disqualify(spec, pin, s);
    if (why) {
      reasons.add(why);
      run = [];
      continue;
    }
    const last = run.at(-1);
    if (last && s.eventAtMs - last.eventAtMs > spec.maxGapMs) {
      reasons.add('GAP_EXCEEDED');
      run = [s];
      continue;
    }
    run.push(s);
  }
  const failed = (extra: string) => {
    reasons.add(extra);
    return {
      channelId: pin.channelId,
      passed: false,
      sampleIds: run.map((s) => s.id),
      firstAtMs: run[0]?.eventAtMs ?? null,
      lastAtMs: run.at(-1)?.eventAtMs ?? null,
      stableMs: run.length > 0 ? run.at(-1)!.eventAtMs - run[0]!.eventAtMs : 0,
      reasonCodes: [...reasons],
    } satisfies ChannelWindow;
  };
  if (run.length === 0) return failed('NO_QUALIFYING_RUN');
  const first = run[0]!;
  const last = run.at(-1)!;
  const stableMs = last.eventAtMs - first.eventAtMs;
  if (spec.asOfMs - last.eventAtMs > spec.maxTailAgeMs) return failed('TAIL_STALE');
  if (stableMs < spec.stableWindowMs) return failed('WINDOW_TOO_SHORT');
  if (run.length < spec.minSamples) return failed('TOO_FEW_SAMPLES');
  return {
    channelId: pin.channelId,
    passed: true,
    sampleIds: run.map((s) => s.id),
    firstAtMs: first.eventAtMs,
    lastAtMs: last.eventAtMs,
    stableMs,
    reasonCodes: [],
  };
}

export function evaluateStableWindow(spec: WindowSpec, samples: readonly WindowSample[]): WindowResult {
  if (spec.pins.length === 0) return { passed: false, reasonCodes: ['NO_PINNED_CHANNEL'], channels: [] };
  const channels = [...spec.pins]
    .sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0))
    .map((pin) => evaluateChannel(spec, pin, samples));
  if (channels.every((c) => c.passed)) {
    const ids = new Set(channels.flatMap((c) => c.sampleIds));
    const chosen = samples.filter((s) => ids.has(s.id)).sort(order);
    return {
      passed: true,
      sampleIds: chosen.map((s) => s.id),
      firstAtMs: Math.min(...channels.map((c) => c.firstAtMs!)),
      lastAtMs: Math.max(...channels.map((c) => c.lastAtMs!)),
      sampleCount: chosen.length,
      // The weakest channel's continuous duration is the window's.
      stableMs: Math.min(...channels.map((c) => c.stableMs)),
      channels,
      reasonCodes: [],
    };
  }
  const reasons: string[] = [];
  for (const c of channels) for (const r of c.reasonCodes) if (!reasons.includes(r)) reasons.push(r);
  return { passed: false, reasonCodes: reasons, channels };
}
