// T-058 payment, fulfillment and duplicate parts: ONE bounded Kite-paid action through the product's exclusive broker
// (FR-11, FR-12, FR-22, INV-05..INV-08, INV-12). The library behind journey-kite-payment.ts (the CLI) and its tests.
//   hard stops (no egress, no database): journey id / evidence dir, clean tracked tree (sourceSha), broker isolation
//   (0600 adapter file, 0700 kpass state root outside the repo), kpass logged in with an agent, no active account
//   allowance (kpass could otherwise pay from it), the unpaid 402 preflight at most 1 cent in USDC on Base, and a Base
//   USDC balance that covers it
//   -> throwaway database (dropped at the end) -> the M08/M09 world: an incident opened by a labelled SIMULATOR device
//   (the sensor part stays NOT_RUN), a PAID_CONTACT candidate for mer_lionx402-com at 1 minor unit USD with an offer
//   observed now, the compatibility decision, a recovery plan, the approval and an execution authority of about 1 hour
//   -> the PAYMENT release gate (`check PAYMENT --request --preflight --authorization`) BEFORE any egress
//   -> the broker activates the Kite session (kpass session create); the approval link is shown to the operator and
//   the passkey approval is awaited, bounded, by polling session status -> ONE paid call -> the identical intent
//   request again (same idempotency key: the product returns the existing intent and the broker sends nothing)
//   -> reconciliation from Kite's own answer (execute receipt + the session's spent total) -> redacted evidence ->
//   manifest -> journey gate (file-only and with the database cross-check) -> drop the database.
// After any egress an ambiguous step stops the run as UNKNOWN; nothing is ever retried. The timeout part stays
// NOT_RUN: Kite has no payment lookup by client key, so an injected timeout cannot be reconciled safely.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { money, type AssetId, type IncidentId } from '@uptimebuyer/contracts';
import { createProviderAccount } from '@uptimebuyer/data';
import { evaluateCandidate } from '@uptimebuyer/compatibility';
import { commitIncidentEvidence } from '@uptimebuyer/evidence';
import { evaluateIncidentRules } from '@uptimebuyer/incidents';
import { createRecoveryPlan, prepareApprovalRequest, publishTenantRiskEstimate } from '@uptimebuyer/planning';
import {
  linkApprovedVendor,
  prepareContactRequest,
  recordQuote,
  reviewContactPoint,
  runProviderSearch,
} from '@uptimebuyer/providers';
import {
  approvePlanAction,
  changeExecutionAuthorityStatus,
  createCommercialIntent,
  intentRequestFor,
  issueExecutionAuthority,
  type ExecutionAuthorityView,
} from '@uptimebuyer/commerce';
import { exactCandidate, warranty } from '../../../../packages/compatibility/test/helpers.js';
import { nwrAsset } from '../../../../packages/evidence/test/helpers.js';
import { isoAt, liveRun, provisionDevice } from '../../../../packages/incidents/test/helpers.js';
import { MANUFACTURER, foodAtRisk, riskBody } from '../../../../packages/planning/test/helpers.js';
import type { KiteReadiness, KpassExecuteRecord } from '../../src/adapters/kite-passport.js';
import type { PaidAdapter } from '../../src/adapters/port.js';
import {
  conservation,
  createBrokerWorld,
  inProcessBroker,
  intentRef,
  sessionRef,
  type BrokerWorld,
} from '../helpers.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** The approved merchant and action (user-approved plan, 2026-11-13). */
export const LIONX402 = Object.freeze({
  merchantId: 'mer_lionx402-com',
  host: 'lionx402.com',
  url: 'https://lionx402.com/api/x402/poi-business-search-json?q=refrigeration%20repair',
  method: 'GET' as const,
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  amountMinor: 1n,
  currency: 'USD',
  catalogId: '5fd185ffb0d48c8a307e4fb1',
  network: 'eip155:8453',
  /** Native USDC on Base mainnet (6 decimals). */
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  assetDecimals: 6,
});
/** Caps for this journey in code (the adapter enforces the same hard caps): 1 cent per call, 5 per session, ~1 hour. */
export const JOURNEY_CAPS = Object.freeze({ perCallMinor: 1n, sessionTotalMinor: 5n, lifetimeMs: 3_600_000 });
/** Micro-units of USDC per USD minor unit (cent). */
const MICROS_PER_CENT = 10_000n;

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;

// ---- pure pre-egress checks ------------------------------------------------------------------------------------

