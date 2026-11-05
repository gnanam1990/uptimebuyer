// M12 security review findings (no database). Each case was added red before its fix.
// S1 — identity-provider endpoints over plain HTTP: the JWKS URL decides which keys authenticate every human, and the
// token endpoint receives authorization codes. A non-loopback http:// endpoint would let a network attacker substitute
// signing keys (authentication bypass) or capture codes, so configuration refuses it; loopback (local development and
// the test harness) stays allowed.
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

describe('M12 security review S1: identity-provider endpoints must be https (loopback excepted)', () => {
  it('accepts https endpoints', () => {
    expect(() => loadApiConfig(base)).not.toThrow();
  });

  it('refuses plain-http JWKS, authorization and token endpoints on a network host', () => {
    for (const key of ['UB_OIDC_JWKS_URL', 'UB_OIDC_AUTHORIZATION_ENDPOINT', 'UB_OIDC_TOKEN_ENDPOINT'] as const)
      for (const url of ['http://idp.example.com/x', 'http://10.0.0.5:8080/x', 'http://localhost.evil.example/x'])
        expect(() => loadApiConfig({ ...base, [key]: url }), `${key}=${url}`).toThrow(new RegExp(key));
  });

  it('allows plain http only on loopback hosts (development and the test harness)', () => {
    for (const host of ['127.0.0.1:45000', 'localhost:45000', '[::1]:45000'])
      expect(() =>
        loadApiConfig({
          ...base,
          UB_OIDC_JWKS_URL: `http://${host}/jwks`,
          UB_OIDC_AUTHORIZATION_ENDPOINT: `http://${host}/authorize`,
          UB_OIDC_TOKEN_ENDPOINT: `http://${host}/token`,
        }),
      ).not.toThrow();
  });

  it('never echoes configuration values (a database password) in the error', () => {
    try {
      loadApiConfig({
        ...base,
        DATABASE_URL: 'postgres://u:hunter2-very-secret@db/ub',
        UB_OIDC_JWKS_URL: 'http://idp.example.com/x',
      });
      throw new Error('expected failure');
    } catch (e) {
      expect(String(e)).not.toContain('hunter2');
      expect(String(e)).not.toContain('idp.example.com');
    }
  });
});
