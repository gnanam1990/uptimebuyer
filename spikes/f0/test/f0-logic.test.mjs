// F0 spike logic checks (not canonical T-IDs; F0 owns none). Run: pnpm exec vitest run --config spikes/f0/vitest.config.mjs
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TAMPER_FIELDS, evaluateIntent, signEnvelope } from '../lib/envelope.mjs';
import { deriveRecoveryResult, makeRecord } from '../lib/evidence.mjs';
import { STATES, applyLookup, classifyExecute, decideOnSubmit, deriveStates, recoverOnBoot } from '../lib/journal.mjs';
import { createLedger } from '../lib/ledger.mjs';
import { decidePart, responseDeadline } from '../lib/parts.mjs';
import { SOURCES, assess } from '../lib/sensor.mjs';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-04T12:00:00Z');
const fields = {
  v: 1,
  intentId: 'i-1',
  incidentId: 'inc-1',
  purpose: 'p',
  providerId: 'local-standin-paid',
  amountMinor: '100',
  currency: 'XTS',
  expiresAt: '2026-11-04T12:10:00.000Z',
  idempotencyKey: 'k-1',
  nonce: 'n-1',
};
const { v: _v, nonce: _n, amountMinor, ...approvalFields } = fields;
const approvals = { 'i-1': { ...approvalFields, maxAmountMinor: amountMinor } };
const allowlist = { 'local-standin-paid': { origin: 'https://127.0.0.1:1' } };
const evalMsg = (message) => evaluateIntent({ message, publicKey: keys.publicKey, approvals, allowlist, nowMs: now });
const tampered = {
  incidentId: 'inc-2',
  purpose: 'q',
  providerId: 'other',
  amountMinor: '101',
  currency: 'USD',
  expiresAt: '2026-11-05T00:00:00.000Z',
  idempotencyKey: 'k-2',
};

describe('F0-B envelope', () => {
  it('accepts the untampered signed envelope', () => {
    expect(evalMsg({ envelope: fields, sig: signEnvelope(fields, keys.privateKey) }).ok).toBe(true);
  });
  it.each(TAMPER_FIELDS)('rejects %s mutated after signing and re-signed out of authority', (f) => {
    const sig = signEnvelope(fields, keys.privateKey);
    expect(evalMsg({ envelope: { ...fields, [f]: tampered[f] }, sig }).code).toBe('SIGNATURE_INVALID');
    const resigned = { ...fields, [f]: tampered[f] };
    const r = evalMsg({ envelope: resigned, sig: signEnvelope(resigned, keys.privateKey) });
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/^(AUTHORITY_MISMATCH_|AMOUNT_EXCEEDS)/);
  });
  it('rejects embedded endpoint/credential fields and other signers', () => {
    const extra = { ...fields, endpoint: 'https://x' };
    expect(evalMsg({ envelope: extra, sig: signEnvelope(extra, keys.privateKey) }).code).toBe(
      'SHAPE_UNEXPECTED_ENVELOPE_FIELDS',
    );
    const other = generateKeyPairSync('ed25519');
    expect(evalMsg({ envelope: fields, sig: signEnvelope(fields, other.privateKey) }).code).toBe('SIGNATURE_INVALID');
  });
  it('rejects at expiry', () => {
    const r = evaluateIntent({
      message: { envelope: fields, sig: signEnvelope(fields, keys.privateKey) },
      publicKey: keys.publicKey,
      approvals,
      allowlist,
      nowMs: Date.parse(fields.expiresAt),
    });
    expect(r.code).toBe('EXPIRED');
  });
});

