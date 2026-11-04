// T-018 — Concurrent trigger deduplication (FR-03, INV-09, NFR-03). Many simultaneous telemetry evaluations and
// manual reports for one asset/fault window converge on one active incident (one recovery authority) through the
// database partial unique index, not arrival order; corroborating evidence is appended. A qualifying trigger on a
// RECOVERED incident inside its watch window reopens that incident exactly once instead of inserting another.
import { publishIncidentRule } from '../src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceIncident,
  evaluateIncidentRules,
  getIncident,
  getIncidentTimeline,
  submitManualReport,
  type IncidentState,
} from '../src/index.js';
import { HIGH_TEMP_RULE, createIncidentWorld, freshAsset, isoAt, liveRun, type IncidentWorld } from './helpers.js';

let w: IncidentWorld;
const HOT = [9_000, 9_200, 9_400, 9_600, 9_800];
const MAIN_PATH: IncidentState[] = ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING', 'RECOVERED'];

async function driveToRecovered(incidentId: string): Promise<void> {
  for (const to of MAIN_PATH) {
    const inc = await getIncident(w.db.pool, w.service, incidentId);
    await advanceIncident(w.db.pool, w.service, incidentId, {
      to,
      reasonCode: `FIXTURE_${to}`,
      guardRef: to === 'RECOVERED' ? 'rev_fixture-passed-0001' : 'evr_fixture-guard-0001',
      expectedVersion: inc.version,
      idempotencyKey: w.key(`advance-${to}`),
    });
  }
}

