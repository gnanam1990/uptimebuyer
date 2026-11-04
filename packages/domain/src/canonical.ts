// Stable, versioned canonical serialization and digests.
//
// Canonical text: JSON-like, no whitespace, object keys sorted by UTF-16 code unit, arrays in order, strings as
// JSON strings, safe integers only, bigint as decimal digits suffixed with `n` (so 1n, 1 and "1" differ), `null`,
// booleans. Anything without exactly one canonical form (floats, NaN, undefined, Date, Map, class instances,
// functions, cycles) is rejected. Digest preimage: `<domain>.v<version>\n<canonical text>`, hashed with SHA-256 and
// rendered `<domain>.v<version>:sha256:<hex>`, so the version prefix is both visible and bound.
import { createHash } from 'node:crypto';
import { DomainError, type VersionedDigest } from '@uptimebuyer/contracts';

const MAX_DEPTH = 64;

function reject(path: string, why: string): never {
  throw new DomainError('VALIDATION_FAILED', 'Value has no canonical form.', { path, reason: why });
}

function encode(v: unknown, path: string, ancestors: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) reject(path, 'NON_SAFE_INTEGER_NUMBER');
      return Object.is(v, -0) ? '0' : String(v);
    case 'bigint':
      return `${v.toString()}n`;
    case 'object': {
      if (ancestors.has(v)) reject(path, 'CYCLE');
      if (ancestors.size >= MAX_DEPTH) reject(path, 'TOO_DEEP');
      ancestors.add(v);
      try {
        if (Array.isArray(v)) {
          const parts: string[] = [];
          for (let i = 0; i < v.length; i++) {
            if (!Object.hasOwn(v, i)) reject(`${path}[${i}]`, 'SPARSE_ARRAY');
            parts.push(encode(v[i], `${path}[${i}]`, ancestors));
          }
          return `[${parts.join(',')}]`;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) reject(path, 'NOT_A_PLAIN_OBJECT');
        if (Object.getOwnPropertySymbols(v).length > 0) reject(path, 'SYMBOL_KEY');
        const keys = Object.keys(v).sort();
        const parts = keys.map((k) => {
          const child = (v as Record<string, unknown>)[k];
          if (child === undefined) reject(`${path}.${k}`, 'UNDEFINED');
          return `${JSON.stringify(k)}:${encode(child, `${path}.${k}`, ancestors)}`;
        });
        return `{${parts.join(',')}}`;
      } finally {
        ancestors.delete(v);
      }
    }
    default:
      return reject(path, `UNSUPPORTED_${typeof v}`.toUpperCase());
  }
}

export function canonicalize(value: unknown): string {
  return encode(value, '$', new Set());
}

const DOMAIN_RE = /^[a-z][a-z0-9-]{0,62}$/;

export function canonicalDigest(domain: string, version: number, value: unknown): VersionedDigest {
  if (!DOMAIN_RE.test(domain)) throw new DomainError('VALIDATION_FAILED', 'Invalid digest domain.');
  if (!Number.isSafeInteger(version) || version < 1 || version > 999_999)
    throw new DomainError('VALIDATION_FAILED', 'Invalid digest version.');
  const tag = `${domain}.v${version}`;
  const hex = createHash('sha256')
    .update(`${tag}\n${canonicalize(value)}`, 'utf8')
    .digest('hex');
  return `${tag}:sha256:${hex}` as VersionedDigest;
}
