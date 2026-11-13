// T-058 payment, fulfillment and duplicate parts: the Kite payment journey runner (test/support/kite-payment-journey.ts)
// over a throwaway database, the M08/M09 product path and the in-process broker. Nothing here contacts Kite, a merchant
// or the network: the dry run uses the RECORDED_CONTRACT adapter (its evidence is labelled RECORDED_CONTRACT and the
// journey gate refuses it), and the live path is exercised with the real KitePassportAdapter driving a local `kpass`
// stand-in that answers with DOCUMENTED-EXAMPLE shapes (test/fixtures/kpass-6.13.2-documented.ts) in temporary roots.
// Proven: the whole run end to end; hard stops before any egress (price above 1 cent, not USDC on Base, wallet short,
// active account allowance, dirty tree, broker isolation, gate refused) with nothing sent; the passkey wait is bounded;
// an ambiguous paid outcome is UNKNOWN, reserved and never retried (not by the duplicate, not by reconciliation); the
// duplicate request returns the same intent with no second egress; every artifact passes a redaction check or the
// evidence is removed; the database is dropped.
/* eslint-disable @typescript-eslint/no-explicit-any -- documented-example fixtures are mutated structurally */
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { KitePassportAdapter } from '../src/adapters/kite-passport.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { KPASS, executeSuccessWithReference } from './fixtures/kpass-6.13.2-documented.js';
import { fakeKpass, type FakeKpass } from './support/fake-kpass.js';
import {
  LIONX402,
  runKitePaymentJourney,
  type JourneyOptions,
  type JourneyReport,
  type JourneyTaps,
} from './support/kite-payment-journey.js';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..', '..');
const rg = await import(path.join(repoRoot, 'scripts', 'release', 'release-gate.mjs'));
const jg = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const capture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'lionx402-preflight-402.json'), 'utf8'));
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for T-058 journey integration tests');

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const keys = generateKeyPairSync('ed25519');
// A synthetic credential-shaped value, assembled at runtime (never a real token), used only by the redaction checks.
const SYNTHETIC_JWT = ['eyJ', 'synthetic-jwt-value', '-for-redaction-only'].join('');
const SCOPE = {
  merchant: 'lionx402.com',
  amountMinor: 1,
  currency: 'USD',
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  environment: 'kite-passport-prod',
};

/** A temporary artifact root plus a gate root holding a throwaway authorizer and one signed PAYMENT record. */
function roots2(over: Record<string, unknown> = {}) {
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'ub-t058-kpj-'));
  roots.push(artifactRoot);
  cpSync(path.join(repoRoot, 'config'), path.join(artifactRoot, 'config'), { recursive: true });
  writeFileSync(
    path.join(artifactRoot, 'config', 'release', 'authorizers.json'),
    JSON.stringify({
      schema: 'release-authorizers.v1',
      authorizers: { 'owner-k1': keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') },
    }),
  );
  mkdirSync(path.join(artifactRoot, 'evidence', 'authorizations'), { recursive: true });
  const now = Date.now();
  const record = rg.signAuthorization(
    {
      schema: 'release-authorization.v1',
      gate: 'PAYMENT',
      authorizationId: 'auth-payment-test-0001',
      authorizedBy: 'repository-owner',
      authorizedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 2 * 3_600_000).toISOString(),
      statement: 'Throwaway test authorization for one payment of at most 1 minor unit USD.',
      scope: SCOPE,
      ...over,
    },
    keys.privateKey,
    'owner-k1',
  );
  writeFileSync(
    path.join(artifactRoot, 'evidence', 'authorizations', `PAYMENT.${record.authorizationId}.json`),
    JSON.stringify(record),
  );
  return artifactRoot;
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const OSM = JSON.stringify({
  query: 'refrigeration repair',
  count: 2,
  results: [
    {
      name: 'Coldline Refrigeration',
      category: 'craft',
      type: 'hvac',
      lat: 51.5,
      lon: -0.12,
      osm_type: 'node',
      osm_id: 1,
    },
    { name: 'Polar Repairs', category: 'shop', type: 'appliance', lat: 51.6, lon: -0.1, osm_type: 'way', osm_id: 2 },
  ],
});
const approvedStatus = (id = 'session_xyz789') => {
  const j = structuredClone(KPASS.sessionStatusApproved.json) as Record<string, any>;
  j.session_id = id;
  j.session.id = id;
  j.session.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  j.session.delegation.payment_policy = { max_amount_per_tx: '0.01', max_total_amount: '0.01', currency: 'USD' };
  j.session.usage = { spent_total: '0.01', reserved_total: '0.00' };
  return { exitCode: 0, json: j };
};
const readinessOk = (k: FakeKpass, over: { base?: string; allowance?: Record<string, unknown> } = {}) => {
  k.script('status', {
    exitCode: 0,
    json: {
      status: 'success',
      agent: { agent_id: 'agent_synthetic-0001', registered: true, type: 'claude' },
      user: { logged_in: true, jwt_valid: true },
    },
  });
  k.script('allowance status', {
    exitCode: 0,
    json: { status: 'success', set: false, state: 'none', ...over.allowance },
  });
  k.script('wallet balance', {
    exitCode: 0,
    json: {
      status: 'success',
      assets: [{ asset: 'USDC', decimals: 6, chains: [{ chain: 'base', amount: over.base ?? '0.050000' }] }],
    },
  });
};

