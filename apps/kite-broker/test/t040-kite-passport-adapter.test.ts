// T-040 — Kite Passport adapter capability (recorded kpass CLI contract; NOT the real Kite service). Kite documents no
// HTTP API and no payment lookup by client key (docs.gokite.ai, 2026-11-05), so the KitePassportAdapter reports
// UNSUPPORTED for autonomous execution unless same-key replay has been explicitly verified, never looks a payment up,
// and only drives `kpass` with an argument vector, a broker-only HOME and no inherited environment. The `kpass` binary
// here is a local recorded stand-in script; no network, account or credential is used.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KitePassportAdapter, minorToDecimal } from '../src/adapters/kite-passport.js';
import { UnconfiguredAdapter } from '../src/adapters/port.js';

function fakeKpass(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'm09-kpass-'));
  const bin = join(dir, 'kpass');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify({ args, env: Object.keys(process.env).sort(), home: process.env.HOME }) + '\\n');
${script}
`,
  );
  chmodSync(bin, 0o700);
  const calls = () =>
    readFileSync(join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; env: string[]; home: string });
  return { bin, dir, calls };
}

const scope = {
  tenantId: 'ten_t040-kite',
  executionAuthorityId: 'xau_t040-kite',
  merchantId: 'mer_weather-0001',
  purpose: 'PAID_LOOKUP',
  perActionLimitMinor: 18_500n,
  baseLimitMinor: 20_000n,
  currency: 'USD',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  remainingSeconds: 3_600,
  providerAccountRevisionId: 'par_t040-kite',
};
const intent = {
  tenantId: 'ten_t040-kite',
  commercialIntentId: 'cin_t040-kite',
  actionKind: 'PAID_CONTACT',
  semanticOperation: 'PAID_LOOKUP',
  merchantId: 'mer_weather-0001',
  purpose: 'PAID_LOOKUP',
  amountMinor: 120n,
  currency: 'USD',
  providerAccountRevisionId: 'par_t040-kite',
  providerSessionRef: 'req_authorityA',
};
const op = {
  clientOperationId: 'op_t040-kite-1',
  idempotencyKey: 'cin-op.t040-kite-1',
  requestDigest: `sha256:${'a'.repeat(64)}`,
};

describe('T-040 KitePassportAdapter capability (recorded kpass contract, not Kite)', () => {
  it('without explicit configuration the broker has no paid adapter and performs no I/O', async () => {
    const none = new UnconfiguredAdapter();
    expect(none.assess()).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'NO_PAID_ADAPTER_CONFIGURED' });
    expect((await none.lookup()).kind).toBe('RECONCILIATION_UNSUPPORTED');
    await expect(none.execute()).rejects.toThrow();
  });

  it('is UNSUPPORTED for autonomous execution until same-key replay is verified; it never claims a lookup by client key', async () => {
    const k = fakeKpass(`process.stdout.write('{}');`);
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      merchantEndpoints: { 'mer_weather-0001': { url: 'https://x402.dev.gokite.ai/api/weather', method: 'GET' } },
    });
    expect(adapter.capability).toEqual({ lookupByClientOperation: false, sameKeyReplay: false });
    expect(adapter.assess(intent)).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'KITE_NO_VERIFIED_RECONCILIATION' });
    expect(
      (
        await adapter.lookup({
          clientOperationId: op.clientOperationId,
          idempotencyKey: op.idempotencyKey,
          providerRef: null,
        })
      ).kind,
    ).toBe('RECONCILIATION_UNSUPPORTED');
    expect(
      () =>
        new KitePassportAdapter({
          kpassBinary: k.bin,
          stateRoot: k.dir,
          timeoutMs: 5_000,
          merchantEndpoints: { m: { url: 'http://insecure.example', method: 'GET' } },
        }),
    ).toThrow();
    expect(JSON.stringify(adapter)).not.toContain(k.dir);
  });

  it('creates a bounded separate session via `kpass session create` and confirms it by request id', async () => {
    const k = fakeKpass(`
