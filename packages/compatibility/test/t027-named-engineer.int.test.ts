// T-027 — Substitute requires named engineer (FR-10, INV-02, INV-03, INV-15), persisted. A substitute HOLD resolves
// only when an authorized named engineer at the incident's site records an immutable, signed authority record whose
// scope (tenant, site, incident, candidate, asset/evidence/policy revisions, action digest), reason and expiry are all
// server-derived from the held decision, and the engine evaluates the new tuple: a new ALLOW row, while the HOLD row
// becomes SUPERSEDED in its lifecycle column only. Policy overrides route to the approver role the policy revision
// names; wrong role, other site, other tenant, expired, over-long, unneeded, stale-tuple, forged and digest-substituted
// authority is refused, and the database itself refuses an exception ALLOW without a matching authority link.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTenant } from '../../data/test/helpers.js';
import {
  checkDecisionExecutable,
  evaluateCandidate,
  getAuthorityRecord,
  getDecision,
  recordAuthority,
  revokeAuthority,
  type DecisionView,
} from '../src/index.js';
import {
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  rejection,
  sleep,
  type CompatWorld,
  type Person,
} from './helpers.js';

let w: CompatWorld;
let outOfWarranty: Awaited<ReturnType<typeof incidentWithEvidence>>;

const evaluate = (candidateActionId: string) => evaluateCandidate(w.db.pool, w.service, { candidateActionId });
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function substituteHold(over: Record<string, unknown> = {}): Promise<DecisionView> {
  const cand = await exactCandidate(w, outOfWarranty, {
    partNumber: '5A1-0398',
    merchantId: merchant() as never,
    ...over,
  });
  const d = await evaluate(cand.candidateActionId);
  expect(d.decision).toBe('HOLD');
  return d;
}
const engineerAuthority = (who: Person, decisionId: string, over: Record<string, unknown> = {}) =>
  recordAuthority(w.db.pool, who.ctx, {
    compatibilityDecisionId: decisionId,
    kind: 'ENGINEER_EXCEPTION',
    reasonCode: 'OEM_PART_BACKORDERED',
    reasonText: '5A1-0398 is the superseded OEM motor with identical mounting and 115 V rating; checked on site.',
    expiresAt: inHours(8),
    ...over,
  } as never);

