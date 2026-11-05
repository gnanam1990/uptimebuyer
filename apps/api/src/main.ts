// apps/api entry point: configuration from the environment, a bounded PostgreSQL pool, OIDC bearer verification
// against the issuer's JWKS, the local object store for citations, and (optionally) the built web app. Authority
// issuance and webhook verifier secrets are not configured from the environment; without them issuance answers
// DEPENDENCY_FAILED and every fulfillment webhook is refused (M14 provisions the secret channel).
import { readFileSync, statSync } from 'node:fs';
import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { HumanOidcVerifier, InMemoryCredentialResolver } from '@uptimebuyer/data';
import { LocalFilesystemObjectStore } from '@uptimebuyer/evidence';
import {
  HealthRegistry,
  MetricsRegistry,
  SecretRegistry,
  SloTracker,
  StructuredLogger,
  Tracer,
  platformMetrics,
} from '@uptimebuyer/observability';
import { collectPlatformSignals, readinessChecks } from '@uptimebuyer/operations';
import { buildApiServer } from './app.js';
import { loadApiConfig } from './config.js';
import { buildOperationsServer } from './ops.js';

const cfg = loadApiConfig(process.env);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 16 });
pool.on('error', () => {});
// M13 observability: structured JSON logs to stdout (the database URL is registered as a secret so it can never be
// echoed), bounded-label metrics, request spans and SLO-aware readiness.
const secrets = new SecretRegistry();
secrets.register(cfg.DATABASE_URL);
const logger = new StructuredLogger({ service: 'api', secrets });
const metrics = new MetricsRegistry();
const slo = new SloTracker();
const health = new HealthRegistry();
readinessChecks(health, pool);
health.register('slo', slo.healthCheck(), { critical: false });
const algorithms = cfg.UB_OIDC_ALGORITHMS.split(',').map((a) => a.trim()) as (
  'ES256' | 'ES384' | 'RS256' | 'PS256' | 'EdDSA'
)[];
const app = await buildApiServer({
  pool,
  verifier: new HumanOidcVerifier({
    issuer: cfg.UB_OIDC_ISSUER,
    audience: cfg.UB_OIDC_AUDIENCE,
    keys: createRemoteJWKSet(new URL(cfg.UB_OIDC_JWKS_URL)),
    algorithms,
  }),
  publicConfig: {
    oidc: {
      issuer: cfg.UB_OIDC_ISSUER,
      authorizationEndpoint: cfg.UB_OIDC_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: cfg.UB_OIDC_TOKEN_ENDPOINT,
      clientId: cfg.UB_OIDC_CLIENT_ID,
      audience: cfg.UB_OIDC_AUDIENCE,
      scope: cfg.UB_OIDC_SCOPE,
    },
    environmentLabel: cfg.UB_ENVIRONMENT_LABEL ?? null,
  },
  store: new LocalFilesystemObjectStore(cfg.UB_OBJECT_STORE_ROOT),
  credentials: new InMemoryCredentialResolver(),
  ...(cfg.UB_WEB_ROOT ? { webRoot: cfg.UB_WEB_ROOT } : {}),
  trustProxy: cfg.UB_TRUST_PROXY === 'true',
  observability: { logger, metrics, tracer: new Tracer({ service: 'api', secrets }), slo, health },
});
const address = await app.listen({ host: cfg.UB_API_HOST, port: cfg.UB_API_PORT });
logger.info('api.listening', { address });
// Operations listener (metrics, alerts, readiness) on a separate loopback/private address. Its bearer token is read
// from a 0600 file delivered by the secret channel, never from an environment value.
let ops: Awaited<ReturnType<typeof buildOperationsServer>> | null = null;
if (process.env.UB_OPS_TOKEN_FILE && process.env.UB_OPS_PORT) {
  const file = process.env.UB_OPS_TOKEN_FILE;
  if ((statSync(file).mode & 0o077) !== 0) throw new Error('operations token file must be 0600');
  const token = readFileSync(file, 'utf8').trim();
  secrets.register(token);
  const pm = platformMetrics(metrics);
  ops = await buildOperationsServer({
    metrics,
    health,
    token,
    beforeScrape: async () => {
      await collectPlatformSignals(pool, pm);
      slo.exportTo(pm);
    },
  });
  await ops.listen({ host: process.env.UB_OPS_HOST ?? '127.0.0.1', port: Number(process.env.UB_OPS_PORT) });
  logger.info('ops.listening', { port: Number(process.env.UB_OPS_PORT) });
}
const stop = async () => {
  await ops?.close();
  await app.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
