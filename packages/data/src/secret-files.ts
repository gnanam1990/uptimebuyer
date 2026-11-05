// File-backed secret channel (M14; INV-06, INV-16, SECURITY.md §5). Deployments deliver secrets as files: container
// secret mounts and Kubernetes secret volumes (0400/0600, owned by root or the workload). The environment carries only
// the REFERENCE (a file path or a root directory), never the value. readSecretFile refuses anything that is not a
// regular file, is readable by group or other, or exceeds a size bound; its errors carry a reason code and never the
// file contents. FileSecretStore resolves a tenant-bound `secretref:` to exactly one file under its root.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CredentialResolver } from './auth.js';

export class SecretFileError extends Error {
  constructor(readonly reasonCode: string) {
    super(`secret file rejected: ${reasonCode}`);
    this.name = 'SecretFileError';
  }
}

/** Read one secret file (following a secret-volume symlink to its target), enforcing type, mode and size. */
export function readSecretFile(file: string, opts: { maxBytes?: number } = {}): Buffer {
  const max = opts.maxBytes ?? 65_536;
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 1024 || file.includes('\0'))
    throw new SecretFileError('SECRET_FILE_PATH_INVALID');
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new SecretFileError('SECRET_FILE_MISSING');
  }
  if (!st.isFile()) throw new SecretFileError('SECRET_FILE_NOT_REGULAR');
  if ((st.mode & 0o077) !== 0) throw new SecretFileError('SECRET_FILE_MODE_TOO_OPEN');
  if (st.size > max) throw new SecretFileError('SECRET_FILE_TOO_LARGE');
  if (st.size === 0) throw new SecretFileError('SECRET_FILE_EMPTY');
  return readFileSync(file);
}

const REF = /^secretref:([a-z0-9-]{1,32})\/tenants\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
const B64URL = /^[A-Za-z0-9_-]{22,1024}$/;

/**
 * CredentialResolver over a directory of secret files laid out as `<root>/<namespace>/tenants/<tenantId>/<path>`, each
 * holding a base64url key. Anything that does not resolve cleanly (bad shape, traversal, a symlink leaving the root,
 * an open mode, a missing or malformed file) resolves to `undefined`, which every caller treats as "no credential":
 * webhooks and devices are then refused (fail closed).
 */
export class FileSecretStore implements CredentialResolver {
  private readonly root: string;

  constructor(root: string) {
    let st;
    try {
      st = statSync(root);
    } catch {
      throw new SecretFileError('SECRET_ROOT_MISSING');
    }
    if (!st.isDirectory()) throw new SecretFileError('SECRET_ROOT_NOT_DIRECTORY');
    if ((st.mode & 0o022) !== 0) throw new SecretFileError('SECRET_ROOT_MODE_TOO_OPEN');
    this.root = realpathSync(root);
  }

  /** The file a reference maps to, or null when the reference is not a well-formed tenant-bound reference. */
  pathFor(ref: string): string | null {
    if (typeof ref !== 'string' || ref.length > 300 || DOT_SEGMENT.test(ref.slice('secretref:'.length))) return null;
    const m = REF.exec(ref);
    if (!m) return null;
    return path.join(this.root, m[1]!, 'tenants', m[2]!, ...m[3]!.split('/'));
  }

  async resolveSigningKey(ref: string): Promise<Uint8Array | undefined> {
    const file = this.pathFor(ref);
    if (!file) return undefined;
    try {
      // The resolved target must stay inside the root (a secret-volume symlink inside the root is fine).
      const real = realpathSync(file);
      if (real !== this.root && !real.startsWith(`${this.root}${path.sep}`)) return undefined;
      const text = readSecretFile(real, { maxBytes: 4_096 }).toString('utf8').trim();
      if (!B64URL.test(text)) return undefined;
      const key = Buffer.from(text, 'base64url');
      return key.length >= 16 ? new Uint8Array(key) : undefined;
    } catch {
      return undefined;
    }
  }
}
