// T-021 (storage layer) — cited bytes are re-openable only if the object store is content-addressed, immutable and
// confined to its tenant namespace: keys are validated, traversal and symlink escapes are refused, an existing object
// is never overwritten and reads verify the digest named by the key.
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFilesystemObjectStore, objectKeyFor } from '../src/index.js';
import { sha256Of } from './helpers.js';

let root: string;
let outside: string;
let store: LocalFilesystemObjectStore;
const tenant = 'ten_object-store-test';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { details?: { reasonCode?: string } }).details?.reasonCode ?? (e as Error).message;
  }
  throw new Error('expected rejection');
};

describe('T-021 content-addressed object store', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ub-m05-store-'));
    outside = mkdtempSync(join(tmpdir(), 'ub-m05-outside-'));
    store = new LocalFilesystemObjectStore(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('stores bytes under their digest and returns them verbatim', async () => {
    const bytes = Buffer.from('Evaporator fan motor .......... 5A1-0402');
    const key = objectKeyFor(tenant, 'evidence', sha256Of(bytes));
    expect(key).toBe(`tenants/${tenant}/evidence/${sha256Of(bytes).slice(7)}`);
    expect(await store.put(key, bytes)).toEqual({ existing: false });
    expect(await store.put(key, bytes)).toEqual({ existing: true });
    expect(Buffer.from(await store.get(key))).toEqual(bytes);
  });

  it('refuses bytes whose digest does not match the key, and never overwrites', async () => {
    const bytes = Buffer.from('original');
    const key = objectKeyFor(tenant, 'evidence', sha256Of(bytes));
    expect(await code(store.put(key, Buffer.from('forged')))).toBe('OBJECT_DIGEST_MISMATCH');
    await store.put(key, bytes);
    expect(Buffer.from(await store.get(key))).toEqual(bytes);
  });

  it('detects tampering of a stored object on read', async () => {
    const bytes = Buffer.from('to be tampered');
    const digest = sha256Of(bytes);
    const key = objectKeyFor(tenant, 'evidence', digest);
    await store.put(key, bytes);
    // Objects are written read-only; an attacker with filesystem access has to change that first.
    chmodSync(join(root, key), 0o640);
    writeFileSync(join(root, key), 'tampered');
    expect(await code(store.get(key))).toBe('OBJECT_INTEGRITY_FAILED');
  });

  it('rejects traversal, absolute, malformed and foreign-shaped keys', async () => {
    const bad = [
      '../etc/passwd',
      `/tenants/${tenant}/evidence/${'a'.repeat(64)}`,
      `tenants/${tenant}/../../x/${'a'.repeat(64)}`,
      `tenants/${tenant}/evidence/${'a'.repeat(63)}`,
      `tenants/${tenant}/evidence/${'A'.repeat(64)}`,
      `tenants/ten_x/evidence/${'a'.repeat(64)}\u0000`,
      `tenants/${tenant}/Evidence/${'a'.repeat(64)}`,
    ];
    for (const key of bad) {
      expect(await code(store.get(key))).toBe('INVALID_OBJECT_KEY');
      expect(await code(store.put(key, Buffer.from('x')))).toBe('INVALID_OBJECT_KEY');
    }
  });

  it('refuses to follow a symlink that escapes the store root', async () => {
    const bytes = Buffer.from('escape');
    const hex = sha256Of(bytes).slice(7);
    mkdirSync(join(root, 'tenants', 'ten_symlink-test'), { recursive: true });
    symlinkSync(outside, join(root, 'tenants', 'ten_symlink-test', 'evidence'));
    const key = `tenants/ten_symlink-test/evidence/${hex}`;
    expect(await code(store.put(key, bytes))).toBe('INVALID_OBJECT_KEY');
    expect(await code(store.get(key))).toBe('INVALID_OBJECT_KEY');
  });

  it('bounds reads', async () => {
    const bytes = Buffer.alloc(4096, 0x61);
    const key = objectKeyFor(tenant, 'evidence', sha256Of(bytes));
    await store.put(key, bytes);
    expect(await code(store.get(key, { maxBytes: 1024 }))).toBe('OBJECT_TOO_LARGE');
  });
});
