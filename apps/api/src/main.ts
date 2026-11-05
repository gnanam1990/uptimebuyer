// apps/api entry point: configuration from the environment, a bounded PostgreSQL pool, OIDC bearer verification
// against the issuer's JWKS, the local object store for citations, and (optionally) the built web app. Authority
// issuance and webhook verifier secrets are not configured from the environment; without them issuance answers
// DEPENDENCY_FAILED and every fulfillment webhook is refused (M14 provisions the secret channel).
import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { HumanOidcVerifier, InMemoryCredentialResolver } from '@uptimebuyer/data';
import { LocalFilesystemObjectStore } from '@uptimebuyer/evidence';
import { buildApiServer } from './app.js';
import { loadApiConfig } from './config.js';

const cfg = loadApiConfig(process.env);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 16 });
pool.on('error', () => {});
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
});
const address = await app.listen({ host: cfg.UB_API_HOST, port: cfg.UB_API_PORT });
console.log(JSON.stringify({ event: 'api.listening', address }));
const stop = async () => {
  await app.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
