// KITE_PASSPORT adapter (credential-bearing; lives only in the broker). Kite publishes no HTTP API reference (checked
// 2026-11-05, docs.gokite.ai/llms/api-reference.txt): agents drive the `kpass` CLI, which keeps the user JWT, agent
// token and session signing key in its own state directory. This adapter therefore runs `kpass ... --output json`
// with an argument vector (never a shell), a minimal environment whose HOME is the broker-only state root, a hard
// timeout and a bounded output size. It is constructed ONLY from explicit broker secret configuration; without it the
// broker uses UnconfiguredAdapter and performs no network I/O. See docs/adr/0003-kite-broker.md for every unverified
// detail. Kite documents no payment lookup by client key, so autonomous execution stays UNSUPPORTED unless the
// operator explicitly records that Kite's same-key replay has been verified for this account.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

export interface KitePassportConfig {
  kpassBinary: string;
  /** Directory used as HOME for kpass (holds `.kite-passport/`); 0700, broker-only. */
  stateRoot: string;
  /** Optional backend override (the CLI's `--base-url`); unset uses the CLI default. */
  baseUrl?: string;
  timeoutMs: number;
  /** Allowlisted paid endpoints per merchant id; nothing else is ever called. */
  merchantEndpoints: Record<string, { url: string; method: 'GET' | 'POST' }>;
  /** Operator-recorded verification that Kite returns the original result on same-key retry. Default false. */
  sameKeyReplayVerified?: boolean;
}

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const nowIso = () => new Date().toISOString();
const MAX_OUTPUT = 256 * 1024;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,120}$/;

type Run = { exitCode: number; json: Record<string, unknown> | null; digest: string | null; timedOut: boolean };

export class KitePassportAdapter implements PaidAdapter {
  readonly adapterId = 'kite-passport-kpass';
  readonly resultOrigin = 'KITE_PASSPORT' as const;
  readonly capability: ReconciliationCapability;
  readonly #cfg: KitePassportConfig;

  constructor(cfg: KitePassportConfig) {
    for (const e of Object.values(cfg.merchantEndpoints)) {
      const u = new URL(e.url);
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Kite merchant endpoints must be https');
    }
    this.#cfg = Object.freeze({ ...cfg, merchantEndpoints: Object.freeze({ ...cfg.merchantEndpoints }) });
    this.capability = Object.freeze({
      lookupByClientOperation: false,
      sameKeyReplay: cfg.sameKeyReplayVerified === true,
    });
  }

  toJSON() {
    return { adapterId: this.adapterId, resultOrigin: this.resultOrigin };
  }