interface Case {
  opts: JourneyOptions;
  k: FakeKpass | null;
  recorded: RecordedContractAdapter | null;
  artifactRoot: string;
  databases: () => Promise<string[]>;
}

function liveCase(
  journeyId: string,
  script: (k: FakeKpass) => void,
  over: Partial<JourneyOptions> = {},
  artifactRoot = roots2(),
): Case {
  const k = fakeKpass();
  readinessOk(k);
  script(k);
  const taps: JourneyTaps = { approvals: [], executions: [] };
  const adapter = new KitePassportAdapter(
    {
      kpassBinary: k.bin,
      stateRoot: k.dir,
      timeoutMs: 5_000,
      merchantEndpoints: { [LIONX402.merchantId]: { url: LIONX402.url, method: 'GET' } },
      manualReconciliationAccepted: true,
    },
    { onApprovalRequired: (a) => taps.approvals.push(a), onExecuted: (r) => taps.executions.push(r) },
  );
  return build(journeyId, 'LIVE', adapter, taps, artifactRoot, k, null, {
    readiness: () => adapter.readiness(),
    sessionUsage: (ref) => adapter.sessionUsage(ref),
    ...over,
  });
}

function build(
  journeyId: string,
  mode: 'LIVE' | 'DRY_RUN',
  adapter: JourneyOptions['adapter'],
  taps: JourneyTaps,
  artifactRoot: string,
  k: FakeKpass | null,
  recorded: RecordedContractAdapter | null,
  over: Partial<JourneyOptions>,
): Case {
  const prefix = `t058kpj${journeyId.replace(/[^a-z0-9]/g, '').slice(-12)}`;
  const opts: JourneyOptions = {
    mode,
    journeyId,
    artifactRoot,
    gateRoot: artifactRoot,
    gateEvidenceDir: path.join(artifactRoot, 'docs', 'release', 'evidence'),
    authorizationId: 'auth-payment-test-0001',
    environment: 'kite-passport-prod',
    adapter,
    taps,
    databaseLabel: prefix,
    readiness: async () => ({
      loggedIn: true,
      agentRegistered: true,
      agentIdSha256: 'a'.repeat(64),
      allowanceSet: false,
      allowanceState: 'none',
      baseUsdcMicros: 1_000_000n,
    }),
    preflight: async () => capture.response,
    trackedTreeClean: () => true,
    sourceSha: () => 'a'.repeat(40),
    isolation: () => ({ configFilePrivate: true, stateRootPrivate: true, outsideRepository: true }),
    checkGate: async ({ requestFile, preflightFile }, authorizationId) =>
      rg.checkAndRecord(artifactRoot, 'PAYMENT', readJson(requestFile), {
        preflight: readJson(preflightFile),
        now: new Date(),
        authorizationId,
      }),
    // Completed-payment evidence: only the consumed decision recorded for this journey (PR #21 review 10).
    isAuthorized: (g, id, request, ctx) => jg.evidenceAuthorizer(artifactRoot, () => new Date())(g, id, request, ctx),
    onApprovalRequired: async () => {},
    approval: { timeoutMs: 20_000, pollMs: 200 },
    secrets: () => [{ name: 'KPASS_JWT', value: SYNTHETIC_JWT }],
    log: () => {},
    killSwitchInstalled: true,
    ...over,
  };
  return {
    opts,
    k,
    recorded,
    artifactRoot,
    databases: async () => {
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      try {
        return (
          await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`ub\\_${prefix}\\_%`])
        ).rows.map((r) => r.datname as string);
      } finally {
        await admin.end();
      }
    },
  };
}

