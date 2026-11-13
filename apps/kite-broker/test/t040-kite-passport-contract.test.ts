// T-040 KitePassportAdapter against the kpass 6.13.2 contract, driven by DOCUMENTED-EXAMPLE kpass JSON shapes
// (test/fixtures/kpass-6.13.2-documented.ts: Kite's installed skill docs, read 2026-11-13; never real responses). The
// `kpass` binary is a local stand-in script; no network, account, credential or payment is used.
// Proven: the exact argv of session create / status / execute; GET query parameters travel in the bound URL and no body
// or internal identifier reaches the merchant; the approved session's id, expiry and caps are re-read before any paid
// command; every documented outcome maps to CONFIRMED / ACCEPTED / FAILED (only where Kite documents that nothing moved)
// / UNKNOWN; payment amounts are decimal USD converted to minor units exactly; a payment from any other session or the
// account allowance is never CONFIRMED; hard caps of 1 cent per call and 5 cents per session hold whatever the config
// says; the approval URL never reaches an outcome; argv values cannot be read as flags; execution without autonomous
// reconciliation is permitted only with explicit attended manual reconciliation.
import { describe, expect, it } from 'vitest';
import {
  KITE_HARD_CAPS,
  KitePassportAdapter,
  decimalUsdToMinor,
  type KitePassportConfig,
  type KpassExecuteRecord,
} from '../src/adapters/kite-passport.js';
import { KPASS, executeSuccessWithReference } from './fixtures/kpass-6.13.2-documented.js';
import { fakeKpass, type FakeKpass } from './support/fake-kpass.js';

const URL_Q = 'https://lionx402.com/api/x402/poi-business-search-json?q=refrigeration%20repair';
const MERCHANT = 'mer_lionx402-com';
const future = () => new Date(Date.now() + 3_600_000).toISOString();

const scope = (over: Record<string, unknown> = {}) => ({
  tenantId: 'ten_t040-contract',
  executionAuthorityId: 'xau_t040-contract',
  merchantId: MERCHANT,
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  perActionLimitMinor: 1n,
  baseLimitMinor: 1n,
  currency: 'USD',
  expiresAt: future(),
  remainingSeconds: 3_540,
  providerAccountRevisionId: 'par_t040-contract',
  ...over,
});
const intent = (over: Record<string, unknown> = {}) => ({
  tenantId: 'ten_t040-contract',
  commercialIntentId: 'cin_t040-contract',
  actionKind: 'PAID_CONTACT',
  semanticOperation: 'PAID_CONTACT',
  merchantId: MERCHANT,
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  amountMinor: 1n,
  currency: 'USD',
  providerAccountRevisionId: 'par_t040-contract',
  providerSessionRef: 'req_abc123',
  ...over,
});
const op = { clientOperationId: 'op_t040-contract-1', idempotencyKey: 'cin-op.t040-contract-1', requestDigest: 'x' };
const noHooks = { onHandoff: () => {} };

/** The documented approved session, re-dated to the future with caps inside the hard caps. */
const approved = (over: Record<string, unknown> = {}) => {
  const j = structuredClone(KPASS.sessionStatusApproved.json) as Record<string, any>;
  j.session.expires_at = future();
  j.session.delegation.payment_policy = { max_amount_per_tx: '0.01', max_total_amount: '0.01', currency: 'USD' };
  Object.assign(j.session, over);
  return { exitCode: 0, json: j };
};
const paid = (amount = '0.01', sessionId = 'session_xyz789') => ({
  exitCode: 0,
  json: executeSuccessWithReference({ amount, sessionId, body: '{"count":1,"results":[{"name":"Cold Fix Ltd"}]}' }),
});

