// T-047 (adapter layer) — CMMS signature verification and the replay-safe CMMS adapter port (FR-17, NFR-11, INV-12).
// Signed CMMS records verify only with the bound verifier key, inside the timestamp tolerance, over the exact raw
// bytes; forged, tampered, stale and future-dated signatures fail. The contract fake (labelled CONTRACT_FAKE) applies
// each idempotency key at most once and answers lookups after an ambiguous timeout. The real HTTPS adapter is
// environment-gated and reports UNSUPPORTED (never a fabricated success) without credentials; it never runs here.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CMMS_RECORD_LIMITS,
  ContractFakeCmmsAdapter,
  HttpsCmmsAdapter,
  signCmmsRecord,
  verifyCmmsSignature,
  type CmmsWorkOrderUpdate,
} from '../src/index.js';

const key = () => new Uint8Array(randomBytes(32));
const body = (o: Record<string, unknown> = {}) =>
  new Uint8Array(Buffer.from(JSON.stringify({ schema: 'cmms-record.v1', recordId: 'wo-1', ...o }), 'utf8'));

function update(over: Partial<CmmsWorkOrderUpdate> = {}): CmmsWorkOrderUpdate {
  return {
    idempotencyKey: `cmms:ten_alpha-0001:cwu_${randomBytes(4).toString('hex')}`,
    tenantId: 'ten_alpha-0001',
    incidentId: 'inc_alpha-0001',
    workOrderKey: 'inc_alpha-0001',
    updateKind: 'CLOSEOUT',
    payload: { decision: 'RECOVERED' },
    payloadDigest: `sha256:${'a'.repeat(64)}`,
    ...over,
  };
}

describe('T-047 CMMS signature verification', () => {
  it('accepts the exact signed bytes inside the tolerance and nothing else', () => {
    const k = key();
    const raw = body();
    const now = 1_800_000_000;
    const sig = signCmmsRecord(k, now, raw);
    expect(verifyCmmsSignature(k, sig, raw, now)).toEqual({ ok: true, timestampSec: now });
    expect(verifyCmmsSignature(k, sig, raw, now + CMMS_RECORD_LIMITS.toleranceSeconds)).toMatchObject({ ok: true });
    // Forged with another key, tampered body, stale, future, malformed.
    expect(verifyCmmsSignature(k, signCmmsRecord(key(), now, raw), raw, now)).toEqual({
      ok: false,
      reasonCode: 'SIGNATURE_MISMATCH',
    });
    expect(verifyCmmsSignature(k, sig, body({ recordId: 'wo-2' }), now)).toEqual({
      ok: false,
      reasonCode: 'SIGNATURE_MISMATCH',
    });
    expect(verifyCmmsSignature(k, sig, raw, now + CMMS_RECORD_LIMITS.toleranceSeconds + 1)).toEqual({
      ok: false,
      reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE',
    });
    expect(verifyCmmsSignature(k, sig, raw, now - CMMS_RECORD_LIMITS.toleranceSeconds - 1)).toEqual({
      ok: false,
      reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE',
    });
    for (const bad of ['', 'v1=00', `t=${now}`, `t=abc,v1=${'0'.repeat(64)}`, `t=${now},v1=zz`])
      expect(verifyCmmsSignature(k, bad, raw, now)).toEqual({ ok: false, reasonCode: 'SIGNATURE_MALFORMED' });
    // Keys shorter than the minimum never verify anything.
    const short = new Uint8Array(16);
    expect(verifyCmmsSignature(short, signCmmsRecord(short, now, raw), raw, now)).toEqual({
      ok: false,
      reasonCode: 'VERIFIER_KEY_TOO_SHORT',
    });
  });
});

describe('T-047 CMMS adapter port (replay-safe)', () => {
  it('the contract fake is labelled CONTRACT_FAKE and applies an idempotency key at most once', async () => {
    const fake = new ContractFakeCmmsAdapter();
    expect(fake.label).toBe('CONTRACT_FAKE');
    expect(fake.capability()).toBe('ELIGIBLE');
    const u = update();
    const a = await fake.write(u);
    const b = await fake.write(u);
    expect(a).toMatchObject({ outcome: 'CONFIRMED' });
    expect(b).toEqual(a);
    expect(fake.appliedCount()).toBe(1);
    // The same key with another payload is a conflict, never a second update.
    expect(await fake.write({ ...u, payloadDigest: `sha256:${'b'.repeat(64)}` })).toEqual({
      outcome: 'FAILED',
      reasonCode: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(fake.appliedCount()).toBe(1);
  });

  it('an ambiguous timeout is UNKNOWN; lookup by the same key resolves it without a duplicate', async () => {
    const fake = new ContractFakeCmmsAdapter();
    const u = update();
    fake.failNext('TIMEOUT_AFTER_APPLY');
    expect(await fake.write(u)).toEqual({ outcome: 'UNKNOWN', reasonCode: 'CMMS_TIMEOUT' });
    const found = await fake.lookup(u.idempotencyKey);
    expect(found).toMatchObject({ outcome: 'CONFIRMED' });
    expect(await fake.write(u)).toEqual(found);
    expect(fake.appliedCount()).toBe(1);

    const v = update();
    fake.failNext('TIMEOUT_BEFORE_APPLY');
    expect(await fake.write(v)).toMatchObject({ outcome: 'UNKNOWN' });
    expect(await fake.lookup(v.idempotencyKey)).toEqual({ outcome: 'NOT_FOUND' });
    expect(fake.appliedCount()).toBe(1);
  });

  it('the real HTTPS CMMS adapter is UNSUPPORTED without credentials and never pretends success', async () => {
    const none = HttpsCmmsAdapter.fromEnv({});
    expect(none.label).toBe('LIVE');
    expect(none.capability()).toBe('UNSUPPORTED');
    expect(await none.write(update())).toEqual({ outcome: 'UNSUPPORTED', reasonCode: 'CMMS_CREDENTIALS_ABSENT' });
    expect(await none.lookup('cmms:x')).toEqual({ outcome: 'UNSUPPORTED', reasonCode: 'CMMS_CREDENTIALS_ABSENT' });
    // A base URL alone (no token) or a non-HTTPS endpoint is still UNSUPPORTED.
    expect(HttpsCmmsAdapter.fromEnv({ UB_CMMS_BASE_URL: 'https://cmms.example' }).capability()).toBe('UNSUPPORTED');
    expect(
      HttpsCmmsAdapter.fromEnv({ UB_CMMS_BASE_URL: 'http://cmms.example', UB_CMMS_TOKEN: 'x'.repeat(40) }).capability(),
    ).toBe('UNSUPPORTED');
  });
});