const evidenceDir = (c: Case) => path.join(c.artifactRoot, 'evidence', 'journeys', c.opts.journeyId);
const egressOf = (r: JourneyReport) => r.egress;

describe('T-058 Kite payment journey: dry run over the RECORDED_CONTRACT adapter', () => {
  it('runs end to end, labels everything RECORDED_CONTRACT, returns the same intent for the duplicate and drops the database', async () => {
    const recorded = new RecordedContractAdapter();
    recorded.sessionModes = ['PENDING'];
    const taps: JourneyTaps = { approvals: [], executions: [] };
    const artifactRoot = roots2();
    let approvalPrompts = 0;
    const c = build('dryrun-t058-kpj-1', 'DRY_RUN', recorded, taps, artifactRoot, null, recorded, {
      // The dry run's "user approval" is a labelled simulation: the recorded session is activated.
      onApprovalRequired: async () => {
        approvalPrompts++;
        for (const key of recorded.sessions.keys()) recorded.activate(key);
      },
    });
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({
      outcome: 'COMPLETED',
      mode: 'DRY_RUN',
      resultOrigin: 'RECORDED_CONTRACT',
      paymentState: 'CONFIRMED',
      capturedMinor: 1n,
      duplicate: { sameIntentReturned: true, secondEgress: false },
    });
    expect(approvalPrompts).toBe(1);
    expect(egressOf(r)).toMatchObject({ sessionCreate: 1, execute: 1 });
    expect(recorded.executeCalls).toBe(1);
    const dir = evidenceDir(c);
    for (const f of [
      'preflight-402.json',
      'gate-request.json',
      'gate-preflight.json',
      'gate-decision.json',
      'payment.json',
      'merchant-response.json',
      'duplicate.json',
      'redaction-check.json',
      'manifest.journey.json',
    ])
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    const manifest = readJson(path.join(dir, 'manifest.journey.json'));
    for (const p of Object.values(manifest.parts) as { origin: string }[]) expect(p.origin).toBe('RECORDED_CONTRACT');
    expect(manifest.notRecorded).toEqual(['sensor', 'document', 'reasoning', 'recovery', 'timeout']);
    expect(manifest.context.timeout).toMatch(/NOT_RUN/);
    expect(r.gate!.fileOnly.parts).toMatchObject({
      payment: 'FAIL',
      fulfillment: 'FAIL',
      duplicate: 'FAIL',
      timeout: 'NOT_RUN',
    });
    expect(r.gate!.withDatabase.parts.payment).toBe('FAIL');
    expect(readJson(path.join(dir, 'redaction-check.json')).result).toBe('PASS');
    // PR #21 review 5: the evidence directory is 0700 and every artifact 0600 (written private before any check).
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(path.join(dir, f)).mode & 0o777, f).toBe(0o600);
    const req = readJson(path.join(dir, 'gate-request.json'));
    expect(req).toEqual({ ...SCOPE, journeyId: 'dryrun-t058-kpj-1' });
    expect(readJson(path.join(dir, 'gate-decision.json')).decision).toBe('AUTHORIZED');
    expect(await c.databases()).toEqual([]);
  });
});