function make(k: FakeKpass, over: Partial<KitePassportConfig> = {}, records: KpassExecuteRecord[] = []) {
  const approvals: { requestId: string; approvalUrl: string; expiresAt: string | null }[] = [];
  const adapter = new KitePassportAdapter(
    {
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      merchantEndpoints: { [MERCHANT]: { url: URL_Q, method: 'GET' } },
      manualReconciliationAccepted: true,
      ...over,
    },
    { onApprovalRequired: (a) => approvals.push(a), onExecuted: (r) => records.push(r) },
  );
  return { adapter, approvals, records };
}

describe('T-040 kpass 6.13.2 session create (documented-example fixtures, not Kite)', () => {
  it('requests a separate, never-reused, browser-less passkey session whose delegation matches the authority', async () => {
    const k = fakeKpass();
    k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
    const { adapter, approvals } = make(k);
    let handoff = 0;
    const out = await adapter.activateSession(scope(), op, { onHandoff: () => handoff++ });
    expect(out).toMatchObject({
      kind: 'ACCEPTED',
      providerRef: 'req_abc123',
      rawProviderStatus: 'human_action_required',
    });
    expect(handoff).toBe(1);
    const [c] = k.callsOf('session create');
    const d = c!.args.indexOf('--delegation');
    expect([...c!.args.slice(0, d), ...c!.args.slice(d + 2)]).toEqual([
      'session',
      'create',
      '--separate',
      '--no-reuse',
      '--no-browser',
      '--no-interactive',
      '--output',
      'json',
    ]);
    const delegation = JSON.parse(c!.args[d + 1]!);
    expect(Object.keys(delegation).sort()).toEqual([
      'execution_constraints',
      'payment_policy',
      'routing_enabled',
      'task',
    ]);
    expect(delegation.payment_policy).toEqual({
      max_amount_per_tx: '0.01',
      max_total_amount: '0.01',
      ttl_seconds: 3_540,
      currency: 'USD',
    });
    expect(delegation.routing_enabled).toBe(false);
    expect(delegation.execution_constraints).toEqual({
      x402: {
        scope_mode: 'scoped',
        allowed_endpoints: [{ method: 'GET', host: 'lionx402.com', path_prefix: '/api/x402/poi-business-search-json' }],
      },
    });
    expect(delegation.task.summary.length).toBeLessThanOrEqual(80);
    expect(delegation.task.summary).toContain('lionx402.com');
    expect(delegation.task.summary).not.toMatch(/xau_|ten_|par_/);
    // The approval URL reaches only the operator callback, never the normalized outcome.
    expect(approvals).toEqual([
      {
        requestId: 'req_abc123',
        approvalUrl: KPASS.sessionCreateRequested.json.approval_url,
        expiresAt: '2026-10-23T12:10:00Z',
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('documented-placeholder-token');
    // cwd and HOME are the broker-only state root; the environment is minimal and fixed.
    expect(c!.home).toBe(k.dir);
    expect(c!.cwd).toBe(k.dir);
    const allowed = new Set([
      'PATH',
      'HOME',
      'KPASS_NO_COLOR',
      'KPASS_NO_UPDATE_CHECK',
      'KPASS_AUTO_UPGRADE',
      'KPASS_NO_BROWSER',
      '__CF_USER_TEXT_ENCODING',
      'PWD',
      'SHLVL',
      '_',
    ]);
    expect(c!.env.filter((e) => !allowed.has(e))).toEqual([]);
  });

  it('a reuse_available answer created no request: the session stays unresolved for manual resolution', async () => {
    const k = fakeKpass();
    k.script('session create', { exitCode: 0, json: KPASS.sessionCreateReuseAvailable.json });
    const { adapter } = make(k);
    expect((await adapter.activateSession(scope(), op, noHooks)).kind).toBe('UNKNOWN');
  });

  it('hard caps: 1 cent per call and 5 cents per session, whatever the authority or config says (nothing spawned)', async () => {
    expect(KITE_HARD_CAPS).toEqual({ perCallMinor: 1n, sessionTotalMinor: 5n, currency: 'USD' });
    const k = fakeKpass();
    const { adapter } = make(k);
    expect(adapter.assessSession(scope({ perActionLimitMinor: 2n }))).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'KITE_HARD_CAP_EXCEEDED',
    });
    expect(adapter.assessSession(scope({ baseLimitMinor: 6n }))).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'KITE_HARD_CAP_EXCEEDED',
    });
    expect(adapter.assessSession(scope({ merchantId: 'mer_unlisted-0001' }))).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'MERCHANT_ENDPOINT_NOT_ALLOWLISTED',
    });
    expect(adapter.assess(intent({ amountMinor: 2n }))).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'KITE_HARD_CAP_EXCEEDED',
    });
    const refused = await adapter.activateSession(scope({ baseLimitMinor: 6n }), op, noHooks);
    expect(refused).toMatchObject({ kind: 'FAILED', notSent: true });
    const big = await adapter.execute(adapter.prepare(intent({ amountMinor: 2n })), op, noHooks);
    expect(big).toMatchObject({ kind: 'FAILED', reasonCode: 'KITE_HARD_CAP_EXCEEDED', notSent: true });
    expect(k.calls()).toEqual([]);
  });
});