if (args[0] === 'session' && args[1] === 'create') process.stdout.write(JSON.stringify({ status: 'human_action_required', request_id: 'req_t040abc', approval_url: 'https://agentpassport.ai/approve/x', expires_at: 'z' }));
else if (args[0] === 'session' && args[1] === 'status') process.stdout.write(JSON.stringify({ status: 'success', session_id: 'ses_1', session: { id: 'ses_1', status: 'active' } }));
`);
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      merchantEndpoints: {},
    });
    let handoff = 0;
    const created = await adapter.activateSession(scope, op, { onHandoff: () => handoff++ });
    expect(created).toMatchObject({ kind: 'ACCEPTED', providerRef: 'req_t040abc' });
    expect(handoff).toBe(1);
    const confirmed = await adapter.lookupSession({
      clientOperationId: op.clientOperationId,
      idempotencyKey: op.idempotencyKey,
      providerRef: 'req_t040abc',
    });
    expect(confirmed.kind).toBe('CONFIRMED');
    const [create, status] = k.calls();
    expect(create!.args.slice(0, 2)).toEqual(['session', 'create']);
    expect(create!.args).toContain('--separate');
    const delegation = JSON.parse(create!.args[create!.args.indexOf('--delegation') + 1]!);
    expect(delegation.payment_policy).toMatchObject({
      max_amount_per_tx: '185.00',
      max_total_amount: '200.00',
      currency: 'USD',
    });
    expect(status!.args).toEqual(['session', 'status', '--request-id', 'req_t040abc', '--output', 'json']);
    // The CLI sees only PATH, its broker-only HOME and a no-colour flag: nothing inherited from the broker.
    for (const c of k.calls()) {
      expect(c.home).toBe(k.dir);
      expect(
        c.env.filter(
          (e) => !['PATH', 'HOME', 'KPASS_NO_COLOR', '__CF_USER_TEXT_ENCODING', 'PWD', 'SHLVL', '_'].includes(e),
        ),
      ).toEqual([]);
    }
    // Without a request id there is no lookup: the session effect stays for manual resolution.
    expect(
      (
        await adapter.lookupSession({
          clientOperationId: op.clientOperationId,
          idempotencyKey: op.idempotencyKey,
          providerRef: null,
        })
      ).kind,
    ).toBe('RECONCILIATION_UNSUPPORTED');
    expect(minorToDecimal(5n)).toBe('0.05');
  });

  it('with verified same-key replay, executes with the pre-egress idempotency key; a pending outcome stays UNKNOWN', async () => {
    const k = fakeKpass(`
if (args[1] === 'status') { process.stdout.write(JSON.stringify({ status: 'success', session: { id: 'ses_A', status: 'active' } })); process.exit(0); }
const key = args[args.indexOf('--idempotency-key') + 1];
if (key.endsWith('pending')) { process.stdout.write(JSON.stringify({ status: 'pending', error: { code: 'payment_outcome_pending', retriable: true } })); process.exit(7); }
process.stdout.write(JSON.stringify({ status: 'success', x402: { status_code: 200 }, payment_requirement: { asset: 'USDC', amount: '120' } }));
`);
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      sameKeyReplayVerified: true,
      merchantEndpoints: { 'mer_weather-0001': { url: 'https://x402.dev.gokite.ai/api/weather', method: 'GET' } },
    });
    expect(adapter.assess(intent)).toEqual({ kind: 'ELIGIBLE' });
    expect(adapter.assess({ ...intent, merchantId: 'mer_unlisted-0001' })).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'MERCHANT_ENDPOINT_NOT_ALLOWLISTED',
    });
    const prepared = adapter.prepare(intent);
    const ok = await adapter.execute(prepared, op, { onHandoff: () => {} });
    expect(ok).toMatchObject({ kind: 'CONFIRMED', capturedMinor: 120n });
    const pending = await adapter.execute(
      prepared,
      { ...op, idempotencyKey: 'cin-op.t040-pending' },
      { onHandoff: () => {} },
    );
    expect(pending).toMatchObject({ kind: 'UNKNOWN', reasonCode: 'KITE_PAYMENT_OUTCOME_PENDING' });
    const call = k.calls().find((c) => c.args[1] === 'execute')!;
    expect(call.args.slice(0, 2)).toEqual(['session', 'execute']);
    expect(call.args[call.args.indexOf('--idempotency-key') + 1]).toBe(op.idempotencyKey);
    expect(call.args[call.args.indexOf('--url') + 1]).toBe('https://x402.dev.gokite.ai/api/weather');
  });

  it('finding 2: execution selects the authority’s own confirmed session with --session-id; another session is never used', async () => {
    const k = fakeKpass(`
