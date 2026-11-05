// T-057 (M14) API secret wiring. apps/api/src/main.ts reads the authority signer, the execution-reference signer
// (when a broker socket is configured) and the webhook verifier store from the environment through secret REFERENCES:
// file paths and a root directory, never values. A missing or unusable reference stops startup with a clear error that
// names the variable and never prints a value; the process exits with EX_CONFIG (78) before opening the database.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiSecretConfigError, REQUIRED_SECRET_REFERENCES, loadApiSecrets } from '../src/secrets.js';

const dir = mkdtempSync(path.join(tmpdir(), 'ub-m14-api-secrets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body: string | Buffer, mode = 0o600) => {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};
const pem = (type: 'ed25519' | 'x25519') =>
  generateKeyPairSync(type as 'ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();

const verifierRoot = path.join(dir, 'verifiers');
mkdirSync(verifierRoot, { mode: 0o700 });
const valid = () => ({
  UB_AUTHORITY_SIGNER_KEY_ID: 'authority-k1',
  UB_AUTHORITY_SIGNER_KEY_FILE: file('signer.pem', pem('ed25519')),
  UB_WEBHOOK_VERIFIER_ROOT: verifierRoot,
});

describe('T-057 API secret references', () => {
  it('names every required reference', () => {
    expect([...REQUIRED_SECRET_REFERENCES].sort()).toEqual(
      ['UB_AUTHORITY_SIGNER_KEY_FILE', 'UB_AUTHORITY_SIGNER_KEY_ID', 'UB_WEBHOOK_VERIFIER_ROOT'].sort(),
    );
  });

  it('fails fast naming each missing reference', () => {
    try {
      loadApiSecrets({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiSecretConfigError);
      for (const k of REQUIRED_SECRET_REFERENCES) expect((e as Error).message).toContain(k);
    }
  });

  it('loads the Ed25519 authority signer and a file-backed webhook verifier store', async () => {
    const s = loadApiSecrets(valid());
    expect(s.authority.signer.keyId).toBe('authority-k1');
    expect(s.authority.signer.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(s.authority.sessions).toBeNull();
    const tenant = 'ten_01HZZZZZZZZZZZZZZZZZZZZZZZ';
    const k = randomBytes(32).toString('base64url');
    mkdirSync(path.join(verifierRoot, 'webhooks', 'tenants', tenant), { recursive: true, mode: 0o700 });
    file(path.join('verifiers', 'webhooks', 'tenants', tenant, 'acme'), k);
    const got = await s.credentials.resolveSigningKey(`secretref:webhooks/tenants/${tenant}/acme`);
    expect(got && Buffer.from(got).toString('base64url')).toBe(k);
  });

  it('refuses a group/other-readable signer file, a non-Ed25519 key and an invalid key id, without echoing values', () => {
    const open = { ...valid(), UB_AUTHORITY_SIGNER_KEY_FILE: file('open.pem', pem('ed25519'), 0o644) };
    expect(() => loadApiSecrets(open)).toThrow(/UB_AUTHORITY_SIGNER_KEY_FILE.*SECRET_FILE_MODE_TOO_OPEN/);
    const wrong = { ...valid(), UB_AUTHORITY_SIGNER_KEY_FILE: file('x.pem', pem('x25519')) };
    expect(() => loadApiSecrets(wrong)).toThrow(/UB_AUTHORITY_SIGNER_KEY_FILE.*NOT_ED25519/);
    expect(() => loadApiSecrets({ ...valid(), UB_AUTHORITY_SIGNER_KEY_ID: 'Bad Id' })).toThrow(
      /UB_AUTHORITY_SIGNER_KEY_ID/,
    );
    try {
      loadApiSecrets({ ...valid(), UB_AUTHORITY_SIGNER_KEY_FILE: file('garbage.pem', 'not-a-key-zzz-secretish') });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('not-a-key-zzz-secretish');
    }
  });

  it('refuses a secret VALUE placed in the environment instead of a reference', () => {
    expect(() =>
      loadApiSecrets({ ...valid(), UB_AUTHORITY_SIGNER_KEY_FILE: pem('ed25519') as unknown as string }),
    ).toThrow(ApiSecretConfigError);
  });

  it('with a broker socket, requires the execution-reference signer reference and builds the session activator', () => {
    const base = { ...valid(), UB_KITE_BROKER_SOCKET: path.join(dir, 'broker', 'broker.sock') };
    expect(() => loadApiSecrets(base)).toThrow(/UB_REFERENCE_SIGNER_KEY_FILE/);
    expect(() =>
      loadApiSecrets({
        ...base,
        UB_REFERENCE_SIGNER_KEY_ID: 'reference-k1',
        UB_REFERENCE_SIGNER_KEY_FILE: file('short.key', randomBytes(8).toString('base64url')),
      }),
    ).toThrow(/UB_REFERENCE_SIGNER_KEY_FILE.*TOO_SHORT/);
    const s = loadApiSecrets({
      ...base,
      UB_REFERENCE_SIGNER_KEY_ID: 'reference-k1',
      UB_REFERENCE_SIGNER_KEY_FILE: file('ref.key', randomBytes(32).toString('base64url')),
    });
    expect(s.authority.sessions).not.toBeNull();
  });

  it('main.ts exits with EX_CONFIG naming the missing reference, before touching the database', async () => {
    const repo = path.resolve(import.meta.dirname, '..', '..', '..');
    const register = path.join(repo, 'apps', 'kite-broker', 'test', 'support', 'ts-register.mjs');
    const env = {
      PATH: process.env.PATH ?? '',
      DATABASE_URL: 'postgres://ub:pw-must-not-leak@127.0.0.1:1/nowhere',
      UB_OIDC_ISSUER: 'http://127.0.0.1:1',
      UB_OIDC_AUDIENCE: 'uptimebuyer',
      UB_OIDC_JWKS_URL: 'http://127.0.0.1:1/jwks',
      UB_OIDC_AUTHORIZATION_ENDPOINT: 'http://127.0.0.1:1/authorize',
      UB_OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:1/token',
      UB_OIDC_CLIENT_ID: 'uptimebuyer-web',
      UB_OBJECT_STORE_ROOT: dir,
      UB_AUTHORITY_SIGNER_KEY_ID: 'authority-k1',
      UB_WEBHOOK_VERIFIER_ROOT: verifierRoot,
    };
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--no-warnings',
        '--import',
        register,
        path.join(repo, 'apps', 'api', 'src', 'main.ts'),
      ],
      { cwd: path.join(repo, 'apps', 'api'), env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise<number | null>((r) => child.once('exit', r));
    expect(code).toBe(78);
    expect(out).toContain('UB_AUTHORITY_SIGNER_KEY_FILE');
    expect(out).not.toContain('pw-must-not-leak');
    expect(out).not.toContain('api.listening');
  });
});
