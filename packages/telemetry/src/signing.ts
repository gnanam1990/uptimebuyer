// HMAC body signature for device telemetry (ADR 0001 §4: signed HTTPS ingestion, HMAC per device credential).
// The body-signing key is derived from the device credential with HKDF-SHA256 under a dedicated label, so the same
// credential never signs two kinds of artefact with one key (the device token uses the credential directly).
// Signing input: "ub-telemetry.v1\n<timestamp ms>\n<device id>\n<hex sha256(body bytes)>". Comparison is constant
// time over fixed-length digests; the timestamp is bounded by a skew window.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_SCHEME = 'ub-telemetry.v1';
export const SIGNATURE_HEADER = 'x-ub-signature';
export const TIMESTAMP_HEADER = 'x-ub-timestamp';
const HKDF_SALT = Buffer.from('uptimebuyer/device-credential', 'utf8');
const HKDF_INFO = Buffer.from('ub-telemetry-body-signature.v1', 'utf8');
const MIN_KEY_BYTES = 32;
const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/;

const bytes = (body: Uint8Array | string): Buffer =>
  typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength);

export function deriveBodySigningKey(deviceKey: Uint8Array): Uint8Array {
  if (!(deviceKey instanceof Uint8Array) || deviceKey.byteLength < MIN_KEY_BYTES)
    throw new Error('Device credential key must be at least 32 bytes.');
  return new Uint8Array(hkdfSync('sha256', deviceKey, HKDF_SALT, HKDF_INFO, 32));
}

export function telemetrySigningInput(timestampMs: number, deviceId: string, body: Uint8Array | string): string {
  const digest = createHash('sha256').update(bytes(body)).digest('hex');
  return `${SIGNATURE_SCHEME}\n${timestampMs}\n${deviceId}\n${digest}`;
}

/** `v1=<hex hmac-sha256>` over the signing input, keyed by the derived body-signing key. */
export function signTelemetryBody(
  deviceKey: Uint8Array,
  timestampMs: number,
  deviceId: string,
  body: Uint8Array | string,
): string {
  const mac = createHmac('sha256', deriveBodySigningKey(deviceKey))
    .update(telemetrySigningInput(timestampMs, deviceId, body), 'utf8')
    .digest('hex');
  return `v1=${mac}`;
}

export type SignatureVerdict =
  { ok: true } | { ok: false; reasonCode: 'SIGNATURE_MALFORMED' | 'SIGNATURE_INVALID' | 'TIMESTAMP_SKEW' };

export function verifyTelemetryBody(input: {
  key: Uint8Array;
  timestampMs: number;
  deviceId: string;
  body: Uint8Array | string;
  signature: string;
  nowMs: number;
  maxSkewMs: number;
}): SignatureVerdict {
  if (!Number.isSafeInteger(input.timestampMs) || Math.abs(input.nowMs - input.timestampMs) > input.maxSkewMs)
    return { ok: false, reasonCode: 'TIMESTAMP_SKEW' };
  const m = SIGNATURE_RE.exec(typeof input.signature === 'string' ? input.signature : '');
  if (!m) return { ok: false, reasonCode: 'SIGNATURE_MALFORMED' };
  const expected = Buffer.from(
    signTelemetryBody(input.key, input.timestampMs, input.deviceId, input.body).slice(3),
    'hex',
  );
  const given = Buffer.from(m[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reasonCode: 'SIGNATURE_INVALID' };
}

/** Parse the timestamp header: a canonical non-negative integer of epoch milliseconds, else NaN. */
export function parseTimestampHeader(value: unknown): number {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : Number.NaN;
}