export interface PreflightCapture {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type PreflightAssessment =
  | {
      ok: true;
      x402Version: number;
      priceMinor: bigint;
      amountAtomic: string;
      asset: string;
      network: string;
      payTo: string;
      scheme: string;
      source: 'BODY' | 'HEADER' | 'BODY_AND_HEADER';
    }
  | { ok: false; reason: string };

/**
 * Assess the merchant's unpaid x402 answer (no payment header was sent). Every offered option must be the `exact`
 * scheme in native USDC on Base mainnet at or below the 1-cent cap; the body and the base64 `payment-required` header
 * must agree when both are present. Anything else is refused.
 */
export function assessX402Preflight(
  c: PreflightCapture,
  capMinor: bigint = JOURNEY_CAPS.perCallMinor,
): PreflightAssessment {
  if (c.status !== 402) return { ok: false, reason: 'PREFLIGHT_NOT_402' };
  const parse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const fromBody = c.body.trim() ? parse(c.body) : null;
  const header = Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === 'payment-required')?.[1];
  const fromHeader = header ? parse(Buffer.from(header, 'base64').toString('utf8')) : null;
  if (fromBody && fromHeader && JSON.stringify(fromBody) !== JSON.stringify(fromHeader))
    return { ok: false, reason: 'PREFLIGHT_AMBIGUOUS' };
  const doc = fromBody ?? fromHeader;
  if (!doc || !Array.isArray(doc.accepts) || doc.accepts.length === 0)
    return { ok: false, reason: 'PREFLIGHT_UNREADABLE' };
  const version = Number(doc.x402Version);
  if (version !== 1 && version !== 2) return { ok: false, reason: 'PREFLIGHT_UNREADABLE' };
  // The challenge must be for exactly the bound resource (no other endpoint's price can stand in for it).
  const resource = (doc.resource ?? null) as { url?: unknown } | null;
  if (resource && resource.url !== undefined && resource.url !== LIONX402.url)
    return { ok: false, reason: 'PREFLIGHT_RESOURCE_MISMATCH' };
  let first: Extract<PreflightAssessment, { ok: true }> | null = null;
  for (const raw of doc.accepts as unknown[]) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const amount = String(a.amount ?? a.maxAmountRequired ?? '');
    if (!/^[0-9]{1,30}$/.test(amount) || typeof a.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo))
      return { ok: false, reason: 'PREFLIGHT_UNREADABLE' };
    if (a.network !== LIONX402.network) return { ok: false, reason: 'PREFLIGHT_NOT_BASE' };
    if (typeof a.asset !== 'string' || a.asset.toLowerCase() !== LIONX402.asset.toLowerCase())
      return { ok: false, reason: 'PREFLIGHT_NOT_USDC' };
    if (a.scheme !== 'exact') return { ok: false, reason: 'PREFLIGHT_SCHEME_UNSUPPORTED' };
    const atomic = BigInt(amount);
    if (atomic <= 0n || atomic > capMinor * MICROS_PER_CENT) return { ok: false, reason: 'PREFLIGHT_PRICE_ABOVE_CAP' };
    first ??= {
      ok: true,
      x402Version: version,
      priceMinor: (atomic + MICROS_PER_CENT - 1n) / MICROS_PER_CENT,
      amountAtomic: amount,
      asset: a.asset,
      network: a.network,
      payTo: a.payTo,
      scheme: a.scheme,
      source: fromBody && fromHeader ? 'BODY_AND_HEADER' : fromBody ? 'BODY' : 'HEADER',
    };
  }
  return first!;
}

/** The kpass state root must be a 0700 directory of this user, outside the repository. */
export function checkStateRoot(dir: string, repoRoot: string = repo): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(dir)) return { ok: false, reason: 'STATE_ROOT_MISSING' };
  const st = lstatSync(dir);
  if (!st.isDirectory()) return { ok: false, reason: 'STATE_ROOT_MISSING' };
  const rel = path.relative(path.resolve(repoRoot), path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
    return { ok: false, reason: 'STATE_ROOT_INSIDE_REPOSITORY' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'STATE_ROOT_NOT_PRIVATE' };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    return { ok: false, reason: 'STATE_ROOT_NOT_OWNED' };
  return { ok: true };
}

// ---- the run ---------------------------------------------------------------------------------------------------

export interface JourneyTaps {
  approvals: { requestId: string; approvalUrl: string; expiresAt: string | null }[];
  executions: KpassExecuteRecord[];
}

export interface JourneyOptions {
  mode: 'DRY_RUN' | 'LIVE';
  journeyId: string;
  /** Repository-shaped root holding evidence/journeys/<journeyId>/ (the repository itself for a real run). */
  artifactRoot: string;
  /** Root of the release gate's authorizations (the repository itself for a real run). */
  gateRoot: string;
  /** Where the journey-gate reports go (docs/release/evidence for a real run). */
  gateEvidenceDir: string;
  authorizationId: string;
  environment: string;
  adapter: PaidAdapter;
  taps: JourneyTaps;
  databaseLabel: string;
  readiness(): Promise<KiteReadiness>;
  preflight(): Promise<PreflightCapture>;
  trackedTreeClean(): boolean;
  sourceSha(): string | null;
  isolation(): { configFilePrivate: boolean; stateRootPrivate: boolean; outsideRepository: boolean };
  checkGate(
    files: { requestFile: string; preflightFile: string },
    authorizationId: string,
  ): Promise<{ decision: string; reasons: string[] }>;
  isAuthorized(
    gate: string,
    id: string,
    request: unknown,
    window: { journeyId: string; startedAt: string; endedAt: string },
  ): boolean;
  onApprovalRequired(a: { approvalUrl: string | null; expiresAt: string | null }): Promise<void> | void;
  approval: { timeoutMs: number; pollMs: number };
  secrets(): { name: string; value: string }[];
  log(line: string): void;
  sessionUsage?(requestRef: string): Promise<{ status: string | null; spentTotal: string | null } | null>;
  /** The operator's kill switch (SIGINT revokes the authority) is installed by the caller. */
  killSwitchInstalled: boolean;
  /** Called with a function that revokes the authority (the CLI wires it to SIGINT). */
  registerKillSwitch?(revoke: () => Promise<void>): void;
  /** Optional extra gate run through the CLI (the real run also spawns scripts/release/journey-gate.mjs). */
  runGateCli?(args: { manifestRel: string; database?: { url: string; tenantId: string; incidentId: string } }): {
    code: number | null;
    report: GateReport;
  };
}

export interface GateReport {
  result: string;
  parts: { part: string; status: string; reasons: string[] }[];
}

