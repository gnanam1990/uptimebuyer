// KITE_PASSPORT adapter (credential-bearing; lives only in the broker). Kite publishes no HTTP API reference: agents drive
// the `kpass` CLI, which keeps the user JWT, agent token and session signing key in its own state directory
// ($HOME/.kite-passport). This adapter runs `kpass ... --no-interactive --output json` with an argument vector (never a
// shell), cwd and HOME set to the broker-only state root, a fixed minimal environment, a hard timeout and a bounded
// output size. It is constructed ONLY from explicit broker secret configuration; without it the broker uses
// UnconfiguredAdapter and performs no network I/O. The command, flag and JSON contract below is kpass 6.13.2 as Kite's
// installed skill docs describe it (request-session, x402-execute, form-session-delegation; read 2026-11-13); see
// docs/adr/0003-kite-broker.md for every source and every unverified detail. Kite documents no payment lookup by client
// key and no original-result guarantee for a same-key replay of a separate-session payment, so autonomous reconciliation
// is UNSUPPORTED: paid execution is allowed only when the operator explicitly accepts attended manual reconciliation
// (an ambiguous outcome stays UNKNOWN and reserved; nothing is retried) or has verified same-key replay.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { canonicalize } from '@uptimebuyer/domain';
import type {
  AdapterOutcome,
  AuthorizedIntent,
  AuthorizedSessionScope,
  CapabilityAssessment,
  ClientOperation,
  PaidAdapter,
  PreparedRequest,
  ReconciliationCapability,
  ReconciliationLocator,
  SendHooks,
} from './port.js';
import { unsupported } from './port.js';

export interface KitePassportEndpoint {
  /** The exact paid URL, query string included (GET parameters travel in the URL; nothing else is sent). */
  url: string;
  /** Only GET is executable today (no request body is ever sent); POST is refused at configuration time. */
  method: 'GET';
}

export interface KitePassportConfig {
  /** Absolute path of the kpass binary. */
  kpassBinary: string;
  /** Absolute directory used as HOME and cwd for kpass (holds `.kite-passport/`); 0700, broker-only. */
  stateRoot: string;
  /** Optional backend override (the CLI's `--base-url`); unset uses the CLI default (production). */
  baseUrl?: string;
  /** Hard timeout of `session execute` (kpass documents a 5-minute execution timeout). */
  timeoutMs: number;
  /** Hard timeout of the non-paying commands (session create/status, readiness reads). Default 30 s. */
  readTimeoutMs?: number;
  /** Allowlisted paid endpoints per merchant id; nothing else is ever called. */
  merchantEndpoints: Record<string, KitePassportEndpoint>;
  /** Operator-recorded verification that Kite returns the original result on same-key retry. Default false. */
  sameKeyReplayVerified?: boolean;
  /**
   * Operator acceptance of attended execution without autonomous reconciliation: an ambiguous outcome stays UNKNOWN,
   * reserved and routed to manual resolution; nothing is ever retried. Default false (paid execution UNSUPPORTED).
   */
  manualReconciliationAccepted?: boolean;
}

/** What one paid call returned, for the operator's evidence (never persisted by the broker; no session id). */
export interface KpassExecuteRecord {
  observedAt: string;
  exitCode: number;
  statusCode: number | null;
  responseBody: string | null;
  responseSha256: string | null;
  paymentReference: string | null;
  amount: string | null;
  asset: string | null;
  chainId: number | null;
  spentTotal: string | null;
  source: string | null;
  sessionMatched: boolean;
  errorCode: string | null;
  outcome: AdapterOutcome['kind'];
  reasonCode: string | null;
  rawResponseDigest: string | null;
}

export interface KitePassportTaps {
  /** The passkey approval link for a created session request (operator terminal only; never stored or logged). */
  onApprovalRequired?(a: { requestId: string; approvalUrl: string; expiresAt: string | null }): void;
  /** Each paid call's normalized answer, including the merchant's delivered body. */
  onExecuted?(r: KpassExecuteRecord): void;
}

export interface KiteReadiness {
  loggedIn: boolean;
  agentRegistered: boolean;
  /** sha256 of the agent id (the id itself is an account identifier and is never returned). */
  agentIdSha256: string | null;
  allowanceSet: boolean;
  allowanceState: string | null;
  /** Base-chain USDC balance in micro-units (6 decimals), or null when unreadable. */
  baseUsdcMicros: bigint | null;
}

