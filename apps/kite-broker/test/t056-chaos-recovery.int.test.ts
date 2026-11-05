// T-056 chaos restart and recovery — recovery boundary (INV-01, INV-14, NFR-02). The assessor is killed after writing
// the closeout and before commit (the existing afterCloseout seam), and with its database connection dying at the
// evaluation write; a CMMS writer is killed after the adapter call (the existing afterSend seam). A restarted
// assessor/writer converges to exactly one closeout, one RECOVERED edge and one applied CMMS update. Under the same
// crash-and-restart, telemetry that is boundary-equal, pre-intervention, late, backfilled, a backfill with a fresh
// LIVE tail, or on a superseded (wrong) channel revision never produces PASSED or RECOVERED.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviseSensorChannel } from '@uptimebuyer/data';
import { getIncident } from '@uptimebuyer/incidents';
import { ContractFakeCmmsAdapter, assessRecovery, runCmmsWrites } from '@uptimebuyer/recovery';
import {
  assess,
  createRecoveryWorld,
  dbNowMs,
  iso,
  milestoneAt,
  readings,
  steady,
  transitionPath,
  verifyingIncident,
  type Reading,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';
import { FaultyPool } from './support/faulty-pool.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t056r');
});
afterAll(async () => {
  await w?.close();
});

const closeouts = async (incidentId: string) =>
  (
    await w.db.pool.query(`SELECT id FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [
      w.tenant.tenantId,
      incidentId,
    ])
  ).rows;
const assessWith = (
  pool: unknown,
  v: { incidentId: string },
  asOfMs: number,
  faults?: { afterCloseout?: () => void },
) =>
  assessRecovery(
    pool as never,
    w.service,
    { incidentId: v.incidentId, idempotencyKey: w.key('assess'), asOf: iso(asOfMs) },
    w.recoverySigning,
    faults ? { faults } : {},
  );

describe('T-056 recovery closeout crash', () => {
  it('an assessor killed after writing the closeout (before commit) leaves nothing; the restart closes exactly once', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    await expect(
      assessWith(w.db.pool, v, m.boundaryMs + 61_500, {
        afterCloseout() {
          throw new Error('assessor killed');
        },
      }),
    ).rejects.toThrow('assessor killed');
    expect(await closeouts(v.incidentId)).toHaveLength(0);
    expect((await getIncident(w.db.pool, w.viewerCtx, v.incidentId)).state).toBe('VERIFYING');
    const r = await assess(w, v, m.boundaryMs + 61_600);
    expect(r).toMatchObject({ outcome: 'PASSED', incidentState: 'RECOVERED' });
    expect(await closeouts(v.incidentId)).toHaveLength(1);
    expect((await transitionPath(w, v.incidentId)).filter((t) => t === 'VERIFYING>RECOVERED')).toHaveLength(1);

    // CMMS writer killed after the adapter call: restarted writers converge to one applied update per key.
    const fake = new ContractFakeCmmsAdapter();
    await expect(
      runCmmsWrites(w.db.pool, w.service, {
        adapter: fake,
        workerId: 't056-cmms-a',
        leaseMs: 50,
        faults: {
          afterSend() {
            throw new Error('writer killed');
          },
        },
      }),
    ).rejects.toThrow('writer killed');
    await new Promise((r2) => setTimeout(r2, 120));
    for (let i = 0; i < 10; i++)
      await runCmmsWrites(w.db.pool, w.service, { adapter: fake, workerId: `t056-cmms-${i}`, reconcileDelayMs: 0 });
    const updates = (
      await w.db.pool.query(
        `SELECT idempotency_key, external_outcome_state FROM cmms_work_order_updates WHERE tenant_id = $1`,
        [w.tenant.tenantId],
      )
    ).rows;
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.every((u) => u.external_outcome_state === 'CONFIRMED')).toBe(true);
    expect(fake.appliedCount()).toBe(new Set(updates.map((u) => u.idempotency_key)).size);
  });

  it('a database connection killed at the evaluation write leaves no partial evaluation; the restart converges', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const fp = new FaultyPool(w.db.pool, [
      { match: /INSERT INTO recovery_evaluations\b/, phase: 'after', tripAfter: true },
    ]);
    await expect(assessWith(fp.asPool(), v, m.boundaryMs + 61_500)).rejects.toBeDefined();
    const ev = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2`,
      [w.tenant.tenantId, v.incidentId],
    );
    expect(ev.rows[0].n).toBe(0);
    const r = await assess(w, v, m.boundaryMs + 61_600);
    expect(r.outcome).toBe('PASSED');
    expect(await closeouts(v.incidentId)).toHaveLength(1);
  });
});

describe('T-056 no recovery from ineligible telemetry across crash and restart', () => {
  type Case = [string, (v: VerifyingIncident, boundaryMs: number) => Promise<void>];
  const CASES: Case[] = [
    ['boundary-equal', async (v, b) => void (await readings(w, v.device, steady(b, b + 50_000)))],
    ['pre-intervention', async () => {}],
    [
      'late',
      async (v, b) => {
        const pts: Reading[] = steady(b + 1_000, b + 61_000);
        pts[3] = { ...pts[3]!, lagMs: 45_000 };
        await readings(w, v.device, pts);
      },
    ],
    [
      'backfilled',
      async (v, b) => void (await readings(w, v.device, steady(b + 1_000, b + 61_000, { delivery: 'BACKFILL' }))),
    ],
    [
      'mixed backfill plus fresh tail',
      async (v, b) =>
        void (await readings(w, v.device, [
          ...steady(b + 1_000, b + 41_000, { delivery: 'BACKFILL' }),
          ...steady(b + 51_000, b + 61_000),
        ])),
    ],
    [
      'wrong (superseded) channel revision',
      async (v, b) => {
        await readings(w, v.device, steady(b + 1_000, b + 61_000));
        await reviseSensorChannel(w.db.pool, w.admin, v.device.channels.temp as never, {
          kind: 'TEMPERATURE',
          unit: 'MILLI_CELSIUS',
          sourceUnit: 'CELSIUS',
          calibrationRevision: 2,
          source: 'API',
        });
      },
    ],
  ];

  it.each(CASES)('%s telemetry never passes, even when the assessor crashes and restarts', async (name, feed) => {
    const v = await verifyingIncident(w);
    const now = await dbNowMs(w);
    const preIntervention = name === 'pre-intervention';
    const m = await milestoneAt(w, v, now + (preIntervention ? 100_000 : 5_000));
    if (preIntervention) await readings(w, v.device, steady(now + 2_000, now + 92_000));
    else await feed(v, m.boundaryMs);
    const asOf = preIntervention ? now + 92_500 : m.boundaryMs + 61_500;
    const fp = new FaultyPool(w.db.pool, [{ match: /recovery_evaluation/, phase: 'after', tripAfter: true }]);
    await assessWith(fp.asPool(), v, asOf).catch(() => null);
    const r = await assess(w, v, asOf + 100);
    expect(r.outcome, name).not.toBe('PASSED');
    expect(r.closeoutId, name).toBeNull();
    expect((await getIncident(w.db.pool, w.viewerCtx, v.incidentId)).state, name).not.toBe('RECOVERED');
    expect(await closeouts(v.incidentId), name).toHaveLength(0);
  });
});