export interface JourneyReport {
  journeyId: string;
  mode: 'DRY_RUN' | 'LIVE';
  outcome: 'COMPLETED' | 'REFUSED' | 'UNKNOWN' | 'FAILED';
  stoppedAt?: string;
  reason?: string;
  resultOrigin?: string;
  egress: { sessionCreate: number; execute: number; sessionLookups: number };
  preflight?: Extract<PreflightAssessment, { ok: true }>;
  gateDecision?: { decision: string; reasons: string[] };
  intentId?: string;
  paymentState?: string;
  capturedMinor?: bigint;
  reconciled?: boolean;
  attempt?: { adapterCapability: string; externalOutcomeState: string; transportState: string };
  duplicate?: { sameIntentReturned: boolean; secondEgress: boolean; sameKeyReplayVerified: boolean };
  gate?: {
    fileOnly: { result: string; parts: Record<string, string> };
    withDatabase: { result: string; parts: Record<string, string> };
  };
  evidenceDir?: string;
  databaseKept?: string | null;
}

/** Counts every adapter call that can leave the process (session create, paid execute, session status). */
class CountingAdapter implements PaidAdapter {
  readonly egress = { sessionCreate: 0, execute: 0, sessionLookups: 0 };
  constructor(private readonly inner: PaidAdapter) {}
  get adapterId() {
    return this.inner.adapterId;
  }
  get resultOrigin() {
    return this.inner.resultOrigin;
  }
  get capability() {
    return this.inner.capability;
  }
  assess(i: Parameters<PaidAdapter['assess']>[0]) {
    return this.inner.assess(i);
  }
  assessSession(s: Parameters<PaidAdapter['assessSession']>[0]) {
    return this.inner.assessSession(s);
  }
  prepare(i: Parameters<PaidAdapter['prepare']>[0]) {
    return this.inner.prepare(i);
  }
  execute(...a: Parameters<PaidAdapter['execute']>) {
    this.egress.execute++;
    return this.inner.execute(...a);
  }
  lookup(l: Parameters<PaidAdapter['lookup']>[0]) {
    return this.inner.lookup(l);
  }
  activateSession(...a: Parameters<PaidAdapter['activateSession']>) {
    this.egress.sessionCreate++;
    return this.inner.activateSession(...a);
  }
  lookupSession(l: Parameters<PaidAdapter['lookupSession']>[0]) {
    this.egress.sessionLookups++;
    return this.inner.lookupSession(l);
  }
}

class Refused extends Error {
  constructor(
    readonly stoppedAt: string,
    readonly reason: string,
  ) {
    super(`${stoppedAt}: ${reason}`);
  }
}

