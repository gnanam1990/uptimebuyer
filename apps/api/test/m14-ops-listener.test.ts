// M14 bring-up finding (T-057): apps/api/src/main.ts with the operations listener enabled registered the platform
// metrics a second time in the registry buildApiServer had already populated, so the API crashed right after
// listening ("Metric already registered") whenever UB_OPS_TOKEN_FILE and UB_OPS_PORT were set. The local
// production-like compose stack enables the listener; this test starts main.ts exactly that way.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetricsRegistry, platformMetrics } from '@uptimebuyer/observability';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'ub-m14-ops-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('T-057 API operations listener starts from main.ts', () => {
  it('platform metrics can be obtained twice from one registry', () => {
    const r = new MetricsRegistry();
    const a = platformMetrics(r);
    expect(() => platformMetrics(r)).not.toThrow();
    expect(platformMetrics(r)).toBe(a);
  });

  it('main.ts with UB_OPS_TOKEN_FILE and UB_OPS_PORT listens on both ports and stays up', async () => {
    const repo = path.resolve(import.meta.dirname, '..', '..', '..');
    const register = path.join(repo, 'apps', 'kite-broker', 'test', 'support', 'ts-register.mjs');
    const signer = path.join(dir, 'signer.pem');
    writeFileSync(signer, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
    chmodSync(signer, 0o600);
    const token = path.join(dir, 'ops-token');
    writeFileSync(token, randomBytes(32).toString('base64url'));
    chmodSync(token, 0o600);
    mkdirSync(path.join(dir, 'verifiers'), { mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--no-warnings',
        '--import',
        register,
        path.join(repo, 'apps', 'api', 'src', 'main.ts'),
      ],
      {
        cwd: path.join(repo, 'apps', 'api'),
        env: {
          PATH: process.env.PATH ?? '',
          DATABASE_URL: 'postgres://ub@127.0.0.1:1/nowhere',
          UB_API_PORT: '0',
          UB_OIDC_ISSUER: 'http://127.0.0.1:1',
          UB_OIDC_AUDIENCE: 'uptimebuyer',
          UB_OIDC_JWKS_URL: 'http://127.0.0.1:1/jwks',
          UB_OIDC_AUTHORIZATION_ENDPOINT: 'http://127.0.0.1:1/authorize',
          UB_OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:1/token',
          UB_OIDC_CLIENT_ID: 'uptimebuyer-web',
          UB_OBJECT_STORE_ROOT: dir,
          UB_AUTHORITY_SIGNER_KEY_ID: 'authority-k1',
          UB_AUTHORITY_SIGNER_KEY_FILE: signer,
          UB_WEBHOOK_VERIFIER_ROOT: path.join(dir, 'verifiers'),
          UB_OPS_TOKEN_FILE: token,
          UB_OPS_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    const deadline = Date.now() + 30_000;
    while (!out.includes('ops.listening') && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    const alive = child.exitCode === null;
    child.kill('SIGTERM');
    await exited;
    expect(out).toContain('api.listening');
    expect(out).toContain('ops.listening');
    expect(out).not.toContain('Metric already registered');
    expect(alive).toBe(true);
  });
});
