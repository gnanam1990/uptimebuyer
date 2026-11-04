// T-009 (INV-10 deletion workflows, FR-23) — legal holds cover the whole scope hierarchy tenant > site > asset >
// incident. A deletion/redaction request is blocked when any active hold is an ancestor OR a descendant of the
// requested scope; unrelated sibling scopes are not blocked, and exports are never blocked.
import { newId, type AssetId, type SiteId } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitEvidenceRevision,
  createPrivacyRequest,
  createSite,
  placeLegalHold,
  registerAsset,
  releaseLegalHold,
  assignRole,
  type TenantContext,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  humanContext,
  incidentId,
  seedTenant,
  sha,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let t: SeededTenant;
let admin: TenantContext;
let s1: SiteId;
let s2: SiteId;
let a1: AssetId;
let a2: AssetId;

const request = (
  scopeType: 'TENANT' | 'SITE' | 'ASSET' | 'INCIDENT',
  scopeId: string,
  parentAssetId?: AssetId,
  requestType: 'DELETION' | 'REDACTION' | 'EXPORT' = 'DELETION',
) =>
  createPrivacyRequest(db.pool, admin, {
    requestType,
    subjectKind: 'CONTACT',
    subjectRefDigest: sha(`subject-${scopeId}-${requestType}`),
    scopeType,
    scopeId,
    ...(parentAssetId ? { parentAssetId } : {}),
  }).then((r) => r.state);

describe('T-009 legal holds block erasure across the scope hierarchy', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t009hold');
    const idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    t = await seedTenant(db.pool, idp, 'theta');
    await assignRole(db.pool, t.admin, {
      principal: { kind: 'HUMAN', userId: t.adminUserId },
      role: 'operator',
      siteId: null,
    });
    admin = await humanContext(db.pool, idp, t.adminSubject, t.tenantId);
    s1 = (await createSite(db.pool, admin, { name: 'S1', timezone: 'UTC', source: 'API' })).siteId;
    s2 = (await createSite(db.pool, admin, { name: 'S2', timezone: 'UTC', source: 'API' })).siteId;
    const identity = (serial: string) => ({
      manufacturer: 'M',
      model: 'X',
      serial,
      safetyClass: 'STANDARD' as const,
      bomRevision: '1',
    });
    a1 = (await registerAsset(db.pool, admin, { siteId: s1, identity: identity('H-1'), source: 'API' })).assetId;
    a2 = (await registerAsset(db.pool, admin, { siteId: s2, identity: identity('H-2'), source: 'API' })).assetId;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('a hold on a site blocks erasure for an asset or incident inside it, but not elsewhere or for export', async () => {
    const { legalHoldId } = await placeLegalHold(db.pool, admin, {
      scopeType: 'SITE',
      scopeId: s1,
      reasonCode: 'LITIGATION',
    });
    expect(await request('ASSET', a1)).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('INCIDENT', incidentId('hold-1'), a1, 'REDACTION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('SITE', s1)).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('TENANT', t.tenantId)).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('ASSET', a2)).toBe('RECEIVED');
    expect(await request('SITE', s2)).toBe('RECEIVED');
    expect(await request('ASSET', a1, undefined, 'EXPORT')).toBe('RECEIVED');
    await releaseLegalHold(db.pool, admin, legalHoldId);
    expect(await request('ASSET', a1, undefined, 'REDACTION')).toBe('RECEIVED');
  });

  it('a hold on an incident blocks site-wide, tenant-wide and asset-wide erasure, but not a sibling scope', async () => {
    const { legalHoldId } = await placeLegalHold(db.pool, admin, {
      scopeType: 'INCIDENT',
      scopeId: incidentId('held'),
      parentAssetId: a1,
      reasonCode: 'REGULATOR_INQUIRY',
    });
    expect(await request('SITE', s1, undefined, 'REDACTION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('TENANT', t.tenantId, undefined, 'REDACTION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('ASSET', a1, undefined, 'REDACTION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('INCIDENT', incidentId('held'), a1, 'REDACTION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('INCIDENT', incidentId('sibling'), a1, 'REDACTION')).toBe('RECEIVED');
    expect(await request('ASSET', a2, undefined, 'REDACTION')).toBe('RECEIVED');
    expect(await request('SITE', s2, undefined, 'REDACTION')).toBe('RECEIVED');
    await releaseLegalHold(db.pool, admin, legalHoldId);
  });

  it('an asset hold blocks its site and tenant scopes; a tenant hold blocks everything', async () => {
    const asset = await placeLegalHold(db.pool, admin, { scopeType: 'ASSET', scopeId: a2, reasonCode: 'LITIGATION' });
    expect(await request('SITE', s2, undefined, 'DELETION')).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('INCIDENT', incidentId('under-a2'), a2)).toBe('BLOCKED_LEGAL_HOLD');
    expect(await request('SITE', s1, undefined, 'DELETION')).toBe('RECEIVED');
    await releaseLegalHold(db.pool, admin, asset.legalHoldId);
    const tenant = await placeLegalHold(db.pool, admin, {
      scopeType: 'TENANT',
      scopeId: t.tenantId,
      reasonCode: 'LITIGATION',
    });
    expect(await request('INCIDENT', incidentId('anything'), a1)).toBe('BLOCKED_LEGAL_HOLD');
    await releaseLegalHold(db.pool, admin, tenant.legalHoldId);
  });

  it('a caller cannot dodge an incident hold by naming a different parent asset', async () => {
    const { legalHoldId } = await placeLegalHold(db.pool, admin, {
      scopeType: 'INCIDENT',
      scopeId: incidentId('pinned'),
      parentAssetId: a1,
      reasonCode: 'REGULATOR_INQUIRY',
    });
    // The hold pins the incident to a1: a request or hold naming a2 for the same incident is a mismatch, never a pass.
    await expect(request('INCIDENT', incidentId('pinned'), a2, 'REDACTION')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      placeLegalHold(db.pool, admin, {
        scopeType: 'INCIDENT',
        scopeId: incidentId('pinned'),
        parentAssetId: a2,
        reasonCode: 'LITIGATION',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await request('INCIDENT', incidentId('pinned'), a1, 'DELETION')).toBe('BLOCKED_LEGAL_HOLD');
    await releaseLegalHold(db.pool, admin, legalHoldId);
  });

  it('an incident scope must name an in-tenant asset consistent with recorded evidence', async () => {
    await expect(
      placeLegalHold(db.pool, admin, { scopeType: 'INCIDENT', scopeId: incidentId('x'), reasonCode: 'LITIGATION' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      placeLegalHold(db.pool, admin, {
        scopeType: 'INCIDENT',
        scopeId: incidentId('x'),
        parentAssetId: newId('asset'),
        reasonCode: 'LITIGATION',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { rows } = await db.admin(`SELECT current_revision_id FROM assets WHERE id = $1`, [a1]);
    await commitEvidenceRevision(db.pool, admin, {
      incidentId: incidentId('evidenced'),
      assetRevisionId: rows[0].current_revision_id,
      items: [],
    });
    await expect(
      placeLegalHold(db.pool, admin, {
        scopeType: 'INCIDENT',
        scopeId: incidentId('evidenced'),
        parentAssetId: a2,
        reasonCode: 'LITIGATION',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(request('INCIDENT', incidentId('evidenced'), a2)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
