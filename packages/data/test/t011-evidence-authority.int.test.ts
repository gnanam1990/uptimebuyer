// T-011 (INV-02, INV-10, FR-18 shared layer) — evidence-ledger authority per principal kind. A human operator may
// append only operator-attested material input; a device only authenticated telemetry-derived material input about
// itself; server-produced kinds (approval, policy decision, payment, receipt, recovery decision, ...) are reachable
// only through the server-side `appendSystemEvidence` path for worker/service principals. Corrections must target
// a same-tenant, caller-correctable, not-yet-superseded entry. Machine tokens cannot be replayed.
import { newId, type EvidenceRecordKind, type EvidenceTrust } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  appendLedgerEvidence,
  appendSystemEvidence,
  assignRole,
  authenticateDevice,
  authenticateService,
  createSite,
  exportEvidenceLedger,
  registerDevice,
  registerServiceIdentity,
  resolveTenantContext,
  signPrincipalToken,
  upsertUser,
  withTenantTransaction,
  type LedgerEvidenceInput,
  type TenantContext,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  humanContext,
  resolver,
  seedTenant,
  sha,
  syntheticKey,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let idp: TestIdentityProvider;
let t: SeededTenant;
let other: SeededTenant;
let operator: TenantContext;
let device: TenantContext;
let service: TenantContext;
let deviceId: string;
let otherDeviceId: string;
const creds = resolver();
let deviceKey: Uint8Array;

const KINDS: EvidenceRecordKind[] = [
  'MATERIAL_INPUT',
  'MODEL_PROPOSAL',
  'POLICY_DECISION',
  'APPROVAL',
  'EXTERNAL_ACTION',
  'PAYMENT_STATE',
  'RECEIPT',
  'RECOVERY_DECISION',
];
const TRUSTS: EvidenceTrust[] = [
  'AUTHORITATIVE',
  'OPERATOR_ATTESTED',
  'PROVIDER_REPORTED',
  'MODEL_PROPOSED',
  'CONTRACT_FAKE',
];

const entry = (over: Partial<LedgerEvidenceInput> = {}): LedgerEvidenceInput => ({
  kind: 'MATERIAL_INPUT',
  trust: 'OPERATOR_ATTESTED',
  subject: { aggregateType: 'device', aggregateId: deviceId },
  incidentId: null,
  payloadSchema: 'evidence.note.v1',
  payloadDigest: sha(`payload-${Math.random()}`),
  payloadRef: null,
  supersedesEvidenceId: null,
  ...over,
});

