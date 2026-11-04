// T-019 (unit) — the append-only deadline ledger: SET/PAUSE/RESUME/SHORTEN/EXTEND/EXPIRE planned under the pinned
// procedure's rules, the original never moves, and replaying the authorized events derives the same projection.
import { describe, expect, it } from 'vitest';
import {
  planDeadlineEvent,
  replayDeadlineEvents,
  type DeadlineEventRecord,
  type DeadlineProcedureRules,
} from '../src/index.js';

const rules: DeadlineProcedureRules = { pauseAllowed: true, maxExtensionMs: 15 * 60_000 };
const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

function applyAll(steps: { eventType: DeadlineEventRecord['eventType']; at: number; newDeadlineAt?: number }[]) {
  const set: DeadlineEventRecord = {
    sequence: 1,
    eventType: 'SET',
    priorDeadlineAt: null,
    newDeadlineAt: iso(T0 + 30 * min),
    priorStatus: null,
    newStatus: 'RUNNING',
    effectiveAt: iso(T0),
  };
  const events: DeadlineEventRecord[] = [set];
  for (const step of steps) {
    const projection = replayDeadlineEvents(events);
    const planned = planDeadlineEvent(
      projection,
      {
        eventType: step.eventType as never,
        effectiveAt: iso(step.at),
        ...(step.newDeadlineAt !== undefined ? { newDeadlineAt: iso(step.newDeadlineAt) } : {}),
      },
      rules,
    );
    events.push({ sequence: events.length + 1, ...planned, effectiveAt: iso(step.at) });
  }
  return events;
}

describe('T-019 deadline ledger replay', () => {
  it('pause/resume adds exactly the paused time; shorten and bounded extend move only the current deadline', () => {
    const events = applyAll([
      { eventType: 'PAUSE', at: T0 + 5 * min },
      { eventType: 'RESUME', at: T0 + 12 * min },
      { eventType: 'SHORTEN', at: T0 + 13 * min, newDeadlineAt: T0 + 30 * min },
      { eventType: 'EXTEND', at: T0 + 14 * min, newDeadlineAt: T0 + 40 * min },
    ]);
    const p = replayDeadlineEvents(events);
    expect(p.originalDeadlineAt).toBe(iso(T0 + 30 * min));
    expect(events[2]!.newDeadlineAt).toBe(iso(T0 + 37 * min));
    expect(p.currentDeadlineAt).toBe(iso(T0 + 40 * min));
    expect(p.status).toBe('RUNNING');
    expect(p.extendedMs).toBe(10 * min);
    expect(p.eventCount).toBe(5);
    // Replay is deterministic and independent of the order rows are read in.
    expect(replayDeadlineEvents([...events].reverse())).toEqual(p);
  });

  it('extension is bounded by the pinned procedure and never allowed when the procedure forbids it', () => {
    const events = applyAll([{ eventType: 'EXTEND', at: T0 + min, newDeadlineAt: T0 + 40 * min }]);
    const p = replayDeadlineEvents(events);
    expect(() =>
      planDeadlineEvent(
        p,
        { eventType: 'EXTEND', effectiveAt: iso(T0 + 2 * min), newDeadlineAt: iso(T0 + 46 * min) },
        rules,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'POLICY_HOLD',
        details: expect.objectContaining({ reasonCode: 'EXTENSION_EXCEEDS_PROCEDURE' }),
      }),
    );
    expect(() =>
      planDeadlineEvent(
        p,
        { eventType: 'EXTEND', effectiveAt: iso(T0 + 2 * min), newDeadlineAt: iso(T0 + 41 * min) },
        { pauseAllowed: false, maxExtensionMs: 0 },
      ),
    ).toThrow(expect.objectContaining({ code: 'POLICY_HOLD' }));
    expect(() =>
      planDeadlineEvent(
        p,
        { eventType: 'PAUSE', effectiveAt: iso(T0 + 2 * min) },
        { pauseAllowed: false, maxExtensionMs: 0 },
      ),
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reasonCode: 'PAUSE_NOT_PERMITTED' }) }));
  });

  it('illegal moves are refused: shorten later, extend earlier, resume when running, anything after expiry', () => {
    const events = applyAll([]);
    const p = replayDeadlineEvents(events);
    const at = iso(T0 + min);
    expect(() =>
      planDeadlineEvent(p, { eventType: 'SHORTEN', effectiveAt: at, newDeadlineAt: iso(T0 + 31 * min) }, rules),
    ).toThrow();
    expect(() =>
      planDeadlineEvent(p, { eventType: 'EXTEND', effectiveAt: at, newDeadlineAt: iso(T0 + 29 * min) }, rules),
    ).toThrow();
    expect(() => planDeadlineEvent(p, { eventType: 'RESUME', effectiveAt: at }, rules)).toThrow();
    expect(() => planDeadlineEvent(p, { eventType: 'EXPIRE', effectiveAt: at }, rules)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reasonCode: 'DEADLINE_NOT_REACHED' }) }),
    );
    const expired = applyAll([{ eventType: 'EXPIRE', at: T0 + 31 * min }]);
    const pe = replayDeadlineEvents(expired);
    expect(pe.status).toBe('EXPIRED');
    expect(pe.originalDeadlineAt).toBe(iso(T0 + 30 * min));
    for (const eventType of ['PAUSE', 'RESUME', 'SHORTEN', 'EXTEND', 'EXPIRE'] as const)
      expect(() =>
        planDeadlineEvent(pe, { eventType, effectiveAt: iso(T0 + 32 * min), newDeadlineAt: iso(T0 + 33 * min) }, rules),
      ).toThrow();
  });

  it('a tampered or out-of-sequence ledger does not replay', () => {
    const events = applyAll([{ eventType: 'SHORTEN', at: T0 + min, newDeadlineAt: T0 + 20 * min }]);
    expect(() => replayDeadlineEvents([{ ...events[1]!, priorDeadlineAt: iso(T0 + 31 * min) }, events[0]!])).toThrow();
    expect(() => replayDeadlineEvents([events[1]!])).toThrow();
    expect(() => replayDeadlineEvents([events[0]!, { ...events[1]!, sequence: 3 }])).toThrow();
    expect(() => replayDeadlineEvents([events[0]!, { ...events[0]!, sequence: 2 }])).toThrow();
  });
});
