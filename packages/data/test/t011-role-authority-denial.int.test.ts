// T-011 — Role and approval authority denial (FR-10 shared layer, FR-24, INV-15, NFR-05).
// Viewer, operator, maintenance/finance approver, engineer, administrator, auditor, device, service and integration
// identities are each tested against every privileged action, including site and amount (minor units + currency)
// boundaries and approval kind. Authorization is deny-by-default; separate principal kinds authenticate separately.
import { money, newId, type CurrencyCode, type SiteId } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIONS,
  addMembership,
  assignRole,
  authenticateDevice,
  authenticateHuman,
  authenticateIntegration,
  authenticateService,
  authorize,
  createProviderAccount,
  createSite,
  publishPolicyRevision,
  recordApproval,
  registerDevice,
  registerIntegrationIdentity,
  registerServiceIdentity,
  resolveTenantContext,
  revokeRole,
  setDeviceStatus,
  signPrincipalToken,
  upsertUser,
  commitEvidenceRevision,
  registerAsset,
  listAuditEntries,
  type ActionName,
  type AuthorityPolicy,
  type AuthorizationRequest,
  type Role,
  type TenantContext,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  humanContext,
  fixtureIncident,
  resolver,
  seedTenant,
  sha,
  syntheticKey,
  TestIdentityProvider,
  vdigest,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let idp: TestIdentityProvider;
let t: SeededTenant;
let s1: SiteId;
let s2: SiteId;
let policy: AuthorityPolicy;
let policyRevisionId: string;
const creds = resolver();
const ctx: Record<string, TenantContext> = {};
const subjects: Record<string, string> = {};

type Identity =
  | 'viewer'
  | 'operator'
  | 'maintenance_approver'
  | 'finance_approver'
  | 'engineer'
  | 'admin'
  | 'site_admin'
  | 'auditor'
  | 'device'
  | 'service'
  | 'integration';
const IDENTITIES: Identity[] = [
  'viewer',
  'operator',
  'maintenance_approver',
  'finance_approver',
  'engineer',
  'admin',
  'site_admin',
  'auditor',
  'device',
  'service',
  'integration',
];

const usd = (n: bigint) => money(n, 'USD');

// The expected matrix at site S1 within every amount bound. Anything not listed is denied.
const ALLOWED: Record<ActionName, Identity[]> = {
  'registry.read': [
    'viewer',
    'operator',
    'maintenance_approver',
    'finance_approver',
    'engineer',
    'admin',
    'site_admin',
    'auditor',
  ],
  'registry.write': ['admin', 'site_admin'],
  'incident.acknowledge': ['operator', 'maintenance_approver', 'engineer'],
  'incident.read': [
    'viewer',
    'operator',
    'maintenance_approver',
    'finance_approver',
    'engineer',
    'admin',
    'site_admin',
    'auditor',
  ],
  'incident.manage': ['operator', 'maintenance_approver', 'engineer'],
  'incident.report': ['operator', 'maintenance_approver', 'engineer'],
  'incident.engine': ['service'],
  'evidence.submit': ['operator', 'maintenance_approver', 'engineer'],
  // Tenant-wide curators only; every identity in this matrix except the tenant admin is site-scoped.
  'evidence.library_write': ['admin'],
  'evidence.read': [
    'viewer',
    'operator',
    'maintenance_approver',
    'finance_approver',
    'engineer',
    'admin',
    'site_admin',
    'auditor',
    'service',
  ],
  'evidence.engine': ['service'],
  'approval.plan_action': ['maintenance_approver'],
  'approval.budget_adjustment': ['finance_approver'],
  'approval.engineering_exception': ['engineer'],
  'policy.publish': ['admin'],
  'role.assign': ['admin'],
  'provider_account.manage': ['admin'],
  'audit.read': ['admin', 'auditor'],
  'audit.export': ['admin', 'auditor'],
  'evidence.export': ['admin', 'auditor'],
  'telemetry.read': [
    'viewer',
    'operator',
    'maintenance_approver',
    'finance_approver',
    'engineer',
    'admin',
    'site_admin',
    'auditor',
  ],
  'telemetry.ingest': ['device'],
  'job.execute': ['service'],
  'outbox.dispatch': ['service'],
  'provider_callback.ingest': ['integration'],
};

