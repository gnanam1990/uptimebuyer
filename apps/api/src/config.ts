// Runtime configuration from the environment, validated strictly. Only non-secret values live here: the OIDC issuer,
// audience and public endpoints, listener address, the web bundle root and the object store root. Signing keys and
// webhook verifier secrets are never read from the environment (they arrive through the deployment's secret channel).
import { z } from 'zod';

// Identity-provider endpoints must be https: the JWKS decides which keys authenticate humans and the token endpoint
// receives authorization codes. Plain http is allowed only on loopback (local development and the test harness).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const Url = z.url().refine((u) => {
  const url = new URL(u);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}, 'https URL required (http only on loopback)');
export const ApiConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  UB_API_HOST: z.string().default('127.0.0.1'),
  UB_API_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  UB_OIDC_ISSUER: z.string().min(1).max(500),
  UB_OIDC_AUDIENCE: z.string().min(1).max(200),
  UB_OIDC_JWKS_URL: Url,
  UB_OIDC_AUTHORIZATION_ENDPOINT: Url,
  UB_OIDC_TOKEN_ENDPOINT: Url,
  UB_OIDC_CLIENT_ID: z.string().min(1).max(200),
  UB_OIDC_SCOPE: z.string().min(1).max(200).default('openid'),
  UB_OIDC_ALGORITHMS: z.string().default('ES256'),
  UB_ENVIRONMENT_LABEL: z.string().max(80).optional(),
  UB_WEB_ROOT: z.string().optional(),
  UB_OBJECT_STORE_ROOT: z.string().min(1),
  UB_TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});
export type ApiConfig = z.output<typeof ApiConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const r = ApiConfigSchema.safeParse(env);
  if (!r.success) {
    // Name the missing/invalid keys only; never print values (they may include a database password).
    const keys = [...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new Error(`invalid API configuration: ${keys}`);
  }
  return r.data;
}
