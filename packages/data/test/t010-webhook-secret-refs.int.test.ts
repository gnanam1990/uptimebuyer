// T-010 (INV-06, INV-16) — namespace poisoning and confused-deputy secret references.
// An INVALID-signature webhook delivery must never occupy the replay key, so a later VALID delivery of the same
// provider event is still accepted. Credential and verifier references are bound to the owning tenant
// (`secretref:<ns>/tenants/<tenantId>/...`), so tenant A cannot point any principal or provider account at
// tenant B's secret — enforced in code and by the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendProviderAccountRevision,
  createProviderAccount,
  createSite,
  findWebhookDelivery,
  recordWebhookDelivery,
  registerDevice,
  registerIntegrationIdentity,
  registerServiceIdentity,
  resolveWebhookBinding,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  seedTenant,
  sha,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let a: SeededTenant;
let b: SeededTenant;
let siteA: string;

const revision = (credentialRef: string, webhookVerifierRef: string | null) => ({
  capabilities: ['WEBHOOK' as const],
  paid: false,
  ownerService: 'M07_UNPAID' as const,
  credentialRef,
  endpointPolicyDigest: sha('endpoint'),
  webhookVerifierRef,
});

describe('T-010 webhook replay-key poisoning and tenant-bound secret references', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t010ref');
    const idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    a = await seedTenant(db.pool, idp, 'mu');
    b = await seedTenant(db.pool, idp, 'nu');
    siteA = (await createSite(db.pool, a.admin, { name: 'S', timezone: 'UTC', source: 'API' })).siteId;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('an invalid-signature delivery cannot poison the replay key of a later valid delivery', async () => {
    const own = (p: string) => `secretref:${p}/tenants/${a.tenantId}/cmms`;
    const acct = await createProviderAccount(db.pool, a.admin, {
      providerKey: 'cmms',
      environment: 'SANDBOX',
      revision: revision(own('provider'), own('webhook')),
      source: 'API',
    });
    const binding = await resolveWebhookBinding(db.pool, acct.webhookBinding);
    const forged = await recordWebhookDelivery(db.pool, binding, {
      providerEventId: 'evt-42',
      signatureValid: false,
      bodyDigest: sha('forged'),
    });
    expect(forged.duplicate).toBe(false);
    const genuine = await recordWebhookDelivery(db.pool, binding, {
      providerEventId: 'evt-42',
      signatureValid: true,
      bodyDigest: sha('genuine'),
    });
    expect(genuine.duplicate).toBe(false);
    expect(genuine.deliveryId).not.toBe(forged.deliveryId);
    const replay = await recordWebhookDelivery(db.pool, binding, {
      providerEventId: 'evt-42',
      signatureValid: true,
      bodyDigest: sha('genuine'),
    });
    expect(replay).toEqual({ deliveryId: genuine.deliveryId, duplicate: true });
    const forgedAgain = await recordWebhookDelivery(db.pool, binding, {
      providerEventId: 'evt-42',
      signatureValid: false,
      bodyDigest: sha('forged-2'),
    });
    expect(forgedAgain.duplicate).toBe(false);
    expect(forgedAgain.deliveryId).not.toBe(genuine.deliveryId);
    const found = await findWebhookDelivery(db.pool, a.admin, acct.providerAccountId, 'evt-42');
    expect(found).toMatchObject({ deliveryId: genuine.deliveryId, signatureResult: 'VALID' });
    const { rows } = await db.admin(
      `SELECT signature_result, count(*)::int AS n FROM webhook_deliveries WHERE provider_event_id = 'evt-42'
        GROUP BY signature_result ORDER BY signature_result`,
    );
    expect(rows).toEqual([
      { signature_result: 'INVALID', n: 2 },
      { signature_result: 'VALID', n: 1 },
    ]);
    // Even raw SQL cannot record two VALID deliveries for one provider event.
    await expect(
      db.admin(
        `INSERT INTO webhook_deliveries (tenant_id, id, provider_account_id, provider_account_revision_id, provider_event_id, signature_result, body_digest)
         VALUES ($1, 'whd_dup-valid-0001', $2, $3, 'evt-42', 'VALID', $4)`,
        [a.tenantId, acct.providerAccountId, acct.providerAccountRevisionId, sha('dup')],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('credential and verifier references must name the caller tenant, in code and in the database', async () => {
    const foreign = (ns: string) => `secretref:${ns}/tenants/${b.tenantId}/stolen`;
    const mine = (ns: string) => `secretref:${ns}/tenants/${a.tenantId}/mine`;
    const rejected = [
      [
        'foreign device ref',
        () =>
          registerDevice(db.pool, a.admin, { siteId: siteA as never, credentialRef: foreign('device'), source: 'API' }),
      ],
      [
        'untenanted device ref',
        () =>
          registerDevice(db.pool, a.admin, {
            siteId: siteA as never,
            credentialRef: 'secretref:device/legacy-1',
            source: 'API',
          }),
      ],
      [
        'traversal device ref',
        () =>
          registerDevice(db.pool, a.admin, {
            siteId: siteA as never,
            credentialRef: `secretref:device/tenants/${a.tenantId}/../${b.tenantId}/x`,
            source: 'API',
          }),
      ],
      [
        'foreign service ref',
        () =>
          registerServiceIdentity(db.pool, a.admin, { workload: 'general-worker', credentialRef: foreign('service') }),
      ],
      [
        'foreign integration ref',
        () =>
          registerIntegrationIdentity(db.pool, a.admin, {
            providerAccountId: null,
            credentialRef: foreign('integration'),
          }),
      ],
      [
        'foreign provider credential',
        () =>
          createProviderAccount(db.pool, a.admin, {
            providerKey: 'p1',
            environment: 'SANDBOX',
            revision: revision(foreign('provider'), null),
            source: 'API',
          }),
      ],
      [
        'foreign webhook verifier',
        () =>
          createProviderAccount(db.pool, a.admin, {
            providerKey: 'p2',
            environment: 'SANDBOX',
            revision: revision(mine('provider'), foreign('webhook')),
            source: 'API',
          }),
      ],
    ] as const;
    for (const [name, call] of rejected)
      await expect(call(), name).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const acct = await createProviderAccount(db.pool, a.admin, {
      providerKey: 'p3',
      environment: 'SANDBOX',
      revision: revision(mine('provider'), mine('webhook')),
      source: 'API',
    });
    await expect(
      appendProviderAccountRevision(db.pool, a.admin, acct.providerAccountId, {
        revision: revision(mine('provider'), foreign('webhook')),
        source: 'API',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      (await registerDevice(db.pool, a.admin, { siteId: siteA as never, credentialRef: mine('device'), source: 'API' }))
        .deviceId,
    ).toMatch(/^dev_/);

    // Database-level enforcement independent of the repository layer.
    await expect(
      db.admin(
        `INSERT INTO devices (tenant_id, id, site_id, credential_ref) VALUES ($1, 'dev_raw-probe-0001', $2, $3)`,
        [a.tenantId, siteA, foreign('device')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.admin(
        `INSERT INTO service_identities (tenant_id, id, workload, credential_ref) VALUES ($1, 'svc_raw-probe-0001', 'api', $2)`,
        [a.tenantId, foreign('service')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.admin(
        `INSERT INTO integration_identities (tenant_id, id, credential_ref) VALUES ($1, 'itg_raw-probe-0001', $2)`,
        [a.tenantId, foreign('integration')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.admin(
        `INSERT INTO provider_account_revisions (tenant_id, id, provider_account_id, revision, capabilities, paid, owner_service,
           credential_ref, endpoint_policy_digest, webhook_verifier_ref, effective_at, actor_kind, actor_id, source)
         VALUES ($1, 'par_raw-probe-0001', $2, 99, ARRAY['WEBHOOK'], false, 'M07_UNPAID', $3, $4, $5, now(), 'HUMAN', 'x', 'API')`,
        [a.tenantId, acct.providerAccountId, mine('provider'), sha('x'), foreign('webhook')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
