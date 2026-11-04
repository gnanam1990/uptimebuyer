// T-011 (INV-03, INV-15) — approval vs concurrent supersession. An approval checked against a current asset or
// provider-account revision must never commit as a live approval after that revision was superseded: either the
// approval serializes before the supersession (which then invalidates it) or it is rejected.
// The interleaving is forced deterministically: a separate session row-locks the approval's site, so the approval
// INSERT (whose FK check needs a key-share lock on that site) stalls after its revision checks while the
// supersession runs.
import { setTimeout as sleep } from 'node:timers/promises';
import { money, type AssetId, type SiteId } from '@uptimebuyer/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  appendProviderAccountRevision,
  assignRole,
  commitEvidenceRevision,
  createProviderAccount,
  createSite,
  getApprovalStatus,
  publishPolicyRevision,
  recordApproval,
  registerAsset,
  reviseAssetIdentity,
  upsertUser,
  type ApprovalInput,
  type TenantContext,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  humanContext,
  fixtureIncident,
  seedTenant,
  sha,
  TestIdentityProvider,
  vdigest,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let t: SeededTenant;
let approver: TenantContext;
let siteId: SiteId;
let assetId: AssetId;
let policyRevisionId: string;

type Settled<T> = { ok: true; value: T } | { ok: false; error: { code?: string } };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

