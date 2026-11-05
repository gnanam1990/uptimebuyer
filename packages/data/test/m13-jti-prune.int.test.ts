// M13 (NFR-04, FR-24; M02/M03 residual) — the machine-token single-use table (principal_token_uses) is pruned safely:
// only rows whose token expired longer ago than the verifier's clock tolerance plus a safety margin are deleted, in
// bounded batches, so a pruned token id can never be replayed (its token is already refused by expiry) and replay
// protection for every still-acceptable token stays intact.
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryCredentialResolver,
  TOKEN_USE_PRUNE_GRACE_SECONDS,
  assignRole,
  authenticateService,
  pruneExpiredTokenUses,
  registerServiceIdentity,
  signPrincipalToken,
} from '../src/index.js';
import {
  TestIdentityProvider,
  createTestDatabase,
  dbScripts,
  seedTenant,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let t: SeededTenant;
let serviceId: string;
const key = new Uint8Array(randomBytes(32));
const creds = new InMemoryCredentialResolver();

beforeAll(async () => {
  db = await createTestDatabase('m13jti');
  await (await dbScripts()).migrate(db.url);
  const idp = await TestIdentityProvider.create();
  t = await seedTenant(db.pool, idp, 'jti');
  const ref = `secretref:service/tenants/${t.tenantId}/jti-worker`;
  creds.set(ref, key);
  const svc = await registerServiceIdentity(db.pool, t.admin, { workload: 'general-worker', credentialRef: ref });
  serviceId = svc.serviceIdentityId;
  await assignRole(db.pool, t.admin, {
    principal: { kind: 'SERVICE', serviceIdentityId: svc.serviceIdentityId },
    role: 'worker',
    siteId: null,
  });
});
afterAll(async () => {
  await db?.drop();
});

const lastReason = async () =>
  (
    await db.admin(
      `SELECT reason_code FROM security_audit_entries WHERE action = 'principal.authenticate' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    )
  ).rows[0]?.reason_code;
const uses = async () => (await db.admin(`SELECT id, expires_at FROM principal_token_uses ORDER BY id`)).rows;

/** A service token with explicit iat/exp (seconds), signed with the service key. */
const handToken = (iat: number, exp: number, jti = randomUUID()) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'ub-service+jwt', kid: serviceId })
    .setIssuer('urn:uptimebuyer:service')
    .setAudience('urn:uptimebuyer:service')
    .setSubject(serviceId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

describe('M13 jti replay table pruning', () => {
  it('keeps replay protection for a live token across a prune', async () => {
    const token = await signPrincipalToken('SERVICE', serviceId, key);
    await authenticateService(db.pool, creds, token);
    await expect(authenticateService(db.pool, creds, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await lastReason()).toBe('TOKEN_REPLAYED');
    const before = (await uses()).length;
    await pruneExpiredTokenUses(db.pool);
    expect((await uses()).length).toBe(before);
    await expect(authenticateService(db.pool, creds, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await lastReason()).toBe('TOKEN_REPLAYED');
  });

  it('deletes only rows expired longer ago than the grace window', async () => {
    expect(TOKEN_USE_PRUNE_GRACE_SECONDS).toBeGreaterThanOrEqual(305);
    const ins = (id: string, offsetSeconds: number) =>
      db.admin(
        `INSERT INTO principal_token_uses (tenant_id, id, principal_kind, principal_id, expires_at)
         VALUES ($1, $2, 'SERVICE', $3, clock_timestamp() + make_interval(secs => $4))`,
        [t.tenantId, id, serviceId, offsetSeconds],
      );
    await ins('old-expired-000000001', -2 * 3600);
    await ins('old-expired-000000002', -(TOKEN_USE_PRUNE_GRACE_SECONDS + 60));
    await ins('inside-grace-00000001', -(TOKEN_USE_PRUNE_GRACE_SECONDS - 60));
    await ins('recently-expired-0001', -3);
    await ins('future-valid-00000001', 300);
    const r = await pruneExpiredTokenUses(db.pool);
    expect(r.deleted).toBe(2);
    const ids = (await uses()).map((u) => u.id);
    expect(ids).toEqual(
      expect.arrayContaining(['inside-grace-00000001', 'recently-expired-0001', 'future-valid-00000001']),
    );
    expect(ids).not.toContain('old-expired-000000001');
    expect(ids).not.toContain('old-expired-000000002');
  });

  it('a pruned token id cannot be replayed: its token is refused by expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const token = await handToken(now - 3 * 3600, now - 2 * 3600, jti);
    await db.admin(
      `INSERT INTO principal_token_uses (tenant_id, id, principal_kind, principal_id, expires_at)
       VALUES ($1, $2, 'SERVICE', $3, to_timestamp($4))`,
      [t.tenantId, jti, serviceId, now - 2 * 3600],
    );
    await pruneExpiredTokenUses(db.pool);
    expect((await uses()).map((u) => u.id)).not.toContain(jti);
    await expect(authenticateService(db.pool, creds, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await lastReason()).toBe('TOKEN_REJECTED');
    // Not re-recorded either: an expired token never occupies (or reopens) the replay key.
    expect((await uses()).map((u) => u.id)).not.toContain(jti);
  });

  it('a token still inside the verifier clock tolerance keeps its replay row', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await handToken(now - 60, now + 2);
    await authenticateService(db.pool, creds, token);
    await pruneExpiredTokenUses(db.pool);
    await new Promise((r) => setTimeout(r, 3_000));
    // exp is now ~1 s in the past: within the 5 s tolerance the token itself would verify, so the row must survive.
    await pruneExpiredTokenUses(db.pool);
    await expect(authenticateService(db.pool, creds, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await lastReason()).toBe('TOKEN_REPLAYED');
  });

  it('refuses a grace window shorter than the verifier tolerance and prunes in bounded batches', async () => {
    await expect(pruneExpiredTokenUses(db.pool, { graceSeconds: 4 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    for (let i = 0; i < 7; i++)
      await db.admin(
        `INSERT INTO principal_token_uses (tenant_id, id, principal_kind, principal_id, expires_at)
         VALUES ($1, $2, 'SERVICE', $3, clock_timestamp() - interval '1 day')`,
        [t.tenantId, `batch-expired-${String(i).padStart(8, '0')}`, serviceId],
      );
    expect((await pruneExpiredTokenUses(db.pool, { batchSize: 3 })).deleted).toBe(3);
    expect((await pruneExpiredTokenUses(db.pool, { batchSize: 3 })).deleted).toBe(3);
    expect((await pruneExpiredTokenUses(db.pool, { batchSize: 3 })).deleted).toBe(1);
    expect((await pruneExpiredTokenUses(db.pool, { batchSize: 3 })).deleted).toBe(0);
  });
});