function requestFor(action: ActionName, siteId: SiteId | null = s1): AuthorizationRequest {
  switch (action) {
    case 'approval.plan_action':
      return { action, siteId, approvalKind: 'PLAN_ACTION', actionClass: 'STANDARD', amount: usd(50_000n) };
    case 'approval.budget_adjustment':
      return { action, siteId, approvalKind: 'BUDGET_ADJUSTMENT', actionClass: 'STANDARD', amount: usd(200_000n) };
    case 'approval.engineering_exception':
      return { action, siteId, approvalKind: 'PLAN_ACTION', actionClass: 'SUBSTITUTE', amount: usd(50_000n) };
    case 'policy.publish':
    case 'role.assign':
    case 'provider_account.manage':
    case 'audit.read':
    case 'audit.export':
    case 'evidence.export':
    case 'evidence.library_write':
      return { action, siteId: null };
    default:
      return { action, siteId };
  }
}

describe('T-011 role and approval authority denial', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t011');
    idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    t = await seedTenant(db.pool, idp, 'gamma');
    s1 = (await createSite(db.pool, t.admin, { name: 'S1', timezone: 'Europe/Paris', source: 'API' })).siteId;
    s2 = (await createSite(db.pool, t.admin, { name: 'S2', timezone: 'Europe/Paris', source: 'API' })).siteId;
    policy = {
      approvalLimits: [
        {
          approvalKind: 'PLAN_ACTION',
          actionClass: 'STANDARD',
          role: 'maintenance_approver',
          currency: 'USD',
          maxAmountMinor: 50_000n,
          siteIds: null,
        },
        {
          approvalKind: 'BUDGET_ADJUSTMENT',
          actionClass: 'STANDARD',
          role: 'finance_approver',
          currency: 'USD',
          maxAmountMinor: 200_000n,
          siteIds: [s1],
        },
        {
          approvalKind: 'PLAN_ACTION',
          actionClass: 'SUBSTITUTE',
          role: 'engineer',
          currency: 'USD',
          maxAmountMinor: 50_000n,
          siteIds: null,
        },
        // A misconfigured rule naming a non-engineer for a substitute must not weaken INV-15.
        {
          approvalKind: 'PLAN_ACTION',
          actionClass: 'SUBSTITUTE',
          role: 'maintenance_approver',
          currency: 'USD',
          maxAmountMinor: 50_000n,
          siteIds: null,
        },
      ],
    };
    policyRevisionId = (
      await publishPolicyRevision(db.pool, t.admin, { policyKey: 'AUTHORITY', body: policy, source: 'API' })
    ).policyRevisionId;

    const humanRoles: [Identity, Role, SiteId | null][] = [
      ['viewer', 'viewer', s1],
      ['operator', 'operator', s1],
      ['maintenance_approver', 'maintenance_approver', s1],
      ['finance_approver', 'finance_approver', null],
      ['engineer', 'engineer', s1],
      ['site_admin', 'admin', s1],
      ['auditor', 'auditor', null],
    ];
    for (const [identity, role, siteId] of humanRoles) {
      const subject = `${identity}-${Date.now()}`;
      subjects[identity] = subject;
      const user = await upsertUser(db.pool, { issuer: idp.issuer, externalSubject: subject, displayName: identity });
      await addMembership(db.pool, t.admin, user.userId);
      await assignRole(db.pool, t.admin, { principal: { kind: 'HUMAN', userId: user.userId }, role, siteId });
      if (role === 'maintenance_approver' || role === 'engineer')
        await assignRole(db.pool, t.admin, {
          principal: { kind: 'HUMAN', userId: user.userId },
          role: 'operator',
          siteId,
        });
      ctx[identity] = await humanContext(db.pool, idp, subject, t.tenantId);
    }
    ctx.admin = t.admin;

    const deviceKey = syntheticKey();
    creds.set(`secretref:device/tenants/${t.tenantId}/gamma-1`, deviceKey);
    const device = await registerDevice(db.pool, t.admin, {
      siteId: s1,
      credentialRef: `secretref:device/tenants/${t.tenantId}/gamma-1`,
      source: 'API',
    });
    subjects.device = device.deviceId;
    ctx.device = await resolveTenantContext(
      db.pool,
      await authenticateDevice(db.pool, creds, await signPrincipalToken('DEVICE', device.deviceId, deviceKey)),
      undefined,
    );

    const serviceKey = syntheticKey();
    creds.set(`secretref:service/tenants/${t.tenantId}/gamma-worker`, serviceKey);
    const svc = await registerServiceIdentity(db.pool, t.admin, {
      workload: 'general-worker',
      credentialRef: `secretref:service/tenants/${t.tenantId}/gamma-worker`,
    });
    await assignRole(db.pool, t.admin, {
      principal: { kind: 'SERVICE', serviceIdentityId: svc.serviceIdentityId },
      role: 'worker',
      siteId: null,
    });
    subjects.service = svc.serviceIdentityId;
    ctx.service = await resolveTenantContext(
      db.pool,
      await authenticateService(db.pool, creds, await signPrincipalToken('SERVICE', svc.serviceIdentityId, serviceKey)),
      t.tenantId,
    );

    const provider = await createProviderAccount(db.pool, t.admin, {
      providerKey: 'cmms-demo',
      environment: 'SANDBOX',
      revision: {
        capabilities: ['WEBHOOK'],
        paid: false,
        ownerService: 'M07_UNPAID',
        credentialRef: `secretref:provider/tenants/${t.tenantId}/gamma-cmms`,
        endpointPolicyDigest: sha('gamma-endpoint'),
        webhookVerifierRef: `secretref:webhook/tenants/${t.tenantId}/gamma-cmms`,
      },
      source: 'API',
    });
    const integrationKey = syntheticKey();
    creds.set(`secretref:integration/tenants/${t.tenantId}/gamma-cmms`, integrationKey);
    const integ = await registerIntegrationIdentity(db.pool, t.admin, {
      providerAccountId: provider.providerAccountId,
      credentialRef: `secretref:integration/tenants/${t.tenantId}/gamma-cmms`,
    });
    await assignRole(db.pool, t.admin, {
      principal: { kind: 'INTEGRATION', integrationIdentityId: integ.integrationIdentityId },
      role: 'integration',
      siteId: null,
    });
    subjects.integration = integ.integrationIdentityId;
    ctx.integration = await resolveTenantContext(
      db.pool,
      await authenticateIntegration(
        db.pool,
        creds,
        await signPrincipalToken('INTEGRATION', integ.integrationIdentityId, integrationKey),
      ),
      undefined,
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('the action catalogue is exactly the tested set', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('each identity is allowed exactly its role actions and denied every other privileged action (deny by default)', () => {
    for (const action of Object.keys(ALLOWED) as ActionName[])
      for (const identity of IDENTITIES) {
        const decision = authorize(ctx[identity]!, requestFor(action), policy);
        expect(decision.allowed, `${identity} -> ${action}`).toBe(ALLOWED[action].includes(identity));
        if (!decision.allowed) expect(decision.reasonCode).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
  });

  it('site boundaries: site-scoped grants do not reach another site, and site-scoped actions require a site', () => {
    for (const identity of ['viewer', 'operator', 'maintenance_approver', 'engineer', 'site_admin'] as const) {
      expect(authorize(ctx[identity]!, requestFor('registry.read', s2), policy).allowed, identity).toBe(false);
      expect(authorize(ctx[identity]!, requestFor('registry.read', s1), policy).allowed, identity).toBe(true);
    }
    expect(authorize(ctx.maintenance_approver!, requestFor('approval.plan_action', s2), policy)).toMatchObject({
      allowed: false,
      reasonCode: 'SITE_OUT_OF_SCOPE',
    });
    expect(authorize(ctx.site_admin!, requestFor('registry.write', null), policy).allowed).toBe(false);
    expect(authorize(ctx.site_admin!, requestFor('policy.publish'), policy).allowed).toBe(false);
    expect(authorize(ctx.admin!, requestFor('registry.write', s2), policy).allowed).toBe(true);
    expect(authorize(ctx.operator!, { action: 'incident.acknowledge', siteId: null }, policy)).toMatchObject({
      allowed: false,
      reasonCode: 'SITE_REQUIRED',
    });
    // Finance approver is tenant-wide, but the policy limits budget adjustments to S1.
    expect(authorize(ctx.finance_approver!, requestFor('approval.budget_adjustment', s2), policy)).toMatchObject({
      allowed: false,
      reasonCode: 'NO_MATCHING_AUTHORITY_RULE',
    });
  });

  it('amount boundaries are exact in minor units and currency-bound', () => {
    const plan = (amountMinor: bigint, currency: CurrencyCode = 'USD'): AuthorizationRequest => ({
      action: 'approval.plan_action',
      siteId: s1,
      approvalKind: 'PLAN_ACTION',
      actionClass: 'STANDARD',
      amount: money(amountMinor, currency),
    });
    expect(authorize(ctx.maintenance_approver!, plan(0n), policy).allowed).toBe(true);
    expect(authorize(ctx.maintenance_approver!, plan(50_000n), policy).allowed).toBe(true);
    expect(authorize(ctx.maintenance_approver!, plan(50_001n), policy)).toMatchObject({
      allowed: false,
      reasonCode: 'NO_MATCHING_AUTHORITY_RULE',
    });
    expect(authorize(ctx.maintenance_approver!, plan(100n, 'EUR'), policy).allowed).toBe(false);
    expect(authorize(ctx.maintenance_approver!, plan(100n, 'JPY'), policy).allowed).toBe(false);
    const { amount: _omit, ...noAmount } = plan(1n);
    expect(authorize(ctx.maintenance_approver!, noAmount as AuthorizationRequest, policy)).toMatchObject({
      allowed: false,
      reasonCode: 'AMOUNT_REQUIRED',
    });
    expect(authorize(ctx.maintenance_approver!, plan(1n), undefined)).toMatchObject({
      allowed: false,
      reasonCode: 'POLICY_REQUIRED',
    });
    const budget = (n: bigint): AuthorizationRequest => ({
      action: 'approval.budget_adjustment',
      siteId: s1,
      approvalKind: 'BUDGET_ADJUSTMENT',
      actionClass: 'STANDARD',
      amount: usd(n),
    });
    expect(authorize(ctx.finance_approver!, budget(200_000n), policy).allowed).toBe(true);
    expect(authorize(ctx.finance_approver!, budget(200_001n), policy).allowed).toBe(false);
    // Approval kinds do not cross: a plan approver cannot adjust budgets and vice versa.
    expect(authorize(ctx.maintenance_approver!, budget(1n), policy).allowed).toBe(false);
    expect(authorize(ctx.finance_approver!, plan(1n), policy).allowed).toBe(false);
    // A mismatched approval kind for the action is rejected outright.
    expect(
      authorize(ctx.finance_approver!, { ...budget(1n), approvalKind: 'PLAN_ACTION' } as AuthorizationRequest, policy),
    ).toMatchObject({ allowed: false, reasonCode: 'APPROVAL_KIND_MISMATCH' });
  });

  it('substitute, non-exact and safety-critical approvals require a named engineer regardless of policy text', () => {
    for (const actionClass of ['SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL'] as const) {
      const req: AuthorizationRequest = {
        action: 'approval.engineering_exception',
        siteId: s1,
        approvalKind: 'PLAN_ACTION',
        actionClass,
        amount: usd(10_000n),
      };
      expect(authorize(ctx.maintenance_approver!, req, policy).allowed, actionClass).toBe(false);
      expect(authorize(ctx.admin!, req, policy).allowed, actionClass).toBe(false);
      // Only SUBSTITUTE has an engineer rule in this policy; the others fail closed even for the engineer.
      expect(authorize(ctx.engineer!, req, policy).allowed, actionClass).toBe(actionClass === 'SUBSTITUTE');
      // A standard plan-action request cannot smuggle an engineering class.
      expect(
        authorize(ctx.maintenance_approver!, { ...req, action: 'approval.plan_action' } as AuthorizationRequest, policy)
          .allowed,
      ).toBe(false);
    }
  });

  it('the repository enforces authority on approvals and configuration, auditing every denial', async () => {
    const asset = await registerAsset(db.pool, t.admin, {
      siteId: s1,
      identity: {
        manufacturer: 'Hoshizaki',
        model: 'KM-515',
        serial: 'G-1',
        safetyClass: 'STANDARD',
        bomRevision: '1',
      },
      source: 'API',
    });
    const gamma = await fixtureIncident(db.pool, {
      tenantId: t.tenantId,
      assetId: asset.assetId,
      userId: t.adminUserId,
      label: 'gamma',
    });
    const evidence = await commitEvidenceRevision(db.pool, ctx.operator!, {
      incidentId: gamma,
      assetRevisionId: asset.assetRevisionId,
      items: [],
    });
    const input = {
      approvalKind: 'PLAN_ACTION' as const,
      incidentId: gamma,
      siteId: s1,
      assetRevisionId: asset.assetRevisionId,
      evidenceRevisionId: evidence.evidenceRevisionId,
      policyRevisionId,
      planHash: vdigest('plan', 'gamma'),
      actionDigest: vdigest('action', 'gamma'),
      actionClass: 'STANDARD' as const,
      paid: false,
      providerAccountRevisionId: null,
      targetExecutionAuthorityId: null,
      maxAmount: usd(50_000n),
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    for (const who of ['viewer', 'operator', 'finance_approver', 'engineer', 'admin', 'auditor', 'device', 'service'])
      await expect(recordApproval(db.pool, ctx[who]!, input), who).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      recordApproval(db.pool, ctx.maintenance_approver!, { ...input, maxAmount: usd(50_001n) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ok = await recordApproval(db.pool, ctx.maintenance_approver!, input);
    expect(ok.approvalId).toMatch(/^apr_/);
    // Paid scope must pin the exact provider-account revision.
    await expect(recordApproval(db.pool, ctx.maintenance_approver!, { ...input, paid: true })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await expect(
      publishPolicyRevision(db.pool, ctx.site_admin!, { policyKey: 'AUTHORITY', body: policy, source: 'API' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createSite(db.pool, ctx.viewer!, { name: 'nope', timezone: 'Europe/Paris', source: 'API' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      assignRole(db.pool, ctx.maintenance_approver!, {
        principal: { kind: 'HUMAN', userId: t.adminUserId },
        role: 'engineer',
        siteId: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Devices cannot hold roles at all.
    await expect(
      assignRole(db.pool, t.admin, {
        principal: { kind: 'DEVICE', deviceId: subjects.device } as never,
        role: 'admin',
        siteId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const denials = await listAuditEntries(db.pool, t.admin, { result: 'DENIED' });
    const actions = denials.map((d) => d.action);
    expect(actions.filter((x) => x === 'approval.plan_action').length).toBeGreaterThanOrEqual(9);
    expect(actions).toContain('policy.publish');
    expect(actions).toContain('registry.write');
    expect(actions).toContain('role.assign');
  });

  it('revoked roles and revoked devices lose authority on the next resolution', async () => {
    const viewer = ctx.viewer!;
    const grant = viewer.grants.find((g) => g.role === 'viewer')!;
    await revokeRole(db.pool, t.admin, grant.assignmentId!);
    const fresh = await humanContext(db.pool, idp, subjects.viewer!, t.tenantId);
    expect(authorize(fresh, requestFor('registry.read'), policy).allowed).toBe(false);

    await setDeviceStatus(db.pool, t.admin, subjects.device as never, 'REVOKED');
    const key = creds.get(`secretref:device/tenants/${t.tenantId}/gamma-1`)!;
    await expect(
      authenticateDevice(db.pool, creds, await signPrincipalToken('DEVICE', subjects.device!, key)),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('principal kinds authenticate separately: tokens are not interchangeable and bad tokens fail closed', async () => {
    const serviceKey = creds.get(`secretref:service/tenants/${t.tenantId}/gamma-worker`)!;
    const serviceToken = await signPrincipalToken('SERVICE', subjects.service!, serviceKey);
    await expect(authenticateDevice(db.pool, creds, serviceToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(authenticateIntegration(db.pool, creds, serviceToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(authenticateHuman(db.pool, idp.verifier(), `Bearer ${serviceToken}`)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const humanToken = await idp.mint(subjects.operator!);
    await expect(authenticateService(db.pool, creds, humanToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Wrong key, expired, wrong audience, unknown subject and unknown principal all fail with one opaque code.
    const wrongKey = await signPrincipalToken('SERVICE', subjects.service!, syntheticKey());
    await expect(authenticateService(db.pool, creds, wrongKey)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const expired = await signPrincipalToken('SERVICE', subjects.service!, serviceKey, { ttlSeconds: -60 });
    await expect(authenticateService(db.pool, creds, expired)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const unknownSvc = await signPrincipalToken('SERVICE', newId('serviceIdentity'), serviceKey);
    await expect(authenticateService(db.pool, creds, unknownSvc)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      authenticateHuman(db.pool, idp.verifier(), `Bearer ${await idp.mint(subjects.operator!, { audience: 'other' })}`),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      authenticateHuman(db.pool, idp.verifier(), `Bearer ${await idp.mint('nobody-registered')}`),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      authenticateHuman(db.pool, idp.verifier(), `Bearer ${await idp.mint(subjects.operator!, { expiresIn: '-1m' })}`),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(authenticateHuman(db.pool, idp.verifier(), 'Basic abc')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    // Short HMAC keys are refused outright.
    await expect(signPrincipalToken('SERVICE', subjects.service!, new Uint8Array(8))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