async function lockWaiters(): Promise<number> {
  const { rows } = await db.admin(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0].n;
}
async function waitForWaiters(n: number, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while ((await lockWaiters()) < n) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${n} lock waiter(s)`);
    await sleep(20);
  }
}

/** Run `approve` and `supersede` with the approval forced to stall between its checks and its insert. */
async function race<A, S>(approve: () => Promise<A>, supersede: () => Promise<S>) {
  const blocker = new pg.Client({ connectionString: db.url });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [t.tenantId, siteId]);
    const a = settle(approve());
    await waitForWaiters(1);
    const s = settle(supersede());
    // Give the supersession time to commit if nothing serializes it behind the approval.
    await Promise.race([s, sleep(500)]);
    await blocker.query('COMMIT');
    return { approval: await a, supersession: await s };
  } finally {
    await blocker.end();
  }
}

async function noLiveApprovalOnSupersededRevision() {
  const { rows } = await db.admin(
    `SELECT a.id FROM approvals a
       LEFT JOIN asset_revisions r ON r.tenant_id = a.tenant_id AND r.id = a.asset_revision_id
       LEFT JOIN provider_account_revisions p ON p.tenant_id = a.tenant_id AND p.id = a.provider_account_revision_id
      WHERE (r.superseded_at IS NOT NULL OR p.superseded_at IS NOT NULL)
        AND a.expires_at > now()
        AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id)`,
  );
  expect(rows).toEqual([]);
}

describe('T-011 approval vs concurrent revision supersession', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t011race');
    const idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    t = await seedTenant(db.pool, idp, 'lambda');
    siteId = (await createSite(db.pool, t.admin, { name: 'S', timezone: 'UTC', source: 'API' })).siteId;
    assetId = (
      await registerAsset(db.pool, t.admin, {
        siteId,
        identity: { manufacturer: 'M', model: 'X', serial: 'R-0', safetyClass: 'STANDARD', bomRevision: '1' },
        source: 'API',
      })
    ).assetId;
    policyRevisionId = (
      await publishPolicyRevision(db.pool, t.admin, {
        policyKey: 'AUTHORITY',
        body: {
          approvalLimits: [
            {
              approvalKind: 'PLAN_ACTION',
              actionClass: 'STANDARD',
              role: 'maintenance_approver',
              currency: 'USD',
              maxAmountMinor: 100_000n,
              siteIds: null,
            },
          ],
        },
        source: 'API',
      })
    ).policyRevisionId;
    const subject = `approver-${Date.now()}`;
    const user = await upsertUser(db.pool, { issuer: idp.issuer, externalSubject: subject, displayName: 'approver' });
    await addMembership(db.pool, t.admin, user.userId);
    for (const role of ['maintenance_approver', 'operator'] as const)
      await assignRole(db.pool, t.admin, { principal: { kind: 'HUMAN', userId: user.userId }, role, siteId: null });
    approver = await humanContext(db.pool, idp, subject, t.tenantId);
  });
  afterAll(async () => {
    await db?.drop();
  });

  async function freshInput(n: string, providerAccountRevisionId: string | null): Promise<ApprovalInput> {
    const { rows } = await db.admin(`SELECT current_revision_id, version FROM assets WHERE id = $1`, [assetId]);
    const inc = await fixtureIncident(db.pool, {
      tenantId: t.tenantId,
      assetId,
      userId: t.adminUserId,
      label: `race-${n}`,
    });
    const ev = await commitEvidenceRevision(db.pool, approver, {
      incidentId: inc,
      assetRevisionId: rows[0].current_revision_id,
      items: [],
    });
    return {
      approvalKind: 'PLAN_ACTION',
      incidentId: inc,
      siteId,
      assetRevisionId: rows[0].current_revision_id,
      evidenceRevisionId: ev.evidenceRevisionId,
      policyRevisionId,
      planHash: vdigest('plan', n),
      actionDigest: vdigest('action', n),
      actionClass: 'STANDARD',
      paid: providerAccountRevisionId !== null,
      providerAccountRevisionId,
      targetExecutionAuthorityId: null,
      maxAmount: money(1_000n, 'USD'),
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  }

  it('asset identity supersession racing an approval never leaves a live approval on the old revision', async () => {
    const input = await freshInput('asset', null);
    const { rows } = await db.admin(`SELECT version FROM assets WHERE id = $1`, [assetId]);
    const { approval, supersession } = await race(
      () => recordApproval(db.pool, approver, input),
      () =>
        reviseAssetIdentity(
          db.pool,
          t.admin,
          assetId,
          { manufacturer: 'M', model: 'X', serial: 'R-1', safetyClass: 'STANDARD', bomRevision: '1' },
          { expectedVersion: rows[0].version, source: 'API' },
        ),
    );
    expect(supersession.ok).toBe(true);
    if (approval.ok) {
      const status = await getApprovalStatus(db.pool, approver, approval.value.approvalId);
      expect(status.executable).toBe(false);
      expect(status.events.map((e) => e.reasonCode)).toEqual(['ASSET_REVISION_SUPERSEDED']);
    } else expect(approval.error.code).toBe('POLICY_HOLD');
    await noLiveApprovalOnSupersededRevision();
  });

  it('provider-account revision supersession racing a paid approval never leaves it live', async () => {
    const account = await createProviderAccount(db.pool, t.admin, {
      providerKey: 'race-provider',
      environment: 'SANDBOX',
      revision: {
        capabilities: ['PURCHASE'],
        paid: true,
        ownerService: 'KITE_BROKER_PAID',
        credentialRef: `secretref:provider/tenants/${t.tenantId}/race`,
        endpointPolicyDigest: sha('race-endpoint'),
        webhookVerifierRef: null,
      },
      source: 'API',
    });
    const input = await freshInput('provider', account.providerAccountRevisionId);
    const { approval, supersession } = await race(
      () => recordApproval(db.pool, approver, input),
      () =>
        appendProviderAccountRevision(db.pool, t.admin, account.providerAccountId, {
          revision: {
            capabilities: ['PURCHASE', 'QUOTE'],
            paid: true,
            ownerService: 'KITE_BROKER_PAID',
            credentialRef: `secretref:provider/tenants/${t.tenantId}/race-2`,
            endpointPolicyDigest: sha('race-endpoint-2'),
            webhookVerifierRef: null,
          },
          source: 'API',
        }),
    );
    expect(supersession.ok).toBe(true);
    if (approval.ok) {
      const status = await getApprovalStatus(db.pool, approver, approval.value.approvalId);
      expect(status.executable).toBe(false);
      expect(status.events.map((e) => e.reasonCode)).toEqual(['PROVIDER_ACCOUNT_REVISION_SUPERSEDED']);
    } else expect(approval.error.code).toBe('POLICY_HOLD');
    await noLiveApprovalOnSupersededRevision();
  });
});
