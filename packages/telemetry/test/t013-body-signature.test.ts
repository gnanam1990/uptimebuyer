// T-013 — Authenticated telemetry acceptance (unit layer): the HMAC body signature binds the exact body bytes, the
// signing timestamp and the device id under a key derived from the device credential; any change to any of them,
// a wrong key, a malformed or truncated signature, or a timestamp outside the skew bound fails verification.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_SCHEME,
  deriveBodySigningKey,
  signTelemetryBody,
  telemetrySigningInput,
  verifyTelemetryBody,
} from '../src/index.js';

const deviceKey = () => new Uint8Array(randomBytes(32));
const body = Buffer.from(JSON.stringify({ schemaVersion: 1, deviceId: 'dev_fixture-1', messages: [] }), 'utf8');
const now = Date.UTC(2026, 10, 4, 12, 0, 0);

describe('T-013 telemetry body signature', () => {
  it('derives a body-signing key that differs from the raw device credential key', () => {
    const k = deviceKey();
    const derived = deriveBodySigningKey(k);
    expect(derived.byteLength).toBe(32);
    expect(Buffer.from(derived).equals(Buffer.from(k))).toBe(false);
    expect(Buffer.from(deriveBodySigningKey(k)).equals(Buffer.from(derived))).toBe(true);
  });

  it('rejects keys shorter than 256 bits', () => {
    expect(() => deriveBodySigningKey(new Uint8Array(16))).toThrow();
  });

  it('the signing input binds scheme, timestamp, device id and the body digest', () => {
    const input = telemetrySigningInput(now, 'dev_fixture-1', body);
    expect(input.startsWith(`${SIGNATURE_SCHEME}\n${now}\ndev_fixture-1\n`)).toBe(true);
    expect(input).toMatch(/\n[0-9a-f]{64}$/);
  });

  it('verifies an untampered body and rejects every tampered component', () => {
    const k = deviceKey();
    const sig = signTelemetryBody(k, now, 'dev_fixture-1', body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    const ok = (o: Partial<{ key: Uint8Array; ts: number; dev: string; b: Buffer; sig: string; at: number }>) =>
      verifyTelemetryBody({
        key: o.key ?? k,
        timestampMs: o.ts ?? now,
        deviceId: o.dev ?? 'dev_fixture-1',
        body: o.b ?? body,
        signature: o.sig ?? sig,
        nowMs: o.at ?? now,
        maxSkewMs: 300_000,
      });
    expect(ok({})).toEqual({ ok: true });
    const flipped = Buffer.from(body);
    flipped[5] = flipped[5]! ^ 1;
    expect(ok({ b: flipped })).toEqual({ ok: false, reasonCode: 'SIGNATURE_INVALID' });
    expect(ok({ ts: now + 1, at: now })).toEqual({ ok: false, reasonCode: 'SIGNATURE_INVALID' });
    expect(ok({ dev: 'dev_fixture-2' })).toEqual({ ok: false, reasonCode: 'SIGNATURE_INVALID' });
    expect(ok({ key: deviceKey() })).toEqual({ ok: false, reasonCode: 'SIGNATURE_INVALID' });
    expect(ok({ sig: sig.slice(0, -2) })).toEqual({ ok: false, reasonCode: 'SIGNATURE_MALFORMED' });
    expect(ok({ sig: `v2=${sig.slice(3)}` })).toEqual({ ok: false, reasonCode: 'SIGNATURE_MALFORMED' });
    expect(ok({ sig: '' })).toEqual({ ok: false, reasonCode: 'SIGNATURE_MALFORMED' });
    expect(ok({ sig: sig.toUpperCase() })).toEqual({ ok: false, reasonCode: 'SIGNATURE_MALFORMED' });
  });

  it('rejects a signing timestamp outside the skew bound in either direction, even with a valid signature', () => {
    const k = deviceKey();
    const old = now - 300_001;
    const ahead = now + 300_001;
    const verify = (ts: number) =>
      verifyTelemetryBody({
        key: k,
        timestampMs: ts,
        deviceId: 'dev_fixture-1',
        body,
        signature: signTelemetryBody(k, ts, 'dev_fixture-1', body),
        nowMs: now,
        maxSkewMs: 300_000,
      });
    expect(verify(old)).toEqual({ ok: false, reasonCode: 'TIMESTAMP_SKEW' });
    expect(verify(ahead)).toEqual({ ok: false, reasonCode: 'TIMESTAMP_SKEW' });
    expect(verify(now - 300_000)).toEqual({ ok: true });
    expect(verify(Number.NaN)).toEqual({ ok: false, reasonCode: 'TIMESTAMP_SKEW' });
  });
});
