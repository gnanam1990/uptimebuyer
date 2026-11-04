// F0 minimal intent envelope: credential-free, signed by f0-client, verified and authority-checked by f0-kite-broker.
// This is a spike schema, not the M09 CommercialIntent/ExecutionAuthority implementation.
import { sign, verify } from 'node:crypto';
import { canonical } from './canonical.mjs';

export const ENVELOPE_FIELDS = Object.freeze([
  'v',
  'intentId',
  'incidentId',
  'purpose',
  'providerId',
  'amountMinor',
  'currency',
  'expiresAt',
  'idempotencyKey',
  'nonce',
]);
// Fields the prompt requires tamper evidence for.
export const TAMPER_FIELDS = Object.freeze([
  'incidentId',
  'purpose',
  'providerId',
  'amountMinor',
  'currency',
  'expiresAt',
  'idempotencyKey',
]);
const STRING = /^[A-Za-z0-9._:-]{1,128}$/;
const MINOR = /^[1-9][0-9]{0,15}$/;
const CURRENCY = /^[A-Z]{3}$/;

export function signEnvelope(envelope, privateKey) {
  return sign(null, Buffer.from(canonical(envelope)), privateKey).toString('base64');
}

export function verifyEnvelopeSignature(envelope, sig, publicKey) {
  if (typeof sig !== 'string' || sig.length === 0 || sig.length > 256) return false;
  try {
    return verify(null, Buffer.from(canonical(envelope)), publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

// Exact shape: any extra field (endpoint, url, credential, embedded authority) is rejected.
export function checkShape(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'SHAPE_NOT_OBJECT';
  const outer = Object.keys(message).sort().join(',');
  if (outer !== 'envelope,sig') return 'SHAPE_UNEXPECTED_TOP_LEVEL_FIELDS';
  const env = message.envelope;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'SHAPE_ENVELOPE_NOT_OBJECT';
  const keys = Object.keys(env).sort();
  const expected = [...ENVELOPE_FIELDS].sort();
  if (keys.join(',') !== expected.join(',')) return 'SHAPE_UNEXPECTED_ENVELOPE_FIELDS';
  if (env.v !== 1) return 'SHAPE_VERSION';
  for (const f of ['intentId', 'incidentId', 'purpose', 'providerId', 'idempotencyKey', 'nonce']) {
    if (typeof env[f] !== 'string' || !STRING.test(env[f])) return `SHAPE_FIELD_${f}`;
  }
  if (typeof env.amountMinor !== 'string' || !MINOR.test(env.amountMinor)) return 'SHAPE_FIELD_amountMinor';
  if (typeof env.currency !== 'string' || !CURRENCY.test(env.currency)) return 'SHAPE_FIELD_currency';
  if (typeof env.expiresAt !== 'string' || Number.isNaN(Date.parse(env.expiresAt))) return 'SHAPE_FIELD_expiresAt';
  return null;
}

// Authority check against the approval record the broker loaded itself (never from the envelope).
export function checkAuthority(env, approval, allowlist, nowMs) {
  if (!approval) return 'NO_APPROVAL_FOR_INTENT';
  for (const f of ['incidentId', 'purpose', 'providerId', 'currency', 'expiresAt', 'idempotencyKey']) {
    if (env[f] !== approval[f]) return `AUTHORITY_MISMATCH_${f}`;
  }
  if (BigInt(env.amountMinor) > BigInt(approval.maxAmountMinor)) return 'AMOUNT_EXCEEDS_APPROVAL';
  if (!Object.hasOwn(allowlist, env.providerId)) return 'PROVIDER_NOT_ALLOWLISTED';
  if (Date.parse(env.expiresAt) <= nowMs) return 'EXPIRED';
  return null;
}

export function evaluateIntent({ message, publicKey, approvals, allowlist, nowMs }) {
  const shape = checkShape(message);
  if (shape) return { ok: false, code: shape };
  if (!verifyEnvelopeSignature(message.envelope, message.sig, publicKey))
    return { ok: false, code: 'SIGNATURE_INVALID' };
  const env = message.envelope;
  const denied = checkAuthority(env, approvals[env.intentId], allowlist, nowMs);
  if (denied) return { ok: false, code: denied };
  return { ok: true, envelope: env, destination: allowlist[env.providerId] };
}