describe('F0-C reconciliation state (LOCAL_STAND_IN)', () => {
  it('provider ledger: same key + same digest returns the same effect; different digest is refused', () => {
    const l = createLedger();
    const a = l.execute('k', 'd1', { amountMinor: '1', currency: 'XTS' });
    const b = l.execute('k', 'd1', { amountMinor: '1', currency: 'XTS' });
    expect(b.effect.effectId).toBe(a.effect.effectId);
    expect(b.replayed).toBe(true);
    expect(l.execute('k', 'd2', {}).status).toBe(422);
    expect(l.snapshot().k.effectsCreated).toBe(1);
  });
  it('lost response is UNKNOWN, is not retried, and converges only through lookup', () => {
    expect(classifyExecute({ kind: 'transport', error: 'TRANSPORT_ERROR' }).state).toBe(STATES.UNKNOWN);
    expect(classifyExecute({ kind: 'response', status: 503 }).state).toBe(STATES.UNKNOWN);
    const entry = { requestDigest: 'd1', state: STATES.UNKNOWN };
    expect(decideOnSubmit(entry, 'd1')).toBe('RETURN_UNKNOWN_NO_RETRY');
    expect(decideOnSubmit(entry, 'd2')).toBe('IDEMPOTENCY_CONFLICT');
    expect(applyLookup(entry, { kind: 'transport' }).state).toBe(STATES.UNKNOWN);
    expect(applyLookup(entry, { kind: 'response', status: 404 }).reason).toBe('NOT_FOUND_IS_NOT_PROOF');
    expect(
      applyLookup(entry, { kind: 'response', status: 200, body: { requestDigest: 'other', effect: { effectId: 'e' } } })
        .state,
    ).toBe(STATES.UNKNOWN);
    expect(
      applyLookup(entry, { kind: 'response', status: 200, body: { requestDigest: 'd1', effect: { effectId: 'e' } } }),
    ).toEqual({ state: STATES.CONFIRMED, effectId: 'e' });
  });
  it('SEND_STARTED without an outcome is recovered as UNKNOWN at boot', () => {
    const s = deriveStates([{ event: 'SEND_STARTED', intentId: 'i', idempotencyKey: 'k', requestDigest: 'd' }]);
    expect(recoverOnBoot(s).map((e) => e.idempotencyKey)).toEqual(['k']);
  });
});

describe('F0-D simulated sensor and part evidence', () => {
  const policy = { maxAgeMs: 300_000, maxClockSkewMs: 30_000, minMilliC: 0, maxMilliC: 5_000 };
  it('stale data never reads healthy, whatever its source label', () => {
    for (const source of Object.values(SOURCES)) {
      const r = assess([{ seq: 1, source, sourceTimeMs: now - 600_000, valueMilliC: 3_000 }], now, policy);
      expect(r.conditionStatus).toBe('STALE');
      expect(r.healthyClaimAllowed).toBe(false);
    }
  });
  it('SIMULATED_INPUT in range is never a healthy claim', () => {
    const r = assess([{ seq: 1, source: SOURCES.SIMULATED_INPUT, sourceTimeMs: now, valueMilliC: 3_000 }], now, policy);
    expect(r).toMatchObject({ conditionStatus: 'FRESH_IN_RANGE', healthyClaimAllowed: false });
  });
  it('ambiguous or similar parts stay HELD; SOP alone sets the deadline', () => {
    const cited = { manufacturer: 'FixtureCo', mpn: 'A-1', citation: { docDigest: 'd', page: 1 }, isFixture: true };
    expect(decidePart(cited, { manufacturer: 'FixtureCo', mpn: 'A-2', similarity: 0.99 }).decision).toBe('HELD');
    expect(decidePart({ ...cited, citation: null }, { manufacturer: 'FixtureCo', mpn: 'A-1' }).decision).toBe('HELD');
    expect(decidePart(cited, { manufacturer: 'FixtureCo', mpn: 'A-1' }).decision).toBe('EXACT_MATCH_FIXTURE_ONLY');
    expect(responseDeadline(null, { minutes: 600 }).decision).toBe('HELD');
  });
});

describe('F0-E recovery-authority separation', () => {
  it('payment + provider-completed cannot produce a recovery result', () => {
    const recs = [
      makeRecord('PAYMENT_OBSERVATION', { effectId: 'e' }),
      makeRecord('PROVIDER_ACCEPTANCE', { effectId: 'e' }),
      makeRecord('WORK_REPORT', { status: 'PROVIDER_REPORTED_COMPLETED', reportedAtMs: now }),
    ];
    expect(deriveRecoveryResult(recs, { minSamples: 1 }).result).toBe('INSUFFICIENT_FOR_RECOVERY');
    const live = makeRecord('SENSOR_WINDOW', {
      source: SOURCES.LIVE_AUTHENTICATED,
      startMs: now,
      samples: 3,
      allFreshInRange: true,
    });
    const signoff = makeRecord('SIGNOFF', { role: 'maintenance_approver' });
    // A window that does not start strictly after the intervention does not qualify.
    expect(deriveRecoveryResult([...recs, signoff, live], { minSamples: 1 }).result).toBe('INSUFFICIENT_FOR_RECOVERY');
    const after = makeRecord('SENSOR_WINDOW', {
      source: SOURCES.LIVE_AUTHENTICATED,
      startMs: now + 1,
      samples: 3,
      allFreshInRange: true,
    });
    expect(deriveRecoveryResult([...recs, signoff, after], { minSamples: 1 }).result).toBe(
      'CONDITION_RESTORED_OBSERVED',
    );
  });
});
