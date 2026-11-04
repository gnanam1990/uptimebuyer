// Pure deadline ledger (FR-04, STATE-MACHINES §1). The original response/containment deadline is computed once at
// opening (SET) from the pinned procedure; every later change is an appended PAUSE/RESUME/SHORTEN/EXTEND/EXPIRE event
// planned only from the PINNED procedure's rules (never a later revision, a risk estimate or a provider ETA).
// Replaying the events in sequence derives the projection; a ledger that does not replay is rejected.
import { DomainError } from '@uptimebuyer/contracts';

export const DEADLINE_EVENT_TYPES = Object.freeze(['SET', 'PAUSE', 'RESUME', 'SHORTEN', 'EXTEND', 'EXPIRE'] as const);
export type DeadlineEventType = (typeof DEADLINE_EVENT_TYPES)[number];
export type DeadlineStatus = 'RUNNING' | 'PAUSED' | 'EXPIRED';
export type DeadlineAdjustment = Exclude<DeadlineEventType, 'SET'>;

export interface DeadlineEventRecord {
  readonly sequence: number;
  readonly eventType: DeadlineEventType;
  readonly priorDeadlineAt: string | null;
  readonly newDeadlineAt: string;
  readonly priorStatus: DeadlineStatus | null;
  readonly newStatus: DeadlineStatus;
  readonly effectiveAt: string;
}

export interface DeadlineProjection {
  readonly originalDeadlineAt: string;
  readonly currentDeadlineAt: string;
  readonly status: DeadlineStatus;
  readonly pausedAt: string | null;
  /** Total time added by EXTEND events (RESUME compensation is not an extension). */
  readonly extendedMs: number;
  readonly eventCount: number;
}

export interface DeadlineProcedureRules {
  readonly pauseAllowed: boolean;
  readonly maxExtensionMs: number;
}

export interface PlannedDeadlineEvent {
  readonly eventType: DeadlineEventType;
  readonly priorDeadlineAt: string;
  readonly newDeadlineAt: string;
  readonly priorStatus: DeadlineStatus;
  readonly newStatus: DeadlineStatus;
}

const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();

const hold = (reasonCode: string) =>
  new DomainError('POLICY_HOLD', 'The deadline change is not permitted by the pinned procedure.', { reasonCode });
const corrupt = (reasonCode: string) =>
  new DomainError('EVIDENCE_APPEND_INVALID', 'The deadline ledger does not replay.', { reasonCode });

export function computeOriginalDeadline(basisAt: string, responseDeadlineMs: number): string {
  return iso(ms(basisAt) + responseDeadlineMs);
}