describe('T-011 evidence-ledger authority per principal kind', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t011ev');
    idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    t = await seedTenant(db.pool, idp, 'iota');
    other = await seedTenant(db.pool, idp, 'kappa');
    const site = (await createSite(db.pool, t.admin, { name: 'S', timezone: 'UTC', source: 'API' })).siteId;
    const subject = `operator-${Date.now()}`;
    const user = await upsertUser(db.pool, { issuer: idp.issuer, externalSubject: subject, displayName: 'op' });
    await addMembership(db.pool, t.admin, user.userId);
    await assignRole(db.pool, t.admin, {
      principal: { kind: 'HUMAN', userId: user.userId },
      role: 'operator',
      siteId: null,
    });
    operator = await humanContext(db.pool, idp, subject, t.tenantId);

    deviceKey = syntheticKey();
    const ref = `secretref:device/tenants/${t.tenantId}/iota-1`;
    creds.set(ref, deviceKey);
    deviceId = (await registerDevice(db.pool, t.admin, { siteId: site, credentialRef: ref, source: 'API' })).deviceId;
    otherDeviceId = (
      await registerDevice(db.pool, t.admin, {
        siteId: site,
        credentialRef: `secretref:device/tenants/${t.tenantId}/iota-2`,
        source: 'API',
      })
    ).deviceId;
    device = await resolveTenantContext(
      db.pool,
      await authenticateDevice(db.pool, creds, await signPrincipalToken('DEVICE', deviceId, deviceKey)),
      undefined,
    );

    const svcKey = syntheticKey();
    const svcRef = `secretref:service/tenants/${t.tenantId}/worker`;
    creds.set(svcRef, svcKey);
    const svc = await registerServiceIdentity(db.pool, t.admin, { workload: 'general-worker', credentialRef: svcRef });
    await assignRole(db.pool, t.admin, {
      principal: { kind: 'SERVICE', serviceIdentityId: svc.serviceIdentityId },
      role: 'worker',
      siteId: null,
    });
    service = await resolveTenantContext(
      db.pool,
      await authenticateService(db.pool, creds, await signPrincipalToken('SERVICE', svc.serviceIdentityId, svcKey)),
      undefined,
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('a human operator may append only operator-attested material input', async () => {
    const ok = await appendLedgerEvidence(db.pool, operator, entry());
    expect(ok.kind).toBe('MATERIAL_INPUT');
    expect(ok.trust).toBe('OPERATOR_ATTESTED');
    for (const kind of KINDS.filter((k) => k !== 'MATERIAL_INPUT'))
      await expect(appendLedgerEvidence(db.pool, operator, entry({ kind })), kind).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    for (const trust of TRUSTS.filter((x) => x !== 'OPERATOR_ATTESTED'))
      await expect(appendLedgerEvidence(db.pool, operator, entry({ trust })), trust).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(appendLedgerEvidence(db.pool, t.admin, entry())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a device may append only authenticated telemetry-derived material input about itself', async () => {
    const own = entry({ trust: 'AUTHORITATIVE', payloadSchema: 'telemetry.window.v1' });
    expect((await appendLedgerEvidence(db.pool, device, own)).trust).toBe('AUTHORITATIVE');
    const denied: [string, LedgerEvidenceInput][] = [
      ['other device', { ...own, subject: { aggregateType: 'device', aggregateId: otherDeviceId } }],
      ['other aggregate', { ...own, subject: { aggregateType: 'asset', aggregateId: newId('asset') } }],
      ['non-telemetry payload', { ...own, payloadSchema: 'evidence.note.v1' }],
      ['operator trust', { ...own, trust: 'OPERATOR_ATTESTED' }],
      ['approval kind', { ...own, kind: 'APPROVAL' }],
      ['payment kind', { ...own, kind: 'PAYMENT_STATE' }],
    ];
    for (const [name, input] of denied)
      await expect(appendLedgerEvidence(db.pool, device, input), name).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('server-produced kinds are reachable only through appendSystemEvidence for worker/service principals', async () => {
    const sys = entry({
      kind: 'APPROVAL',
      trust: 'AUTHORITATIVE',
      subject: { aggregateType: 'approval', aggregateId: newId('approval') },
    });
    const e = await withTenantTransaction(db.pool, service, (c) => appendSystemEvidence(c, service, sys));
    expect(e.kind).toBe('APPROVAL');
    for (const ctx of [operator, device, t.admin])
      await expect(withTenantTransaction(db.pool, ctx, (c) => appendSystemEvidence(c, ctx, sys))).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
        },
      );
    // Server paths cannot claim human attestation.
    await expect(
      withTenantTransaction(db.pool, service, (c) =>
        appendSystemEvidence(c, service, { ...sys, trust: 'OPERATOR_ATTESTED' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The generic submit path refuses services as well.
    await expect(appendLedgerEvidence(db.pool, service, sys)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await exportEvidenceLedger(db.pool, t.admin)).chain).toEqual({ ok: true });
  });

  it('a correction must target a same-tenant, caller-correctable, not-yet-superseded entry', async () => {
    const mine = await appendLedgerEvidence(db.pool, operator, entry());
    const fixed = await appendLedgerEvidence(db.pool, operator, entry({ supersedesEvidenceId: mine.evidenceId }));
    expect(fixed.supersedesEvidenceId).toBe(mine.evidenceId);
    // Forking: the original already has a correction.
    await expect(
      appendLedgerEvidence(db.pool, operator, entry({ supersedesEvidenceId: mine.evidenceId })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // A human cannot "correct" authoritative device telemetry or a server-produced record.
    const telemetry = await appendLedgerEvidence(
      db.pool,
      device,
      entry({ trust: 'AUTHORITATIVE', payloadSchema: 'telemetry.window.v1' }),
    );
    await expect(
      appendLedgerEvidence(db.pool, operator, entry({ supersedesEvidenceId: telemetry.evidenceId })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sys = await withTenantTransaction(db.pool, service, (c) =>
      appendSystemEvidence(c, service, entry({ kind: 'POLICY_DECISION', trust: 'AUTHORITATIVE' })),
    );
    await expect(
      appendLedgerEvidence(db.pool, operator, entry({ supersedesEvidenceId: sys.evidenceId })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Devices never issue corrections.
    await expect(
      appendLedgerEvidence(
        db.pool,
        device,
        entry({
          trust: 'AUTHORITATIVE',
          payloadSchema: 'telemetry.window.v1',
          supersedesEvidenceId: telemetry.evidenceId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Another tenant's entry is indistinguishable from a missing one.
    await assignRole(db.pool, other.admin, {
      principal: { kind: 'HUMAN', userId: other.adminUserId },
      role: 'operator',
      siteId: null,
    });
    const foreignErr = await appendLedgerEvidence(
      db.pool,
      operator,
      entry({ supersedesEvidenceId: newId('evidence') }),
    ).catch((e) => e);
    const { rows } = await db.admin(`SELECT id FROM evidence_ledger_entries WHERE tenant_id = $1 LIMIT 1`, [
      t.tenantId,
    ]);
    const otherOperator = await humanContext(db.pool, idp, other.adminSubject, other.tenantId);
    const crossErr = await appendLedgerEvidence(
      db.pool,
      otherOperator,
      entry({ supersedesEvidenceId: rows[0].id }),
    ).catch((e) => e);
    expect(foreignErr.code).toBe('FORBIDDEN');
    expect(crossErr.code).toBe('FORBIDDEN');
    expect(crossErr.message).toBe(foreignErr.message);
    expect(crossErr.details).toEqual(foreignErr.details);
  });

  it('a machine-principal token cannot be replayed', async () => {
    const token = await signPrincipalToken('DEVICE', deviceId, deviceKey);
    await authenticateDevice(db.pool, creds, token);
    await expect(authenticateDevice(db.pool, creds, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