describe('T-040 kpass 6.13.2 session status (documented-example fixtures, not Kite)', () => {
  const lookup = (adapter: KitePassportAdapter, providerRef: string | null = 'req_abc123') =>
    adapter.lookupSession({ clientOperationId: op.clientOperationId, idempotencyKey: op.idempotencyKey, providerRef });

  it('approved -> CONFIRMED, pending -> ACCEPTED, rejected/expired -> FAILED (no session exists), anything else UNKNOWN', async () => {
    const k = fakeKpass();
    k.script(
      'session status',
      approved(),
      { exitCode: 0, json: KPASS.sessionStatusPending.json },
      { exitCode: 3, json: KPASS.sessionStatusRejected.json },
      { exitCode: 3, json: KPASS.sessionStatusExpired.json },
      { exitCode: 3, json: { status: 'error', error: 'Agent not registered' } },
    );
    const { adapter } = make(k);
    expect(await lookup(adapter)).toMatchObject({ kind: 'CONFIRMED', providerRef: 'req_abc123', capturedMinor: 0n });
    expect(await lookup(adapter)).toMatchObject({ kind: 'ACCEPTED', providerRef: 'req_abc123' });
    expect(await lookup(adapter)).toMatchObject({ kind: 'FAILED', reasonCode: 'KITE_SESSION_REJECTED' });
    expect(await lookup(adapter)).toMatchObject({ kind: 'FAILED', reasonCode: 'KITE_SESSION_REQUEST_EXPIRED' });
    expect(await lookup(adapter)).toMatchObject({ kind: 'UNKNOWN' });
    for (const c of k.callsOf('session status'))
      expect(c.args).toEqual([
        'session',
        'status',
        '--request-id',
        'req_abc123',
        '--no-interactive',
        '--output',
        'json',
      ]);
    expect((await lookup(adapter, null)).kind).toBe('RECONCILIATION_UNSUPPORTED');
    expect((await lookup(adapter, '--request-id')).kind).toBe('RECONCILIATION_UNSUPPORTED');
  });
});

