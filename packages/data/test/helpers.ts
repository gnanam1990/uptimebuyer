// Shared fixtures for the M02 integration tests: a throwaway PostgreSQL database per test file (created from
// DATABASE_URL and dropped afterwards), the migration runner, a local OIDC identity provider for human sessions,
// an in-memory credential resolver, and a representative seeded tenant. Synthetic keys are generated at runtime.
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import pg from 'pg';
import {
  HumanOidcVerifier,
  InMemoryCredentialResolver,
  authenticateHuman,
  provisionTenant,
  resolveTenantContext,
  upsertUser,
  type TenantContext,
} from '../src/index.js';
import type { TenantId, UserId } from '@uptimebuyer/contracts';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
export const migrationsDir = path.join(repoRoot, 'packages', 'data', 'migrations');

type DbModule = {
  migrate(url: string, dir?: string): Promise<string[]>;
  seed(url: string, dir?: string): Promise<void>;
};
export const dbScripts = async (): Promise<DbModule> =>
  (await import(path.join(repoRoot, 'scripts', 'db.mjs'))) as DbModule;

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  admin(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

/** Create an isolated database. Fails (never skips) when DATABASE_URL is missing. */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must be set for integration tests (CI provides a Postgres service).');
  const name = `ub_${label}_${process.pid}_${Date.now()}`.toLowerCase();
  const root = new pg.Client({ connectionString: base });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  return {
    url,
    pool,
    admin: (sql, params) => pool.query(sql, params as unknown[]),
    async drop() {
      await pool.end().catch(() => {});
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** A local OIDC issuer: ES256 keys generated per run; the verifier sees only the public JWKS. */
export class TestIdentityProvider {
  readonly issuer = 'https://idp.test.invalid/';
  readonly audience = 'uptimebuyer-api';
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly jwks: { keys: JWK[] },
  ) {}

  static async create(): Promise<TestIdentityProvider> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
    return new TestIdentityProvider(privateKey, { keys: [jwk] });
  }

  verifier(): HumanOidcVerifier {
    return new HumanOidcVerifier({
      issuer: this.issuer,
      audience: this.audience,
      keys: createLocalJWKSet(this.jwks),
      algorithms: ['ES256'],
    });
  }

  async mint(subject: string, opts: { audience?: string; issuer?: string; expiresIn?: string } = {}): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
      .setIssuer(opts.issuer ?? this.issuer)
      .setAudience(opts.audience ?? this.audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '10m')
      .sign(this.privateKey);
  }
}

export const syntheticKey = (): Uint8Array => new Uint8Array(randomBytes(32));

export async function humanContext(
  pool: pg.Pool,
  idp: TestIdentityProvider,
  subject: string,
  tenantHeader?: string,
): Promise<TenantContext> {
  const principal = await authenticateHuman(pool, idp.verifier(), `Bearer ${await idp.mint(subject)}`);
  return resolveTenantContext(pool, principal, tenantHeader);
}

export interface SeededTenant {
  tenantId: TenantId;
  adminUserId: UserId;
  adminSubject: string;
  admin: TenantContext;
}

/** Platform provisioning of a tenant with its first tenant-wide administrator. */
export async function seedTenant(pool: pg.Pool, idp: TestIdentityProvider, name: string): Promise<SeededTenant> {
  const adminSubject = `admin-${name}-${randomBytes(4).toString('hex')}`;
  const user = await upsertUser(pool, {
    issuer: idp.issuer,
    externalSubject: adminSubject,
    displayName: `${name} admin`,
  });
  const { tenantId } = await provisionTenant(pool, { name, adminUserId: user.userId, source: 'PROVISIONING' });
  const admin = await humanContext(pool, idp, adminSubject, tenantId);
  return { tenantId, adminUserId: user.userId, adminSubject, admin };
}

export const resolver = () => new InMemoryCredentialResolver();

export const sha = (seed: string) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;
export const vdigest = (domain: string, seed: string) => `${domain}.v1:${sha(seed)}`;
export const incidentId = (n: string) => `inc_fixture-${n}`;