if (args[0] === 'session' && args[1] === 'status') {
  const req = args[args.indexOf('--request-id') + 1];
  const map = { req_authorityA: ['ses_A', 'active'], req_authorityB: ['ses_B', 'active'], req_inactive: ['ses_C', 'expired'] };
  const [id, status] = map[req] ?? [null, 'unknown'];
  process.stdout.write(JSON.stringify({ status: 'success', session_id: id, session: { id, status } }));
} else process.stdout.write(JSON.stringify({ status: 'success', x402: { status_code: 200 }, payment_requirement: { amount: '120' } }));
`);
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      sameKeyReplayVerified: true,
      merchantEndpoints: { 'mer_weather-0001': { url: 'https://x402.dev.gokite.ai/api/weather', method: 'GET' } },
    });
    expect(adapter.assess({ ...intent, providerSessionRef: null })).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'KITE_SESSION_NOT_BOUND',
    });
    const prepared = adapter.prepare(intent);
    expect((await adapter.execute(prepared, op, { onHandoff: () => {} })).kind).toBe('CONFIRMED');
    const exec = k.calls().find((c) => c.args[1] === 'execute')!;
    expect(exec.args[exec.args.indexOf('--session-id') + 1]).toBe('ses_A');
    expect(k.calls().some((c) => c.args.includes('ses_B') || c.args.includes('req_authorityB'))).toBe(false);
    // A bound session that is no longer active refuses before any payment command (definite no effect).
    let handed = 0;
    const refused = await adapter.execute(
      adapter.prepare({ ...intent, providerSessionRef: 'req_inactive' }),
      { ...op, idempotencyKey: 'cin-op.t040-inactive' },
      { onHandoff: () => handed++ },
    );
    expect(refused).toMatchObject({ kind: 'FAILED', reasonCode: 'KITE_BOUND_SESSION_NOT_ACTIVE' });
    expect(handed).toBe(0);
    expect(k.calls().filter((c) => c.args[1] === 'execute')).toHaveLength(1);
  });

  it('finding 3: refuses a session whose remaining authority lifetime is below the minimum and never exceeds it', async () => {
    const k = fakeKpass(
      `process.stdout.write(JSON.stringify({ status: 'human_action_required', request_id: 'req_ttl' }));`,
    );
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      merchantEndpoints: {},
    });
    expect(adapter.assessSession({ ...scope, remainingSeconds: 59 })).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'AUTHORITY_LIFETIME_TOO_SHORT',
    });
    expect(adapter.assessSession({ ...scope, remainingSeconds: 120 })).toEqual({ kind: 'ELIGIBLE' });
    await adapter.activateSession(
      { ...scope, remainingSeconds: 120, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      op,
      { onHandoff: () => {} },
    );
    const create = k.calls().at(-1)!;
    const ttl = JSON.parse(create.args[create.args.indexOf('--delegation') + 1]!).payment_policy.ttl_seconds;
    expect(ttl).toBeLessThanOrEqual(120);
    expect(ttl).toBe(120);
  });

  it('a local kpass refusal is marked not-sent (never authoritative no-effect for an earlier send)', async () => {
    const k = fakeKpass(`
if (args[1] === 'status') { process.stdout.write(JSON.stringify({ session: { id: 'ses_A', status: 'active' } })); process.exit(0); }
process.stdout.write(JSON.stringify({ status: 'error', error: { code: 'local_protocol_refusal' } })); process.exit(8);
`);
    const adapter = new KitePassportAdapter({
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      sameKeyReplayVerified: true,
      merchantEndpoints: { 'mer_weather-0001': { url: 'https://x402.dev.gokite.ai/api/weather', method: 'GET' } },
    });
    const out = await adapter.execute(adapter.prepare(intent), op, { onHandoff: () => {} });
    expect(out).toMatchObject({ kind: 'FAILED', reasonCode: 'KPASS_LOCAL_REFUSAL', notSent: true });
  });
});