describe('T-040 kpass 6.13.2 session execute (documented-example fixtures, not Kite)', () => {
  it('pays exactly the bound GET URL from the authority’s own session; no body, headers, allowance or internal id', async () => {
    const k = fakeKpass();
    k.script('session status', approved());
    k.script('session execute', paid());
    const records: KpassExecuteRecord[] = [];
    const { adapter } = make(k, {}, records);
    expect(adapter.capability).toEqual({ lookupByClientOperation: false, sameKeyReplay: false });
    expect(adapter.assess(intent())).toEqual({ kind: 'ELIGIBLE' });
    let handoff = 0;
    const out = await adapter.execute(adapter.prepare(intent()), op, { onHandoff: () => handoff++ });
    expect(out).toMatchObject({ kind: 'CONFIRMED', capturedMinor: 1n, providerRef: `0x${'ab'.repeat(32)}` });
    expect(handoff).toBe(1);
    const [c] = k.callsOf('session execute');
    expect(c!.args).toEqual([
      'session',
      'execute',
      '--session-id',
      'session_xyz789',
      '--url',
      URL_Q,
      '--method',
      'GET',
      '--idempotency-key',
      op.idempotencyKey,
      '--no-browser',
      '--no-interactive',
      '--output',
      'json',
    ]);
    expect(c!.args.join(' ')).not.toMatch(/--body|--headers|--use-allowance|op_t040|cin_t040/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      statusCode: 200,
      responseBody: '{"count":1,"results":[{"name":"Cold Fix Ltd"}]}',
      paymentReference: `0x${'ab'.repeat(32)}`,
      amount: '0.01',
      asset: 'USDC',
      chainId: 8453,
      spentTotal: '0.01',
      source: null,
      sessionMatched: true,
    });
    expect(JSON.stringify(records[0])).not.toContain('session_xyz789');
  });

  it('the documented success example without a settlement reference still confirms; the reference is then null', async () => {
    const k = fakeKpass();
    k.script('session status', approved());
    const j = structuredClone(KPASS.executeSuccess.json) as Record<string, any>;
    j.payment_requirement.amount = '0.01';
    k.script('session execute', { exitCode: 0, json: j });
    const { adapter } = make(k);
    expect(await adapter.execute(adapter.prepare(intent()), op, noHooks)).toMatchObject({
      kind: 'CONFIRMED',
      providerRef: null,
      capturedMinor: 1n,
    });
  });

  it.each([
    ['another session paid', paid('0.01', 'session_other'), 'KITE_PAID_OUTSIDE_BOUND_SESSION'],
    [
      'the account allowance paid',
      { exitCode: 0, json: KPASS.executeFromAllowance.json },
      'KITE_PAID_OUTSIDE_BOUND_SESSION',
    ],
    ['a sub-cent amount', paid('0.001'), 'KPASS_AMOUNT_NOT_MINOR_UNITS'],
    ['more than the intent', paid('1.00'), 'KITE_CAPTURE_ABOVE_INTENT'],
    [
      'another asset',
      { exitCode: 0, json: { ...paid().json, payment_requirement: { asset: 'PYUSD', amount: '0.01' } } },
      'KITE_UNEXPECTED_ASSET',
    ],
    [
      'another chain',
      { exitCode: 0, json: { ...paid().json, x402: { ...(paid().json.x402 as object), chain_id: 137 } } },
      'KITE_UNEXPECTED_CHAIN',
    ],
    [
      'a non-2xx merchant answer',
      { exitCode: 0, json: { ...paid().json, x402: { ...(paid().json.x402 as object), status_code: 500 } } },
      'KITE_MERCHANT_NON_2XX',
    ],
    [
      'payment_outcome_pending (exit 7)',
      { exitCode: 7, json: KPASS.executePending.json },
      'KITE_PAYMENT_OUTCOME_PENDING',
    ],
    [
      'merchant_failed_held (exit 7)',
      { exitCode: 7, json: KPASS.executeMerchantFailedHeld.json },
      'KITE_MERCHANT_FAILED_HELD',
    ],
    [
      'session_rule_exceeded (exit 6)',
      { exitCode: 6, json: KPASS.executeSessionRuleExceeded.json },
      'KPASS_UNRESOLVED',
    ],
    [
      'payment_settled_unfulfilled (exit 1)',
      { exitCode: 1, json: KPASS.executeSettledUnfulfilled.json },
      'KITE_SETTLED_UNFULFILLED',
    ],
    [
      'a documented no-effect code on the wrong exit',
      { exitCode: 1, json: KPASS.executeWalletEmpty.json },
      'KPASS_UNRESOLVED',
    ],
    ['an undocumented exit code', { exitCode: 8, json: { status: 'error' } }, 'KPASS_UNRESOLVED'],
    ['unreadable output', { exitCode: 0, raw: 'not json' }, 'KPASS_NO_RESULT'],
  ])('%s is UNKNOWN (%s), never CONFIRMED or FAILED', async (_name, answer, reason) => {
    const k = fakeKpass();
    k.script('session status', approved());
    k.script('session execute', answer as never);
    const { adapter } = make(k);
    expect(await adapter.execute(adapter.prepare(intent()), op, noHooks)).toMatchObject({
      kind: 'UNKNOWN',
      reasonCode: reason,
    });
  });

  it.each([
    ['wallet_empty (exit 6)', KPASS.executeWalletEmpty],
    ['idempotency_key_required (exit 2)', KPASS.executeIdempotencyKeyRequired],
    ['no_payment_requirement (exit 2)', KPASS.executeNoPaymentRequirement],
  ])('%s is a documented pre-spend refusal: FAILED for this invocation only (notSent)', async (_n, ex) => {
    const k = fakeKpass();
    k.script('session status', approved());
    k.script('session execute', { exitCode: ex.exitCode, json: ex.json });
    const { adapter } = make(k);
    expect(await adapter.execute(adapter.prepare(intent()), op, noHooks)).toMatchObject({
      kind: 'FAILED',
      reasonCode: 'KITE_PRE_SPEND_REFUSAL',
      effect: 'NO_EFFECT_PROVED',
      notSent: true,
    });
  });

  it('a timed-out execute is UNKNOWN', async () => {
    const k = fakeKpass();
    k.script('session status', approved());
    k.script('session execute', { ...paid(), sleepMs: 4_000 });
    const { adapter } = make(k, { timeoutMs: 1_000 });
    expect(await adapter.execute(adapter.prepare(intent()), op, noHooks)).toMatchObject({
      kind: 'UNKNOWN',
      reasonCode: 'KPASS_NO_RESULT',
    });
  });

  it.each([
    ['not active', approved({ status: 'expired' }), 'KITE_BOUND_SESSION_NOT_ACTIVE'],
    [
      'past its expiry',
      approved({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      'KITE_BOUND_SESSION_EXPIRED',
    ],
    ['without an expiry', approved({ expires_at: undefined }), 'KITE_BOUND_SESSION_EXPIRED'],
    [
      'with caps above the hard caps',
      approved({ delegation: { payment_policy: { max_amount_per_tx: '0.02', max_total_amount: '0.05' } } }),
      'KITE_BOUND_SESSION_CAPS_EXCEED',
    ],
    ['without caps', approved({ delegation: {} }), 'KITE_BOUND_SESSION_CAPS_EXCEED'],
    ['with a flag-like id', approved({ id: '--use-allowance' }), 'KITE_BOUND_SESSION_UNRESOLVED'],
  ])('a bound session %s refuses before any paid command (nothing sent)', async (_n, status, reason) => {
    const k = fakeKpass();
    k.script('session status', status as never);
    const { adapter } = make(k);
    let handoff = 0;
    const out = await adapter.execute(adapter.prepare(intent()), op, { onHandoff: () => handoff++ });
    expect(out).toMatchObject({ kind: 'FAILED', reasonCode: reason, notSent: true });
    expect(handoff).toBe(0);
    expect(k.callsOf('session execute')).toEqual([]);
  });

  it('an idempotency key that could be read as a flag is refused before kpass runs', async () => {
    const k = fakeKpass();
    const { adapter } = make(k);
    const out = await adapter.execute(adapter.prepare(intent()), { ...op, idempotencyKey: '--use-allowance' }, noHooks);
    expect(out).toMatchObject({ kind: 'FAILED', notSent: true });
    expect(k.calls()).toEqual([]);
  });
});

describe('T-040 KITE_PASSPORT configuration, capability and conversions', () => {
  it('refuses merchant endpoints that are not plain public https URLs, and GET endpoints with a body', () => {
    const k = fakeKpass();
    const bad = [
      'http://lionx402.com/x',
      'https://user:pw@lionx402.com/x',
      'https://lionx402.com/x#frag',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://lionx402.com:8443/x',
    ];
    for (const url of bad)
      expect(
        () =>
          new KitePassportAdapter({
            kpassBinary: k.bin,
            stateRoot: k.dir,
            timeoutMs: 5_000,
            merchantEndpoints: { [MERCHANT]: { url, method: 'GET' } },
          }),
        url,
      ).toThrow();
    expect(
      () =>
        new KitePassportAdapter({
          kpassBinary: 'kpass',
          stateRoot: k.dir,
          timeoutMs: 5_000,
          merchantEndpoints: {},
        }),
    ).toThrow();
    expect(
      () =>
        new KitePassportAdapter({
          kpassBinary: k.bin,
          stateRoot: 'relative/dir',
          timeoutMs: 5_000,
          merchantEndpoints: {},
        }),
    ).toThrow();
  });

  it('without verified replay or explicit attended manual reconciliation, paid execution stays UNSUPPORTED', () => {
    const k = fakeKpass();
    const { adapter } = make(k, { manualReconciliationAccepted: false });
    expect(adapter.assess(intent())).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'KITE_NO_VERIFIED_RECONCILIATION' });
    // Attended mode never claims autonomous reconciliation: ambiguity stays UNKNOWN for manual resolution.
    expect(make(k).adapter.capability).toEqual({ lookupByClientOperation: false, sameKeyReplay: false });
  });

  it('decimal USD amounts convert to minor units exactly or not at all', () => {
    expect(decimalUsdToMinor('0.01')).toBe(1n);
    expect(decimalUsdToMinor('0.010000')).toBe(1n);
    expect(decimalUsdToMinor('1.00')).toBe(100n);
    expect(decimalUsdToMinor('5')).toBe(500n);
    for (const v of ['0.001', '0.015', '-0.01', '1e-2', '', ' 0.01', '0x1', '0.01.0', '1234567890123456789'])
      expect(decimalUsdToMinor(v), v).toBeNull();
  });
});

