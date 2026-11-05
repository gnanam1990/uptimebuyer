// T-010 / T-011 re-run over the M11 tables and commands (INV-16, FR-24, NFR-05). Every M11 table is tenant-leading
// with composite tenant foreign keys. Another tenant (admin, worker service, CMMS integration) gets the same
// RESOURCE_UNAVAILABLE as a nonexistent id on every read and write path. Members of ANOTHER SITE of the same tenant are
// refused on every human-callable recovery command and query, and a refused call writes nothing (every command
// authorizes against the resource's site inside its transaction). The role matrix holds: viewers read, operators record
// evidence and disputes, policy-named approvers/engineers attest, only the engine assesses, sweeps and writes to the
// CMMS, only administrators publish recovery policy and bind CMMS integrations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SiteId } from '@uptimebuyer/contracts';
import { createSite, type TenantContext } from '@uptimebuyer/data';
import {
  ContractFakeCmmsAdapter,
  disputeRecoveryEvidence,
  getCloseout,
  getRecoveryGate,
  getRecoveryStatus,
  monitorRecoveredIncidents,
  publishRecoveryPolicy,
  recordInterventionMilestone,
  recordRecoveryEvidence,
  recoveryMetrics,
  registerCmmsIntegration,
  runCmmsWrites,
} from '@uptimebuyer/recovery';
import { person } from '../../../packages/compatibility/test/helpers.js';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import { workerService } from '../../../packages/incidents/test/helpers.js';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import { rejection } from './helpers.js';
import {
  POLICY,
  assess,
  cmmsBinding,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  iso,
  recoveredIncident,
  sendCmms,
  verifyingIncident,
  type CmmsBinding,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';

const M11_TABLES = [
  'recovery_policy_revisions',
  'cmms_integrations',
  'recovery_evidence',
  'recovery_evidence_disputes',
  'intervention_milestones',
  'recovery_evaluations',
  'recovery_evaluation_transitions',
  'recovery_evaluation_channels',
  'recovery_evaluation_samples',
  'recovery_evaluation_signoffs',
  'recovery_assessments',
  'recovery_closeouts',
  'recovery_command_receipts',
  'cmms_work_order_updates',
  'cmms_write_attempts',
];

let w: RecoveryWorld;
let foreign: Awaited<ReturnType<typeof seedTenant>>;
let foreignWorker: TenantContext;
let foreignCmms: CmmsBinding;
let farOperator: TenantContext;
let farApprover: TenantContext;
let recovered: Awaited<ReturnType<typeof recoveredIncident>>;
let open: VerifyingIncident;
let openEvidenceId: string;

beforeAll(async () => {
  w = await createRecoveryWorld('t010r');
  recovered = await recoveredIncident(w);
  open = await verifyingIncident(w);
  openEvidenceId = (await sendCmms(w, w.cmms, cmmsRecord(open, (await dbNowMs(w)) + 2_000))).evidenceId;
  foreign = await seedTenant(w.db.pool, w.idp, 't010r-beta');
  foreignWorker = await workerService({ ...w, admin: foreign.admin } as never, foreign.admin);
  const fsite = await createSite(w.db.pool, foreign.admin, {
    name: 'Beta store',
    timezone: 'Europe/London',
    source: 'API',
  });
  foreignCmms = await cmmsBinding(w, fsite.siteId, 'beta', foreign.admin);
  farOperator = (await person(w, 'far-operator', ['operator'], w.otherSiteId as never)).ctx;
  farApprover = (
    await person(w, 'far-approver', ['maintenance_approver', 'engineer', 'operator'], w.otherSiteId as never)
  ).ctx;
});
afterAll(async () => w?.close());

const count = async (table: string) =>
  (await w.db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [w.tenant.tenantId])).rows[0]
    .n as number;
const writeCounts = async () => Object.fromEntries(await Promise.all(M11_TABLES.map(async (t) => [t, await count(t)])));

