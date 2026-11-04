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
    private readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
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

/**
 * A minimal real incident (with a fixture rule and procedure) for the M02-era tests: since M04 the incident_id columns
 * of evidence revisions, ledger entries, approvals, legal holds and privacy requests carry composite tenant foreign
 * keys to `incidents`. Inserted directly because these tests exercise M02 surfaces, not the incident engine
 * (packages/incidents covers that). Idempotent per (tenant, label); returns `inc_fixture-<label>`.
 */
export async function fixtureIncident(
  pool: pg.Pool,
  input: { tenantId: string; assetId: string; userId: string; label: string },
): Promise<string> {
  const id = incidentId(input.label);
  const tag = sha(input.tenantId).slice(7, 23);
  await pool.query(
    `INSERT INTO operating_procedure_revisions (tenant_id, id, procedure_key, revision, deadline_kind, deadline_basis,
       response_deadline_ms, pause_allowed, max_extension_ms, adjust_role, initial_assignee_user_id, timezone_basis,
       body_digest, effective_at, published_by_user_id)
     VALUES ($1, $2, 'fixture', 1, 'RESPONSE', 'OPENED_AT', 1800000, true, 0, 'operator', $3, 'UTC', $4,
       clock_timestamp(), $3)
     ON CONFLICT DO NOTHING`,
    [input.tenantId, `opr_fixture-${tag}`, input.userId, `incident-procedure.v1:${sha('fixture-procedure')}`],
  );
  await pool.query(
    `INSERT INTO incident_rule_revisions (tenant_id, id, rule_key, revision, status, channel_kind, comparator,
       threshold_int, hysteresis_int, duration_ms, min_samples, quorum_channels, max_gap_ms, max_evaluation_lag_ms,
       stale_behavior, fault_window_key, fault_family, urgency, watch_window_ms, recovery_window_ms, procedure_key,
       body_digest, effective_at, published_by_user_id)
     VALUES ($1, $2, 'fixture', 1, 'ACTIVE', 'TEMPERATURE', 'ABOVE', 8000, 0, 60000, 1, 1, 60000, 60000, 'HOLD',
       'fixture', 'FIXTURE', 'NORMAL', 0, 600000, 'fixture', $4, clock_timestamp(), $3)
     ON CONFLICT DO NOTHING`,
    [input.tenantId, `irl_fixture-${tag}`, input.userId, `incident-rule.v1:${sha('fixture-rule')}`],
  );
  await pool.query(
    `INSERT INTO incidents (tenant_id, id, site_id, asset_id, asset_revision_id, rule_revision_id, procedure_revision_id,
       trigger_kind, trigger_input_origin, state, fault_family, fault_window_key, urgency, trigger_event_at,
       trigger_received_at, opened_at, open_latency_ms, deadline_kind, deadline_basis, deadline_basis_at,
       deadline_computed_at, deadline_basis_digest, deadline_timezone_basis, original_response_deadline_at,
       current_response_deadline_at, deadline_status, correlation_id, version)
     SELECT a.tenant_id, $3, a.site_id, a.id, a.current_revision_id, $4, $5, 'MANUAL_REPORT', 'OPERATOR_REPORT',
       'TRIAGING', 'FIXTURE', $6, 'NORMAL', now(), now(), now(), 0, 'RESPONSE', 'OPENED_AT', now(), now(), $7, 'UTC',
       now() + interval '30 minutes', now() + interval '30 minutes', 'RUNNING', 'corr_fixture-incident', 1
       FROM assets a WHERE a.tenant_id = $1 AND a.id = $2
     ON CONFLICT DO NOTHING`,
    [
      input.tenantId,
      input.assetId,
      id,
      `irl_fixture-${tag}`,
      `opr_fixture-${tag}`,
      `fx-${input.label}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 64),
      `incident-deadline-basis.v1:${sha(`fixture-${input.label}`)}`,
    ],
  );
  const { rowCount } = await pool.query(`SELECT 1 FROM incidents WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    id,
  ]);
  if (rowCount !== 1) throw new Error(`fixture incident ${id} was not created (asset not in tenant?)`);
  return id;
}