describe('T-040 kpass 6.13.2 read-only readiness (observed shapes, synthetic values)', () => {
  it('reads login, agent, allowance and the Base USDC balance without spending, and never returns an identifier raw', async () => {
    const k = fakeKpass();
    k.script('status', {
      exitCode: 0,
      json: {
        status: 'success',
        agent: { agent_id: 'agent_synthetic-0001', registered: true, type: 'claude' },
        user: { logged_in: true, jwt_valid: true, email: 'someone@example.invalid', user_id: 'user_synthetic' },
        session: { active: false, current_session_id: null },
      },
    });
    k.script('allowance status', { exitCode: 0, json: { status: 'success', set: false, state: 'none' } });
    k.script('wallet balance', {
      exitCode: 0,
      json: {
        status: 'success',
        assets: [
          {
            asset: 'USDC',
            decimals: 6,
            chains: [
              { chain: 'arc', amount: '0.000000' },
              { chain: 'base', amount: '0.250000' },
            ],
          },
        ],
      },
    });
    const { adapter } = make(k);
    const r = await adapter.readiness();
    expect(r).toMatchObject({
      loggedIn: true,
      agentRegistered: true,
      allowanceState: 'none',
      allowanceSet: false,
      baseUsdcMicros: 250_000n,
    });
    expect(r.agentIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(
      /agent_synthetic|example\.invalid|user_synthetic/,
    );
    for (const c of k.calls()) expect(c.args.slice(-3)).toEqual(['--no-interactive', '--output', 'json']);
    expect(k.calls().map((c) => c.args.slice(0, -3))).toEqual([
      ['status'],
      ['allowance', 'status'],
      ['wallet', 'balance'],
    ]);
  });
});