/** Plan the next event against the current projection. Throws POLICY_HOLD / VALIDATION_FAILED; never mutates. */
export function planDeadlineEvent(
  projection: DeadlineProjection,
  cmd: { eventType: DeadlineAdjustment; effectiveAt: string; newDeadlineAt?: string },
  rules: DeadlineProcedureRules,
): PlannedDeadlineEvent {
  const prior = projection.currentDeadlineAt;
  const base = { eventType: cmd.eventType, priorDeadlineAt: prior, priorStatus: projection.status } as const;
  if (projection.status === 'EXPIRED') throw hold('DEADLINE_EXPIRED');
  const at = ms(cmd.effectiveAt);
  switch (cmd.eventType) {
    case 'PAUSE':
      if (!rules.pauseAllowed) throw hold('PAUSE_NOT_PERMITTED');
      if (projection.status !== 'RUNNING') throw hold('DEADLINE_NOT_RUNNING');
      if (at >= ms(prior)) throw hold('DEADLINE_ALREADY_PASSED');
      return { ...base, newDeadlineAt: prior, newStatus: 'PAUSED' };
    case 'RESUME': {
      if (projection.status !== 'PAUSED' || projection.pausedAt === null) throw hold('DEADLINE_NOT_PAUSED');
      const paused = Math.max(0, at - ms(projection.pausedAt));
      return { ...base, newDeadlineAt: iso(ms(prior) + paused), newStatus: 'RUNNING' };
    }
    case 'SHORTEN':
    case 'EXTEND': {
      if (projection.status !== 'RUNNING') throw hold('DEADLINE_NOT_RUNNING');
      if (cmd.newDeadlineAt === undefined)
        throw new DomainError('VALIDATION_FAILED', 'A new deadline is required.', {
          reasonCode: 'NEW_DEADLINE_REQUIRED',
        });
      const next = ms(cmd.newDeadlineAt);
      if (cmd.eventType === 'SHORTEN') {
        if (next >= ms(prior)) throw hold('SHORTEN_MUST_BE_EARLIER');
        if (next <= at) throw hold('SHORTEN_INTO_PAST');
        return { ...base, newDeadlineAt: iso(next), newStatus: 'RUNNING' };
      }
      if (next <= ms(prior)) throw hold('EXTEND_MUST_BE_LATER');
      if (rules.maxExtensionMs <= 0) throw hold('EXTENSION_NOT_PERMITTED');
      if (projection.extendedMs + (next - ms(prior)) > rules.maxExtensionMs) throw hold('EXTENSION_EXCEEDS_PROCEDURE');
      return { ...base, newDeadlineAt: iso(next), newStatus: 'RUNNING' };
    }
    case 'EXPIRE':
      if (projection.status !== 'RUNNING') throw hold('DEADLINE_NOT_RUNNING');
      if (at < ms(prior)) throw hold('DEADLINE_NOT_REACHED');
      return { ...base, newDeadlineAt: prior, newStatus: 'EXPIRED' };
  }
}

/** Replay a complete ledger (any read order) and return the derived projection, or throw if it does not replay. */
export function replayDeadlineEvents(events: readonly DeadlineEventRecord[]): DeadlineProjection {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0];
  if (!first || first.eventType !== 'SET' || first.sequence !== 1) throw corrupt('FIRST_EVENT_NOT_SET');
  if (first.priorDeadlineAt !== null || first.newStatus !== 'RUNNING') throw corrupt('SET_INVALID');
  let p: DeadlineProjection = {
    originalDeadlineAt: iso(ms(first.newDeadlineAt)),
    currentDeadlineAt: iso(ms(first.newDeadlineAt)),
    status: 'RUNNING',
    pausedAt: null,
    extendedMs: 0,
    eventCount: 1,
  };
  for (const [i, e] of sorted.slice(1).entries()) {
    if (e.sequence !== i + 2) throw corrupt('SEQUENCE_GAP');
    if (e.eventType === 'SET') throw corrupt('SECOND_SET');
    if (e.priorDeadlineAt === null || ms(e.priorDeadlineAt) !== ms(p.currentDeadlineAt) || e.priorStatus !== p.status)
      throw corrupt('PRIOR_MISMATCH');
    // Re-derive every event under unbounded rules: extension bounds are enforced when the event is planned (the
    // procedure is pinned), replay checks arithmetic and state consistency.
    let planned: PlannedDeadlineEvent;
    try {
      planned = planDeadlineEvent(
        p,
        { eventType: e.eventType, effectiveAt: e.effectiveAt, newDeadlineAt: e.newDeadlineAt },
        { pauseAllowed: true, maxExtensionMs: Number.MAX_SAFE_INTEGER },
      );
    } catch {
      throw corrupt('EVENT_NOT_DERIVABLE');
    }
    if (ms(planned.newDeadlineAt) !== ms(e.newDeadlineAt) || planned.newStatus !== e.newStatus)
      throw corrupt('PROJECTION_MISMATCH');
    p = {
      originalDeadlineAt: p.originalDeadlineAt,
      currentDeadlineAt: iso(ms(e.newDeadlineAt)),
      status: e.newStatus,
      pausedAt: e.eventType === 'PAUSE' ? iso(ms(e.effectiveAt)) : e.newStatus === 'PAUSED' ? p.pausedAt : null,
      extendedMs: p.extendedMs + (e.eventType === 'EXTEND' ? ms(e.newDeadlineAt) - ms(e.priorDeadlineAt) : 0),
      eventCount: p.eventCount + 1,
    };
  }
  return p;
}
