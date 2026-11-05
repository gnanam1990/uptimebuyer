// T-053 SSRF corpus for identity-provider URLs (SECURITY.md §6 "DNS resolution and redirects are revalidated;
// link-local, loopback, private metadata, and unapproved IP ranges are denied"). The API fetches the JWKS from the
// configured URL and the browser posts authorization codes to the token endpoint, so a configured endpoint must never
// point at cloud metadata, link-local, unspecified or private literal addresses, carry userinfo or a fragment, or use
// an internal-only host name. Plain-http loopback stays allowed for development and the test harness (M12 S1).
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u@db.internal:5432/ub',
  UB_OIDC_ISSUER: 'https://idp.example.com/',
  UB_OIDC_AUDIENCE: 'uptimebuyer-api',
  UB_OIDC_JWKS_URL: 'https://idp.example.com/.well-known/jwks.json',
  UB_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/authorize',
  UB_OIDC_TOKEN_ENDPOINT: 'https://idp.example.com/token',
  UB_OIDC_CLIENT_ID: 'uptimebuyer-web',
  UB_OBJECT_STORE_ROOT: '/var/lib/uptimebuyer/objects',
};

const HOSTILE = [
  'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'https://169.254.170.2/v2/credentials',
  'https://[fd00:ec2::254]/latest/meta-data/',
  'https://[::ffff:169.254.169.254]/jwks',
  'https://[fe80::1]/jwks',
  'https://0.0.0.0/jwks',
  'https://[::]/jwks',
  'https://10.0.0.5/jwks',
  'https://192.168.1.10/jwks',
  'https://172.16.0.9/jwks',
  'https://100.64.0.1/jwks',
  'https://2852039166/jwks',
  'https://0xa9fea9fe/jwks',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://metadata/jwks',
  'https://idp.corp/jwks',
  'https://user:pass@idp.example.com/jwks',
  'https://idp.example.com/jwks#frag',
  'https://idp.example.com@169.254.169.254/jwks',
  'file:///etc/passwd',
  'gopher://idp.example.com/_x',
  'http://127.0.0.1.nip.io/jwks',
];

describe('T-053 identity-provider URL SSRF corpus', () => {
  it.each(HOSTILE)('refuses %s for every IdP endpoint', (url) => {
    for (const key of ['UB_OIDC_JWKS_URL', 'UB_OIDC_AUTHORIZATION_ENDPOINT', 'UB_OIDC_TOKEN_ENDPOINT'] as const)
      expect(() => loadApiConfig({ ...base, [key]: url }), `${key}=${url}`).toThrow(new RegExp(key));
  });

  it('still accepts public https endpoints and plain-http loopback', () => {
    expect(() => loadApiConfig(base)).not.toThrow();
    expect(() =>
      loadApiConfig({
        ...base,
        UB_OIDC_JWKS_URL: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
        UB_OIDC_TOKEN_ENDPOINT: 'https://idp.example.com:8443/oauth2/token',
      }),
    ).not.toThrow();
    for (const host of ['127.0.0.1:45000', 'localhost:45000', '[::1]:45000'])
      expect(() => loadApiConfig({ ...base, UB_OIDC_JWKS_URL: `http://${host}/jwks` })).not.toThrow();
  });
});