describe('T-058 Kite payment journey: live path against a documented-example kpass stand-in', () => {
  it('pays once from the authority’s own session, gives no second egress for the duplicate, reconciles from Kite’s answer', async () => {
    const c = liveCase('j-t058-kpj-live-ok', (k) => {
      k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
      k.script('session status', { exitCode: 0, json: KPASS.sessionStatusPending.json }, approvedStatus());
      k.script('session execute', {
        exitCode: 0,
        json: executeSuccessWithReference({ amount: '0.01', sessionId: 'session_xyz789', body: OSM }),
      });
    });
    const printed: (string | null)[] = [];
    c.opts.onApprovalRequired = (a) => void printed.push(a.approvalUrl);
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({
      outcome: 'COMPLETED',
      resultOrigin: 'KITE_PASSPORT',
      paymentState: 'CONFIRMED',
      capturedMinor: 1n,
      reconciled: true,
      duplicate: { sameIntentReturned: true, secondEgress: false, sameKeyReplayVerified: false },
    });
    expect(printed).toEqual([KPASS.sessionCreateRequested.json.approval_url]);
    expect(c.k!.callsOf('session create')).toHaveLength(1);
    expect(c.k!.callsOf('session execute')).toHaveLength(1);
    const dir = evidenceDir(c);
    const payment = readJson(path.join(dir, 'payment.json'));
    expect(payment).toMatchObject({
      origin: 'KITE_PASSPORT',
      state: 'CONFIRMED',
      amountMinor: '1',
      capMinor: '1',
      currency: 'USD',
      settlement: { asset: 'USDC', amount: '0.01', chainId: 8453, reference: `0x${'ab'.repeat(32)}` },
      kiteSessionUsage: { spentTotal: '0.01' },
    });
    const merchant = readJson(path.join(dir, 'merchant-response.json'));
    expect(merchant).toMatchObject({ origin: 'PROVIDER_LIVE', statusCode: 200, resultCount: 2 });
    expect(merchant.responseSha256).toBe(createHash('sha256').update(OSM).digest('hex'));
    // No approval URL, session id or request id is ever recorded.
    const all = [
      'payment.json',
      'merchant-response.json',
      'duplicate.json',
      'manifest.journey.json',
      'gate-request.json',
    ]
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(/documented-placeholder-token|session_xyz789|req_abc123|approval_url/);
    expect(r.gate!.fileOnly.parts).toMatchObject({
      payment: 'PASS',
      fulfillment: 'PASS',
      duplicate: 'PASS',
      timeout: 'NOT_RUN',
    });
    expect(r.gate!.withDatabase.parts).toMatchObject({ payment: 'PASS', fulfillment: 'PASS', duplicate: 'PASS' });
    expect(await c.databases()).toEqual([]);
  });

  it('an ambiguous paid outcome is UNKNOWN, stays reserved and is never retried by the duplicate or reconciliation', async () => {
    const c = liveCase('j-t058-kpj-live-unknown', (k) => {
      k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
      k.script('session status', approvedStatus());
      k.script('session execute', { exitCode: 7, json: KPASS.executePending.json });
    });
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'UNKNOWN', paymentState: 'UNKNOWN', reconciled: false });
    expect(r.duplicate).toMatchObject({ sameIntentReturned: true, secondEgress: false });
    expect(c.k!.callsOf('session execute')).toHaveLength(1);
    expect(r.attempt).toMatchObject({ adapterCapability: 'UNSUPPORTED', externalOutcomeState: 'UNKNOWN' });
    expect(r.gate!.fileOnly.parts.payment).toBe('UNKNOWN');
    // The database is kept for manual resolution and named in the report; the test drops it.
    expect(r.databaseKept).toBeTruthy();
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${r.databaseKept}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('a gate refusal stops the run with nothing sent and the database dropped', async () => {
    const c = liveCase(
      'j-t058-kpj-live-refused',
      () => {},
      {},
      roots2({ scope: { ...SCOPE, merchant: 'other.example' } }),
    );
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'REFUSED', stoppedAt: 'GATE' });
    expect(r.reason).toMatch(/SCOPE_MISMATCH:merchant/);
    expect(c.k!.callsOf('session create')).toEqual([]);
    expect(c.k!.callsOf('session execute')).toEqual([]);
    expect(await c.databases()).toEqual([]);
  });

  it('a passkey approval that never comes stops after the bounded wait; nothing is paid', async () => {
    const c = liveCase(
      'j-t058-kpj-live-timeout',
      (k) => {
        k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
        k.script('session status', { exitCode: 0, json: KPASS.sessionStatusPending.json });
      },
      { approval: { timeoutMs: 1_500, pollMs: 300 } },
    );
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'REFUSED', stoppedAt: 'SESSION_APPROVAL', reason: 'SESSION_APPROVAL_TIMEOUT' });
    expect(c.k!.callsOf('session execute')).toEqual([]);
    expect(await c.databases()).toEqual([]);
  });

  it('a secret in any artifact fails the redaction check: the evidence is removed and nothing is recorded', async () => {
    const leaked = SYNTHETIC_JWT;
    const c = liveCase('j-t058-kpj-live-leak', (k) => {
      k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
      k.script('session status', approvedStatus());
      k.script('session execute', {
        exitCode: 0,
        json: executeSuccessWithReference({
          amount: '0.01',
          sessionId: 'session_xyz789',
          body: JSON.stringify({ count: 1, results: [{ name: leaked }] }),
        }),
      });
    });
    await expect(runKitePaymentJourney(c.opts)).rejects.toThrow(/redaction check failed/);
    expect(existsSync(evidenceDir(c))).toBe(false);
    // The payment itself happened in the throwaway world; the kept database is named for inspection.
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      for (const d of await c.databases()) await admin.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
});

