// RECORDED_CONTRACT adapter: an in-memory, scriptable provider that follows the same contract as the LOCAL_STAND_IN
// (lookup by client operation, fencing of unknown keys, provider-enforced same-key replay, refunds/reversals). It is
// NOT Kite and NOT a provider; it performs no I/O and every result it produces is labelled RECORDED_CONTRACT. Tests
// use it for deterministic interleavings; the separate-process tests use the real HTTPS LOCAL_STAND_IN instead.
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
  ProviderReturn,
  ReconciliationCapability,
  ReconciliationLocator,
  SendHooks,
} from './port.js';
import { unsupported } from './port.js';

export type RecordedMode = 'SETTLE' | 'ACCEPT_ONLY' | 'DECLINE' | 'DROP_RESPONSE' | 'TIMEOUT_BEFORE_HANDOFF' | 'HANG';

interface Effect {
  ref: string;
  amountMinor: bigint;
  status: 'SETTLED' | 'ACCEPTED' | 'DECLINED';
  returns: ProviderReturn[];
  requestDigest: string;
}

const digest = (v: unknown) =>
  `sha256:${createHash('sha256')
    .update(canonicalize(v as never))
    .digest('hex')}`;
const now = () => new Date().toISOString();

export class RecordedContractAdapter implements PaidAdapter {
  readonly adapterId = 'recorded-contract';
  readonly resultOrigin = 'RECORDED_CONTRACT' as const;
  capability: ReconciliationCapability;
  readonly effects = new Map<string, Effect>();
  readonly sessions = new Map<string, { ref: string; status: 'ACTIVE' | 'PENDING' }>();
  readonly fenced = new Set<string>();
  executeCalls = 0;
  lookupCalls = 0;
  nextModes: RecordedMode[] = [];
  sessionModes: ('CONFIRM' | 'PENDING' | 'DROP_RESPONSE' | 'DECLINE')[] = [];
  lookupMode: 'NORMAL' | 'UNAVAILABLE' | 'UNSUPPORTED' = 'NORMAL';
  /** Resolves a HANG execution (tests release it). */
  private hanging: (() => void)[] = [];
  /** Every intent and session scope the broker authorized (inspection only). */
  readonly assessed: AuthorizedIntent[] = [];
  readonly sessionScopes: AuthorizedSessionScope[] = [];
  /** When set, a settled payment captures this instead of the requested amount (over-capture probes). */
  captureOverride: bigint | null = null;

  constructor(capability: Partial<ReconciliationCapability> = {}) {
    this.capability = { lookupByClientOperation: true, sameKeyReplay: true, ...capability };
  }

  releaseHanging() {
    for (const r of this.hanging.splice(0)) r();
  }

  assess(intent: AuthorizedIntent): CapabilityAssessment {
    this.assessed.push(intent);
    return this.capability.lookupByClientOperation || this.capability.sameKeyReplay
      ? { kind: 'ELIGIBLE' }
      : { kind: 'UNSUPPORTED', reasonCode: 'NO_AUTHORITATIVE_RECONCILIATION' };
  }
  assessSession(scope: AuthorizedSessionScope): CapabilityAssessment {
    this.sessionScopes.push(scope);
    return { kind: 'ELIGIBLE' };
  }

  prepare(intent: AuthorizedIntent): PreparedRequest {
    const body = {
      merchantId: intent.merchantId,
      purpose: intent.purpose,
      amountMinor: intent.amountMinor.toString(),
      currency: intent.currency,
      operation: intent.semanticOperation,
    };
    return { requestDigest: digest(body), body };
  }

