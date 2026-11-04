// T-010 / T-011 re-run over the M08 tables and commands (INV-16, FR-24). Every new table carries tenant_id with
// tenant-leading keys and foreign keys; a foreign tenant (human or worker service) gets the same RESOURCE_UNAVAILABLE
// denial as a nonexistent id on every read and write path, including references to this tenant's candidates and
// quotes; members of another site cannot read plans; only the planning engine builds plans and prepares approval
// requests, site roles read them, and only an administrator publishes the versioned risk estimate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTenant } from '../../data/test/helpers.js';
import { workerService } from '../../incidents/test/helpers.js';
import {
  createRecoveryPlan,
  getApprovalRequest,
  getRecoveryPlan,
  listIncidentPlans,
  prepareApprovalRequest,
  publishTenantRiskEstimate,
} from '../src/index.js';
import {
  createPlanningWorld,
  person,
  rejection,
  riskBody,
  scenario,
  type PlanningWorld,
  type Scenario,
} from './helpers.js';

let w: PlanningWorld;
let s: Scenario;
let foreign: Awaited<ReturnType<typeof seedTenant>>;
let ids: { planId: string; planHash: string; planActionId: string; approvalRequestId: string };

const M08_TABLES = [
  'tenant_risk_estimates',
  'recovery_plans',
  'plan_actions',
  'recovery_plan_transitions',
  'plan_approval_requests',
];

describe('T-010/T-011 planning tenant, site and role scope', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t010p');
    s = await scenario(w, [
      { label: 'a', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'b', priceMinor: 24_000n, etaMinutes: 10 },
    ]);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    const top = plan.actions.find((a) => a.ordinal === 1)!;
    const req = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    ids = {
      planId: plan.planId,
      planHash: plan.planHash,
      planActionId: top.planActionId,
      approvalRequestId: req.approvalRequestId,
    };
    foreign = await seedTenant(w.db.pool, w.idp, 't010p-beta');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('every M08 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M08_TABLES) {
      const col = await w.db.pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(col.rows[0]?.is_nullable, table).toBe('NO');
      const keys = await w.db.pool.query(
        `SELECT conname, contype, (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype IN ('f', 'p', 'u')`,
        [table],
      );
      expect(
        keys.rows.some((k) => k.contype === 'p'),
        table,
      ).toBe(true);
      for (const k of keys.rows) expect(k.first, `${table}.${k.conname}`).toBe('tenant_id');
    }
  });

  it('the database refuses rows that point at another tenant’s plan, candidate or quote', async () => {
    const own = await w.db.pool.query(
      `SELECT candidate_action_id, quote_id, action_digest, incident_id FROM plan_actions WHERE tenant_id = $1 AND plan_id = $2 LIMIT 1`,
      [w.tenant.tenantId, ids.planId],
    );
    const a = own.rows[0];
    const r = await w.db.pool
      .query(
        `INSERT INTO plan_actions (tenant_id, id, plan_id, incident_id, candidate_action_id, quote_id, action_digest,
           action_kind, disposition, reason_codes, inputs, components, issues)
         VALUES ($1, 'pla_cross-tenant-1', $2, $3, $4, $5, $6, 'PART_PURCHASE', 'HELD', ARRAY['X_Y'], '[]', '[]', '[]')`,
        [foreign.tenantId, ids.planId, a.incident_id, a.candidate_action_id, a.quote_id, a.action_digest],
      )
      .catch((e) => e);
    expect(r.code).toBe('23503');
  });

  it('another tenant sees the same denial as for a nonexistent id, on every read and write path', async () => {
    const svc = await workerService(w, foreign.admin);
    const probes: [string, () => Promise<unknown>][] = [
      ['plan', () => getRecoveryPlan(w.db.pool, foreign.admin, ids.planId)],
      ['list', () => listIncidentPlans(w.db.pool, foreign.admin, s.incidentId)],
      ['request', () => getApprovalRequest(w.db.pool, foreign.admin, ids.approvalRequestId)],
      ['build', () => createRecoveryPlan(w.db.pool, svc, { incidentId: s.incidentId, candidates: s.refs }, w.signing)],
      [
        'prepare',
        () =>
          prepareApprovalRequest(
            w.db.pool,
            svc,
            { planId: ids.planId, planHash: ids.planHash, planActionId: ids.planActionId },
            w.signing,
          ),
      ],
      ['service-read', () => getRecoveryPlan(w.db.pool, svc, ids.planId)],
    ];
    for (const [name, probe] of probes) {
      const r = await rejection(probe());
      expect([name, r.code, r.reasonCode]).toEqual([name, 'FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
    // A foreign engine cannot borrow this tenant's candidates or quotes for a plan of its own.
    const missing = await rejection(getRecoveryPlan(w.db.pool, w.admin, 'pln_does-not-exist'));
    expect([missing.code, missing.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    const audit = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND result = 'DENIED' AND action LIKE 'planning.%'`,
      [foreign.tenantId],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('members of another site cannot read this site’s plans or requests', async () => {
    const outsider = await person(
      w,
      'outsider',
      ['viewer', 'operator', 'maintenance_approver'],
      w.otherSiteId as never,
    );
    for (const probe of [
      () => getRecoveryPlan(w.db.pool, outsider.ctx, ids.planId),
      () => listIncidentPlans(w.db.pool, outsider.ctx, s.incidentId),
      () => getApprovalRequest(w.db.pool, outsider.ctx, ids.approvalRequestId),
    ])
      expect((await rejection(probe())).code).toBe('FORBIDDEN');
  });

  it('role matrix: site roles read, only the engine builds/prepares, only an administrator publishes estimates', async () => {
    for (const who of ['viewer', 'operator', 'approver', 'auditor'])
      expect((await getRecoveryPlan(w.db.pool, w.people[who]!.ctx, ids.planId)).planId).toBe(ids.planId);
    for (const ctx of [w.people.viewer!.ctx, w.people.operator!.ctx, w.people.approver!.ctx, w.engineer.ctx, w.admin]) {
      expect(
        (
          await rejection(
            createRecoveryPlan(w.db.pool, ctx, { incidentId: s.incidentId, candidates: s.refs }, w.signing),
          )
        ).code,
      ).toBe('FORBIDDEN');
      expect(
        (
          await rejection(
            prepareApprovalRequest(
              w.db.pool,
              ctx,
              { planId: ids.planId, planHash: ids.planHash, planActionId: ids.planActionId },
              w.signing,
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
    }
    for (const ctx of [w.people.operator!.ctx, w.people.approver!.ctx, w.service])
      expect((await rejection(publishTenantRiskEstimate(w.db.pool, ctx, riskBody()))).code).toBe('FORBIDDEN');
    const siteAdmin = await person(w, 'site-admin', ['admin'], w.siteId as never);
    expect((await rejection(publishTenantRiskEstimate(w.db.pool, siteAdmin.ctx, riskBody()))).code).toBe('FORBIDDEN');
    expect(
      (await rejection(publishTenantRiskEstimate(w.db.pool, siteAdmin.ctx, riskBody({ siteId: w.otherSiteId })))).code,
    ).toBe('FORBIDDEN');
    const own = await publishTenantRiskEstimate(w.db.pool, siteAdmin.ctx, riskBody({ siteId: w.siteId }));
    expect(own.siteId).toBe(w.siteId);
  });
});