const NOT_RUN_TIMEOUT =
  'NOT_RUN: Kite documents no payment lookup by client key, so an injected timeout after egress could only be ' +
  'resolved manually; the timeout part is not attempted (docs/adr/0003-kite-broker.md).';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function runKitePaymentJourney(o: JourneyOptions): Promise<JourneyReport> {
  const counting = new CountingAdapter(o.adapter);
  const base: JourneyReport = { journeyId: o.journeyId, mode: o.mode, outcome: 'REFUSED', egress: counting.egress };
  const relDir = `evidence/journeys/${o.journeyId}`;
  const outDir = path.join(o.artifactRoot, relDir);
  let preflight: Extract<PreflightAssessment, { ok: true }>;
  let capture: PreflightCapture;
  let sourceSha: string;
  // ---- hard stops before anything leaves the process (no database exists yet)
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.journeyId)) throw new Refused('PREFLIGHT', 'JOURNEY_ID');
    if (o.mode === 'DRY_RUN' && !o.journeyId.startsWith('dryrun-')) throw new Refused('PREFLIGHT', 'DRY_RUN_ID');
    if (o.mode === 'LIVE' && o.journeyId.startsWith('dryrun-')) throw new Refused('PREFLIGHT', 'JOURNEY_ID');
    if (existsSync(outDir)) throw new Refused('PREFLIGHT', 'EVIDENCE_EXISTS');
    if (o.mode === 'LIVE' && !o.trackedTreeClean()) throw new Refused('PREFLIGHT', 'TREE_NOT_CLEAN');
    const sha = o.sourceSha();
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Refused('PREFLIGHT', 'SOURCE_SHA');
    sourceSha = sha;
    const iso = o.isolation();
    if (!iso.configFilePrivate || !iso.stateRootPrivate || !iso.outsideRepository)
      throw new Refused('PREFLIGHT', 'BROKER_ISOLATION');
    if (o.adapter.resultOrigin !== (o.mode === 'LIVE' ? 'KITE_PASSPORT' : 'RECORDED_CONTRACT'))
      throw new Refused('PREFLIGHT', 'ADAPTER_ORIGIN');
    const ready = await o.readiness();
    if (!ready.loggedIn || !ready.agentRegistered) throw new Refused('PREFLIGHT', 'KPASS_NOT_LOGGED_IN');
    // kpass pays from the account allowance when no usable session is current: none may be active.
    if (ready.allowanceSet || (ready.allowanceState !== null && ready.allowanceState !== 'none'))
      throw new Refused('PREFLIGHT', 'ACCOUNT_ALLOWANCE_ACTIVE');
    capture = await o.preflight();
    const a = assessX402Preflight(capture);
    if (!a.ok) throw new Refused('PREFLIGHT', a.reason);
    preflight = a;
    if (ready.baseUsdcMicros === null || ready.baseUsdcMicros < BigInt(a.amountAtomic))
      throw new Refused('PREFLIGHT', 'WALLET_CANNOT_COVER');
  } catch (e) {
    if (e instanceof Refused) return { ...base, stoppedAt: e.stoppedAt, reason: e.reason };
    throw e;
  }
  o.log(`preflight ok: ${preflight.amountAtomic} atomic USDC on ${preflight.network} to ${preflight.payTo}`);

  const startedAt = new Date().toISOString();
  const w = await createBrokerWorld(o.databaseLabel);
  const broker = inProcessBroker(w, counting, {
    sendLeaseMs: 360_000,
    reconcileBaseMs: 3_600_000,
  });
  let keepDatabase = false;
  try {
    // ---- the product world: incident, candidate, decision, plan, approval, authority
    const world = await buildWorld(
      w,
      o,
      `x402 ${preflight.scheme} ${preflight.amountAtomic} atomic USDC on ${preflight.network} (unpaid preflight)`,
    );
    const auth = world.auth;
    const authority = auth.authority;
    const lifetimeMs = Date.parse(authority.expiresAt) - Date.parse(authority.issuedAt);
    if (
      authority.merchantId !== LIONX402.merchantId ||
      authority.purpose !== LIONX402.purpose ||
      authority.perActionLimit.currency !== LIONX402.currency ||
      authority.perActionLimit.amountMinor > JOURNEY_CAPS.perCallMinor ||
      authority.baseLimit.amountMinor > JOURNEY_CAPS.sessionTotalMinor ||
      lifetimeMs > JOURNEY_CAPS.lifetimeMs + 60_000 ||
      preflight.priceMinor > authority.perActionLimit.amountMinor
    )
      throw new Refused('AUTHORITY', 'AUTHORITY_OUTSIDE_CAPS');
    if (o.registerKillSwitch)
      o.registerKillSwitch(async () => {
        await changeExecutionAuthorityStatus(w.db.pool, w.operator, {
          executionAuthorityId: authority.executionAuthorityId,
          to: 'REVOKED',
          reasonCode: 'OPERATOR_KILL_SWITCH',
        });
      });

    // ---- PAYMENT release gate before any egress
    mkdirSync(outDir, { recursive: true });
    const rel = (f: string) => `${relDir}/${f}`;
    const write = (f: string, v: unknown) => writeFileSync(path.join(outDir, f), json(v));
    const request = {
      merchant: new URL(LIONX402.url).hostname,
      amountMinor: Number(authority.perActionLimit.amountMinor),
      currency: authority.perActionLimit.currency,
      purpose: authority.purpose,
      environment: o.environment,
      journeyId: o.journeyId,
    };
    const iso = o.isolation();
    const gatePreflight = {
      // The adapter came from the 0600 file outside the repository; kpass's state root is 0700, broker-only.
      'broker-isolation': iso.configFilePrivate && iso.stateRootPrivate && iso.outsideRepository,
      // Authority, Kite session caps and the merchant's quoted price are inside the 1 / 5 cent hard caps.
      'budget-bound':
        authority.perActionLimit.amountMinor <= JOURNEY_CAPS.perCallMinor &&
        authority.baseLimit.amountMinor <= JOURNEY_CAPS.sessionTotalMinor &&
        preflight.priceMinor <= authority.perActionLimit.amountMinor,
      // The pre-egress operation key exists and an ambiguous outcome stays UNKNOWN, reserved for a finance approver's
      // manual resolution; no autonomous retry is possible (capability is not autonomous unless verified).
      'reconciliation-ready':
        world.financeApproverPresent &&
        (o.adapter.capability.lookupByClientOperation || o.adapter.capability.sameKeyReplay || o.mode === 'LIVE'),
      // The authority is ACTIVE and the operator's kill switch (revoke) is wired; the Kite session TTL is bounded by it.
      'kill-switch-ready': authority.status === 'ACTIVE' && o.killSwitchInstalled,
    };
    write('preflight-402.json', {
      schema: 'journey-x402-preflight.v1',
      journeyId: o.journeyId,
      origin: o.mode === 'LIVE' ? 'REAL_UNPAID_PREFLIGHT' : 'RECORDED_PREFLIGHT_REPLAY',
      request: { method: 'GET', url: LIONX402.url, paymentHeaderSent: false },
      response: { status: capture.status, bodySha256: sha256(capture.body), body: capture.body },
      assessment: preflight,
      capMinor: JOURNEY_CAPS.perCallMinor,
    });
    write('gate-request.json', request);
    write('gate-preflight.json', gatePreflight);
    const decision = await o.checkGate(
      { requestFile: path.join(outDir, 'gate-request.json'), preflightFile: path.join(outDir, 'gate-preflight.json') },
      o.authorizationId,
    );
    write('gate-decision.json', { ...decision, at: new Date().toISOString(), authorizationId: o.authorizationId });
    if (decision.decision !== 'AUTHORIZED') throw new Refused('GATE', decision.reasons.join(',') || 'REFUSED');
    o.log(`PAYMENT gate AUTHORIZED (${o.authorizationId})`);

    // ---- Kite session: the broker creates the approval request; the operator approves with a passkey.
    keepDatabase = o.mode === 'LIVE';
    const sRef = () => sessionRef(w, authority.executionAuthorityId);
    let session = (await broker.activateSession(sRef())).session;
    if (session.externalOutcomeState === 'ACCEPTED') {
      const link = o.taps.approvals.at(-1);
      await o.onApprovalRequired({ approvalUrl: link?.approvalUrl ?? null, expiresAt: link?.expiresAt ?? null });
      const until = Date.now() + o.approval.timeoutMs;
      while (session.externalOutcomeState === 'ACCEPTED' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, o.approval.pollMs));
        session = await broker.reconcileAuthoritySession(sRef());
      }
    }
    if (session.externalOutcomeState === 'ACCEPTED') throw new Refused('SESSION_APPROVAL', 'SESSION_APPROVAL_TIMEOUT');
    if (session.externalOutcomeState !== 'CONFIRMED')
      throw new Refused('SESSION_APPROVAL', `SESSION_${session.externalOutcomeState}`);
    o.log('Kite session approved');

    // ---- ONE paid call through the broker
    const intentRequest = intentRequestFor(auth, w.operator, w.key('intent'));
    const created = await createCommercialIntent(w.db.pool, w.operator, intentRequest, w.referenceSigner);
    const intentId = created.intent.commercialIntentId as string;
    const run = await broker.execute(intentRef(w, intentId));
    const paidAt = new Date().toISOString();
    const executeCallsAfterPayment = counting.egress.execute;

    // ---- the identical request again: same intent request and idempotency key, then a fresh execution reference
    const again = await createCommercialIntent(w.db.pool, w.operator, intentRequest, w.referenceSigner);
    const rerun = await broker.execute(intentRef(w, again.intent.commercialIntentId));
    const duplicateAt = new Date().toISOString();
    const duplicate = {
      sameIntentReturned: again.intent.commercialIntentId === intentId && again.created === false,
      secondEgress: counting.egress.execute !== executeCallsAfterPayment,
      // Kite's docs do not promise the original result for a same-key replay of a separate-session payment, so the
      // duplicate is the product's own protection (same intent, no second egress), never a provider replay.
      sameKeyReplayVerified: false,
      basis: 'PRODUCT_DUPLICATE_PROTECTION',
      firstState: run.intent.state,
      secondState: rerun.intent.state,
      secondReplayFlag: rerun.replay,
    };

    // ---- reconciliation from Kite's own answer
    await broker.reconcile(intentRef(w, intentId));
    const view = await broker.intentView(w.tenant.tenantId, intentId as never);
    if (!view) throw new Error('the intent view is unavailable');
    const attempt = (
      await w.db.pool.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [
        w.tenant.tenantId,
        intentId,
      ])
    ).rows[0];
    const ledger = await conservation(w);
    const exec = o.taps.executions.at(-1) ?? null;
    const usage =
      o.sessionUsage && session.providerSessionRef ? await o.sessionUsage(session.providerSessionRef) : null;
    const state = view.intent.state as string;
    const captured = view.money.capturedGrossMinor;
    const reconciled =
      state === 'CONFIRMED' &&
      ledger.problems.length === 0 &&
      captured === preflight.priceMinor &&
      view.money.openReservedMinor === 0n &&
      (o.mode === 'DRY_RUN' || (exec?.outcome === 'CONFIRMED' && decimalCents(usage?.spentTotal) === captured));
    const origin = o.adapter.resultOrigin;

    // ---- evidence (identifiers that could act on the Kite account are never written: digests only)
    write('payment.json', {
      schema: 'journey-kite-payment-record.v1',
      journeyId: o.journeyId,
      origin,
      adapterId: o.adapter.adapterId,
      merchant: {
        id: LIONX402.merchantId,
        host: LIONX402.host,
        url: LIONX402.url,
        method: LIONX402.method,
        catalogId: LIONX402.catalogId,
      },
      purpose: LIONX402.purpose,
      authorizationId: o.authorizationId,
      intentId,
      externalAttemptId: attempt?.id ?? null,
      state,
      amountMinor: captured,
      capMinor: authority.perActionLimit.amountMinor,
      baseLimitMinor: authority.baseLimit.amountMinor,
      currency: authority.perActionLimit.currency,
      money: view.money,
      attempt: attempt
        ? {
            transportState: attempt.transport_state,
            externalOutcomeState: attempt.external_outcome_state,
            adapterCapability: attempt.adapter_capability,
            reasonCode: attempt.reason_code,
            rawProviderStatus: attempt.raw_provider_status,
            rawResponseDigest: attempt.raw_response_digest,
            idempotencyKeySha256: sha256(String(attempt.idempotency_key)),
          }
        : null,
      settlement: exec
        ? {
            asset: exec.asset,
            amount: exec.amount,
            chainId: exec.chainId,
            reference: exec.paymentReference,
            payTo: preflight.payTo,
            source: exec.source ?? 'separate-session',
            sessionMatched: exec.sessionMatched,
          }
        : { origin: 'RECORDED_CONTRACT', reference: attempt?.provider_ref ?? null },
      kiteSession: {
        requestRefSha256: session.providerSessionRef ? sha256(session.providerSessionRef) : null,
        externalOutcomeState: session.externalOutcomeState,
      },
      kiteSessionUsage: usage ? { status: usage.status, spentTotal: usage.spentTotal } : null,
      receipts: view.receipts,
      transitions: view.transitions,
      ledgerConservation: ledger.problems.length === 0 ? 'HOLDS' : ledger.problems,
      reconciled,
      reconciliation:
        o.mode === 'LIVE'
          ? "Kite's execute answer (x402 2xx, amount, asset, chain, the authority's own session) plus the session's spent total after the duplicate; Kite has no lookup by client key."
          : 'RECORDED_CONTRACT lookup by client operation (not Kite).',
      paidAt,
      sameKeyReplayVerified: false,
    });
    const results = parseResults(exec?.responseBody ?? null);
    write('merchant-response.json', {
      schema: 'journey-merchant-response.v1',
      journeyId: o.journeyId,
      origin: o.mode === 'LIVE' ? 'PROVIDER_LIVE' : 'RECORDED_CONTRACT',
      merchant: LIONX402.host,
      url: LIONX402.url,
      statusCode: exec?.statusCode ?? (state === 'CONFIRMED' ? 200 : null),
      responseSha256: exec?.responseSha256 ?? null,
      resultCount: results.count,
      results: results.items,
      body: exec?.responseBody ?? null,
      note: 'OpenStreetMap business and POI search results (public data) delivered for the paid call.',
      observedAt: exec?.observedAt ?? paidAt,
    });
    write('duplicate.json', {
      schema: 'journey-duplicate-record.v1',
      journeyId: o.journeyId,
      origin,
      intentId,
      ...duplicate,
      executeCallsAfterPayment,
      executeCallsAfterDuplicate: counting.egress.execute,
      observedAt: duplicateAt,
    });

    // ---- redaction: every artifact, against the credential values and every Kite session/approval identifier
    const secretValues = [
      ...o.secrets(),
      ...o.taps.approvals.flatMap((a, n) => [
        { name: `APPROVAL_URL_${n}`, value: a.approvalUrl },
        { name: `APPROVAL_TOKEN_${n}`, value: new URL(a.approvalUrl).searchParams.get('token') ?? '' },
        { name: `KITE_REQUEST_ID_${n}`, value: a.requestId },
      ]),
      ...(session.providerSessionRef ? [{ name: 'KITE_REQUEST_REF', value: session.providerSessionRef }] : []),
    ];
    const ev = (await import(path.join(repo, 'scripts', 'release', 'journey-evidence.mjs'))) as any;
    const files = [
      'preflight-402.json',
      'gate-request.json',
      'gate-preflight.json',
      'gate-decision.json',
      'payment.json',
      'merchant-response.json',
      'duplicate.json',
    ];
    const redaction = ev.redactionCheck(
      files.map((f) => ({ path: rel(f), bytes: readFileSync(path.join(outDir, f)) })),
      secretValues,
    );
    write('redaction-check.json', redaction);
    ev.enforceRedaction(redaction, [outDir], 'exported artifacts');

    // ---- manifest and journey gate
    const art = (f: string) => ({ path: rel(f), sha256: sha256(readFileSync(path.join(outDir, f))) });
    const endedAt = new Date().toISOString();
    const paymentFacts = {
      state,
      reconciled,
      amountMinor: Number(captured),
      capMinor: Number(authority.perActionLimit.amountMinor),
      currency: authority.perActionLimit.currency,
      request,
      intentId,
      settlementReference: exec?.paymentReference ?? null,
    };
    const parts: Record<string, unknown> = {
      payment: {
        capturedAt: paidAt,
        authorizationId: o.authorizationId,
        artifacts: [art('payment.json'), art('gate-decision.json'), art('redaction-check.json')],
        facts: paymentFacts,
      },
      duplicate: {
        capturedAt: duplicateAt,
        artifacts: [art('duplicate.json')],
        facts: {
          sameIntentReturned: duplicate.sameIntentReturned,
          secondEgress: duplicate.secondEgress,
          basis: duplicate.basis,
        },
      },
    };
    if (state === 'CONFIRMED' && (exec?.statusCode ?? 200) >= 200 && (exec?.statusCode ?? 200) < 300)
      parts.fulfillment = {
        capturedAt: exec?.observedAt ?? paidAt,
        artifacts: [art('merchant-response.json')],
        facts: {
          statusCode: exec?.statusCode ?? 200,
          resultCount: results.count,
          responseSha256: exec?.responseSha256 ?? null,
        },
      };
    const manifest = ev.buildJourneyManifest({
      journeyId: o.journeyId,
      sourceSha,
      startedAt,
      endedAt,
      parts,
      recordable: ev.PAYMENT_RECORDED_PARTS,
      ...(o.mode === 'DRY_RUN' ? { originOverride: 'RECORDED_CONTRACT' } : {}),
      context: {
        incidentTrigger:
          'SIMULATED_INPUT (labelled SIMULATOR device in a throwaway database; the sensor part is NOT_RUN)',
        tenant: 'synthetic tenant in a throwaway database, dropped after the gate ran',
        runner: 'apps/kite-broker/test/support/journey-kite-payment.ts',
        mode: o.mode,
        timeout: NOT_RUN_TIMEOUT,
        duplicate:
          'product duplicate protection (same intent, no second egress); Kite same-key replay is not documented as returning the original result',
      },
    });
    const manifestRel = rel('manifest.journey.json');
    writeFileSync(path.join(o.artifactRoot, manifestRel), json(manifest));
    const jg = (await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'))) as any;
    const gateCtx = {
      artifactRoot: o.artifactRoot,
      expectedSha: sourceSha,
      simulatedDigests: jg.loadSimulatedDigests(repo),
      isAuthorized: o.isAuthorized,
    };
    const fileOnly = jg.evaluateJourney(manifest, gateCtx) as GateReport;
    const facts = await jg.collectDatabaseFacts(w.db.pool, {
      tenantId: w.tenant.tenantId,
      incidentId: world.incidentId,
    });
    const withDatabase = jg.evaluateJourney(manifest, { ...gateCtx, databaseFacts: facts }) as GateReport;
    const cli = o.runGateCli
      ? {
          fileOnly: o.runGateCli({ manifestRel }),
          withDatabase: o.runGateCli({
            manifestRel,
            database: { url: w.db.url, tenantId: w.tenant.tenantId, incidentId: world.incidentId },
          }),
        }
      : null;
    mkdirSync(o.gateEvidenceDir, { recursive: true });
    const gateFile = path.join(o.gateEvidenceDir, `t058-journey-${o.journeyId}.gate.json`);
    const gateDbFile = path.join(o.gateEvidenceDir, `t058-journey-${o.journeyId}.gate-database.json`);
    writeFileSync(gateFile, json(cli?.fileOnly.report ?? fileOnly));
    writeFileSync(gateDbFile, json(cli?.withDatabase.report ?? withDatabase));
    const leak = ev.redactionCheck(
      [gateFile, gateDbFile, path.join(o.artifactRoot, manifestRel)].map((f) => ({ path: f, bytes: readFileSync(f) })),
      secretValues,
    );
    ev.enforceRedaction(leak, [gateFile, gateDbFile, outDir], 'gate artifacts');
    const statusOf = (r: GateReport) => Object.fromEntries(r.parts.map((p) => [p.part, p.status]));
    const outcome = state === 'CONFIRMED' ? 'COMPLETED' : state === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    // An ambiguous paid outcome keeps the throwaway database for manual resolution; a settled run drops it.
    keepDatabase = outcome === 'UNKNOWN';
    return {
      ...base,
      outcome,
      resultOrigin: origin,
      preflight,
      gateDecision: decision,
      intentId,
      paymentState: state,
      capturedMinor: captured,
      reconciled,
      ...(attempt
        ? {
            attempt: {
              adapterCapability: attempt.adapter_capability as string,
              externalOutcomeState: attempt.external_outcome_state as string,
              transportState: attempt.transport_state as string,
            },
          }
        : {}),
      duplicate: {
        sameIntentReturned: duplicate.sameIntentReturned,
        secondEgress: duplicate.secondEgress,
        sameKeyReplayVerified: false,
      },
      gate: {
        fileOnly: { result: fileOnly.result, parts: statusOf(fileOnly) },
        withDatabase: { result: withDatabase.result, parts: statusOf(withDatabase) },
      },
      evidenceDir: outDir,
      databaseKept: keepDatabase ? new URL(w.db.url).pathname.slice(1) : null,
    };
  } catch (e) {
    if (e instanceof Refused) {
      // Refused before the paid call: nothing was paid. Evidence of a refused run is not kept.
      if (counting.egress.execute === 0) {
        keepDatabase = false;
        rmSync(outDir, { recursive: true, force: true });
      }
      return { ...base, stoppedAt: e.stoppedAt, reason: e.reason, databaseKept: keepDatabase ? dbName(w) : null };
    }
    throw e;
  } finally {
    if (keepDatabase) {
      o.log(`database kept for manual resolution: ${dbName(w)}`);
      await w.brokerPool.end().catch(() => {});
      await w.gw.close().catch(() => {});
      await w.db.pool.end().catch(() => {});
    } else await w.close().catch(() => {});
  }
}

