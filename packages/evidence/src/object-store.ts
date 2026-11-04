// Content-addressed immutable object store behind a port (ADR 0001 §5). Keys are `tenants/<tenantId>/<kind>/<hex>`
// where <hex> is the SHA-256 of the bytes: a put verifies the digest, never overwrites, and a get re-verifies it, so
// cited bytes can always be re-opened exactly or the read fails closed. The local filesystem adapter confines every
// path to its root: keys are validated by a strict grammar, resolved paths must stay under the real root, and no
// component may be a symlink.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DomainError, Sha256DigestSchema } from '@uptimebuyer/contracts';
import { rejected } from './errors.js';

export interface ObjectStorePort {
  /** Store `bytes` under `key`; idempotent for identical content, refuses content that does not match the key. */
  put(key: string, bytes: Uint8Array): Promise<{ existing: boolean }>;
  /** Read and verify the bytes under `key`. */
  get(key: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
}

const KEY = /^tenants\/(ten_[A-Za-z0-9][A-Za-z0-9-]{3,63})\/([a-z][a-z0-9-]{0,31})\/([0-9a-f]{64})$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_MAX_READ = 64 * 1024 * 1024;

const invalidKey = () => rejected('INVALID_OBJECT_KEY', 'Object key failed validation.');
const integrity = () =>
  new DomainError('DIGEST_MISMATCH', 'Stored object does not match its content digest.', {
    reasonCode: 'OBJECT_INTEGRITY_FAILED',
  });

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const sha256DigestOf = (bytes: Uint8Array): `sha256:${string}` => `sha256:${sha256Hex(bytes)}`;

/** The canonical content-addressed key for `sha256` in `tenantId`'s `kind` namespace. */
export function objectKeyFor(tenantId: string, kind: string, sha256: string): string {
  if (!/^ten_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(tenantId) || !KIND.test(kind) || !Sha256DigestSchema.safeParse(sha256).success)
    throw invalidKey();
  return `tenants/${tenantId}/${kind}/${sha256.slice('sha256:'.length)}`;
}

export function parseObjectKey(key: string): { tenantId: string; kind: string; hex: string } {
  if (typeof key !== 'string') throw invalidKey();
  const m = KEY.exec(key);
  if (!m) throw invalidKey();
  return { tenantId: m[1]!, kind: m[2]!, hex: m[3]! };
}

export class LocalFilesystemObjectStore implements ObjectStorePort {
  private realRoot: Promise<string> | null = null;
  constructor(private readonly rootDir: string) {}

  private root(): Promise<string> {
    this.realRoot ??= (async () => {
      await mkdir(this.rootDir, { recursive: true });
      return realpath(this.rootDir);
    })();
    return this.realRoot;
  }

  /** Resolve `key` to a path under the root, refusing any existing symlink component. */
  private async resolve(key: string, create: boolean): Promise<{ dir: string; file: string }> {
    const k = parseObjectKey(key);
    const root = await this.root();
    const parts = ['tenants', k.tenantId, k.kind];
    let dir = root;
    for (const p of parts) {
      dir = join(dir, p);
      const st = await lstat(dir).catch(() => null);
      if (st === null) {
        if (!create) break;
        await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
        const again = await lstat(dir);
        if (!again.isDirectory() || again.isSymbolicLink()) throw invalidKey();
      } else if (st.isSymbolicLink() || !st.isDirectory()) throw invalidKey();
    }
    const file = join(root, ...parts, k.hex);
    const rel = relative(root, file);
    if (rel.startsWith('..') || rel.split(sep).length !== 4) throw invalidKey();
    return { dir, file };
  }

  async put(key: string, bytes: Uint8Array): Promise<{ existing: boolean }> {
    const { hex } = parseObjectKey(key);
    if (sha256Hex(bytes) !== hex) throw rejected('OBJECT_DIGEST_MISMATCH', 'Bytes do not match the object key.');
    const { dir, file } = await this.resolve(key, true);
    const existing = await lstat(file).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) throw invalidKey();
      await this.get(key);
      return { existing: true };
    }
    // Write a private temp file, then hard-link it into place: link() fails if the target exists, so a concurrent
    // writer can never replace an object, and readers never observe partial content.
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    const fh = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o440);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, file);
      return { existing: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        await this.get(key);
        return { existing: true };
      }
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async get(key: string, opts: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const { hex } = parseObjectKey(key);
    const { file } = await this.resolve(key, false);
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_READ;
    let fh;
    try {
      fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw integrity();
      if (code === 'ELOOP') throw invalidKey();
      throw e;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw invalidKey();
      if (st.size > maxBytes) throw rejected('OBJECT_TOO_LARGE', 'Stored object exceeds the read bound.');
      const bytes = await fh.readFile();
      if (bytes.length > maxBytes) throw rejected('OBJECT_TOO_LARGE', 'Stored object exceeds the read bound.');
      if (sha256Hex(bytes) !== hex) throw integrity();
      return new Uint8Array(bytes);
    } finally {
      await fh.close();
    }
  }
}