describe('T-027 substitute requires named engineer (persisted)', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t027');
    outOfWarranty = await incidentWithEvidence(w, { warrantyExpiresOn: '2025-01-31' });
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a named engineer authority resolves the HOLD only through a new tuple; the old row is only SUPERSEDED', async () => {
    const held = await substituteHold();
    expect(held.requiredAuthorities).toEqual([
      { kind: 'ENGINEER_EXCEPTION', roles: ['engineer'], exceptionClasses: ['SUBSTITUTE'], overriddenReasons: [] },
    ]);
    const before = await w.db.pool.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      held.compatibilityDecisionId,
    ]);

    const a = await engineerAuthority(w.engineer, held.compatibilityDecisionId);
    expect(a.signatureDigest).toMatch(/^compatibility-authority\.v1:sha256:[0-9a-f]{64}$/);
    const rec = await getAuthorityRecord(w.db.pool, w.engineer.ctx, a.authorityRecordId);
    expect(rec).toMatchObject({
      kind: 'ENGINEER_EXCEPTION',
      actorUserId: w.engineer.userId,
      actorRole: 'engineer',
      tenantId: w.tenant.tenantId,
      siteId: w.siteId,
      incidentId: outOfWarranty.incidentId,
      candidateActionId: held.candidateActionId,
      assetRevisionId: held.assetRevisionId,
      evidenceRevisionId: held.evidenceRevisionId,
      policyRevisionId: held.policyRevisionId,
      actionDigest: held.actionDigest,
      heldDecisionId: held.compatibilityDecisionId,
      exceptionClasses: ['SUBSTITUTE'],
      reasonCode: 'OEM_PART_BACKORDERED',
      status: 'ACTIVE',
      label: 'HUMAN APPROVAL',
    });

    // Recording the authority does not edit the HOLD; the engine must evaluate the new tuple.
    expect((await getDecision(w.db.pool, w.service, held.compatibilityDecisionId)).lifecycle).toBe('CURRENT');
    const allowed = await evaluate(held.candidateActionId);
    expect(allowed.compatibilityDecisionId).not.toBe(held.compatibilityDecisionId);
    expect(allowed.decision).toBe('ALLOW');
    expect(allowed.appliedAuthorityIds).toEqual([a.authorityRecordId]);
    expect(allowed.authoritySetDigest).not.toBe(held.authoritySetDigest);
    expect(allowed.inputDigest).not.toBe(held.inputDigest);

    const prior = await getDecision(w.db.pool, w.service, held.compatibilityDecisionId);
    expect(prior).toMatchObject({
      decision: 'HOLD',
      lifecycle: 'SUPERSEDED',
      supersededReason: 'NEW_EVALUATION',
      supersededByDecisionId: allowed.compatibilityDecisionId,
    });
    const after = await w.db.pool.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      held.compatibilityDecisionId,
    ]);
    const strip = (r: Record<string, unknown>) => {
      const { lifecycle: _l, superseded_at: _a, superseded_reason: _r, superseded_by_decision_id: _b, ...rest } = r;
      return rest;
    };
    expect(strip(after.rows[0])).toEqual(strip(before.rows[0]));

    const link = await w.db.pool.query(
      `SELECT authority_record_id FROM compatibility_decision_authorities WHERE tenant_id = $1 AND decision_id = $2`,
      [w.tenant.tenantId, allowed.compatibilityDecisionId],
    );
    expect(link.rows).toEqual([{ authority_record_id: a.authorityRecordId }]);
    const upd = await rejection(
      w.db.pool.query(`UPDATE compatibility_authority_records SET reason_text = 'x' WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        a.authorityRecordId,
      ]),
    );
    expect(upd.code).toBe('UB001');
  });

  it('wrong role, other site, other tenant, expired, over-long and unneeded authority are refused', async () => {
    const held = await substituteHold();
    for (const who of [w.people.operator!, w.people.approver!, w.finance, w.people.viewer!, w.farEngineer]) {
      const r = await rejection(engineerAuthority(who, held.compatibilityDecisionId));
      expect(r.code).toBe('FORBIDDEN');
    }
    const svc = await rejection(engineerAuthority({ ctx: w.service } as Person, held.compatibilityDecisionId));
    expect(svc.code).toBe('FORBIDDEN');
    const foreign = await seedTenant(w.db.pool, w.idp, 't027-beta');
    const f = await rejection(engineerAuthority({ ctx: foreign.admin } as Person, held.compatibilityDecisionId));
    expect([f.code, f.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);

    const past = await rejection(
      engineerAuthority(w.engineer, held.compatibilityDecisionId, { expiresAt: inHours(-1) }),
    );
    expect([past.code, past.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_ALREADY_EXPIRED']);
    const long = await rejection(
      engineerAuthority(w.engineer, held.compatibilityDecisionId, { expiresAt: inHours(24 * 30) }),
    );
    expect([long.code, long.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_TTL_EXCEEDED']);
    const blank = await rejection(engineerAuthority(w.engineer, held.compatibilityDecisionId, { reasonText: '   ' }));
    expect(blank.code).toBe('VALIDATION_FAILED');
    const scoped = await rejection(
      engineerAuthority(w.engineer, held.compatibilityDecisionId, {
        actionDigest: `action.v1:sha256:${'0'.repeat(64)}`,
      }),
    );
    expect(scoped.code).toBe('VALIDATION_FAILED');

    // A policy approval is not what this HOLD needs, and an exact ALLOW needs no authority at all.
    const wrongKind = await rejection(
      recordAuthority(w.db.pool, w.people.approver!.ctx, {
        compatibilityDecisionId: held.compatibilityDecisionId,
        kind: 'POLICY_APPROVAL',
        reasonCode: 'VENDOR_OVERRIDE',
        reasonText: 'override',
        expiresAt: inHours(2),
      }),
    );
    expect([wrongKind.code, wrongKind.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_NOT_REQUIRED']);
    const exact = await exactCandidate(w, outOfWarranty, { merchantId: merchant() as never });
    const ok = await evaluate(exact.candidateActionId);
    expect(ok.decision).toBe('ALLOW');
    const unneeded = await rejection(engineerAuthority(w.engineer, ok.compatibilityDecisionId));
    expect([unneeded.code, unneeded.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_NOT_REQUIRED']);
  });

  it('a superseded HOLD cannot be approved (TOCTOU between evaluation and approval)', async () => {
    const held = await substituteHold();
    await engineerAuthority(w.engineer, held.compatibilityDecisionId);
    await evaluate(held.candidateActionId);
    const stale = await rejection(engineerAuthority(w.engineer, held.compatibilityDecisionId));
    expect([stale.code, stale.reasonCode]).toEqual(['POLICY_HOLD', 'DECISION_NOT_CURRENT']);
  });

  it('two concurrent approvals of one HOLD record at most one authority', async () => {
    const held = await substituteHold();
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => engineerAuthority(w.engineer, held.compatibilityDecisionId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a policy override routes to the approver role the policy names, not to an engineer or finance approver', async () => {
    const cand = await exactCandidate(w, outOfWarranty, {
      merchantId: merchant() as never,
      vendorId: w.unapprovedVendorId,
    });
    const held = await evaluate(cand.candidateActionId);
    expect(held.requiredAuthorities).toEqual([
      {
        kind: 'POLICY_APPROVAL',
        roles: ['maintenance_approver'],
        exceptionClasses: [],
        overriddenReasons: ['VENDOR_NOT_APPROVED'],
      },
    ]);
    const input = (expiresAt = inHours(4)) => ({
      compatibilityDecisionId: held.compatibilityDecisionId,
      kind: 'POLICY_APPROVAL' as const,
      reasonCode: 'VENDOR_EMERGENCY_USE',
      reasonText: 'Approved vendor has no stock; one-off purchase from suspended vendor approved for this incident.',
      expiresAt,
    });
    for (const who of [w.engineer, w.finance, w.people.operator!]) {
      const r = await rejection(recordAuthority(w.db.pool, who.ctx, input()));
      expect(r.code).toBe('FORBIDDEN');
    }
    const eng = await rejection(engineerAuthority(w.engineer, held.compatibilityDecisionId));
    expect([eng.code, eng.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_NOT_REQUIRED']);
    const a = await recordAuthority(w.db.pool, w.people.approver!.ctx, input());
    const rec = await getAuthorityRecord(w.db.pool, w.people.approver!.ctx, a.authorityRecordId);
    expect(rec).toMatchObject({
      kind: 'POLICY_APPROVAL',
      actorRole: 'maintenance_approver',
      overriddenReasons: ['VENDOR_NOT_APPROVED'],
    });
    const allowed = await evaluate(held.candidateActionId);
    expect(allowed.decision).toBe('ALLOW');
    expect(allowed.reasonCodes).toContain('POLICY_OVERRIDE_APPLIED');
  });

  it('an in-warranty substitute needs both the named engineer and the policy-named approver', async () => {
    const inWarranty = await incidentWithEvidence(w);
    const cand = await exactCandidate(w, inWarranty, { partNumber: '5A1-0398', merchantId: merchant() as never });
    const held = await evaluate(cand.candidateActionId);
    expect(held.requiredAuthorities.map((r) => r.kind).sort()).toEqual(['ENGINEER_EXCEPTION', 'POLICY_APPROVAL']);
    await engineerAuthority(w.engineer, held.compatibilityDecisionId);
    const half = await evaluate(cand.candidateActionId);
    expect(half.decision).toBe('HOLD');
    expect(half.requiredAuthorities.map((r) => r.kind)).toEqual(['POLICY_APPROVAL']);
    await recordAuthority(w.db.pool, w.people.approver!.ctx, {
      compatibilityDecisionId: half.compatibilityDecisionId,
      kind: 'POLICY_APPROVAL',
      reasonCode: 'WARRANTY_WAIVED',
      reasonText: 'Warranty claim declined by OEM; substitute accepted outside warranty terms.',
      expiresAt: inHours(4),
    });
    expect((await evaluate(cand.candidateActionId)).decision).toBe('ALLOW');
  });

  it('expiry, revocation and digest substitution make an exception ALLOW non-executable', async () => {
    const held = await substituteHold();
    const a = await engineerAuthority(w.engineer, held.compatibilityDecisionId, {
      expiresAt: new Date(Date.now() + 2_500).toISOString(),
    });
    const allowed = await evaluate(held.candidateActionId);
    expect(allowed.decision).toBe('ALLOW');
    const ok = await checkDecisionExecutable(w.db.pool, w.service, {
      compatibilityDecisionId: allowed.compatibilityDecisionId,
      actionDigest: allowed.actionDigest,
    });
    expect(ok.executable).toBe(true);
    const swapped = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: allowed.compatibilityDecisionId,
        actionDigest: `action.v1:sha256:${'9'.repeat(64)}`,
      }),
    );
    expect(swapped.code).toBe('DIGEST_MISMATCH');
    await sleep(3_000);
    const expired = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: allowed.compatibilityDecisionId,
        actionDigest: allowed.actionDigest,
      }),
    );
    expect([expired.code, expired.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_EXPIRED']);
    const reheld = await evaluate(held.candidateActionId);
    expect(reheld.decision).toBe('HOLD');
    expect(reheld.authorityFindings).toEqual([
      { authorityRecordId: a.authorityRecordId, reasonCode: 'AUTHORITY_EXPIRED' },
    ]);

    const held2 = await substituteHold();
    const b = await engineerAuthority(w.engineer, held2.compatibilityDecisionId);
    const allowed2 = await evaluate(held2.candidateActionId);
    await revokeAuthority(w.db.pool, w.engineer.ctx, b.authorityRecordId, 'SITE_CHECK_FAILED');
    const revoked = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: allowed2.compatibilityDecisionId,
        actionDigest: allowed2.actionDigest,
      }),
    );
    expect([revoked.code, revoked.reasonCode]).toEqual(['POLICY_HOLD', 'AUTHORITY_INACTIVE']);
    expect((await getDecision(w.db.pool, w.service, allowed2.compatibilityDecisionId)).lifecycle).toBe('SUPERSEDED');
  });

  it('the database refuses an exception ALLOW linked to an authority for another tuple', async () => {
    const heldA = await substituteHold();
    const a = await engineerAuthority(w.engineer, heldA.compatibilityDecisionId);
    const heldB = await substituteHold();
    const forged = await rejection(
      w.db.pool.query(
        `INSERT INTO compatibility_decision_authorities (tenant_id, decision_id, authority_record_id) VALUES ($1, $2, $3)`,
        [w.tenant.tenantId, heldB.compatibilityDecisionId, a.authorityRecordId],
      ),
    );
    expect(forged.code).toBe('UB061');
  });
});
