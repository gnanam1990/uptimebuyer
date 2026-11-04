// T-019 — Incident lifecycle concurrency (FR-04, FR-16, NFR-03). Conflicting recover, reopen, escalate, pause/resume,
// acknowledge, assign, accept, reassign, handoff and deadline pause/resume/shorten/extend commands are serialized by
// the M01 transition table and the aggregate version (compare-and-set): exactly one of a conflicting set wins, no
// update is lost, cross-tenant owners fail, only one assignment is current and accepted, the original deadline
// persists, and replaying the authorized deadline events derives the stored projection.
import { createSite, registerAsset, type TenantContext } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptAssignment,
  acknowledgeIncident,
  adjustIncidentDeadline,
  advanceIncident,
  assignIncident,
  escalateIncident,
  expireIncidentDeadlines,
  getIncident,
  getIncidentTimeline,
  handoffIncident,
  pauseIncident,
  reopenIncident,
  replayDeadlineEvents,
  resumeIncident,
  returnFromEscalation,
  submitManualReport,
  type IncidentView,
} from '../src/index.js';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import {
  HIGH_TEMP_RULE,
  createIncidentWorld,
  freshAsset,
  isoAt,
  person,
  rejection,
  type IncidentWorld,
} from './helpers.js';

let w: IncidentWorld;
const minute = 60_000;

async function openIncident(): Promise<IncidentView> {
  const { assetId } = await freshAsset(w);
  const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
    idempotencyKey: w.key('open'),
    assetId,
    ruleKey: HIGH_TEMP_RULE.ruleKey,
    reasonCode: 'ALARM_PANEL_RED',
  });
  return getIncident(w.db.pool, w.admin, r.incidentId);
}

const get = (id: string) => getIncident(w.db.pool, w.admin, id);

/** Run every command concurrently; return fulfilled count and the rejection codes. */
async function race(cmds: (() => Promise<unknown>)[]) {
  const settled = await Promise.allSettled(cmds.map((f) => f()));
  return {
    ok: settled.filter((s) => s.status === 'fulfilled').length,
    codes: settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => (s.reason as { code?: string }).code),
  };
}

async function ownedBy(inc: IncidentView, owner: { ctx: TenantContext; userId: string }): Promise<IncidentView> {
  let cur = inc;
  if (cur.currentAssignment?.assigneeUserId !== owner.userId) {
    await assignIncident(w.db.pool, w.people.operator!.ctx, cur.incidentId, {
      assigneeUserId: owner.userId as never,
      reasonCode: 'DISPATCH',
      expectedVersion: cur.version,
      idempotencyKey: w.key('assign'),
    });
    cur = await get(cur.incidentId);
  }
  await acceptAssignment(w.db.pool, owner.ctx, cur.incidentId, cur.currentAssignment!.assignmentId, {
    expectedVersion: cur.version,
    idempotencyKey: w.key('accept'),
  });
  return get(cur.incidentId);
}