const dbName = (w: BrokerWorld) => new URL(w.db.url).pathname.slice(1);

/**
 * An operator-entered DIAGNOSTIC_VISIT quote through the M07 path (the planning world's SYNTHETIC_FIXTURE provider
 * search, its verified contact point and an unpaid contact request), at the merchant's quoted 1 cent, valid 1 hour.
 */
async function operatorQuote(w: BrokerWorld, incidentId: string, note: string): Promise<string> {
  const search = await runProviderSearch(
    w.db.pool,
    w.operator,
    {
      incidentId,
      providerAccountId: w.unpaid.providerAccountId,
      query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
      bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
      idempotencyKey: w.key('search'),
    },
    { adapters: w.adapters, credentials: w.creds },
  );
  const hit = search.results.find((r) => r.discovery.externalRef === 'cl-001') ?? search.results[0];
  if (!hit) throw new Error('the provider search found nobody');
  for (const cp of hit.contactPoints)
    if (cp.reviewState !== 'VERIFIED')
      await reviewContactPoint(w.db.pool, w.admin, { contactPointId: cp.contactPointId, decision: 'VERIFIED' });
  await linkApprovedVendor(w.db.pool, w.admin, {
    serviceProviderId: hit.provider.serviceProviderId,
    vendorId: w.vendorId,
  });
  const point = hit.contactPoints.find((c) => c.channel === 'API') ?? hit.contactPoints[0]!;
  const req = await prepareContactRequest(w.db.pool, w.operator, {
    incidentId,
    serviceProviderId: hit.provider.serviceProviderId,
    contactPointId: point.contactPointId,
    providerAccountId: w.unpaid.providerAccountId,
    channel: point.channel,
    purposeCode: 'QUOTE',
    idempotencyKey: w.key('prep'),
  });
  const q = await recordQuote(w.db.pool, w.operator, {
    contactRequestId: req.contactRequestId,
    sourceKind: 'OPERATOR_ENTRY',
    scopeKind: 'DIAGNOSTIC_VISIT',
    partNumber: '5A1-0402',
    manufacturer: MANUFACTURER,
    amount: money(LIONX402.amountMinor, 'USD'),
    taxMinor: 0n,
    etaMinutes: 5,
    availabilityStatus: 'AVAILABLE',
    validUntil: new Date(Date.now() + JOURNEY_CAPS.lifetimeMs).toISOString(),
    sourceEvidence: { note: `operator-entered from ${LIONX402.host}: ${note}` },
  });
  return q.quoteId;
}

