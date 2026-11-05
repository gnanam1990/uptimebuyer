// M14 (T-057, INV-06, INV-16) file-backed secret channel. Deployments deliver secrets as files (container secret
// mounts, 0600/0400); the environment carries only the reference (a path or a root). readSecretFile refuses files that
// are not regular, readable by group/other or oversized, and never echoes contents in its errors. FileSecretStore maps a
// tenant-bound `secretref:` to exactly one file under its root and refuses traversal, foreign shapes and open modes.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileSecretStore, SecretFileError, readSecretFile } from '../src/index.js';

const root = mkdtempSync(path.join(tmpdir(), 'ub-m14-secrets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, body: string | Buffer, mode = 0o600) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
};
const tenant = 'ten_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const key = Buffer.alloc(32, 7).toString('base64url');

describe('M14 readSecretFile', () => {
  it('reads a 0600 or 0400 regular file', () => {
    expect(readSecretFile(put('a/ok', 'value-1')).toString()).toBe('value-1');
    expect(readSecretFile(put('a/ro', 'value-2', 0o400)).toString()).toBe('value-2');
  });

  it('refuses group/other-readable files, directories, missing files and oversize files without echoing content', () => {
    const open = put('a/open', 'do-not-print-me', 0o644);
    expect(() => readSecretFile(open)).toThrow(SecretFileError);
    try {
      readSecretFile(open);
    } catch (e) {
      expect((e as SecretFileError).reasonCode).toBe('SECRET_FILE_MODE_TOO_OPEN');
      expect(String((e as Error).message)).not.toContain('do-not-print-me');
    }
    expect(() => readSecretFile(path.join(root, 'a'))).toThrow(/NOT_REGULAR/);
    expect(() => readSecretFile(path.join(root, 'missing'))).toThrow(/MISSING/);
    expect(() => readSecretFile(put('a/big', Buffer.alloc(70_000)), { maxBytes: 65_536 })).toThrow(/TOO_LARGE/);
  });
});

describe('M14 FileSecretStore (CredentialResolver over files)', () => {
  const store = new FileSecretStore(root);

  it('resolves a tenant-bound reference to the key file under its root', async () => {
    put(`webhooks/tenants/${tenant}/acme/verifier`, `${key}\n`);
    const got = await store.resolveSigningKey(`secretref:webhooks/tenants/${tenant}/acme/verifier`);
    expect(got && Buffer.from(got).toString('base64url')).toBe(key);
  });

  it('refuses traversal, foreign shapes, open modes and symlinks out of the root', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ub-m14-outside-'));
    writeFileSync(path.join(outside, 'k'), key);
    chmodSync(path.join(outside, 'k'), 0o600);
    mkdirSync(path.join(root, `webhooks/tenants/${tenant}/link`), { recursive: true });
    symlinkSync(path.join(outside, 'k'), path.join(root, `webhooks/tenants/${tenant}/link/k`));
    put(`webhooks/tenants/${tenant}/open/k`, key, 0o644);
    for (const ref of [
      `secretref:webhooks/tenants/${tenant}/../../../etc/passwd`,
      `secretref:webhooks/tenants/${tenant}/./acme/verifier`,
      `secretref:webhooks/../webhooks/tenants/${tenant}/acme/verifier`,
      `/etc/passwd`,
      `secretref:webhooks/tenants/${tenant}/open/k`,
      `secretref:webhooks/tenants/${tenant}/link/k`,
      `secretref:webhooks/tenants/${tenant}/does-not-exist`,
      `secretref:Bad_NS/tenants/${tenant}/x`,
      `secretref:webhooks/x`,
    ])
      expect(await store.resolveSigningKey(ref), ref).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a root that is missing or writable by group/other', () => {
    expect(() => new FileSecretStore(path.join(root, 'nope'))).toThrow(SecretFileError);
    const loose = mkdtempSync(path.join(tmpdir(), 'ub-m14-loose-'));
    chmodSync(loose, 0o777);
    expect(() => new FileSecretStore(loose)).toThrow(/ROOT_MODE_TOO_OPEN/);
    rmSync(loose, { recursive: true, force: true });
  });

  it('never needs a key value in the environment: a PEM private key is read only from a file', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const file = put('authority/signer.pem', pem);
    expect(readSecretFile(file).toString()).toBe(pem);
  });
});
