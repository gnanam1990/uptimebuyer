// T-058 Kite payment journey runner (CLI). The run itself is test/support/kite-payment-journey.ts; this file wires it.
//
// --dry-run: the RECORDED_CONTRACT adapter (no Kite, no merchant, no network), the recorded real unpaid preflight
//   (test/fixtures/lionx402-preflight-402.json), a throwaway authorizer key and gate root in a temporary directory, and
//   a simulated passkey approval. Every artifact is labelled RECORDED_CONTRACT; the journey gate refuses them.
//     DATABASE_URL=postgres://... node --experimental-transform-types --no-warnings \
//       --import ./packages/domain/test/support/ts-register.mjs \
//       apps/kite-broker/test/support/journey-kite-payment.ts --dry-run --journey-id dryrun-kite-payment-1
//
// --live: run ONLY by the operator after the wallet is funded, the authorizer key is registered and the PAYMENT
//   authorization is signed. It reads the KITE_PASSPORT adapter file (default
//   ~/.config/uptimebuyer/kite-broker/broker.json, 0600, outside the repository), sends ONE unpaid preflight GET to the
//   merchant, checks the PAYMENT gate before any Kite command, prints the passkey approval link, waits (bounded) for the
//   approval, makes exactly one paid call, sends the identical request again through the product, reconciles, exports
//   redacted evidence to evidence/journeys/<journeyId>/ and runs the journey gate (file-only and --database).
//     DATABASE_URL=postgres://... node --experimental-transform-types --no-warnings \
//       --import ./packages/domain/test/support/ts-register.mjs \
//       apps/kite-broker/test/support/journey-kite-payment.ts --live --journey-id j-2026-11-13-kite-payment \
//       --authorization <authorizationId> [--broker-config <file>] [--approval-timeout-s 600]
// Ctrl-C during a live run revokes the execution authority (kill switch); nothing further can be paid under it.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { KitePassportAdapter } from '../../src/adapters/kite-passport.js';
import { RecordedContractAdapter } from '../../src/adapters/recorded.js';
import { loadKiteAdapterFile, minimumSendLeaseMs } from '../../src/config.js';
import {
  LIONX402,
  checkStateRoot,
  runKitePaymentJourney,
  type GateReport,
  type JourneyOptions,
  type JourneyTaps,
  type PreflightCapture,
} from './kite-payment-journey.js';

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..', '..');
/* eslint-disable @typescript-eslint/no-explicit-any */
const rg = (await import(path.join(repo, 'scripts', 'release', 'release-gate.mjs'))) as any;
const jg = (await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'))) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const die = (msg: string): never => {
  console.error(`journey refused: ${msg}`);
  process.exit(2);
};
const json = (v: unknown) => `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** One unpaid GET to the merchant: no payment header, no redirects, bounded (5 s connect budget inside 15 s). */
async function unpaidPreflight(): Promise<PreflightCapture> {
  const res = await fetch(LIONX402.url, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  for (const k of ['content-type', 'payment-required']) {
    const v = res.headers.get(k);
    if (v !== null) headers[k] = v;
  }
  return { status: res.status, headers, body: text.slice(0, 64 * 1024) };
}

function gateCheckCli(files: { requestFile: string; preflightFile: string }, authorizationId: string) {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/release/release-gate.mjs',
      'check',
      'PAYMENT',
      '--request',
      files.requestFile,
      '--preflight',
      files.preflightFile,
      '--authorization',
      authorizationId,
    ],
    { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  );
  const out = r.stdout ?? '';
  try {
    const d = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)) as { decision: string; reasons: string[] };
    return { decision: r.status === 0 ? d.decision : 'REFUSED', reasons: d.reasons ?? [] };
  } catch {
    return { decision: 'REFUSED', reasons: ['GATE_OUTPUT_UNREADABLE'] };
  }
}

function journeyGateCli(args: {
  manifestRel: string;
  database?: { url: string; tenantId: string; incidentId: string };
}) {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/release/journey-gate.mjs',
      '--manifest',
      args.manifestRel,
      '--json',
      ...(args.database
        ? ['--database', '--tenant', args.database.tenantId, '--incident', args.database.incidentId]
        : []),
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      // The database URL travels in the environment, never on argv; the child gets nothing else.
      env: { PATH: process.env.PATH ?? '', ...(args.database ? { JOURNEY_DATABASE_URL: args.database.url } : {}) },
    },
  );
  return { code: r.status, report: JSON.parse(r.stdout) as GateReport };
}

/** Values the redaction check must never find in an artifact (compared only, never printed). */
function kpassSecrets(stateRoot: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(path.join(stateRoot, '.kite-passport', f), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const cfg = read('config.json');
  const agent = read('agent.json');
  if (typeof cfg.jwt === 'string') out.push({ name: 'KPASS_JWT', value: cfg.jwt });
  if (typeof agent.agent_token === 'string') out.push({ name: 'KPASS_AGENT_TOKEN', value: agent.agent_token });
  if (typeof cfg.email === 'string') out.push({ name: 'KPASS_ACCOUNT_EMAIL', value: cfg.email });
  if (typeof cfg.user_id === 'string') out.push({ name: 'KPASS_USER_ID', value: cfg.user_id });
  if (typeof agent.agent_id === 'string') out.push({ name: 'KPASS_AGENT_ID', value: agent.agent_id });
  return out;
}

async function main() {
  const live = process.argv.includes('--live');
  const dry = process.argv.includes('--dry-run');
  if (live === dry) die('pass exactly one of --live or --dry-run');
  const journeyId = arg('--journey-id') ?? die('--journey-id is required');
  if (!process.env.DATABASE_URL) die('DATABASE_URL is not set');
  const taps: JourneyTaps = { approvals: [], executions: [] };
  const log = (l: string) => console.error(`[journey ${journeyId}] ${l}`);
  let opts: JourneyOptions;

  if (live) {
    const authorizationId = arg('--authorization') ?? die('--authorization <id> is required');
    const configFile = path.resolve(
      arg('--broker-config') ?? path.join(homedir(), '.config', 'uptimebuyer', 'kite-broker', 'broker.json'),
    );
    if (inside(configFile, repo)) die('the broker config must live outside the repository');
    let cfg;
    try {
      cfg = loadKiteAdapterFile(configFile);
    } catch (e) {
      die(`broker config rejected: ${(e as { reasonCode?: string }).reasonCode ?? 'UNREADABLE'}`);
    }
    cfg = cfg!;
    const ep = cfg.merchantEndpoints[LIONX402.merchantId];
    if (
      !ep ||
      ep.url !== LIONX402.url ||
      ep.method !== LIONX402.method ||
      Object.keys(cfg.merchantEndpoints).length !== 1
    )
      die(`the broker config must allow exactly ${LIONX402.merchantId} -> GET ${LIONX402.url}`);
    if (cfg.baseUrl) die('the broker config must not override the kpass backend');
    if (cfg.sameKeyReplayVerified === true)
      die('same-key replay is not verified by Kite; refusing sameKeyReplayVerified');
    if (cfg.manualReconciliationAccepted !== true) die('the broker config must accept attended manual reconciliation');
    const state = checkStateRoot(cfg.stateRoot, repo);
    const approvalS = Number(arg('--approval-timeout-s') ?? 600);
    if (!Number.isInteger(approvalS) || approvalS < 30 || approvalS > 900) die('--approval-timeout-s must be 30..900');
    const adapter = new KitePassportAdapter(
      {
        kpassBinary: cfg.kpassBinary,
        stateRoot: cfg.stateRoot,
        timeoutMs: cfg.timeoutMs,
        ...(cfg.readTimeoutMs ? { readTimeoutMs: cfg.readTimeoutMs } : {}),
        merchantEndpoints: { ...cfg.merchantEndpoints },
        sameKeyReplayVerified: false,
        manualReconciliationAccepted: true,
      },
      {
        onApprovalRequired: (a) => taps.approvals.push(a),
        onExecuted: (r) => taps.executions.push(r),
      },
    );
    let revoke: (() => Promise<void>) | null = null;
    let interrupted = false;
    process.on('SIGINT', () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      log('interrupt: revoking the execution authority (kill switch); press Ctrl-C again to exit');
      void revoke?.().then(
        () => log('authority REVOKED; nothing further can be paid under it'),
        () => log('revoke failed; the authority still expires on its own'),
      );
    });
    opts = {
      mode: 'LIVE',
      journeyId,
      artifactRoot: repo,
      gateRoot: repo,
      gateEvidenceDir: path.join(repo, 'docs', 'release', 'evidence'),
      authorizationId,
      environment: 'kite-passport-prod',
      adapter,
      taps,
      databaseLabel: 'j058kite',
      readiness: () => adapter.readiness(),
      preflight: unpaidPreflight,
      trackedTreeClean: () => {
        const s = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
        return s.status === 0 && s.stdout.trim() === '';
      },
      sourceSha: () => jg.headSha(repo),
      isolation: () => ({
        configFilePrivate: true,
        stateRootPrivate: state.ok,
        outsideRepository: !inside(configFile, repo),
      }),
      checkGate: async (files, id) => gateCheckCli(files, id),
      // Completed-payment evidence: only the consumed decision recorded for this journey (PR #21 review 10).
      isAuthorized: (g, id, request, window) => jg.evidenceAuthorizer(repo)(g, id, request, window),
      onApprovalRequired: (a) => {
        console.error('');
        console.error('==> Approve the Kite spending session with your passkey:');
        console.error(`    ${a.approvalUrl ?? '(no link returned; run kpass session status with the broker HOME)'}`);
        console.error(`    caps: 0.01 USD per call, 0.01 USD total; link expires ${a.expiresAt ?? 'soon'}`);
        console.error(`    waiting up to ${approvalS} s ...`);
      },
      approval: { timeoutMs: approvalS * 1_000, pollMs: 5_000 },
      secrets: () => kpassSecrets(cfg!.stateRoot),
      log,
      sessionUsage: (ref) => adapter.sessionUsage(ref),
      killSwitchInstalled: true,
      registerKillSwitch: (fn) => {
        revoke = fn;
        // A Ctrl-C that came before the authority existed (preflight, world build) revokes it the moment it exists.
        if (interrupted)
          void fn().then(
            () => log('authority REVOKED (interrupt before it was issued)'),
            () => log('revoke failed; the authority still expires on its own'),
          );
      },
      interrupted: () => interrupted,
      // The lease outlasts the status read plus the paid call (PR #21 review 2), with a minute of margin.
      sendLeaseMs: minimumSendLeaseMs(cfg) + 60_000,
      runGateCli: journeyGateCli,
    };
  } else {
    // Dry run: everything lives in a temporary root; nothing leaves the process.
    const root = mkdtempSync(path.join(tmpdir(), 'ub-j058-kite-dry-'));
    cpSync(path.join(repo, 'config'), path.join(root, 'config'), { recursive: true });
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(
      path.join(root, 'config', 'release', 'authorizers.json'),
      JSON.stringify({
        schema: 'release-authorizers.v1',
        note: 'DRY RUN: throwaway key generated for this run only',
        authorizers: { 'dryrun-k1': keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') },
      }),
    );
    mkdirSync(path.join(root, 'evidence', 'authorizations'), { recursive: true });
    const now = Date.now();
    const record = rg.signAuthorization(
      {
        schema: 'release-authorization.v1',
        gate: 'PAYMENT',
        authorizationId: 'auth-payment-dryrun',
        authorizedBy: 'dry-run',
        authorizedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        statement: 'DRY RUN ONLY: throwaway authorization for the RECORDED_CONTRACT journey; authorizes nothing real.',
        scope: {
          merchant: LIONX402.host,
          amountMinor: 1,
          currency: 'USD',
          purpose: LIONX402.purpose,
          environment: 'kite-passport-prod',
        },
      },
      keys.privateKey,
      'dryrun-k1',
    );
    writeFileSync(
      path.join(root, 'evidence', 'authorizations', 'PAYMENT.auth-payment-dryrun.json'),
      JSON.stringify(record),
    );
    const recorded = new RecordedContractAdapter();
    recorded.sessionModes = ['PENDING'];
    const capture = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'lionx402-preflight-402.json'), 'utf8'));
    opts = {
      mode: 'DRY_RUN',
      journeyId,
      artifactRoot: root,
      gateRoot: root,
      gateEvidenceDir: path.join(root, 'docs', 'release', 'evidence'),
      authorizationId: 'auth-payment-dryrun',
      environment: 'kite-passport-prod',
      adapter: recorded,
      taps,
      databaseLabel: 'j058kitedry',
      readiness: async () => ({
        loggedIn: true,
        agentRegistered: true,
        agentIdSha256: null,
        allowanceSet: false,
        allowanceState: 'none',
        baseUsdcMicros: 1_000_000n,
      }),
      preflight: async () => capture.response,
      trackedTreeClean: () => true,
      sourceSha: () => jg.headSha(repo),
      isolation: () => ({ configFilePrivate: true, stateRootPrivate: true, outsideRepository: true }),
      checkGate: async ({ requestFile, preflightFile }, id) =>
        rg.checkAndRecord(root, 'PAYMENT', JSON.parse(readFileSync(requestFile, 'utf8')), {
          preflight: JSON.parse(readFileSync(preflightFile, 'utf8')),
          now: new Date(),
          authorizationId: id,
        }),
      // Completed-payment evidence: only the consumed decision recorded for this journey (PR #21 review 10).
      isAuthorized: (g, id, request, window) => jg.evidenceAuthorizer(root)(g, id, request, window),
      onApprovalRequired: () => {
        log('DRY RUN: simulating the passkey approval of the RECORDED_CONTRACT session');
        for (const key of recorded.sessions.keys()) recorded.activate(key);
      },
      approval: { timeoutMs: 10_000, pollMs: 100 },
      secrets: () => [],
      log,
      killSwitchInstalled: true,
    };
    log(`DRY RUN artifacts: ${root}`);
  }

  const report = await runKitePaymentJourney(opts);
  if (existsSync(report.evidenceDir ?? '')) log(`evidence: ${report.evidenceDir}`);
  console.log(json(report));
  process.exitCode = { COMPLETED: 0, REFUSED: 2, UNKNOWN: 4, FAILED: 5 }[report.outcome];
}

await main();