describe('T-058 Kite payment journey: hard stops before any egress (no database is created)', () => {
  const body = () => JSON.parse(capture.response.body);
  it.each([
    [
      'the price is above 1 cent',
      {
        preflight: async () => ({
          ...capture.response,
          headers: {},
          body: JSON.stringify({ ...body(), accepts: [{ ...body().accepts[0], amount: '20000' }] }),
        }),
      },
      'PREFLIGHT_PRICE_ABOVE_CAP',
    ],
    [
      'the network is not Base',
      {
        preflight: async () => ({
          ...capture.response,
          headers: {},
          body: JSON.stringify({ ...body(), accepts: [{ ...body().accepts[0], network: 'eip155:137' }] }),
        }),
      },
      'PREFLIGHT_NOT_BASE',
    ],
    [
      'the wallet cannot cover it',
      {
        readiness: async () => ({
          loggedIn: true,
          agentRegistered: true,
          agentIdSha256: 'a'.repeat(64),
          allowanceSet: false,
          allowanceState: 'none',
          baseUsdcMicros: 9_999n,
        }),
      },
      'WALLET_CANNOT_COVER',
    ],
    [
      'an account allowance is active',
      {
        readiness: async () => ({
          loggedIn: true,
          agentRegistered: true,
          agentIdSha256: 'a'.repeat(64),
          allowanceSet: true,
          allowanceState: 'active',
          baseUsdcMicros: 1_000_000n,
        }),
      },
      'ACCOUNT_ALLOWANCE_ACTIVE',
    ],
    [
      'kpass is not logged in',
      {
        readiness: async () => ({
          loggedIn: false,
          agentRegistered: false,
          agentIdSha256: null,
          allowanceSet: false,
          allowanceState: 'none',
          baseUsdcMicros: 0n,
        }),
      },
      'KPASS_NOT_LOGGED_IN',
    ],
    ['the tracked tree is dirty', { trackedTreeClean: () => false }, 'TREE_NOT_CLEAN'],
    [
      'the broker config is not private',
      { isolation: () => ({ configFilePrivate: false, stateRootPrivate: true, outsideRepository: true }) },
      'BROKER_ISOLATION',
    ],
  ])('refuses when %s', async (_n, over, reason) => {
    const c = liveCase(
      `j-t058-kpj-stop-${reason.toLowerCase().replace(/_/g, '-').slice(0, 30)}`,
      () => {},
      over as never,
    );
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'REFUSED', reason });
    expect(c.k!.callsOf('session create')).toEqual([]);
    expect(c.k!.callsOf('session execute')).toEqual([]);
    expect(existsSync(evidenceDir(c))).toBe(false);
    expect(await c.databases()).toEqual([]);
  });

  it('refuses a dry run whose journey id does not start with dryrun- and a live run over an existing evidence directory', async () => {
    const recorded = new RecordedContractAdapter();
    const c = build('j-not-dry', 'DRY_RUN', recorded, { approvals: [], executions: [] }, roots2(), null, recorded, {});
    expect(await runKitePaymentJourney(c.opts)).toMatchObject({ outcome: 'REFUSED', reason: 'DRY_RUN_ID' });
    const l = liveCase('j-t058-kpj-exists', () => {});
    mkdirSync(evidenceDir(l), { recursive: true });
    expect(await runKitePaymentJourney(l.opts)).toMatchObject({ outcome: 'REFUSED', reason: 'EVIDENCE_EXISTS' });
    expect(recorded.executeCalls).toBe(0);
  });
});