describe('T-010/T-011 recovery tenant, site and role scope', () => {
  it('every M11 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M11_TABLES) {
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

  it('another tenant gets the same answer as absence on every read and write path', async () => {
    const before = await writeCounts();
    const missingInc = 'inc_00000000-0000-0000-0000-000000000000';
    const missingEv = 'rce_00000000-0000-0000-0000-000000000000';
    const missingClose = 'rco_00000000-0000-0000-0000-000000000000';
    const shape = async (p: Promise<unknown>) => {
      const r = await rejection(p);
      return { code: r.code, reasonCode: r.reasonCode, message: r.message };
    };
    const pairs: [() => Promise<unknown>, () => Promise<unknown>][] = [
      [
        () => getRecoveryStatus(w.db.pool, foreign.admin, recovered.inc.incidentId),
        () => getRecoveryStatus(w.db.pool, foreign.admin, missingInc),
      ],
      [
        () => getRecoveryGate(w.db.pool, foreign.admin, recovered.inc.incidentId),
        () => getRecoveryGate(w.db.pool, foreign.admin, missingInc),
      ],
      [
        () => getCloseout(w.db.pool, foreign.admin, recovered.r.closeoutId!),
        () => getCloseout(w.db.pool, foreign.admin, missingClose),
      ],
      [
        () => assess(w, open, undefined, foreignWorker),
        () => assess(w, { incidentId: missingInc }, undefined, foreignWorker),
      ],
      [
        () =>
          recordInterventionMilestone(
            w.db.pool,
            foreignWorker,
            { incidentId: open.incidentId, evidenceId: openEvidenceId, idempotencyKey: 'foreign-milestone-1' },
            w.recoverySigning,
          ),
        () =>
          recordInterventionMilestone(
            w.db.pool,
            foreignWorker,
            { incidentId: missingInc, evidenceId: missingEv, idempotencyKey: 'foreign-milestone-2' },
            w.recoverySigning,
          ),
      ],
      [
        () =>
          recordRecoveryEvidence(
            w.db.pool,
            foreignWorker,
            {
              incidentId: open.incidentId,
              idempotencyKey: 'foreign-evidence-1',
              kind: 'PROVIDER_COMPLETION',
              occurredAt: iso(Date.now()),
              sourceRef: open.orderId,
            },
            w.recoverySigning,
          ),
        () =>
          recordRecoveryEvidence(
            w.db.pool,
            foreignWorker,
            {
              incidentId: missingInc,
              idempotencyKey: 'foreign-evidence-2',
              kind: 'PROVIDER_COMPLETION',
              occurredAt: iso(Date.now()),
              sourceRef: open.orderId,
            },
            w.recoverySigning,
          ),
      ],
      [
        () =>
          disputeRecoveryEvidence(w.db.pool, foreign.admin, {
            evidenceId: openEvidenceId,
            reasonCode: 'X',
            idempotencyKey: 'foreign-dispute-1',
          }),
        () =>
          disputeRecoveryEvidence(w.db.pool, foreign.admin, {
            evidenceId: missingEv,
            reasonCode: 'X',
            idempotencyKey: 'foreign-dispute-2',
          }),
      ],
      [
        () => sendCmms(w, foreignCmms, cmmsRecord(open, Date.now())),
        () => sendCmms(w, foreignCmms, cmmsRecord({ ...open, incidentId: missingInc }, Date.now())),
      ],
    ];
    for (const [real, absent] of pairs) {
      const a = await shape(real());
      expect(a.code).toBe('FORBIDDEN');
      expect(a).toEqual(await shape(absent()));
    }
    // Tenant-wide engine paths of another tenant see nothing of this one.
    expect((await monitorRecoveredIncidents(w.db.pool, foreignWorker, {})).reopened).toEqual([]);
    expect(
      (await runCmmsWrites(w.db.pool, foreignWorker, { adapter: new ContractFakeCmmsAdapter(), workerId: 'beta' }))
        .claimed,
    ).toBe(0);
    expect(await recoveryMetrics(w.db.pool, foreign.admin, {})).toMatchObject({
      closeouts: 0,
      stable: 0,
      pendingWatch: 0,
      reopened: 0,
    });
    expect(await writeCounts()).toEqual(before);
  });

  it('members of another site are refused on every human-callable command and query, writing nothing', async () => {
    const before = await writeCounts();
    const at = iso(Date.now());
    const calls: [string, () => Promise<unknown>][] = [];
    for (const [who, ctx] of [
      ['far-operator', farOperator],
      ['far-approver', farApprover],
      ['far-engineer', w.farEngineer.ctx],
    ] as const) {
      calls.push(
        [`${who} status`, () => getRecoveryStatus(w.db.pool, ctx, recovered.inc.incidentId)],
        [`${who} gate`, () => getRecoveryGate(w.db.pool, ctx, recovered.inc.incidentId)],
        [`${who} closeout`, () => getCloseout(w.db.pool, ctx, recovered.r.closeoutId!)],
        [`${who} metrics`, () => recoveryMetrics(w.db.pool, ctx, { siteId: w.siteId })],
        [
          `${who} note`,
          () =>
            recordRecoveryEvidence(
              w.db.pool,
              ctx,
              {
                incidentId: open.incidentId,
                idempotencyKey: w.key('x'),
                kind: 'OPERATOR_NOTE',
                occurredAt: at,
                note: 'done',
              },
              w.recoverySigning,
            ),
        ],
        [
          `${who} part scan`,
          () =>
            recordRecoveryEvidence(
              w.db.pool,
              ctx,
              {
                incidentId: open.incidentId,
                idempotencyKey: w.key('x'),
                kind: 'INSTALLED_PART',
                occurredAt: at,
                planId: open.planId,
                actionDigest: open.actionDigest,
                installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0402', serial: 'SN-FAR-1' },
              },
              w.recoverySigning,
            ),
        ],
        [
          `${who} attestation`,
          () =>
            recordRecoveryEvidence(
              w.db.pool,
              ctx,
              {
                incidentId: open.incidentId,
                idempotencyKey: w.key('x'),
                kind: 'OPERATOR_ATTESTATION',
                occurredAt: at,
                planId: open.planId,
                actionDigest: open.actionDigest,
                milestoneType: 'WORK_COMPLETED',
              },
              w.recoverySigning,
            ),
        ],
        [
          `${who} dispute`,
          () =>
            disputeRecoveryEvidence(w.db.pool, ctx, {
              evidenceId: openEvidenceId,
              reasonCode: 'X',
              idempotencyKey: w.key('x'),
            }),
        ],
        [
          `${who} milestone`,
          () =>
            recordInterventionMilestone(
              w.db.pool,
              ctx,
              { incidentId: open.incidentId, evidenceId: openEvidenceId, idempotencyKey: w.key('x') },
              w.recoverySigning,
            ),
        ],
        [`${who} policy`, () => publishRecoveryPolicy(w.db.pool, ctx, { siteId: w.siteId, body: POLICY })],
        [
          `${who} cmms bind`,
          () =>
            registerCmmsIntegration(w.db.pool, ctx, {
              siteId: w.siteId,
              integrationIdentityId: w.cmms.integrationIdentityId,
              systemKey: 'cmms-evil',
              environment: 'SANDBOX',
              verifierRef: `secretref:webhook/tenants/${w.tenant.tenantId}/evil`,
            }),
        ],
      );
    }
    for (const [label, call] of calls) expect((await rejection(call())).code, label).toBe('FORBIDDEN');
    expect(await writeCounts()).toEqual(before);
  });

  it('the role matrix: viewers read, operators record, only policy-named roles attest, only the engine assesses', async () => {
    const st = await getRecoveryStatus(w.db.pool, w.viewerCtx, recovered.inc.incidentId);
    expect(st.closeouts.map((c) => c.closeoutId)).toEqual([recovered.r.closeoutId]);
    expect((await getCloseout(w.db.pool, w.viewerCtx, recovered.r.closeoutId!)).manifestDigest).toMatch(
      /^recovery-closeout\.v1:/,
    );
    const at = iso(Date.now());
    const note = {
      incidentId: open.incidentId,
      kind: 'OPERATOR_NOTE' as const,
      occurredAt: at,
      note: 'cabinet feels cold',
    };
    expect(
      (
        await rejection(
          recordRecoveryEvidence(w.db.pool, w.viewerCtx, { ...note, idempotencyKey: w.key('n') }, w.recoverySigning),
        )
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      (await recordRecoveryEvidence(w.db.pool, w.operator, { ...note, idempotencyKey: w.key('n') }, w.recoverySigning))
        .trust,
    ).toBe('UNATTESTED');
    const att = {
      incidentId: open.incidentId,
      kind: 'OPERATOR_ATTESTATION' as const,
      occurredAt: at,
      planId: open.planId,
      actionDigest: open.actionDigest,
      milestoneType: 'WORK_COMPLETED' as const,
    };
    expect(
      (await recordRecoveryEvidence(w.db.pool, w.approver, { ...att, idempotencyKey: w.key('a') }, w.recoverySigning))
        .trust,
    ).toBe('OPERATOR_ATTESTED');
    expect(
      (
        await recordRecoveryEvidence(
          w.db.pool,
          w.engineer.ctx,
          { ...att, idempotencyKey: w.key('a') },
          w.recoverySigning,
        )
      ).trust,
    ).toBe('OPERATOR_ATTESTED');
    for (const ctx of [w.operator, w.approver, w.admin, w.viewerCtx])
      expect((await rejection(assess(w, open, undefined, ctx))).code).toBe('FORBIDDEN');
    for (const ctx of [w.operator, w.admin])
      expect(
        (await rejection(runCmmsWrites(w.db.pool, ctx, { adapter: new ContractFakeCmmsAdapter(), workerId: 'x' })))
          .code,
      ).toBe('FORBIDDEN');
    for (const ctx of [w.operator, w.approver])
      expect((await rejection(publishRecoveryPolicy(w.db.pool, ctx, { siteId: null, body: POLICY }))).code).toBe(
        'FORBIDDEN',
      );
    // A site-scoped policy published by the tenant admin applies to that site only.
    const site2 = await publishRecoveryPolicy(w.db.pool, w.admin, {
      siteId: w.otherSiteId as SiteId,
      body: { ...POLICY, minSamples: 9 },
    });
    expect(site2.recoveryPolicyRevisionId).toMatch(/^rpr_/);
  });
});
