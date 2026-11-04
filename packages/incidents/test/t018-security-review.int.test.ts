// Security-review regressions (M04 self-review) on the T-018/T-019/T-020 surfaces:
// - a long breach re-evaluated after every reading must link each device sample once (no quadratic evidence growth);
// - oversized identifiers are rejected as invalid input before any lookup;
// - an Idempotency-Key shared by a manual report and a lifecycle command on the same incident serializes on one
//   lock order (no deadlock), and exactly one use wins;
// - an assignment or handoff cannot be due in the past.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeIncident,
  assignIncident,
  evaluateIncidentRules,
  getIncident,
  getIncidentTimeline,
  listIncidents,
  submitManualReport,
} from '../src/index.js';
import {
  HIGH_TEMP_RULE,
  createIncidentWorld,
  freshAsset,
  isoAt,
  liveRun,
  rejection,
  type IncidentWorld,
} from './helpers.js';

let w: IncidentWorld;
const HOT = [9_000, 9_200, 9_400, 9_600, 9_800];

describe('T-018/T-019/T-020 security-review regressions', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('m04sec');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('T-018: re-evaluating an ongoing breach links each new sample once, never the whole run again', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, HOT);
    const opened = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) })).evaluations[0]!;
    expect(opened.outcome).toBe('OPENED');
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) {
      const more = await liveRun(w, device, [10_000 + i]);
      extra.push(...more.sampleIds);
      const e = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(more.at) })).evaluations[0]!;
      expect(e).toMatchObject({ outcome: 'ATTACHED', incidentId: opened.incidentId });
    }
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, opened.incidentId!);
    const telemetry = timeline.signals.filter((s) => s.signalKind === 'TELEMETRY_TRIGGER');
    expect(telemetry).toHaveLength(5);
    expect(telemetry.slice(1).map((s) => s.samples.map((x) => x.sampleId))).toEqual(extra.map((id) => [id]));
    const links = await w.db.admin(
      `SELECT count(*)::int AS n, count(DISTINCT sample_id)::int AS d FROM incident_signal_samples s
         JOIN incident_signals g ON g.tenant_id = s.tenant_id AND g.id = s.signal_id WHERE g.incident_id = $1`,
      [opened.incidentId],
    );
    expect(links.rows[0]).toEqual({ n: 9, d: 9 });
  });

  it('T-020: oversized identifiers are invalid input, not lookups', async () => {
    const huge = `ast_${'a'.repeat(10_000)}`;
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          idempotencyKey: w.key('huge'),
          assetId: huge,
          ruleKey: HIGH_TEMP_RULE.ruleKey,
          reasonCode: 'X',
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await rejection(evaluateIncidentRules(w.db.pool, w.service, { assetId: huge }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      await rejection(listIncidents(w.db.pool, w.people.operator!.ctx, { siteId: `sit_${'b'.repeat(10_000)}` })),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const { assetId } = await freshAsset(w);
    const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
      idempotencyKey: w.key('ok'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'X',
    });
    const inc = await getIncident(w.db.pool, w.admin, r.incidentId);
    expect(
      await rejection(
        assignIncident(w.db.pool, w.people.operator!.ctx, r.incidentId, {
          assigneeUserId: `usr_${'c'.repeat(10_000)}`,
          reasonCode: 'X',
          expectedVersion: inc.version,
          idempotencyKey: w.key('as'),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('T-019: a key shared by a report and a lifecycle command on one incident serializes; one use wins, no deadlock', async () => {
    for (let i = 0; i < 8; i++) {
      const { assetId } = await freshAsset(w);
      const first = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
        idempotencyKey: w.key(`seed-${i}`),
        assetId,
        ruleKey: HIGH_TEMP_RULE.ruleKey,
        reasonCode: 'SEED',
      });
      const inc = await getIncident(w.db.pool, w.admin, first.incidentId);
      const key = w.key(`shared-${i}`);
      const settled = await Promise.allSettled([
        acknowledgeIncident(w.db.pool, w.people.operator!.ctx, first.incidentId, {
          expectedVersion: inc.version,
          idempotencyKey: key,
        }),
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          idempotencyKey: key,
          assetId,
          ruleKey: HIGH_TEMP_RULE.ruleKey,
          reasonCode: 'SECOND',
        }),
      ]);
      const codes = settled.map((s) => (s.status === 'rejected' ? (s.reason as { code?: string }).code : 'OK'));
      expect(codes.sort(), `iteration ${i}`).toEqual(['IDEMPOTENCY_KEY_REUSED', 'OK']);
    }
  });

  it('T-019: an assignment or handoff cannot be due in the past', async () => {
    const { assetId } = await freshAsset(w);
    const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
      idempotencyKey: w.key('due'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'X',
    });
    const inc = await getIncident(w.db.pool, w.admin, r.incidentId);
    expect(
      await rejection(
        assignIncident(w.db.pool, w.people.operator!.ctx, r.incidentId, {
          assigneeUserId: w.people.operator2!.userId,
          reasonCode: 'DISPATCH',
          nextActionDueAt: isoAt(Date.now() - 60_000),
          expectedVersion: inc.version,
          idempotencyKey: w.key('past'),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', reasonCode: 'NEXT_ACTION_DUE_IN_PAST' });
  });
});
