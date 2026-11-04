// T-010 / T-011 re-run over the M06 tables and commands (INV-15, INV-16, FR-24). Every new table carries tenant_id
// with tenant-leading keys and foreign keys; a foreign tenant gets the same RESOURCE_UNAVAILABLE denial as a
// nonexistent id on every read and write path; a member of another site cannot read or act on this site's
// decisions; only operators (and their approver/engineer peers) at the site may register candidates, only the
// server engine evaluates or activates policy, and only humans holding the right role record authority.
import { money } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTenant } from '../../data/test/helpers.js';
import {
  activateEffectivePolicy,
  checkDecisionExecutable,
  evaluateCandidate,
  getAuthorityRecord,
  getCandidateAction,
  getDecision,
  listDecisions,
  listPolicyHistory,
  recordAuthority,
  registerCandidateAction,
  reproduceDecision,
  revokeAuthority,
} from '../src/index.js';
import {
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  person,
  recordAuthorityFor,
  rejection,
  type CompatWorld,
} from './helpers.js';

let w: CompatWorld;
let foreign: Awaited<ReturnType<typeof seedTenant>>;
let ids: {
  candidateActionId: string;
  decisionId: string;
  authorityRecordId: string;
  incidentId: string;
  actionDigest: string;
};

const M06_TABLES = [
  'candidate_actions',
  'compatibility_decisions',
  'compatibility_decision_authorities',
  'compatibility_authority_records',
  'compatibility_authority_events',
  'compatibility_policy_activations',
];

describe('T-010/T-011 compatibility tenant, site and role scope', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t010c');
    const inc = await incidentWithEvidence(w, { warrantyExpiresOn: '2025-01-31' });
    const cand = await exactCandidate(w, inc, { partNumber: '5A1-0398', merchantId: merchant() as never });
    const held = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId });
    const a = await recordAuthorityFor(w, held.compatibilityDecisionId);
    ids = {
      candidateActionId: cand.candidateActionId,
      decisionId: held.compatibilityDecisionId,
      authorityRecordId: a.authorityRecordId,
      incidentId: inc.incidentId,
      actionDigest: cand.actionDigest,
    };
    foreign = await seedTenant(w.db.pool, w.idp, 't010c-beta');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('every M06 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M06_TABLES) {
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

  it('another tenant sees the same denial as for a nonexistent id, on every read and write path', async () => {
    const other = foreign.admin;
    const probes: [string, () => Promise<unknown>][] = [
      ['candidate', () => getCandidateAction(w.db.pool, other, ids.candidateActionId)],
      ['decision', () => getDecision(w.db.pool, other, ids.decisionId)],
      ['list', () => listDecisions(w.db.pool, other, { incidentId: ids.incidentId })],
      ['reproduce', () => reproduceDecision(w.db.pool, other, ids.decisionId)],
      ['authority', () => getAuthorityRecord(w.db.pool, other, ids.authorityRecordId)],
      ['revoke', () => revokeAuthority(w.db.pool, other, ids.authorityRecordId, 'X')],
      [
        'record',
        () =>
          recordAuthority(w.db.pool, other, {
            compatibilityDecisionId: ids.decisionId,
            kind: 'ENGINEER_EXCEPTION',
            reasonCode: 'X',
            reasonText: 'x',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      ],
      [
        'register',
        () =>
          registerCandidateAction(w.db.pool, other, {
            incidentId: ids.incidentId as never,
            kind: 'PART_PURCHASE',
            component: 'Evaporator fan motor',
            manufacturer: 'Northwind Refrigeration',
            partNumber: '5A1-0402',
            quantity: 1,
            vendorId: w.vendorId,
            providerAccountRevisionId: w.providerAccountRevisionId,
            merchantId: merchant(),
            amount: money(18_500n, 'USD'),
            purpose: 'PART_PURCHASE',
            offerObservedAt: new Date().toISOString(),
            specClaims: [],
            certificationClaims: [],
          }),
      ],
    ];
    for (const [name, probe] of probes) {
      const r = await rejection(probe());
      expect([name, r.code, r.reasonCode]).toEqual([name, 'FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
    const missing = await rejection(getDecision(w.db.pool, w.admin, 'cmp_does-not-exist'));
    expect([missing.code, missing.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
  });

  it('a foreign worker service cannot evaluate or check this tenant’s decisions', async () => {
    const { workerService } = await import('../../incidents/test/helpers.js');
    const svc = await workerService(w, foreign.admin);
    for (const probe of [
      () => evaluateCandidate(w.db.pool, svc, { candidateActionId: ids.candidateActionId }),
      () =>
        checkDecisionExecutable(w.db.pool, svc, {
          compatibilityDecisionId: ids.decisionId,
          actionDigest: ids.actionDigest,
        }),
    ]) {
      const r = await rejection(probe());
      expect([r.code, r.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
  });

  it('members of another site cannot read, register or approve here', async () => {
    const outsider = await person(w, 'outsider', ['viewer', 'operator', 'engineer'], w.otherSiteId);
    for (const probe of [
      () => getDecision(w.db.pool, outsider.ctx, ids.decisionId),
      () => getCandidateAction(w.db.pool, outsider.ctx, ids.candidateActionId),
      () => listDecisions(w.db.pool, outsider.ctx, { incidentId: ids.incidentId }),
      () => getAuthorityRecord(w.db.pool, outsider.ctx, ids.authorityRecordId),
    ]) {
      expect((await rejection(probe())).code).toBe('FORBIDDEN');
    }
  });

  it('role matrix: register (operator peers), evaluate/activate (engine), read (site roles), history (admin/auditor)', async () => {
    const inc = await incidentWithEvidence(w);
    const viewerReg = await rejection(exactCandidate(w, inc, { merchantId: merchant() as never }, w.people.viewer!));
    expect(viewerReg.code).toBe('FORBIDDEN');
    const auditorReg = await rejection(exactCandidate(w, inc, { merchantId: merchant() as never }, w.people.auditor!));
    expect(auditorReg.code).toBe('FORBIDDEN');
    for (const who of [w.people.operator!, w.people.approver!, w.engineer])
      expect((await exactCandidate(w, inc, { merchantId: merchant() as never }, who)).candidateActionId).toMatch(
        /^cand_/,
      );
    for (const ctx of [w.people.viewer!.ctx, w.people.auditor!.ctx, w.people.approver!.ctx]) {
      expect((await rejection(activateEffectivePolicy(w.db.pool, ctx))).code).toBe('FORBIDDEN');
      expect(
        (await rejection(evaluateCandidate(w.db.pool, ctx, { candidateActionId: ids.candidateActionId }))).code,
      ).toBe('FORBIDDEN');
    }
    expect((await getDecision(w.db.pool, w.people.viewer!.ctx, ids.decisionId)).compatibilityDecisionId).toBe(
      ids.decisionId,
    );
    expect((await listPolicyHistory(w.db.pool, w.people.auditor!.ctx)).length).toBeGreaterThan(0);
    expect((await rejection(listPolicyHistory(w.db.pool, w.people.viewer!.ctx))).code).toBe('FORBIDDEN');
    // Revocation: only the recording engineer or an admin, never another role.
    for (const who of [w.people.operator!, w.people.approver!, w.people.viewer!])
      expect((await rejection(revokeAuthority(w.db.pool, who.ctx, ids.authorityRecordId, 'NOT_MINE'))).code).toBe(
        'FORBIDDEN',
      );
  });
});