/** The first live wiring is capped in code, whatever an authority or the configuration says (USD minor units). */
export const KITE_HARD_CAPS = Object.freeze({ perCallMinor: 1n, sessionTotalMinor: 5n, currency: 'USD' });
/** Shortest provider session lifetime worth creating (seconds). */
export const MIN_SESSION_TTL_SECONDS = 60;
/** The only settlement kpass may report for this wiring: USDC on Base mainnet. */
const BASE_CHAIN_ID = 8453;

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const MAX_OUTPUT = 512 * 1024;
// Kite session request ids: real kpass 6.13.2 ids are agent_session_req_<uuid> (observed 2026-11-13); the req_<id>
// form is the documentation's placeholder. Both start with a letter, so neither can be read as a flag.
const REQUEST_ID = /^(?:agent_session_)?req_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Broker-generated operation keys; never starting with '-' so kpass cannot read one as a flag. */
const OP_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_REF = /^[\x21-\x7E]{1,256}$/;
/** Default hard timeout of the non-paying kpass commands (status reads, session create). */
export const DEFAULT_KPASS_READ_TIMEOUT_MS = 30_000;
/** A kpass value must never be readable as a flag. */
const plainArg = (v: string) => v.length > 0 && !v.startsWith('-');

/**
 * Error codes Kite documents as "nothing was sent / paid / moved" for `session execute`, with their documented exit
 * code (x402-execute SKILL.md Error Handling and references/commands.md). They prove only that THIS invocation moved
 * nothing, so they are returned as not-sent (the broker honours that only on a first send, never on a replay).
 */
const PRE_SPEND: Readonly<Record<string, number>> = Object.freeze({
  idempotency_key_required: 2,
  no_payment_requirement: 2,
  merchant_unsupported: 2,
  route_unavailable: 2,
  route_uneconomical: 2,
  routing_cost_exceeded: 2,
  slippage_exceeded: 2,
  unsupported_asset: 2,
  provider_unavailable: 1,
  allowance_unavailable: 4,
  wallet_empty: 6,
  separate_session_used_up: 6,
});

/** Decimal USD (as kpass prints caps and amounts) to integer cents; null unless exactly representable. */
export function decimalUsdToMinor(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,18}))?$/.exec(v);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (/[^0]/.test(frac.slice(2))) return null;
  return BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2));
}

/** Minor units (2-decimal currencies) to the decimal string the delegation schema expects. */
export function minorToDecimal(minor: bigint): string {
  const s = minor.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Kite's Passport web host (request-session docs: the CLI opens approval pages on it only). */
const PASSPORT_WEB_HOST = 'agentpassport.ai';
function isPassportApprovalUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      u.port === '' &&
      (u.hostname === PASSPORT_WEB_HOST || u.hostname.endsWith(`.${PASSPORT_WEB_HOST}`))
    );
  } catch {
    return false;
  }
}

