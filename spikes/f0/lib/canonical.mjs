// Canonical JSON (sorted keys, no whitespace) and digest helpers shared by every F0 spike process.
import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const digestOf = (value) => sha256(canonical(value));
// Short fingerprint for metadata-only references to secret material (never the value itself).
export const fingerprint = (data) => sha256(data).slice(0, 16);