async function activeCount(assetId: string): Promise<{ total: number; active: number }> {
  const r = await w.db.admin(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE state <> 'RECOVERED')::int AS active FROM incidents WHERE asset_id = $1`,
    [assetId],
  );
  return r.rows[0];
}

describe('T-018 concurrent trigger deduplication', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t018');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('simultaneous telemetry evaluations and manual reports converge on exactly one active incident', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, HOT);
    const telemetry = Array.from({ length: 10 }, () =>
      evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) }).then((r) => r.evaluations[0]!),
    );
    const reports = Array.from({ length: 6 }, (_, i) =>
      submitManualReport(w.db.pool, (i % 2 ? w.people.operator : w.people.operator2)!.ctx, {
        idempotencyKey: w.key(`report-${i}`),
        assetId,
        ruleKey: HIGH_TEMP_RULE.ruleKey,
        reasonCode: 'CABINET_WARM_TO_TOUCH',
        note: `report ${i}`,
      }),
    );
    const results = await Promise.all([...telemetry, ...reports]);
    const ids = new Set(results.map((r) => r.incidentId));
    expect(ids.size).toBe(1);
    const incidentId = [...ids][0]!;
    expect(results.filter((r) => r.outcome === 'OPENED')).toHaveLength(1);
    for (const r of results) expect(['OPENED', 'ATTACHED', 'DUPLICATE']).toContain(r.outcome);
    expect(await activeCount(assetId)).toEqual({ total: 1, active: 1 });

    const timeline = await getIncidentTimeline(w.db.pool, w.admin, incidentId);
    // Every report is linked; the identical telemetry window is linked once, not once per evaluation.
    expect(timeline.signals.filter((s) => s.signalKind === 'MANUAL_REPORT')).toHaveLength(6);
    expect(timeline.signals.filter((s) => s.signalKind === 'TELEMETRY_TRIGGER')).toHaveLength(1);
    expect(timeline.manualReports).toHaveLength(6);
    expect(timeline.signals.filter((s) => s.outcome === 'OPENED')).toHaveLength(1);
    expect(timeline.assignments).toHaveLength(1);
    expect(timeline.deadlineEvents).toHaveLength(1);
    const opened = await w.db.admin(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'incident.opened.v1'`,
      [incidentId],
    );
    expect(opened.rows[0].n).toBe(1);

    // The database itself refuses a second active incident for the same tenant/site/asset/fault window.
    await expect(
      w.db.admin(
        `INSERT INTO incidents (tenant_id, id, site_id, asset_id, asset_revision_id, rule_revision_id, procedure_revision_id,
           policy_revision_id, trigger_kind, trigger_input_origin, state, fault_family, fault_window_key, urgency,
           trigger_event_at, trigger_received_at, opened_at, open_latency_ms, deadline_kind, deadline_basis,
           deadline_basis_at, deadline_computed_at, deadline_basis_digest, deadline_timezone_basis,
           original_response_deadline_at, current_response_deadline_at, deadline_status, correlation_id, version)
         SELECT tenant_id, 'inc_forged-duplicate-0001', site_id, asset_id, asset_revision_id, rule_revision_id,
           procedure_revision_id, policy_revision_id, trigger_kind, trigger_input_origin, 'TRIAGING', fault_family,
           fault_window_key, urgency, trigger_event_at, trigger_received_at, opened_at, open_latency_ms, deadline_kind,
           deadline_basis, deadline_basis_at, deadline_computed_at, deadline_basis_digest, deadline_timezone_basis,
           original_response_deadline_at, current_response_deadline_at, deadline_status, correlation_id, 1
         FROM incidents WHERE id = $1`,
        [incidentId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // ... and a writer cannot choose the dedupe key to dodge it.
    await expect(
      w.db.admin(`UPDATE incidents SET dedupe_key = 'x', version = version + 1 WHERE id = $1`, [incidentId]),
    ).rejects.toMatchObject({ code: '428C9' });
  });

  it('a RECOVERED incident inside its watch window is reopened exactly once by concurrent triggers', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, HOT);
    const incidentId = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) }))
      .evaluations[0]!.incidentId!;
    await driveToRecovered(incidentId);
    expect((await getIncident(w.db.pool, w.admin, incidentId)).state).toBe('RECOVERED');

    const again = await liveRun(w, device, HOT);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () =>
        evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(again.at) }).then((r) => r.evaluations[0]!),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          idempotencyKey: w.key(`recur-${i}`),
          assetId,
          ruleKey: HIGH_TEMP_RULE.ruleKey,
          reasonCode: 'RECURRENCE_OBSERVED',
        }),
      ),
    ]);
    expect(new Set(results.map((r) => r.incidentId))).toEqual(new Set([incidentId]));
    expect(results.filter((r) => r.outcome === 'REOPENED')).toHaveLength(1);
    expect(await activeCount(assetId)).toEqual({ total: 1, active: 1 });

    const inc = await getIncident(w.db.pool, w.admin, incidentId);
    expect(inc).toMatchObject({ state: 'TRIAGING', reopenCount: 1, recoveredAt: null });
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, incidentId);
    const path = timeline.transitions.map((t) => `${t.fromState ?? '-'}>${t.toState}`);
    expect(path.filter((p) => p === 'RECOVERED>REOPENED')).toHaveLength(1);
    expect(path.slice(-2)).toEqual(['RECOVERED>REOPENED', 'REOPENED>TRIAGING']);
    // History is preserved: the original opening signal and the recovery transition are still there.
    expect(path).toContain('VERIFYING>RECOVERED');
    expect(timeline.signals.filter((s) => s.outcome === 'OPENED')).toHaveLength(1);
    expect(timeline.signals.filter((s) => s.outcome === 'REOPENED')).toHaveLength(1);
    const reopened = await w.db.admin(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'incident.reopened.v1'`,
      [incidentId],
    );
    expect(reopened.rows[0].n).toBe(1);
  });

  it('outside the watch window a new incident opens, and still only one is active per fault window', async () => {
    await publishIncidentRule(w.db.pool, w.admin, {
      ...HIGH_TEMP_RULE,
      ruleKey: 'freezer-temp-high',
      faultWindowKey: 'freezer-temperature',
      watchWindowMs: 0,
    });
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, HOT);
    const first = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) })).evaluations;
    expect(first.map((e) => e.outcome).sort()).toEqual(['OPENED', 'OPENED']);
    const freezer = first.find((e) => e.ruleKey === 'freezer-temp-high')!.incidentId!;
    await driveToRecovered(freezer);
    const again = await liveRun(w, device, HOT);
    const second = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(again.at) })).evaluations;
    const freezer2 = second.find((e) => e.ruleKey === 'freezer-temp-high')!;
    expect(freezer2.outcome).toBe('OPENED');
    expect(freezer2.incidentId).not.toBe(freezer);
    expect(second.find((e) => e.ruleKey === HIGH_TEMP_RULE.ruleKey)!.outcome).toBe('ATTACHED');
    const r = await w.db.admin(
      `SELECT fault_window_key, count(*)::int AS total, count(*) FILTER (WHERE state <> 'RECOVERED')::int AS active
         FROM incidents WHERE asset_id = $1 GROUP BY fault_window_key ORDER BY fault_window_key`,
      [assetId],
    );
    expect(r.rows).toEqual([
      { fault_window_key: 'cabinet-temperature', total: 1, active: 1 },
      { fault_window_key: 'freezer-temperature', total: 2, active: 1 },
    ]);
  });
});