function assertEndpoint(merchantId: string, e: KitePassportEndpoint) {
  let u: URL;
  try {
    u = new URL(e.url);
  } catch {
    throw new Error(`Kite merchant endpoint for ${merchantId} is not a URL`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.hash ||
    u.port !== '' ||
    isIP(host) !== 0 ||
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    false
  )
    throw new Error(`Kite merchant endpoint for ${merchantId} must be a plain public https URL`);
  // Only GET can be executed (no body is ever sent): a POST endpoint would let an operator approve an unusable session.
  if (e.method !== 'GET') throw new Error(`Kite merchant endpoint for ${merchantId} must use GET`);
}

type Run = {
  exitCode: number;
  json: Record<string, unknown> | null;
  stdout: string;
  digest: string | null;
  timedOut: boolean;
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class KitePassportAdapter implements PaidAdapter {
  readonly adapterId = 'kite-passport-kpass';
  readonly resultOrigin = 'KITE_PASSPORT' as const;
  readonly capability: ReconciliationCapability;
  readonly #cfg: KitePassportConfig;
  readonly #taps: KitePassportTaps;
  readonly #mayExecute: boolean;

  constructor(cfg: KitePassportConfig, taps: KitePassportTaps = {}) {
    if (!path.isAbsolute(cfg.kpassBinary)) throw new Error('kpassBinary must be an absolute path');
    if (!path.isAbsolute(cfg.stateRoot)) throw new Error('stateRoot must be an absolute path');
    for (const [id, e] of Object.entries(cfg.merchantEndpoints)) assertEndpoint(id, e);
    this.#cfg = Object.freeze({
      ...cfg,
      merchantEndpoints: Object.freeze(
        Object.fromEntries(Object.entries(cfg.merchantEndpoints).map(([k, v]) => [k, Object.freeze({ ...v })])),
      ),
    });
    this.#taps = taps;
    this.capability = Object.freeze({
      lookupByClientOperation: false,
      sameKeyReplay: cfg.sameKeyReplayVerified === true,
    });
    this.#mayExecute = cfg.sameKeyReplayVerified === true || cfg.manualReconciliationAccepted === true;
  }

  toJSON() {
    return { adapterId: this.adapterId, resultOrigin: this.resultOrigin };
  }

  /**
   * kpass 6.13.2 discovers a project-level `.kite-passport` by walking up from its working directory before it falls
   * back to $HOME (observed 2026-11-13). Unless the state root holds its own private `.kite-passport`, kpass could
   * resolve to another login (for example the user's interactive one) and its current session: nothing runs then.
   */
  stateReady(): boolean {
    try {
      const st = lstatSync(path.join(this.#cfg.stateRoot, '.kite-passport'));
      return (
        st.isDirectory() &&
        (st.mode & 0o077) === 0 &&
        (typeof process.getuid !== 'function' || st.uid === process.getuid())
      );
    } catch {
      return false;
    }
  }

  #endpoint(merchantId: string): KitePassportEndpoint | null {
    return Object.hasOwn(this.#cfg.merchantEndpoints, merchantId) ? this.#cfg.merchantEndpoints[merchantId]! : null;
  }

  assess(intent: AuthorizedIntent): CapabilityAssessment {
    if (!this.#mayExecute) return { kind: 'UNSUPPORTED', reasonCode: 'KITE_NO_VERIFIED_RECONCILIATION' };
    // Execution is bound to THIS authority's confirmed session (never kpass's "current" session or the allowance).
    if (!intent.providerSessionRef || !REQUEST_ID.test(intent.providerSessionRef))
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_SESSION_NOT_BOUND' };
    if (!this.#endpoint(intent.merchantId))
      return { kind: 'UNSUPPORTED', reasonCode: 'MERCHANT_ENDPOINT_NOT_ALLOWLISTED' };
    if (intent.currency !== KITE_HARD_CAPS.currency)
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_CURRENCY_UNSUPPORTED' };
    if (intent.amountMinor <= 0n || intent.amountMinor > KITE_HARD_CAPS.perCallMinor)
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_HARD_CAP_EXCEEDED' };
    return { kind: 'ELIGIBLE' };
  }

  assessSession(scope: AuthorizedSessionScope): CapabilityAssessment {
    if (scope.currency !== KITE_HARD_CAPS.currency)
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_CURRENCY_UNSUPPORTED' };
    if (!this.#endpoint(scope.merchantId))
      return { kind: 'UNSUPPORTED', reasonCode: 'MERCHANT_ENDPOINT_NOT_ALLOWLISTED' };
    if (
      scope.perActionLimitMinor <= 0n ||
      scope.perActionLimitMinor > KITE_HARD_CAPS.perCallMinor ||
      scope.baseLimitMinor < scope.perActionLimitMinor ||
      scope.baseLimitMinor > KITE_HARD_CAPS.sessionTotalMinor
    )
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_HARD_CAP_EXCEEDED' };
    // The provider session may never outlive the authority; too little lifetime left is refused, not rounded up.
    if (!Number.isInteger(scope.remainingSeconds) || scope.remainingSeconds < MIN_SESSION_TTL_SECONDS)
      return { kind: 'UNSUPPORTED', reasonCode: 'AUTHORITY_LIFETIME_TOO_SHORT' };
    return { kind: 'ELIGIBLE' };
  }

  prepare(intent: AuthorizedIntent): PreparedRequest {
    const ep = this.#endpoint(intent.merchantId);
    if (!ep) throw new Error('merchant endpoint not allowlisted');
    const body = {
      url: ep.url,
      method: ep.method,
      merchantId: intent.merchantId,
      purpose: intent.purpose,
      amountMinor: intent.amountMinor.toString(),
      currency: intent.currency,
      boundSessionRequest: intent.providerSessionRef ?? '',
    };
    return { requestDigest: sha(canonicalize(body)), body };
  }

  /**
   * `kpass session execute --session-id <bound> --url <exact> --method <m> --idempotency-key <k>`. The key is the
   * pre-egress operation key (kpass forwards it to Passport as the Idempotency-Key header). No body, headers or internal
   * identifier is sent: a GET's parameters are already in the bound URL. Never `--use-allowance`.
   */
  async execute(request: PreparedRequest, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome> {
    const b = request.body;
    const amountMinor = /^[0-9]{1,18}$/.test(b.amountMinor ?? '') ? BigInt(b.amountMinor!) : -1n;
    if (amountMinor <= 0n || amountMinor > KITE_HARD_CAPS.perCallMinor || b.currency !== KITE_HARD_CAPS.currency)
      return this.notSent('KITE_HARD_CAP_EXCEEDED');
    const ep = this.#endpoint(b.merchantId ?? '');
    // The prepared request must still be exactly the allowlisted endpoint (URL, method and host binding).
    if (!ep || ep.url !== b.url || ep.method !== b.method) return this.notSent('MERCHANT_ENDPOINT_NOT_ALLOWLISTED');
    if (ep.method !== 'GET') return this.notSent('KITE_METHOD_UNSUPPORTED');
    if (!OP_KEY.test(op.idempotencyKey)) return this.notSent('KITE_OPERATION_KEY_INVALID');
    const bound = b.boundSessionRequest ?? '';
    if (!REQUEST_ID.test(bound)) return this.notSent('KITE_SESSION_NOT_BOUND');
    if (!this.stateReady()) return this.notSent('KITE_STATE_ROOT_NOT_INITIALIZED');
    // Resolve the bound session from its approval request (a non-paying status read) and require it active, unexpired
    // and capped inside the hard caps before any paid command.
    const st = await this.run(['session', 'status', '--request-id', bound], null, this.readTimeout);
    if (!this.answersFor(st, bound)) return this.notSent('KITE_BOUND_SESSION_UNRESOLVED');
    const session = obj(st.json?.session);
    const sessionId = str(session?.id) ?? str(st.json?.session_id);
    if (st.timedOut || st.exitCode !== 0 || !sessionId || !SESSION_ID.test(sessionId))
      return this.notSent('KITE_BOUND_SESSION_UNRESOLVED');
    if (session?.status !== 'active') return this.notSent('KITE_BOUND_SESSION_NOT_ACTIVE');
    const expires = Date.parse(str(session.expires_at) ?? '');
    if (!Number.isFinite(expires) || expires <= Date.now()) return this.notSent('KITE_BOUND_SESSION_EXPIRED');
    const policy = obj(obj(session.delegation)?.payment_policy);
    const perTx = decimalUsdToMinor(policy?.max_amount_per_tx);
    const total = decimalUsdToMinor(policy?.max_total_amount);
    const currency = str(policy?.currency) ?? 'USD';
    if (
      perTx === null ||
      total === null ||
      currency !== KITE_HARD_CAPS.currency ||
      perTx > KITE_HARD_CAPS.perCallMinor ||
      total > KITE_HARD_CAPS.sessionTotalMinor
    )
      return this.notSent('KITE_BOUND_SESSION_CAPS_EXCEED');
    if (!plainArg(sessionId) || !plainArg(ep.url)) return this.notSent('KITE_BOUND_SESSION_UNRESOLVED');
    const args = [
      'session',
      'execute',
      '--session-id',
      sessionId,
      '--url',
      ep.url,
      '--method',
      ep.method,
      '--idempotency-key',
      op.idempotencyKey,
      '--no-browser',
    ];
    const r = await this.run(args, hooks, this.#cfg.timeoutMs);
    const out = this.executeOutcome(r, sessionId, amountMinor);
    this.#taps.onExecuted?.(this.executeRecord(r, sessionId, out));
    return out;
  }

  private executeOutcome(r: Run, sessionId: string, amountMinor: bigint): AdapterOutcome {
    if (r.timedOut || r.json === null) return this.unknown('KPASS_NO_RESULT', r);
    const j = r.json;
    const code = str(j.error_code);
    const details = obj(j.details);
    if (r.exitCode === 0 && j.status === 'success') {
      const x402 = obj(j.x402);
      // Paid by anything but the authority's own session (another session, the account allowance): never confirmed.
      if (j.source === 'allowance' || str(j.session_id) !== sessionId)
        return this.unknown('KITE_PAID_OUTSIDE_BOUND_SESSION', r);
      const status = Number(x402?.status_code);
      if (!Number.isInteger(status) || status < 200 || status > 299) return this.unknown('KITE_MERCHANT_NON_2XX', r);
      const req = obj(j.payment_requirement);
      if (str(req?.asset) !== 'USDC') return this.unknown('KITE_UNEXPECTED_ASSET', r);
      if (x402?.chain_id !== undefined && x402.chain_id !== BASE_CHAIN_ID)
        return this.unknown('KITE_UNEXPECTED_CHAIN', r);
      // kpass prints the paid amount as a decimal of the budget currency (USD), e.g. "0.01".
      const captured = decimalUsdToMinor(req?.amount);
      if (captured === null || captured <= 0n) return this.unknown('KPASS_AMOUNT_NOT_MINOR_UNITS', r);
      if (captured > amountMinor) return this.unknown('KITE_CAPTURE_ABOVE_INTENT', r);
      const ref = str(obj(obj(j.payment)?.payment_response)?.reference);
      return {
        kind: 'CONFIRMED',
        providerRef: ref && PROVIDER_REF.test(ref) ? ref : null,
        capturedMinor: captured,
        returns: [],
        ...this.obs(r, 'success'),
      };
    }
    if (code && PRE_SPEND[code] === r.exitCode)
      return {
        kind: 'FAILED',
        reasonCode: 'KITE_PRE_SPEND_REFUSAL',
        effect: 'NO_EFFECT_PROVED',
        // Documented as "nothing sent/paid" for THIS invocation only; the broker honours it only on a first send.
        notSent: true,
        ...this.obs(r, code),
      };
    if (r.exitCode === 7)
      return this.unknown(
        details?.outcome === 'merchant_failed_held' ? 'KITE_MERCHANT_FAILED_HELD' : 'KITE_PAYMENT_OUTCOME_PENDING',
        r,
      );
    if (code === 'payment_settled_unfulfilled') return this.unknown('KITE_SETTLED_UNFULFILLED', r);
    // Policy refusals, routing failures with ambiguous funds and everything undocumented stay UNKNOWN.
    return this.unknown('KPASS_UNRESOLVED', r);
  }

  private executeRecord(r: Run, sessionId: string, out: AdapterOutcome): KpassExecuteRecord {
    const j = r.json ?? {};
    const x402 = obj(j.x402);
    const body = str(x402?.response_body);
    const status = Number(x402?.status_code);
    const chain = x402?.chain_id;
    return {
      observedAt: out.observedAt,
      exitCode: r.exitCode,
      statusCode: Number.isInteger(status) ? status : null,
      responseBody: body,
      responseSha256: body === null ? null : hex(body),
      paymentReference: str(obj(obj(j.payment)?.payment_response)?.reference),
      amount: str(obj(j.payment_requirement)?.amount),
      asset: str(obj(j.payment_requirement)?.asset),
      chainId: typeof chain === 'number' ? chain : null,
      spentTotal: str(obj(j.usage)?.spent_total),
      source: str(j.source),
      sessionMatched: str(j.session_id) === sessionId,
      errorCode: str(j.error_code),
      outcome: out.kind,
      reasonCode: 'reasonCode' in out ? out.reasonCode : null,
      rawResponseDigest: r.digest,
    };
  }

  async lookup(_locator: ReconciliationLocator): Promise<AdapterOutcome> {
    return unsupported('KITE_NO_LOOKUP_BY_CLIENT_KEY');
  }

  /** `kpass session create --delegation <json> --separate --no-reuse --no-browser`: a human approves it with a passkey. */
  async activateSession(
    scope: AuthorizedSessionScope,
    _op: ClientOperation,
    hooks: SendHooks,
  ): Promise<AdapterOutcome> {
    const cap = this.assessSession(scope);
    if (cap.kind !== 'ELIGIBLE') return this.notSent(cap.reasonCode);
    if (!this.stateReady()) return this.notSent('KITE_STATE_ROOT_NOT_INITIALIZED');
    const ep = this.#endpoint(scope.merchantId)!;
    const u = new URL(ep.url);
    const ttl = scope.remainingSeconds; // database-clock remaining lifetime: never more than the authority
    const summary = `UptimeBuyer: ${scope.purpose} via ${u.hostname}`.slice(0, 80);
    const delegation = {
      task: { summary },
      payment_policy: {
        max_amount_per_tx: minorToDecimal(scope.perActionLimitMinor),
        max_total_amount: minorToDecimal(scope.baseLimitMinor),
        ttl_seconds: ttl,
        currency: scope.currency,
      },
      // Recorded with the session (Kite does not enforce it on paid calls today; the broker binds the URL itself).
      execution_constraints: {
        x402: {
          scope_mode: 'scoped',
          allowed_endpoints: [{ method: ep.method, host: u.hostname, path_prefix: u.pathname }],
        },
      },
      // Same-chain only: no bridge or swap cost can be added to the capped amount.
      routing_enabled: false,
    };
    const r = await this.run(
      ['session', 'create', '--delegation', JSON.stringify(delegation), '--separate', '--no-reuse', '--no-browser'],
      hooks,
      this.readTimeout,
    );
    const out = this.sessionOutcome(r);
    const j = r.json ?? {};
    const approvalUrl = str(j.approval_url);
    if (out.kind === 'ACCEPTED' && out.providerRef && approvalUrl && isPassportApprovalUrl(approvalUrl))
      this.#taps.onApprovalRequired?.({ requestId: out.providerRef, approvalUrl, expiresAt: str(j.expires_at) });
    return out;
  }

  async lookupSession(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    if (!locator.providerRef || !REQUEST_ID.test(locator.providerRef))
      return unsupported('KITE_NO_SESSION_LOOKUP_WITHOUT_REQUEST_ID');
    const r = await this.run(['session', 'status', '--request-id', locator.providerRef], null, this.readTimeout);
    // An answer about another approval request is never taken for this one.
    if (!this.answersFor(r, locator.providerRef)) return this.unknown('KPASS_SESSION_UNRESOLVED', r);
    return this.sessionOutcome(r);
  }

  /** A status answer names no request id, or exactly the one asked about. */
  private answersFor(r: Run, requestId: string): boolean {
    const named = r.json?.request_id;
    return named === undefined || named === requestId;
  }

  /** Read-only: the bound session's status and Kite's own spent total (for reconciliation evidence). */
  async sessionUsage(requestRef: string): Promise<{ status: string | null; spentTotal: string | null } | null> {
    if (!REQUEST_ID.test(requestRef)) return null;
    const r = await this.run(['session', 'status', '--request-id', requestRef], null, this.readTimeout);
    if (r.timedOut || r.exitCode !== 0 || !r.json || !this.answersFor(r, requestRef)) return null;
    const s = obj(r.json.session);
    return { status: str(s?.status), spentTotal: str(obj(s?.usage)?.spent_total) };
  }

  /** Read-only readiness: `kpass status`, `allowance status`, `wallet balance` (no bind, no spend). */
  async readiness(): Promise<KiteReadiness> {
    if (!this.stateReady())
      return {
        loggedIn: false,
        agentRegistered: false,
        agentIdSha256: null,
        allowanceSet: true,
        allowanceState: null,
        baseUsdcMicros: null,
      };
    const st = await this.run(['status'], null, this.readTimeout);
    const al = await this.run(['allowance', 'status'], null, this.readTimeout);
    const wb = await this.run(['wallet', 'balance'], null, this.readTimeout);
    const user = obj(st.json?.user);
    const agent = obj(st.json?.agent);
    const agentId = str(agent?.agent_id);
    let baseUsdcMicros: bigint | null = null;
    if (wb.exitCode === 0 && Array.isArray(wb.json?.assets))
      for (const a of wb.json.assets as unknown[]) {
        const asset = obj(a);
        if (asset?.asset !== 'USDC' || asset.decimals !== 6 || !Array.isArray(asset.chains)) continue;
        for (const c of asset.chains as unknown[]) {
          const chain = obj(c);
          const m = /^([0-9]{1,12})\.([0-9]{6})$/.exec(str(chain?.amount) ?? '');
          if (chain?.chain === 'base' && m) baseUsdcMicros = BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!);
        }
      }
    return {
      loggedIn: st.exitCode === 0 && user?.logged_in === true && user?.jwt_valid === true,
      agentRegistered: st.exitCode === 0 && agent?.registered === true && agentId !== null,
      agentIdSha256: agentId ? hex(agentId) : null,
      allowanceSet: al.exitCode !== 0 || al.json?.set !== false,
      allowanceState: al.exitCode === 0 ? str(al.json?.state) : null,
      baseUsdcMicros,
    };
  }

  private get readTimeout() {
    return this.#cfg.readTimeoutMs ?? DEFAULT_KPASS_READ_TIMEOUT_MS;
  }

  private sessionOutcome(r: Run): AdapterOutcome {
    if (r.timedOut || r.json === null) return this.unknown('KPASS_NO_RESULT', r);
    const j = r.json;
    const status = str(j.status) ?? '';
    const requestId = typeof j.request_id === 'string' && REQUEST_ID.test(j.request_id) ? j.request_id : null;
    const session = obj(j.session);
    if (r.exitCode === 0 && status === 'success' && session?.status === 'active')
      return { kind: 'CONFIRMED', providerRef: requestId, capturedMinor: 0n, returns: [], ...this.obs(r, 'active') };
    if (r.exitCode === 0 && (status === 'human_action_required' || status === 'pending') && requestId)
      return { kind: 'ACCEPTED', providerRef: requestId, ...this.obs(r, status) };
    // Documented terminal answers of `session status` (exit 3): no session exists, so nothing can be spent from it.
    const error = str(j.error) ?? '';
    if (r.exitCode === 3 && /rejected by the user/i.test(error))
      return {
        kind: 'FAILED',
        reasonCode: 'KITE_SESSION_REJECTED',
        effect: 'NO_EFFECT_PROVED',
        ...this.obs(r, 'rejected'),
      };
    if (r.exitCode === 3 && /expired before approval/i.test(error))
      return {
        kind: 'FAILED',
        reasonCode: 'KITE_SESSION_REQUEST_EXPIRED',
        effect: 'NO_EFFECT_PROVED',
        ...this.obs(r, 'request_expired'),
      };
    return this.unknown('KPASS_SESSION_UNRESOLVED', r);
  }

  /** Definitely nothing was handed to Kite (no paying command ran): a no-effect refusal, never REQUESTED. */
  private notSent(reasonCode: string): AdapterOutcome {
    return {
      kind: 'FAILED',
      reasonCode,
      effect: 'NO_EFFECT_PROVED',
      notSent: true,
      rawProviderStatus: null,
      rawResponseDigest: null,
      observedAt: nowIso(),
    };
  }

  private obs(r: Run, status: string) {
    return { rawProviderStatus: status.slice(0, 64), rawResponseDigest: r.digest, observedAt: nowIso() };
  }
  private unknown(reasonCode: string, r: Run): AdapterOutcome {
    return {
      kind: 'UNKNOWN',
      providerRef: null,
      reasonCode,
      rawProviderStatus: `exit_${r.exitCode}`,
      rawResponseDigest: r.digest,
      observedAt: nowIso(),
    };
  }

  private run(args: string[], hooks: SendHooks | null, timeoutMs: number): Promise<Run> {
    // Never spawn kpass against anything but the broker's own initialized state (see stateReady).
    if (!this.stateReady())
      return Promise.resolve({ exitCode: -2, json: null, stdout: '', digest: null, timedOut: false });
    const full = [
      ...args,
      ...(this.#cfg.baseUrl ? ['--base-url', this.#cfg.baseUrl] : []),
      '--no-interactive',
      '--output',
      'json',
    ];
    return new Promise((resolve) => {
      const child = execFile(
        this.#cfg.kpassBinary,
        full,
        {
          cwd: this.#cfg.stateRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/local/bin',
            HOME: this.#cfg.stateRoot,
            KPASS_NO_COLOR: '1',
            KPASS_NO_UPDATE_CHECK: '1',
            KPASS_AUTO_UPGRADE: '0',
            KPASS_NO_BROWSER: '1',
          },
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT,
          windowsHide: true,
          shell: false,
        },
        (error, stdout) => {
          const out = String(stdout ?? '');
          let json: Record<string, unknown> | null;
          try {
            const parsed: unknown = out.trim() ? JSON.parse(out) : null;
            json = obj(parsed) ?? null;
          } catch {
            json = null;
          }
          const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({
            exitCode: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            json,
            stdout: out,
            digest: out ? sha(out) : null,
            timedOut: Boolean(e?.killed),
          });
        },
      );
      child.on('spawn', () => hooks?.onHandoff());
    });
  }
}