  async execute(request: PreparedRequest, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome> {
    const mode = this.nextModes.shift() ?? 'SETTLE';
    if (mode === 'TIMEOUT_BEFORE_HANDOFF') return this.unknown('TIMEOUT');
    if (mode === 'REFUSE_NOT_SENT')
      return { ...this.failed('BOUND_SESSION_NOT_ACTIVE'), notSent: true } as AdapterOutcome;
    hooks.onHandoff();
    this.executeCalls++;
    if (this.fenced.has(op.idempotencyKey)) return this.failed('KEY_FENCED_NO_EFFECT');
    const existing = this.effects.get(op.idempotencyKey);
    if (existing) {
      // Provider-enforced same-key replay: the original effect, never a second one.
      return existing.requestDigest === request.requestDigest
        ? this.outcomeOf(existing)
        : this.failed('IDEMPOTENCY_KEY_CONFLICT');
    }
    if (mode === 'DECLINE') return this.failed('PROVIDER_DECLINED');
    const effect: Effect = {
      ref: `rec_${op.clientOperationId.slice(3, 15)}`,
      amountMinor: this.captureOverride ?? BigInt(request.body.amountMinor!),
      status: mode === 'ACCEPT_ONLY' ? 'ACCEPTED' : 'SETTLED',
      returns: [],
      requestDigest: request.requestDigest,
    };
    this.effects.set(op.idempotencyKey, effect);
    if (mode === 'DROP_RESPONSE') return this.unknown('RESPONSE_LOST');
    if (mode === 'HANG') {
      await new Promise<void>((r) => this.hanging.push(r));
      return this.unknown('TIMEOUT');
    }
    return this.outcomeOf(effect);
  }

  async lookup(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    this.lookupCalls++;
    if (this.lookupMode === 'UNAVAILABLE') throw new Error('lookup unavailable');
    if (this.lookupMode === 'UNSUPPORTED') return unsupported('LOOKUP_NOT_SUPPORTED_BY_PROVIDER');
    const effect = this.effects.get(locator.idempotencyKey);
    if (!effect) {
      // Not found: the provider fences the key, so a late copy can never take effect -> authoritative no-effect.
      this.fenced.add(locator.idempotencyKey);
      return this.failed('NOT_FOUND_KEY_FENCED');
    }
    return this.outcomeOf(effect);
  }

  async activateSession(
    _scope: AuthorizedSessionScope,
    op: ClientOperation,
    hooks: SendHooks,
  ): Promise<AdapterOutcome> {
    const mode = this.sessionModes.shift() ?? 'CONFIRM';
    hooks.onHandoff();
    if (mode === 'DECLINE') return this.failed('SESSION_DECLINED');
    const ref = `recsess_${op.clientOperationId.slice(3, 15)}`;
    this.sessions.set(op.idempotencyKey, { ref, status: mode === 'PENDING' ? 'PENDING' : 'ACTIVE' });
    if (mode === 'DROP_RESPONSE') return this.unknown('RESPONSE_LOST');
    return mode === 'PENDING'
      ? { kind: 'ACCEPTED', providerRef: ref, ...this.obs('human_action_required') }
      : { kind: 'CONFIRMED', providerRef: ref, capturedMinor: 0n, returns: [], ...this.obs('active') };
  }

  async lookupSession(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    const s = this.sessions.get(locator.idempotencyKey);
    if (!s) return this.failed('SESSION_NOT_FOUND');
    return s.status === 'ACTIVE'
      ? { kind: 'CONFIRMED', providerRef: s.ref, capturedMinor: 0n, returns: [], ...this.obs('active') }
      : { kind: 'ACCEPTED', providerRef: s.ref, ...this.obs('human_action_required') };
  }

  // ----- provider-side test controls -------------------------------------------------------------------------------
  settle(idempotencyKey: string) {
    const e = this.effects.get(idempotencyKey);
    if (e) e.status = 'SETTLED';
  }
  activate(idempotencyKey: string) {
    const s = this.sessions.get(idempotencyKey);
    if (s) s.status = 'ACTIVE';
  }
  addReturn(idempotencyKey: string, r: ProviderReturn) {
    this.effects.get(idempotencyKey)?.returns.push(r);
  }

  private outcomeOf(e: Effect): AdapterOutcome {
    if (e.status === 'DECLINED') return this.failed('PROVIDER_DECLINED');
    if (e.status === 'ACCEPTED') return { kind: 'ACCEPTED', providerRef: e.ref, ...this.obs('accepted') };
    return {
      kind: 'CONFIRMED',
      providerRef: e.ref,
      capturedMinor: e.amountMinor,
      returns: [...e.returns],
      ...this.obs('settled'),
    };
  }
  private obs(status: string) {
    return { rawProviderStatus: status, rawResponseDigest: digest({ status, t: now() }), observedAt: now() };
  }
  private failed(reasonCode: string): AdapterOutcome {
    return { kind: 'FAILED', reasonCode, effect: 'NO_EFFECT_PROVED', ...this.obs(reasonCode.toLowerCase()) };
  }
  private unknown(reasonCode: string): AdapterOutcome {
    return {
      kind: 'UNKNOWN',
      providerRef: null,
      reasonCode,
      rawProviderStatus: null,
      rawResponseDigest: null,
      observedAt: now(),
    };
  }
}