function decimalCents(v: string | null | undefined): bigint | null {
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,18}))?$/.exec(v ?? '');
  if (!m) return null;
  const f = (m[2] ?? '').padEnd(2, '0');
  return /[^0]/.test(f.slice(2)) ? null : BigInt(m[1]!) * 100n + BigInt(f.slice(0, 2));
}

function parseResults(body: string | null): { count: number | null; items: unknown[] } {
  if (!body) return { count: null, items: [] };
  try {
    const b = JSON.parse(body) as { count?: unknown; results?: unknown };
    const items = Array.isArray(b.results) ? b.results.slice(0, 50) : [];
    return { count: Number.isSafeInteger(b.count) ? (b.count as number) : items.length, items };
  } catch {
    return { count: null, items: [] };
  }
}

/** The M08/M09 product world for the approved action (synthetic tenant; the incident trigger is SIMULATED_INPUT). */
async function buildWorld(w: BrokerWorld, o: JourneyOptions, preflightNote: string) {
  const provider = await createProviderAccount(w.db.pool, w.admin, {
    providerKey: 'kite-passport',
    environment: o.mode === 'LIVE' ? 'PRODUCTION' : 'SANDBOX',
    revision: {
      capabilities: ['PURCHASE', 'KITE_SESSION'],
      paid: true,
      ownerService: 'KITE_BROKER_PAID',
      credentialRef: `secretref:provider/tenants/${w.tenant.tenantId}/kite-passport`,
      endpointPolicyDigest: `sha256:${sha256(JSON.stringify({ url: LIONX402.url, method: LIONX402.method }))}` as never,
      webhookVerifierRef: null,
    },
    source: 'API',
  });
  const asset = await nwrAsset(w);
  await warranty(w, asset.assetId);
  await foodAtRisk(w as never, asset.assetId, 500_000n);
  // Incident from a labelled SIMULATOR device: SIMULATED_INPUT, never a physical-sensor claim.
  const device = await provisionDevice(w, { siteId: w.siteId, assetId: asset.assetId, inputClass: 'SIMULATOR' });
  const telemetry = await liveRun(w, device, [4_000, 9_000, 9_200, 9_400, 9_600, 9_800]);
  const opened = (
    await evaluateIncidentRules(w.db.pool, w.service, { assetId: asset.assetId as AssetId, at: isoAt(telemetry.at) })
  ).evaluations[0];
  if (opened?.outcome !== 'OPENED' || !opened.incidentId) throw new Error(`incident not opened: ${json(opened)}`);
  const incidentId = opened.incidentId as IncidentId;
  const rev = await commitIncidentEvidence(w.db.pool, w.operator, w.store, {
    incidentId,
    reasonCode: 'TRIAGE_EVIDENCE',
  });
  // The planner ranks only priced interventions: a PAID_CONTACT kind has no quote scope and is always INCOMPLETE, so
  // the paid lookup is modelled as a DIAGNOSTIC_SERVICE (the diagnostic step of finding a repair technician) priced
  // by an operator-entered DIAGNOSTIC_VISIT quote that carries the merchant's own unpaid 402 price.
  const quoteId = await operatorQuote(w, incidentId, preflightNote);
  // The synthetic tenant's operator risk estimate gains a repeat-failure estimate for DIAGNOSTIC_SERVICE.
  const base = riskBody();
  await publishTenantRiskEstimate(w.db.pool, w.admin, {
    ...base,
    repeatFailure: {
      ...base.repeatFailure,
      byActionKind: [
        ...base.repeatFailure.byActionKind,
        { actionKind: 'DIAGNOSTIC_SERVICE', estimatePpm: 50_000, lowPpm: 20_000, highPpm: 90_000 },
      ],
    },
  });
  const cand = await exactCandidate(
    w,
    { incidentId, evidenceRevisionId: rev.evidenceRevisionId },
    {
      kind: 'DIAGNOSTIC_SERVICE',
      merchantId: LIONX402.merchantId,
      amount: money(LIONX402.amountMinor, 'USD'),
      purpose: LIONX402.purpose,
      providerAccountRevisionId: provider.providerAccountRevisionId,
      offerObservedAt: new Date().toISOString(),
    },
  );
  const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId }, w.signing);
  if (d.decision !== 'ALLOW') throw new Error(`compatibility decision is ${d.decision}: ${json(d)}`);
  const plan = await createRecoveryPlan(
    w.db.pool,
    w.service,
    { incidentId, candidates: [{ candidateActionId: cand.candidateActionId, quoteId }] },
    w.signing,
  );
  const action = plan.actions.find((a) => a.candidateActionId === cand.candidateActionId);
  if (!action) throw new Error('the plan has no action for the candidate');
  if (
    (plan as { state?: string }).state !== 'APPROVABLE' ||
    (action as { disposition?: string }).disposition !== 'RANKED'
  )
    throw new Error(`the plan is not approvable: ${json({ plan: { ...plan, actions: plan.actions.length }, action })}`);
  const req = await prepareApprovalRequest(
    w.db.pool,
    w.service,
    {
      planId: plan.planId,
      planHash: plan.planHash,
      planActionId: action.planActionId,
      expiresAt: new Date(Date.now() + JOURNEY_CAPS.lifetimeMs).toISOString(),
    },
    w.signing,
  );
  const appr = await approvePlanAction(w.db.pool, w.approver, {
    approvalRequestId: req.approvalRequestId,
    planHash: plan.planHash,
    idempotencyKey: w.key('approve'),
  });
  const auth: ExecutionAuthorityView = await issueExecutionAuthority(
    w.db.pool,
    w.operator,
    { approvalId: appr.approvalId, subject: { type: 'PLAN_ACTION', id: cand.candidateActionId } },
    w.authoritySigner,
  );
  return { incidentId, auth, financeApproverPresent: Boolean(w.finance?.ctx) };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