  assess(intent: AuthorizedIntent): CapabilityAssessment {
    if (!this.capability.sameKeyReplay) return { kind: 'UNSUPPORTED', reasonCode: 'KITE_NO_VERIFIED_RECONCILIATION' };
    // Execution is bound to THIS authority's confirmed session (never kpass's "current" session or the allowance).
    if (!intent.providerSessionRef || !REQUEST_ID.test(intent.providerSessionRef))
      return { kind: 'UNSUPPORTED', reasonCode: 'KITE_SESSION_NOT_BOUND' };
    if (!Object.hasOwn(this.#cfg.merchantEndpoints, intent.merchantId))
      return { kind: 'UNSUPPORTED', reasonCode: 'MERCHANT_ENDPOINT_NOT_ALLOWLISTED' };
    if (intent.currency !== 'USD') return { kind: 'UNSUPPORTED', reasonCode: 'KITE_CURRENCY_UNSUPPORTED' };
    return { kind: 'ELIGIBLE' };
  }

  assessSession(scope: AuthorizedSessionScope): CapabilityAssessment {
    return scope.currency === 'USD'
      ? { kind: 'ELIGIBLE' }
      : { kind: 'UNSUPPORTED', reasonCode: 'KITE_CURRENCY_UNSUPPORTED' };
  }

  prepare(intent: AuthorizedIntent): PreparedRequest {
    const ep = this.#cfg.merchantEndpoints[intent.merchantId]!;
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

  /** `kpass session execute`; the idempotency key is forwarded by the CLI as an Idempotency-Key header. */
  async execute(request: PreparedRequest, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome> {
    // Resolve the bound session id from its approval request (a non-paying status read) and require it active.
    const bound = request.body.boundSessionRequest ?? '';
    if (!REQUEST_ID.test(bound)) return this.notSent('KITE_SESSION_NOT_BOUND');
    const st = await this.run(['session', 'status', '--request-id', bound, '--output', 'json'], null);
    const session = st.json?.session as Record<string, unknown> | undefined;
    const sessionId =
      typeof session?.id === 'string'
        ? session.id
        : typeof st.json?.session_id === 'string'
          ? st.json.session_id
          : null;
    if (st.timedOut || st.exitCode !== 0 || !sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
      return this.notSent('KITE_BOUND_SESSION_UNRESOLVED');
    if (session?.status !== 'active') return this.notSent('KITE_BOUND_SESSION_NOT_ACTIVE');
    const args = [
      'session',
      'execute',
      '--session-id',
      sessionId,
      '--url',
      request.body.url!,
      '--method',
      request.body.method!,
      '--body',
      JSON.stringify({ purpose: request.body.purpose, clientOperationId: op.clientOperationId }),
      '--idempotency-key',
      op.idempotencyKey,
      '--output',
      'json',
    ];
    const r = await this.run(args, hooks);
    if (r.timedOut || r.json === null) return this.unknown('KPASS_NO_RESULT', r);
    const x402 = (r.json.x402 ?? (r.json.data as Record<string, unknown> | undefined)?.x402) as
      Record<string, unknown> | undefined;
    const req = (r.json.payment_requirement ?? {}) as Record<string, unknown>;
    if (r.exitCode === 0 && x402 && Number(x402.status_code) >= 200 && Number(x402.status_code) < 300) {
      // UNVERIFIED: payment_requirement.amount is read as minor units of the session currency (see ADR 0003).
      const amount = String(req.amount ?? '');
      if (!/^[0-9]{1,18}$/.test(amount)) return this.unknown('KPASS_AMOUNT_UNREADABLE', r);
      return {
        kind: 'CONFIRMED',
        providerRef: null,
        capturedMinor: BigInt(amount),
        returns: [],
        ...this.obs(r, 'success'),
      };
    }
    if (r.exitCode === 8)
      return {
        kind: 'FAILED',
        reasonCode: 'KPASS_LOCAL_REFUSAL',
        effect: 'NO_EFFECT_PROVED',
        ...this.obs(r, 'local_refusal'),
      };
    // Policy refusals, pending outcomes (exit 7) and everything else stay UNKNOWN: Kite's no-effect semantics are unverified.
    return this.unknown(r.exitCode === 7 ? 'KITE_PAYMENT_OUTCOME_PENDING' : 'KPASS_UNRESOLVED', r);
  }

  async lookup(_locator: ReconciliationLocator): Promise<AdapterOutcome> {
    return unsupported('KITE_NO_LOOKUP_BY_CLIENT_KEY');
  }

  /** `kpass session create --delegation <json> --separate`: a human approves it through the passkey page. */
  async activateSession(
    scope: AuthorizedSessionScope,
    _op: ClientOperation,
    hooks: SendHooks,
  ): Promise<AdapterOutcome> {
    const ttl = Math.max(60, Math.floor((Date.parse(scope.expiresAt) - Date.now()) / 1000));
    const delegation = {
      task: { summary: `UptimeBuyer bounded authority ${scope.executionAuthorityId}` },
      payment_policy: {
        max_amount_per_tx: minorToDecimal(scope.perActionLimitMinor),
        max_total_amount: minorToDecimal(scope.baseLimitMinor),
        ttl_seconds: ttl,
        currency: scope.currency,
      },
    };
    const r = await this.run(
      ['session', 'create', '--delegation', JSON.stringify(delegation), '--separate', '--output', 'json'],
      hooks,
    );
    return this.sessionOutcome(r);
  }

  async lookupSession(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    if (!locator.providerRef || !REQUEST_ID.test(locator.providerRef))
      return unsupported('KITE_NO_SESSION_LOOKUP_WITHOUT_REQUEST_ID');
    return this.sessionOutcome(
      await this.run(['session', 'status', '--request-id', locator.providerRef, '--output', 'json'], null),
    );
  }

  private sessionOutcome(r: Run): AdapterOutcome {
    if (r.timedOut || r.json === null) return this.unknown('KPASS_NO_RESULT', r);
    const j = r.json;
    const status = String(j.status ?? '');
    const requestId = typeof j.request_id === 'string' ? j.request_id : null;
    const session = j.session as Record<string, unknown> | undefined;
    if (session && session.status === 'active')
      return { kind: 'CONFIRMED', providerRef: requestId, capturedMinor: 0n, returns: [], ...this.obs(r, 'active') };
    if (status === 'human_action_required' && requestId)
      return { kind: 'ACCEPTED', providerRef: requestId, ...this.obs(r, status) };
    return this.unknown('KPASS_SESSION_UNRESOLVED', r);
  }

  /** Definitely nothing was handed to Kite (no payment command ran): a no-effect refusal, never REQUESTED. */
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

  private run(args: string[], hooks: SendHooks | null): Promise<Run> {
    const full = this.#cfg.baseUrl ? [...args, '--base-url', this.#cfg.baseUrl] : args;
    return new Promise((resolve) => {
      const child = execFile(
        this.#cfg.kpassBinary,
        full,
        {
          env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: this.#cfg.stateRoot, KPASS_NO_COLOR: '1' },
          timeout: this.#cfg.timeoutMs,
          maxBuffer: MAX_OUTPUT,
          windowsHide: true,
          shell: false,
        },
        (error, stdout) => {
          const out = String(stdout ?? '');
          let json: Record<string, unknown> | null;
          try {
            json = out.trim() ? (JSON.parse(out) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({
            exitCode: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            json,
            digest: out ? sha(out) : null,
            timedOut: Boolean(e?.killed),
          });
        },
      );
      child.on('spawn', () => hooks?.onHandoff());
    });
  }
}

/** Minor units (2-decimal currencies) to the decimal string the delegation schema expects. */
export function minorToDecimal(minor: bigint): string {
  const s = minor.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