const dropDatabase = async (name: string | null | undefined) => {
  if (!name) return;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
};

describe('T-058 PR #21 review 4, 6 and 7: interrupts, unreconciled payments and an ambiguous session request', () => {
  it('review 4: a Ctrl-C before the gate (preflight or world build) revokes the authority and nothing is sent', async () => {
    const c = liveCase('j-t058-kpj-int-early', () => {}, { interrupted: () => true });
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({
      outcome: 'REFUSED',
      stoppedAt: 'INTERRUPT',
      reason: 'OPERATOR_INTERRUPT',
      authorityStatus: 'REVOKED',
    });
    expect(c.k!.callsOf('session create')).toEqual([]);
    expect(c.k!.callsOf('session execute')).toEqual([]);
    expect(await c.databases()).toEqual([]);
  });

  it('review 4: a Ctrl-C during the passkey wait revokes the authority and the paid call never happens', async () => {
    let interrupted = false;
    const c = liveCase(
      'j-t058-kpj-int-wait',
      (k) => {
        k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
        k.script('session status', approvedStatus());
      },
      { interrupted: () => interrupted, onApprovalRequired: () => void (interrupted = true) },
    );
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'REFUSED', stoppedAt: 'INTERRUPT', authorityStatus: 'REVOKED' });
    expect(c.k!.callsOf('session execute')).toEqual([]);
    await dropDatabase(r.databaseKept);
  });

  it('review 6: a confirmed intent whose Kite session usage does not reconcile is UNKNOWN and the database is kept', async () => {
    const c = liveCase(
      'j-t058-kpj-unreconciled',
      (k) => {
        k.script('session create', { exitCode: 0, json: KPASS.sessionCreateRequested.json });
        k.script('session status', approvedStatus());
        k.script('session execute', {
          exitCode: 0,
          json: executeSuccessWithReference({ amount: '0.01', sessionId: 'session_xyz789', body: OSM }),
        });
      },
      { sessionUsage: async () => null },
    );
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'UNKNOWN', paymentState: 'CONFIRMED', reconciled: false });
    expect(r.databaseKept).toBeTruthy();
    expect(r.gate!.fileOnly.parts.payment).toBe('UNKNOWN');
    await dropDatabase(r.databaseKept);
  });

  it('review 7: an ambiguous session create is UNKNOWN: the reconciliation record, evidence and database are kept', async () => {
    const c = liveCase('j-t058-kpj-session-unknown', (k) => {
      k.script('session create', { exitCode: 0, raw: 'not json' });
    });
    const r = await runKitePaymentJourney(c.opts);
    expect(r).toMatchObject({ outcome: 'UNKNOWN', stoppedAt: 'SESSION' });
    expect(r.databaseKept).toBeTruthy();
    expect(c.k!.callsOf('session execute')).toEqual([]);
    const dir = evidenceDir(c);
    const session = readJson(path.join(dir, 'session.json'));
    expect(session).toMatchObject({ externalOutcomeState: 'UNKNOWN' });
    expect(session.clientOperationId).toMatch(/^op_/);
    expect(readJson(path.join(dir, 'redaction-check.json')).result).toBe('PASS');
    await dropDatabase(r.databaseKept);
  });
});