describe('T-019 incident lifecycle concurrency', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t019');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('conflicting commands against one version: exactly one wins, the rest are VERSION_CONFLICT, nothing is lost', async () => {
    const inc = await openIncident();
    const v = inc.version;
    const op = w.people.operator!.ctx;
    const outcome = await race([
      () => acknowledgeIncident(w.db.pool, op, inc.incidentId, { expectedVersion: v, idempotencyKey: w.key('ack') }),
      () =>
        assignIncident(w.db.pool, op, inc.incidentId, {
          assigneeUserId: w.people.operator2!.userId,
          reasonCode: 'DISPATCH',
          expectedVersion: v,
          idempotencyKey: w.key('a1'),
        }),
      () =>
        assignIncident(w.db.pool, w.people.operator2!.ctx, inc.incidentId, {
          assigneeUserId: w.people.approver!.userId,
          reasonCode: 'DISPATCH',
          expectedVersion: v,
          idempotencyKey: w.key('a2'),
        }),
      () =>
        escalateIncident(w.db.pool, op, inc.incidentId, {
          reasonCode: 'SUPERVISOR_REVIEW',
          expectedVersion: v,
          idempotencyKey: w.key('esc'),
        }),
      () =>
        adjustIncidentDeadline(w.db.pool, op, inc.incidentId, {
          eventType: 'SHORTEN',
          newDeadlineAt: isoAt(Date.parse(inc.currentResponseDeadlineAt) - minute),
          reasonCode: 'HIGH_VALUE_STOCK',
          expectedVersion: v,
          idempotencyKey: w.key('shorten'),
        }),
    ]);
    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual(['VERSION_CONFLICT', 'VERSION_CONFLICT', 'VERSION_CONFLICT', 'VERSION_CONFLICT']);
    const after = await get(inc.incidentId);
    expect(after.version).toBe(v + 1);
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.assignments.filter((a) => a.supersededAt === null)).toHaveLength(1);
    expect(after.originalResponseDeadlineAt).toBe(inc.originalResponseDeadlineAt);
  });

  it('no lost update: 12 concurrent shorten commands that reload and retry all land, in one version chain', async () => {
    const inc = await openIncident();
    const op = w.people.operator!.ctx;
    const shortenOnce = async (i: number) => {
      const key = w.key(`shorten-${i}`);
      for (;;) {
        const cur = await get(inc.incidentId);
        try {
          return await adjustIncidentDeadline(w.db.pool, op, inc.incidentId, {
            eventType: 'SHORTEN',
            newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) - minute),
            reasonCode: 'HIGH_VALUE_STOCK',
            expectedVersion: cur.version,
            idempotencyKey: `${key}-v${cur.version}`,
          });
        } catch (e) {
          if ((e as { code?: string }).code !== 'VERSION_CONFLICT') throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, (_, i) => shortenOnce(i)));
    const after = await get(inc.incidentId);
    expect(after.version).toBe(inc.version + 12);
    expect(Date.parse(after.currentResponseDeadlineAt)).toBe(Date.parse(inc.currentResponseDeadlineAt) - 12 * minute);
    expect(after.originalResponseDeadlineAt).toBe(inc.originalResponseDeadlineAt);
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.deadlineEvents.map((e) => e.sequence)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(timeline.deadlineEvents.map((e) => e.incidentVersion).slice(1)).toEqual(
      Array.from({ length: 12 }, (_, i) => inc.version + 1 + i),
    );
    const replay = replayDeadlineEvents(timeline.deadlineEvents);
    expect(replay).toMatchObject({
      originalDeadlineAt: after.originalResponseDeadlineAt,
      currentDeadlineAt: after.currentResponseDeadlineAt,
      status: after.deadlineStatus,
    });
  });

  it('assignment: concurrent accept and reassign resolve by compare-and-set; one current, accepted owner at most', async () => {
    const inc = await openIncident();
    const initial = inc.currentAssignment!;
    expect(initial.assigneeUserId).toBe(w.people.oncall!.userId);
    const outcome = await race([
      () =>
        acceptAssignment(w.db.pool, w.people.oncall!.ctx, inc.incidentId, initial.assignmentId, {
          expectedVersion: inc.version,
          idempotencyKey: w.key('accept'),
        }),
      () =>
        assignIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          assigneeUserId: w.people.operator2!.userId,
          reasonCode: 'REBALANCE',
          expectedVersion: inc.version,
          idempotencyKey: w.key('reassign'),
        }),
    ]);
    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual(['VERSION_CONFLICT']);
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    const current = timeline.assignments.filter((a) => a.supersededAt === null);
    expect(current).toHaveLength(1);
    expect(
      timeline.assignments.filter((a) => a.supersededAt === null && a.acceptedAt !== null).length,
    ).toBeLessThanOrEqual(1);
    // Only the assigned principal can accept, only the current assignment, and only once.
    const now = await get(inc.incidentId);
    const cur = now.currentAssignment!;
    const notAssignee = cur.assigneeUserId === w.people.oncall!.userId ? w.people.operator2! : w.people.oncall!;
    expect(
      await rejection(
        acceptAssignment(w.db.pool, notAssignee.ctx, inc.incidentId, cur.assignmentId, {
          expectedVersion: now.version,
          idempotencyKey: w.key('accept-x'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'NOT_ASSIGNEE' });
    if (cur.assignmentId !== initial.assignmentId)
      expect(
        await rejection(
          acceptAssignment(w.db.pool, w.people.oncall!.ctx, inc.incidentId, initial.assignmentId, {
            expectedVersion: now.version,
            idempotencyKey: w.key('accept-old'),
          }),
        ),
      ).toMatchObject({ code: 'STATE_TRANSITION_INVALID', reasonCode: 'ASSIGNMENT_NOT_CURRENT' });
    // The database allows one current row per incident whatever the writer.
    await expect(
      w.db.admin(
        `INSERT INTO incident_assignments (tenant_id, id, incident_id, assignee_user_id, assignment_kind, assigned_by_kind,
           assigned_by_id, reason_code, incident_version)
         VALUES ($1, 'ias_forged-0001', $2, $3, 'ASSIGN', 'HUMAN', 'usr_x', 'FORGED', 99)`,
        [w.tenant.tenantId, inc.incidentId, w.people.operator!.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cross-tenant and ineligible owners fail; handoff needs the accepted owner and supersedes it', async () => {
    const inc = await openIncident();
    const other = await seedTenant(w.db.pool, w.idp, 't019-other');
    const site = await createSite(w.db.pool, other.admin, { name: 'other', timezone: 'UTC', source: 'API' });
    await registerAsset(w.db.pool, other.admin, {
      siteId: site.siteId,
      identity: { manufacturer: 'M', model: 'X', serial: 'o-1', safetyClass: 'STANDARD', bomRevision: '1' },
      source: 'API',
    });
    const foreigner = await person(w, 'foreign-op', ['operator'], null, other.admin);
    for (const assigneeUserId of [foreigner.userId, other.adminUserId])
      expect(
        await rejection(
          assignIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
            assigneeUserId,
            reasonCode: 'DISPATCH',
            expectedVersion: inc.version,
            idempotencyKey: w.key('foreign'),
          }),
        ),
      ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    // A member without an operating role at the incident's site cannot own it.
    expect(
      await rejection(
        assignIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          assigneeUserId: w.people.viewer!.userId,
          reasonCode: 'DISPATCH',
          expectedVersion: inc.version,
          idempotencyKey: w.key('viewer'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ASSIGNEE_NOT_ELIGIBLE' });
    // The foreign tenant's own context cannot see or touch the incident at all.
    expect(
      await rejection(
        acknowledgeIncident(w.db.pool, foreigner.ctx, inc.incidentId, {
          expectedVersion: inc.version,
          idempotencyKey: w.key('foreign-ack'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    // Composite tenant FK: the database refuses a foreign assignee whatever the writer.
    await expect(
      w.db.admin(
        `INSERT INTO incident_assignments (tenant_id, id, incident_id, assignee_user_id, assignment_kind, assigned_by_kind,
           assigned_by_id, reason_code, incident_version, superseded_at, superseded_by_assignment_id)
         VALUES ($1, 'ias_forged-0002', $2, $3, 'ASSIGN', 'HUMAN', 'usr_x', 'FORGED', 99, now(), $4)`,
        [w.tenant.tenantId, inc.incidentId, foreigner.userId, inc.currentAssignment!.assignmentId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // Handoff: refused before acceptance, allowed for the accepted current owner with a due time and reason.
    expect(
      await rejection(
        handoffIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
          nextOwnerUserId: w.people.operator2!.userId,
          reasonCode: 'SHIFT_CHANGE',
          nextActionDueAt: isoAt(Date.now() + 10 * minute),
          expectedVersion: inc.version,
          idempotencyKey: w.key('handoff-early'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'NOT_ACCEPTED_OWNER' });
    const owned = await ownedBy(inc, w.people.oncall!);
    const handoff = await handoffIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
      nextOwnerUserId: w.people.operator2!.userId,
      reasonCode: 'SHIFT_CHANGE',
      nextActionDueAt: isoAt(Date.now() + 10 * minute),
      expectedVersion: owned.version,
      idempotencyKey: w.key('handoff'),
    });
    const after = await get(inc.incidentId);
    expect(after.currentAssignment).toMatchObject({
      assignmentId: handoff.assignmentId,
      assigneeUserId: w.people.operator2!.userId,
      assignmentKind: 'HANDOFF',
      acceptedAt: null,
      handoffFromAssignmentId: owned.currentAssignment!.assignmentId,
    });
    expect(after.currentAssignment!.handoffDigest).toMatch(/^incident-handoff\.v1:sha256:/);
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.assignments.filter((a) => a.supersededAt === null)).toHaveLength(1);
    expect(timeline.assignments.find((a) => a.assignmentId === owned.currentAssignment!.assignmentId)).toMatchObject({
      supersededByAssignmentId: handoff.assignmentId,
    });
  });

  it('escalation re-entry and pause/resume need the accepted current owner; resume restores the recorded state', async () => {
    const inc = await openIncident();
    await escalateIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
      reasonCode: 'SUPERVISOR_REVIEW',
      expectedVersion: inc.version,
      idempotencyKey: w.key('esc'),
    });
    let cur = await get(inc.incidentId);
    expect(cur.state).toBe('ESCALATED');
    expect(
      await rejection(
        returnFromEscalation(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          to: 'TRIAGING',
          reasonCode: 'REVIEWED',
          expectedVersion: cur.version,
          idempotencyKey: w.key('reenter'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'NOT_ACCEPTED_OWNER' });
    cur = await ownedBy(cur, w.people.oncall!);
    // Pausing from ESCALATED is not an M01 edge.
    expect(
      await rejection(
        pauseIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
          reasonCode: 'AWAIT_ACCESS',
          expectedVersion: cur.version,
          idempotencyKey: w.key('pause-esc'),
        }),
      ),
    ).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    await returnFromEscalation(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
      to: 'AWAITING_EVIDENCE',
      reasonCode: 'REVIEWED',
      expectedVersion: cur.version,
      idempotencyKey: w.key('reenter'),
    });
    cur = await get(inc.incidentId);
    expect(cur.state).toBe('AWAITING_EVIDENCE');
    expect(
      await rejection(
        pauseIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          reasonCode: 'AWAIT_ACCESS',
          expectedVersion: cur.version,
          idempotencyKey: w.key('pause-x'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'NOT_ACCEPTED_OWNER' });
    // Concurrent pause and escalate on the same version: one wins.
    const outcome = await race([
      () =>
        pauseIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
          reasonCode: 'AWAIT_ACCESS',
          expectedVersion: cur.version,
          idempotencyKey: w.key('pause'),
        }),
      () =>
        escalateIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          reasonCode: 'SUPERVISOR_REVIEW',
          expectedVersion: cur.version,
          idempotencyKey: w.key('esc2'),
        }),
    ]);
    expect(outcome.ok).toBe(1);
    cur = await get(inc.incidentId);
    if (cur.state === 'ESCALATED') {
      cur = await get(inc.incidentId);
      await returnFromEscalation(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
        to: 'AWAITING_EVIDENCE',
        reasonCode: 'REVIEWED',
        expectedVersion: cur.version,
        idempotencyKey: w.key('reenter2'),
      });
      cur = await get(inc.incidentId);
      await pauseIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
        reasonCode: 'AWAIT_ACCESS',
        expectedVersion: cur.version,
        idempotencyKey: w.key('pause2'),
      });
      cur = await get(inc.incidentId);
    }
    expect(cur).toMatchObject({ state: 'PAUSED', pausedFromState: 'AWAITING_EVIDENCE' });
    await resumeIncident(w.db.pool, w.people.oncall!.ctx, inc.incidentId, {
      reasonCode: 'ACCESS_GRANTED',
      expectedVersion: cur.version,
      idempotencyKey: w.key('resume'),
    });
    expect(await get(inc.incidentId)).toMatchObject({ state: 'AWAITING_EVIDENCE', pausedFromState: null });
  });

  it('recover vs escalate race, then authorized reopen: legal transitions only, one winner, history kept', async () => {
    const inc = await openIncident();
    let cur = inc;
    for (const to of ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING'] as const) {
      await advanceIncident(w.db.pool, w.service, inc.incidentId, {
        to,
        reasonCode: `FIXTURE_${to}`,
        guardRef: 'evr_fixture-guard-0001',
        expectedVersion: cur.version,
        idempotencyKey: w.key(to),
      });
      cur = await get(inc.incidentId);
    }
    const outcome = await race([
      () =>
        advanceIncident(w.db.pool, w.service, inc.incidentId, {
          to: 'RECOVERED',
          reasonCode: 'RECOVERY_PASSED',
          guardRef: 'rev_fixture-passed-0001',
          expectedVersion: cur.version,
          idempotencyKey: w.key('recover'),
        }),
      () =>
        escalateIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          reasonCode: 'FAILED_INTERVENTION',
          expectedVersion: cur.version,
          idempotencyKey: w.key('esc'),
        }),
    ]);
    expect(outcome.ok).toBe(1);
    expect(outcome.codes).toEqual(['VERSION_CONFLICT']);
    cur = await get(inc.incidentId);
    if (cur.state === 'ESCALATED') {
      // Reaching RECOVERED from ESCALATED is not an M01 edge.
      expect(
        await rejection(
          advanceIncident(w.db.pool, w.service, inc.incidentId, {
            to: 'RECOVERED',
            reasonCode: 'RECOVERY_PASSED',
            guardRef: 'rev_fixture-passed-0001',
            expectedVersion: cur.version,
            idempotencyKey: w.key('recover-late'),
          }),
        ),
      ).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
      return;
    }
    expect(cur.state).toBe('RECOVERED');
    // RECOVERED may only go to REOPENED: escalate, pause and advance are refused.
    expect(
      await rejection(
        escalateIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          reasonCode: 'LATE',
          expectedVersion: cur.version,
          idempotencyKey: w.key('esc-late'),
        }),
      ),
    ).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    // Only an authorized human may reopen; two concurrent reopens produce one.
    expect(
      await rejection(
        reopenIncident(w.db.pool, w.people.viewer!.ctx, inc.incidentId, {
          reasonCode: 'RECURRENCE',
          expectedVersion: cur.version,
          idempotencyKey: w.key('reopen-viewer'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    const reopen = await race(
      [w.people.operator!, w.people.operator2!].map(
        (p) => () =>
          reopenIncident(w.db.pool, p.ctx, inc.incidentId, {
            reasonCode: 'RECURRENCE',
            note: 'cabinet warm again',
            expectedVersion: cur.version,
            idempotencyKey: w.key('reopen'),
          }),
      ),
    );
    expect(reopen.ok).toBe(1);
    const after = await get(inc.incidentId);
    expect(after).toMatchObject({ state: 'TRIAGING', reopenCount: 1, version: cur.version + 2 });
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.transitions.slice(-3).map((t) => `${t.fromState}>${t.toState}`)).toEqual([
      'VERIFYING>RECOVERED',
      'RECOVERED>REOPENED',
      'REOPENED>TRIAGING',
    ]);
    expect(timeline.manualReports.filter((r) => r.reportKind === 'REOPEN_EVIDENCE')).toHaveLength(1);
  });

  it('deadline pause/resume/shorten/extend/expire are authorized, append-only, replayable and never touch the original', async () => {
    const inc = await openIncident();
    const approver = w.people.approver!.ctx;
    const op = w.people.operator!.ctx;
    let cur = inc;
    const step = async (
      ctx: TenantContext,
      eventType: 'PAUSE' | 'RESUME' | 'SHORTEN' | 'EXTEND',
      newDeadlineAt?: string,
    ) => {
      await adjustIncidentDeadline(w.db.pool, ctx, inc.incidentId, {
        eventType,
        ...(newDeadlineAt ? { newDeadlineAt } : {}),
        reasonCode: `REASON_${eventType}`,
        expectedVersion: cur.version,
        idempotencyKey: w.key(eventType),
      });
      cur = await get(inc.incidentId);
    };
    // PAUSE needs the procedure's adjust role.
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, op, inc.incidentId, {
          eventType: 'PAUSE',
          reasonCode: 'DOOR_LOCKED',
          expectedVersion: cur.version,
          idempotencyKey: w.key('pause-op'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PROCEDURE_ROLE_REQUIRED' });
    await step(approver, 'PAUSE');
    expect(cur.deadlineStatus).toBe('PAUSED');
    await step(op, 'RESUME');
    expect(cur.deadlineStatus).toBe('RUNNING');
    await step(op, 'SHORTEN', isoAt(Date.parse(cur.currentResponseDeadlineAt) - 5 * minute));
    await step(approver, 'EXTEND', isoAt(Date.parse(cur.currentResponseDeadlineAt) + 10 * minute));
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, approver, inc.incidentId, {
          eventType: 'EXTEND',
          newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) + 6 * minute),
          reasonCode: 'MORE',
          expectedVersion: cur.version,
          idempotencyKey: w.key('extend-more'),
        }),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'EXTENSION_EXCEEDS_PROCEDURE' });
    // Unknown or client-supplied procedure fields are refused outright.
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, approver, inc.incidentId, {
          eventType: 'EXTEND',
          newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) + minute),
          reasonCode: 'MORE',
          expectedVersion: cur.version,
          idempotencyKey: w.key('extend-proc'),
          procedureRevisionId: 'opr_attacker-chosen-0001',
        } as never),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });

    // The deadline sweep expires the overdue deadline and escalates the live incident.
    const expired = await expireIncidentDeadlines(w.db.pool, w.service, {
      now: isoAt(Date.parse(cur.currentResponseDeadlineAt) + minute),
    });
    expect(expired.expired).toContain(inc.incidentId);
    cur = await get(inc.incidentId);
    expect(cur).toMatchObject({ deadlineStatus: 'EXPIRED', state: 'ESCALATED' });
    expect(cur.originalResponseDeadlineAt).toBe(inc.originalResponseDeadlineAt);
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, approver, inc.incidentId, {
          eventType: 'EXTEND',
          newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) + minute),
          reasonCode: 'TOO_LATE',
          expectedVersion: cur.version,
          idempotencyKey: w.key('extend-late'),
        }),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'DEADLINE_EXPIRED' });

    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.deadlineEvents.map((e) => e.eventType)).toEqual([
      'SET',
      'PAUSE',
      'RESUME',
      'SHORTEN',
      'EXTEND',
      'EXPIRE',
    ]);
    for (const e of timeline.deadlineEvents) {
      expect(e.procedureRevisionId).toBe(inc.procedureRevisionId);
      expect(e.basisDigest).toBe(inc.deadlineBasisDigest);
      expect(e.reasonCode).toMatch(/^[A-Z]/);
      expect(e.authorizedBy.id).toMatch(/^(usr|svc)_/);
    }
    expect(timeline.deadlineEvents.find((e) => e.eventType === 'EXTEND')!.authorizedRole).toBe('maintenance_approver');
    expect(replayDeadlineEvents(timeline.deadlineEvents)).toMatchObject({
      originalDeadlineAt: cur.originalResponseDeadlineAt,
      currentDeadlineAt: cur.currentResponseDeadlineAt,
      status: 'EXPIRED',
      extendedMs: 10 * minute,
    });
    await expect(
      w.db.admin(`UPDATE incident_deadline_events SET new_deadline_at = now() WHERE incident_id = $1`, [
        inc.incidentId,
      ]),
    ).rejects.toMatchObject({ code: 'UB001' });
    await expect(
      w.db.admin(`DELETE FROM incident_deadline_events WHERE incident_id = $1`, [inc.incidentId]),
    ).rejects.toMatchObject({ code: 'UB001' });
    // An expired deadline cannot be revived by any writer.
    await expect(
      w.db.admin(`UPDATE incidents SET deadline_status = 'RUNNING', version = version + 1 WHERE id = $1`, [
        inc.incidentId,
      ]),
    ).rejects.toMatchObject({ code: 'UB042' });
  });

  it('idempotency keys: an identical retry returns the original result; reuse with a different request is refused', async () => {
    const inc = await openIncident();
    const op = w.people.operator!.ctx;
    const key = w.key('idem');
    const input = { expectedVersion: inc.version, idempotencyKey: key };
    const first = await acknowledgeIncident(w.db.pool, op, inc.incidentId, input);
    const again = await acknowledgeIncident(w.db.pool, op, inc.incidentId, input);
    expect(again).toEqual(first);
    expect((await get(inc.incidentId)).version).toBe(inc.version + 1);
    expect(
      await rejection(
        escalateIncident(w.db.pool, op, inc.incidentId, {
          reasonCode: 'X',
          expectedVersion: inc.version + 1,
          idempotencyKey: key,
        }),
      ),
    ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(
      await rejection(acknowledgeIncident(w.db.pool, w.people.operator2!.ctx, inc.incidentId, input)),
    ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
