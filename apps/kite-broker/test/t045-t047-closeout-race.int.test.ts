// T-045 / T-047 concurrency and restart (NFR-02, NFR-03, INV-01, INV-03). Closeout uniqueness and the RECOVERED
// transition commit in ONE transaction with the PASSED evaluation, its pinned samples/signoffs and the manifest, so
// concurrent assessors racing new signoff evidence converge on exactly one closeout whose manifest is exactly the
// evidence set the PASSED evaluation pinned. A crash before commit leaves nothing behind; a retry closes once; a
// repeated Idempotency-Key returns the original result; concurrent first assessments open one evaluation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessRecovery } from '@uptimebuyer/recovery';
import {
  assess,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  milestoneAt,
  readings,
  sendCmms,
  steady,
  transitionPath,
  verifyingIncident,
  type RecoveryWorld,
  iso,
} from './m11-helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t047r');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;
const rows = async (sql: string, p: unknown[]) => (await w.db.pool.query(sql, p)).rows;

describe('T-045/T-047 closeout race, restart and idempotency', () => {
  it('concurrent assessors racing new signoffs converge on one closeout with one consistent evidence set', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const asOf = m.boundaryMs + 61_500;
    const assessors = Array.from({ length: 8 }, (_, i) =>
      assessRecovery(
        w.db.pool,
        w.service,
        { incidentId: v.incidentId, idempotencyKey: w.key(`race-${i}`), asOf: iso(asOf) },
        w.recoverySigning,
      ),
    );
    const extraSignoffs = Array.from({ length: 4 }, () => sendCmms(w, w.cmms, cmmsRecord(v, m.boundaryMs + 2_000)));
    const results = await Promise.all(assessors);
    await Promise.all(extraSignoffs);
    const closeoutIds = new Set(results.map((r) => r.closeoutId));
    expect(closeoutIds.size).toBe(1);
    expect([...closeoutIds][0]).toMatch(/^rco_/);
    expect(results.every((r) => r.outcome === 'PASSED' || r.outcome === 'ALREADY_RECOVERED')).toBe(true);
    expect(results.filter((r) => r.outcome === 'PASSED')).toHaveLength(1);

    const closeouts = await rows(`SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [
      t(),
      v.incidentId,
    ]);
    expect(closeouts).toHaveLength(1);
    const passed = await rows(
      `SELECT id FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state = 'PASSED'`,
      [t(), v.incidentId],
    );
    expect(passed).toEqual([{ id: closeouts[0].evaluation_id }]);
    const pinnedSignoffs = (
      await rows(
        `SELECT DISTINCT evidence_id FROM recovery_evaluation_signoffs WHERE tenant_id = $1 AND evaluation_id = $2`,
        [t(), closeouts[0].evaluation_id],
      )
    ).map((r) => r.evidence_id as string);
    expect([...closeouts[0].manifest.signoffEvidenceIds].sort()).toEqual(pinnedSignoffs.sort());
    const pinnedSamples = (
      await rows(
        `SELECT sample_id FROM recovery_evaluation_samples WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY ordinal`,
        [t(), closeouts[0].evaluation_id],
      )
    ).map((r) => r.sample_id);
    expect(closeouts[0].manifest.sampleIds).toEqual(pinnedSamples);
    const recoveredEdges = await rows(
      `SELECT guard_ref FROM incident_transitions WHERE tenant_id = $1 AND incident_id = $2 AND to_state = 'RECOVERED'`,
      [t(), v.incidentId],
    );
    expect(recoveredEdges).toEqual([{ guard_ref: closeouts[0].evaluation_id }]);
    const assessed = await rows(
      `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND event_type = 'incident.recovered.v1' AND aggregate_id = $2`,
      [t(), v.incidentId],
    );
    expect(assessed[0].n).toBe(1);
    const updates = await rows(
      `SELECT count(*)::int AS n FROM cmms_work_order_updates WHERE tenant_id = $1 AND incident_id = $2 AND update_kind = 'CLOSEOUT'`,
      [t(), v.incidentId],
    );
    expect(updates[0].n).toBe(1);
  });

  it('a crash inside the closeout transaction leaves nothing; the retry closes exactly once', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const input = { incidentId: v.incidentId, idempotencyKey: w.key('crash'), asOf: iso(m.boundaryMs + 61_500) };
    await expect(
      assessRecovery(w.db.pool, w.service, input, w.recoverySigning, {
        faults: {
          afterCloseout() {
            throw new Error('assessor crashed before commit');
          },
        },
      }),
    ).rejects.toThrow('assessor crashed before commit');
    expect(
      await rows(`SELECT id FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [t(), v.incidentId]),
    ).toEqual([]);
    expect(
      await rows(`SELECT state FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2`, [
        t(),
        v.incidentId,
      ]),
    ).toEqual([{ state: 'OBSERVING' }]);
    expect(
      await rows(
        `SELECT count(*)::int AS n FROM recovery_evaluation_samples WHERE tenant_id = $1 AND evaluation_id IN
      (SELECT id FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2)`,
        [t(), v.incidentId],
      ),
    ).toEqual([{ n: 0 }]);
    expect((await transitionPath(w, v.incidentId)).at(-1)).toMatch(/>VERIFYING$/);
    const ok = await assessRecovery(w.db.pool, w.service, input, w.recoverySigning);
    expect(ok.outcome).toBe('PASSED');
    // The same Idempotency-Key replays the original result; another key sees the recovered incident.
    const replay = await assessRecovery(w.db.pool, w.service, input, w.recoverySigning);
    expect(replay).toEqual(ok);
    expect(await assess(w, v)).toMatchObject({ outcome: 'ALREADY_RECOVERED', closeoutId: ok.closeoutId });
    // Reusing the key for another incident is refused.
    const other = await verifyingIncident(w);
    await expect(
      assessRecovery(w.db.pool, w.service, { ...input, incidentId: other.incidentId }, w.recoverySigning),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('concurrent first assessments open exactly one evaluation', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const out = await Promise.all(Array.from({ length: 6 }, () => assess(w, v, m.boundaryMs + 1_000)));
    expect(new Set(out.map((o) => o.recoveryEvaluationId)).size).toBe(1);
    expect(out.every((o) => o.outcome === 'OBSERVING')).toBe(true);
    const evs = await rows(`SELECT state FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2`, [
      t(),
      v.incidentId,
    ]);
    expect(evs).toEqual([{ state: 'OBSERVING' }]);
  });
});
