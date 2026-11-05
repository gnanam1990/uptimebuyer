// M13 security review findings over the M13 data-layer diff. Each case was added red before its fix.
// S2 — dual approval could be pre-empted by a revision scheduled before it was enabled: a single administrator
// publishes a future-dated AUTHORITY revision without dual approval, then enables dual approval; when the queued
// revision takes effect it silently switches dual approval off (and every key it covered) without a second person.
// Enabling dual approval is now refused while any unreviewed future-dated revision of AUTHORITY or a covered key is
// queued, on both the direct and the proposal path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  approvePolicyProposal,
  assignRole,
  proposePolicyRevision,
  publishPolicyRevision,
  upsertUser,
  type TenantContext,
} from '../src/index.js';
import {
  TestIdentityProvider,
  createTestDatabase,
  dbScripts,
  humanContext,
  seedTenant,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let t: SeededTenant;
let admin2: TenantContext;

beforeAll(async () => {
  db = await createTestDatabase('m13sr');
  await (await dbScripts()).migrate(db.url);
  const idp = await TestIdentityProvider.create();
  t = await seedTenant(db.pool, idp, 'sr');
  const u = await upsertUser(db.pool, {
    issuer: idp.issuer,
    externalSubject: 'sr-admin-two',
    displayName: 'admin two',
  });
  await addMembership(db.pool, t.admin, u.userId);
  await assignRole(db.pool, t.admin, { principal: { kind: 'HUMAN', userId: u.userId }, role: 'admin', siteId: null });
  admin2 = await humanContext(db.pool, idp, 'sr-admin-two', t.tenantId);
});
afterAll(async () => {
  await db?.drop();
});

const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'ALLOWED',
    (e: { code?: string; details?: { reasonCode?: string } }) => `${e.code}:${e.details?.reasonCode}`,
  );

describe('M13 security review S2: no pre-scheduled bypass of dual approval', () => {
  it('refuses to enable dual approval while an unreviewed future revision is queued', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await publishPolicyRevision(db.pool, t.admin, {
      policyKey: 'AUTHORITY',
      body: { approvalLimits: [] },
      effectiveAt: later as never,
      source: 'API',
    });
    const enable = {
      approvalLimits: [],
      separationOfDuties: { dualApprovalPolicyKeys: ['AUTHORITY', 'RETENTION'] },
    } as const;
    expect(
      await reason(
        publishPolicyRevision(db.pool, t.admin, { policyKey: 'AUTHORITY', body: enable as never, source: 'API' }),
      ),
    ).toBe('POLICY_HOLD:PENDING_UNREVIEWED_FUTURE_REVISION');
    const p = await proposePolicyRevision(db.pool, t.admin, {
      policyKey: 'AUTHORITY',
      body: enable as never,
      source: 'API',
    });
    expect(
      await reason(approvePolicyProposal(db.pool, admin2, { policyChangeProposalId: p.policyChangeProposalId })),
    ).toBe('POLICY_HOLD:PENDING_UNREVIEWED_FUTURE_REVISION');
  });

  it('still allows enabling dual approval when no unreviewed revision is queued (control)', async () => {
    const t2db = await createTestDatabase('m13sr2');
    try {
      await (await dbScripts()).migrate(t2db.url);
      const idp = await TestIdentityProvider.create();
      const t2 = await seedTenant(t2db.pool, idp, 'sr2');
      const enable = { approvalLimits: [], separationOfDuties: { dualApprovalPolicyKeys: ['RETENTION'] } } as const;
      expect(
        await reason(
          publishPolicyRevision(t2db.pool, t2.admin, { policyKey: 'AUTHORITY', body: enable as never, source: 'API' }),
        ),
      ).toBe('ALLOWED');
    } finally {
      await t2db.drop();
    }
  });
});
