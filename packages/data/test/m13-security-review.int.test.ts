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

// S5 — dual approval was decided from the revision in force only: an administrator alone could weaken or empty the
// separation-of-duties section, supersede a queued revision that turns dual approval on, or have a revision queued
// before the control quietly take effect after it. Required: while the current or ANY scheduled AUTHORITY revision has
// a non-empty separationOfDuties section, every AUTHORITY change needs a second administrator (and every key a current
// or scheduled revision names); enabling the section is refused while an unreviewed revision is queued; the database
// enforces the same rule under the governance lock.
describe('M13 security review S5: governance of the separation-of-duties section', () => {
  let idp: TestIdentityProvider;
  beforeAll(async () => {
    idp = await TestIdentityProvider.create();
  });

  async function twoAdmins(label: string) {
    const tt = await seedTenant(db.pool, idp, label);
    const subject = `${label}-admin-two`;
    const u = await upsertUser(db.pool, { issuer: idp.issuer, externalSubject: subject, displayName: 'second admin' });
    await addMembership(db.pool, tt.admin, u.userId);
    await assignRole(db.pool, tt.admin, {
      principal: { kind: 'HUMAN', userId: u.userId },
      role: 'admin',
      siteId: null,
    });
    return { t: tt, second: await humanContext(db.pool, idp, subject, tt.tenantId) };
  }
  const SPEND = { approvalLimits: [], separationOfDuties: { spend: [{ currency: 'USD', minAmountMinor: 10_000n }] } };
  const DUAL_RETENTION = { approvalLimits: [], separationOfDuties: { dualApprovalPolicyKeys: ['RETENTION'] } };
  const EMPTY = { approvalLimits: [] };
  const authority = (body: object, effectiveAt?: string) => ({
    policyKey: 'AUTHORITY' as const,
    body: body as never,
    source: 'API' as const,
    ...(effectiveAt ? { effectiveAt: effectiveAt as never } : {}),
  });
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const directInsert = async (tenantId: string, key: string, publishedBy: string, effectiveAt: string) => {
    const pol = (await db.admin(`SELECT id FROM policies WHERE tenant_id = $1 AND policy_key = $2`, [tenantId, key]))
      .rows[0];
    return db
      .admin(
        `INSERT INTO policy_revisions (tenant_id, id, policy_id, revision, schema_name, body, body_digest, effective_at,
           published_by_user_id, source)
         VALUES ($1, 'pol_' || replace(gen_random_uuid()::text, '-', ''), $2, 900 + (random() * 99)::int, 'policy.authority.v1',
           '{"approvalLimits":[]}', 'policy.v1:sha256:' || repeat('b', 64), $4, $3, 'API')`,
        [tenantId, pol.id, publishedBy, effectiveAt],
      )
      .then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
  };

  it('an administrator alone cannot weaken or empty an active separation-of-duties section', async () => {
    const { t: tt, second } = await twoAdmins('s5a');
    await publishPolicyRevision(db.pool, tt.admin, authority(SPEND));
    expect(await reason(publishPolicyRevision(db.pool, tt.admin, authority(EMPTY)))).toBe(
      'POLICY_HOLD:DUAL_APPROVAL_REQUIRED',
    );
    expect(await directInsert(tt.tenantId, 'AUTHORITY', tt.adminUserId, new Date().toISOString())).toBe('UB131');
    const p = await proposePolicyRevision(db.pool, tt.admin, authority(EMPTY));
    expect(
      await reason(approvePolicyProposal(db.pool, second, { policyChangeProposalId: p.policyChangeProposalId })),
    ).toBe('ALLOWED');
  });

  it('a queued revision that turns dual approval on cannot be superseded by one administrator', async () => {
    const { t: tt, second } = await twoAdmins('s5b');
    await publishPolicyRevision(db.pool, tt.admin, authority(DUAL_RETENTION, inHours(1)));
    // Later-effective supersede, earlier-effective change, and a RETENTION publish all need the second admin.
    for (const at of [inHours(2), inHours(0.5)])
      expect(await reason(publishPolicyRevision(db.pool, tt.admin, authority(EMPTY, at))), at).toBe(
        'POLICY_HOLD:DUAL_APPROVAL_REQUIRED',
      );
    expect(
      await reason(
        publishPolicyRevision(db.pool, tt.admin, {
          policyKey: 'RETENTION',
          body: { telemetryDays: 1, communicationDays: 1, auditDays: 1 },
          source: 'API',
        }),
      ),
    ).toBe('POLICY_HOLD:DUAL_APPROVAL_REQUIRED');
    expect(await directInsert(tt.tenantId, 'AUTHORITY', tt.adminUserId, inHours(2))).toBe('UB131');
    const p = await proposePolicyRevision(db.pool, tt.admin, authority(EMPTY, inHours(2)));
    expect(
      await reason(approvePolicyProposal(db.pool, second, { policyChangeProposalId: p.policyChangeProposalId })),
    ).toBe('ALLOWED');
  });

  it('a revision queued before the section was enabled never takes effect unapproved', async () => {
    const { t: tt } = await twoAdmins('s5c');
    await publishPolicyRevision(db.pool, tt.admin, authority(EMPTY, inHours(1)));
    expect(await reason(publishPolicyRevision(db.pool, tt.admin, authority(SPEND)))).toBe(
      'POLICY_HOLD:PENDING_UNREVIEWED_FUTURE_REVISION',
    );
    // A direct insert of the enabling revision is refused by the database as well.
    const enabled = await db
      .admin(
        `INSERT INTO policy_revisions (tenant_id, id, policy_id, revision, schema_name, body, body_digest, effective_at,
           published_by_user_id, source)
         SELECT $1, 'pol_' || replace(gen_random_uuid()::text, '-', ''), p.id, 950, 'policy.authority.v1',
           '{"approvalLimits":[],"separationOfDuties":{"spend":[{"currency":"USD","minAmountMinor":"1"}]}}',
           'policy.v1:sha256:' || repeat('c', 64), clock_timestamp(), $2, 'API'
           FROM policies p WHERE p.tenant_id = $1 AND p.policy_key = 'AUTHORITY'`,
        [tt.tenantId, tt.adminUserId],
      )
      .then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    expect(enabled).toBe('UB131');
  });

  it('concurrent publishes cannot interleave past the control', async () => {
    for (let i = 0; i < 4; i++) {
      const { t: tt } = await twoAdmins(`s5d${i}`);
      const [enable, retention] = await Promise.allSettled([
        publishPolicyRevision(db.pool, tt.admin, authority(DUAL_RETENTION)),
        publishPolicyRevision(db.pool, tt.admin, {
          policyKey: 'RETENTION',
          body: { telemetryDays: 2, communicationDays: 2, auditDays: 2 },
          source: 'API',
        }),
      ]);
      expect(enable.status).toBe('fulfilled');
      if (retention.status === 'fulfilled') {
        // Allowed only if it committed before the control existed.
        const r = await db.admin(
          `SELECT (SELECT published_at FROM policy_revisions WHERE id = $1) < (SELECT published_at FROM policy_revisions WHERE id = $2) AS before`,
          [
            retention.value.policyRevisionId,
            (enable as PromiseFulfilledResult<{ policyRevisionId: string }>).value.policyRevisionId,
          ],
        );
        expect(r.rows[0].before).toBe(true);
      } else
        expect((retention.reason as { details?: { reasonCode?: string } }).details?.reasonCode).toBe(
          'DUAL_APPROVAL_REQUIRED',
        );
    }
  });
});
