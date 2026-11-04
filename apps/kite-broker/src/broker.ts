// The exclusive Kite payment broker (FR-11, FR-12, INV-05..INV-08, INV-12; STATE-MACHINES §5-§7). It accepts only a
// verified signed opaque reference, reloads the named aggregate and every bound approval/policy/revision/budget fact
// from PostgreSQL, and linearizes in ONE transaction: lock authority + intent, revalidate, reserve budget and commit
// the attempt's SEND_STARTED marker with the pre-generated client operation identity. Egress happens only after that
// commit. Handoff to the network is recorded as REQUESTED only when observed; any ambiguity is UNKNOWN and resolves
// only by authoritative lookup or provider-guaranteed same-key replay. Without either, adapter capability becomes
// UNSUPPORTED while the effect stays UNKNOWN and reserved for manual resolution. Nothing is ever retried with a new key.
import { createHash } from 'node:crypto';
import { DomainError, newId, type TenantId } from '@uptimebuyer/contracts';
import { transition } from '@uptimebuyer/domain';
import {
  dbNow,
  issueBrokerWorkerContext,
  lockKey,
  withTenantTransaction,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { assertDecisionExecutableInTx, type AuthoritySigning } from '@uptimebuyer/compatibility';
import {
  authorityScopeOf,
  authoritySignatureOf,
  emitAttemptEvent,
  emitIntentStateChanged,
  emitSendStarted,
  emitSessionChanged,
  expireLapsedAuthoritiesInTx,
  hold,
  insertMovement,
  recordReceipt,
  loadIntentViewInTx,
  loadSubjectFacts,
  planningLock,
  providerRevisionCurrent,
  recordIntentTransition,
  staleRevisionReason,
  toCommercialIntent,
  toKiteSession,
  transitionAuthorityInTx,
  verifyAuthorityScope,
  type AuthorityVerifyKeys,
} from '@uptimebuyer/commerce';
import {
  verifyExecutionReference,
  type CommercialIntentStateChangedEvent,
  type IntentRunResult,
  type SignedExecutionReference,
} from '@uptimebuyer/kite-contracts';
import type { KiteSession } from '@uptimebuyer/contracts';
import { autonomousRecovery, type AdapterOutcome, type PaidAdapter } from './adapters/port.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Named crash/race points (tests only; a production broker gets no hooks). */
export type BrokerPoint =
  | 'BEFORE_LINEARIZATION'
  | 'IN_LINEARIZATION_BEFORE_COMMIT'
  | 'AFTER_SEND_STARTED'
  | 'AFTER_EFFECT_BEFORE_PERSIST'
  | 'DURING_LOOKUP';
export type BrokerHooks = Partial<Record<BrokerPoint, (info: { intentId: string }) => Promise<void> | void>>;

export interface KiteBrokerOptions {
  referenceKeyring: Readonly<Record<string, Uint8Array>>;
  authorityKeys: AuthorityVerifyKeys;
  compatibilitySigning: AuthoritySigning;
  adapter: PaidAdapter;
  hooks?: BrokerHooks;
  /** Send lease beyond the adapter timeout before an unanswered SEND_STARTED is reconstructed as UNKNOWN. */
  sendLeaseMs?: number;
  reconcileBaseMs?: number;
  reconcileMaxMs?: number;
}

type Linearized =
  | { kind: 'NOOP'; events: CommercialIntentStateChangedEvent[] }
  | { kind: 'FAILED'; events: CommercialIntentStateChangedEvent[]; reasonCode: string }
  | {
      kind: 'SENT';
      events: CommercialIntentStateChangedEvent[];
      attemptId: string;
      prepared: ReturnType<PaidAdapter['prepare']>;
      op: { clientOperationId: string; idempotencyKey: string; requestDigest: string };
    };

const referenceInvalid = (reason: string) =>
  new DomainError('EXECUTION_REFERENCE_INVALID', 'Execution reference rejected.', { reason });

const sha = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

export class KiteBroker {
  private readonly hooks: BrokerHooks;
  private readonly sendLeaseMs: number;
  private readonly reconcileBaseMs: number;
  private readonly reconcileMaxMs: number;

  constructor(
    private readonly pool: Db,
    private readonly opts: KiteBrokerOptions,
  ) {
    this.hooks = opts.hooks ?? {};
    this.sendLeaseMs = opts.sendLeaseMs ?? 60_000;
    this.reconcileBaseMs = opts.reconcileBaseMs ?? 30_000;
    this.reconcileMaxMs = opts.reconcileMaxMs ?? 15 * 60_000;
  }

  get adapter(): PaidAdapter {
    return this.opts.adapter;
  }

  private async hook(point: BrokerPoint, intentId: string) {
    const h = this.hooks[point];
    if (h) await h({ intentId });
  }

  /** Verify a reference and record its use; a replayed nonce is recognised (it never acts twice). */
  private async admit(
    reference: unknown,
    kind: 'EXECUTION_AUTHORITY' | 'COMMERCIAL_INTENT',
    operation: 'ACTIVATE_SESSION' | 'EXECUTE' | 'RECONCILE',
  ): Promise<{ ref: SignedExecutionReference; ctx: TenantContext; targetId: string; replay: boolean }> {
    const ref = verifyExecutionReference(reference, this.opts.referenceKeyring, new Date().toISOString() as never);
    if (ref.target.kind !== kind) throw referenceInvalid('WRONG_TARGET_KIND');
    const targetId =
      ref.target.kind === 'COMMERCIAL_INTENT' ? ref.target.commercialIntentId : ref.target.executionAuthorityId;
    const ctx = issueBrokerWorkerContext(ref.tenantId, ref.nonce);
    // The target must exist in the reference's own signed tenant; nothing else is looked up for a foreign id.
    const table = kind === 'COMMERCIAL_INTENT' ? 'commercial_intents' : 'execution_authorities';
    const exists = await this.pool.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2`, [
      ref.tenantId,
      targetId,
    ]);
    if (exists.rowCount !== 1) throw referenceInvalid('WRONG_TARGET');
    const ins = await this.pool.query(
      `INSERT INTO broker_reference_uses (tenant_id, nonce, operation, target_kind, target_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, nonce, operation) DO NOTHING`,
      [ref.tenantId, ref.nonce, operation, kind, targetId],
    );
    return { ref, ctx, targetId, replay: ins.rowCount === 0 };
  }

  private tx<T>(ctx: TenantContext, fn: (c: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, ctx, fn);
  }

  // ----- Kite session activation -----------------------------------------------------------------------------------

  async activateSession(reference: unknown): Promise<{ session: KiteSession; replay: boolean }> {
    const { ctx, targetId, replay } = await this.admit(reference, 'EXECUTION_AUTHORITY', 'ACTIVATE_SESSION');
    if (replay) return { session: await this.sessionOf(ctx, targetId), replay };
    const started = await this.tx(ctx, async (c) => {
      const x = (
        await c.query(
          `SELECT *, expires_at > clock_timestamp() AS live FROM execution_authorities WHERE tenant_id = $1 AND id = $2
            FOR NO KEY UPDATE`,
          [ctx.tenantId, targetId],
        )
      ).rows[0];
      if (!x) throw referenceInvalid('WRONG_TARGET');
      const s = (
        await c.query(
          `SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2 FOR NO KEY UPDATE`,
          [ctx.tenantId, x.id],
        )
      ).rows[0];
      if (s.transport_state !== 'PREPARED') return null; // never re-sent; reconcile resolves UNKNOWN
      if (!verifyAuthorityScope(authorityScopeOf(x), authoritySignatureOf(x), this.opts.authorityKeys))
        throw hold('AUTHORITY_SIGNATURE_INVALID');
      if (x.status !== 'ACTIVE' || !x.live) throw hold('AUTHORITY_NOT_ACTIVE', { status: x.status });
      const ok = (await c.query(`SELECT ub_approval_executable($1, $2) AS ok`, [ctx.tenantId, x.approval_id])).rows[0]
        .ok;
      if (!ok) throw hold('APPROVAL_NOT_EXECUTABLE');
      if (!(await providerRevisionCurrent(c, ctx.tenantId, x.provider_account_revision_id)))
        throw hold('PROVIDER_ACCOUNT_REVISION_NOT_CURRENT');
      const scope = this.sessionScope(x);
      const cap = this.opts.adapter.assessSession(scope);
      if (cap.kind === 'UNSUPPORTED') {
        const up = await patch(c, 'execution_authority_sessions', s, {
          adapter_capability: 'UNSUPPORTED',
          reason_code: cap.reasonCode,
        });
        await emitSessionChanged(c, ctx, up);
        return { unsupported: cap.reasonCode };
      }
      const now = await dbNow(c);
      const up = await patch(c, 'execution_authority_sessions', s, {
        transport_state: 'SEND_STARTED',
        external_outcome_state: 'AUTHORIZED',
        send_lease_expires_at: new Date(Date.parse(now) + this.sendLeaseMs).toISOString(),
      });
      await emitSessionChanged(c, ctx, up);
      return { session: up, scope };
    });
    if (started && 'unsupported' in started)
      throw hold('ADAPTER_CAPABILITY_UNSUPPORTED', { capability: started.unsupported });
    if (started) {
      const s = started.session;
      let handoff: Promise<void> | null = null;
      let outcome: AdapterOutcome;
      try {
        outcome = await this.opts.adapter.activateSession(
          started.scope,
          {
            clientOperationId: s.client_operation_id,
            idempotencyKey: s.idempotency_key,
            requestDigest: s.request_digest,
          },
          { onHandoff: () => (handoff = this.markRequested(ctx, 'execution_authority_sessions', s.id)) },
        );
      } catch {
        outcome = unknownOutcome('ADAPTER_ERROR');
      }
      if (handoff) await handoff;
      await this.applySessionOutcome(ctx, s.id, outcome);
    }
    return { session: await this.sessionOf(ctx, targetId), replay };
  }

  private sessionScope(x: any) {
    return {
      tenantId: x.tenant_id,
      executionAuthorityId: x.id,
      merchantId: x.merchant_id,
      purpose: x.purpose,
      perActionLimitMinor: BigInt(x.per_action_limit_minor),
      baseLimitMinor: BigInt(x.base_limit_minor),
      currency: x.currency,
      expiresAt: new Date(x.expires_at).toISOString(),
      providerAccountRevisionId: x.provider_account_revision_id,
    };
  }

  private async sessionOf(ctx: TenantContext, authorityId: string): Promise<KiteSession> {
    const { rows } = await this.pool.query(
      `SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
      [ctx.tenantId, authorityId],
    );
    if (!rows[0]) throw referenceInvalid('WRONG_TARGET');
    return toKiteSession(rows[0]);
  }

  private async markRequested(ctx: TenantContext, table: string, id: string): Promise<void> {
    await this.tx(ctx, async (c) => {
      const row = (
        await c.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [ctx.tenantId, id])
      ).rows[0];
      if (row && row.transport_state === 'SEND_STARTED' && row.external_outcome_state === 'AUTHORIZED')
        await patch(c, table, row, { external_outcome_state: 'REQUESTED' });
    });
  }

  private async applySessionOutcome(ctx: TenantContext, sessionId: string, o: AdapterOutcome): Promise<void> {
    await this.tx(ctx, async (c) => {
      let s = (
        await c.query(`SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
          ctx.tenantId,
          sessionId,
        ])
      ).rows[0];
      const obs = { raw_provider_status: o.rawProviderStatus, raw_response_digest: o.rawResponseDigest };
      const ref =
        'providerRef' in o && o.providerRef && !s.provider_session_ref ? { provider_session_ref: o.providerRef } : {};
      const toTransport = (t: string) => (s.transport_state === 'SEND_STARTED' ? { transport_state: t } : {});
      const walk = async (path: string[], extra: Record<string, unknown>) => {
        for (const [n, step] of path.entries())
          s = await patch(c, 'execution_authority_sessions', s, {
            external_outcome_state: step,
            ...(n === path.length - 1 ? extra : {}),
          });
      };
      const now = Date.parse(await dbNow(c));
      switch (o.kind) {
        case 'CONFIRMED':
        case 'ACCEPTED': {
          const target = o.kind;
          await walk(externalPath(s.external_outcome_state, target), {
            ...toTransport('ACKNOWLEDGED'),
            ...obs,
            ...ref,
            send_lease_expires_at: null,
            next_reconcile_at: target === 'CONFIRMED' ? null : new Date(now + this.reconcileBaseMs).toISOString(),
            reason_code: null,
          });
          break;
        }
        case 'FAILED':
        case 'CANCELLED':
          await walk(externalPath(s.external_outcome_state, o.kind), {
            ...toTransport('DEFINITE_NO_EFFECT'),
            ...obs,
            send_lease_expires_at: null,
            next_reconcile_at: null,
            reason_code: o.kind === 'FAILED' ? o.reasonCode : 'PROVIDER_CANCELLED',
          });
          break;
        case 'UNKNOWN':
        case 'RECONCILIATION_UNSUPPORTED': {
          const manual = o.kind === 'RECONCILIATION_UNSUPPORTED' || !autonomousRecovery(this.opts.adapter.capability);
          const fields = {
            ...toTransport('UNKNOWN'),
            ...obs,
            send_lease_expires_at: null,
            adapter_capability: manual ? 'UNSUPPORTED' : s.adapter_capability,
            next_reconcile_at: manual ? null : new Date(now + this.backoff(s.reconcile_count)).toISOString(),
            reconcile_count: s.reconcile_count + 1,
            reason_code: o.reasonCode,
          };
          if (s.external_outcome_state === 'UNKNOWN') s = await patch(c, 'execution_authority_sessions', s, fields);
          else if (s.external_outcome_state === 'ACCEPTED' && o.kind === 'UNKNOWN')
            s = await patch(c, 'execution_authority_sessions', s, {
              ...fields,
              external_outcome_state: 'ACCEPTED',
              adapter_capability: s.adapter_capability,
            });
          else await walk(['UNKNOWN'], fields);
          break;
        }
      }
      await emitSessionChanged(c, ctx, s);
    });
  }

  /** Reconcile an UNKNOWN or ACCEPTED Kite session by its pre-egress operation identity. */
  async reconcileSessionOf(ctx: TenantContext, authorityId: string): Promise<KiteSession> {
    const s = (
      await this.pool.query(
        `SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
        [ctx.tenantId, authorityId],
      )
    ).rows[0];
    if (!s) throw referenceInvalid('WRONG_TARGET');
    if (s.adapter_capability === 'ELIGIBLE' && ['UNKNOWN', 'ACCEPTED'].includes(s.external_outcome_state)) {
      let o: AdapterOutcome;
      try {
        o = await this.opts.adapter.lookupSession({
          clientOperationId: s.client_operation_id,
          idempotencyKey: s.idempotency_key,
          providerRef: s.provider_session_ref,
        });
      } catch {
        o = unknownOutcome('LOOKUP_UNAVAILABLE');
      }
      await this.applySessionOutcome(ctx, s.id, o);
    }
    return this.sessionOf(ctx, authorityId);
  }

  // ----- paid execution ------------------------------------------------------------------------------------------

  async execute(reference: unknown): Promise<IntentRunResult & { replay: boolean }> {
    const { ctx, targetId, replay } = await this.admit(reference, 'COMMERCIAL_INTENT', 'EXECUTE');
    if (replay) return { ...(await this.result(ctx, targetId, [])), replay };
    await this.hook('BEFORE_LINEARIZATION', targetId);
    const lin = await this.linearize(ctx, targetId);
    const events = [...lin.events];
    if (lin.kind === 'SENT') {
      await this.hook('AFTER_SEND_STARTED', targetId);
      let handoff: Promise<void> | null = null;
      let outcome: AdapterOutcome;
      try {
        outcome = await this.opts.adapter.execute(lin.prepared, lin.op, {
          onHandoff: () => (handoff = this.markRequested(ctx, 'external_attempts', lin.attemptId)),
        });
      } catch {
        outcome = unknownOutcome('ADAPTER_ERROR');
      }
      if (handoff) await handoff;
      await this.hook('AFTER_EFFECT_BEFORE_PERSIST', targetId);
      events.push(...(await this.applyOutcome(ctx, targetId, outcome, 'EXECUTE')));
    }
    return { ...(await this.result(ctx, targetId, events)), replay };
  }

  private async result(ctx: TenantContext, intentId: string, events: CommercialIntentStateChangedEvent[]) {
    const { rows } = await this.pool.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      intentId,
    ]);
    if (!rows[0]) throw referenceInvalid('WRONG_TARGET');
    return { intent: toCommercialIntent(rows[0]), events };
  }

  /** The linearization transaction. Returns without egress unless reserve + SEND_STARTED committed together. */
  private async linearize(ctx: TenantContext, intentId: string): Promise<Linearized> {
    const peek = (
      await this.pool.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        intentId,
      ])
    ).rows[0];
    if (!peek) throw referenceInvalid('WRONG_TARGET');
    if (peek.state !== 'CREATED') return { kind: 'NOOP', events: [] };
    return this.tx(ctx, async (c) => {
      // Lock order everywhere: planning lock -> authority -> intent -> (ledger trigger) account -> capture row.
      if (peek.subject_type === 'PLAN_ACTION') await lockKey(c, planningLock(ctx.tenantId, peek.incident_id));
      const x = (
        await c.query(
          `SELECT *, expires_at > clock_timestamp() AS live FROM execution_authorities WHERE tenant_id = $1 AND id = $2
            FOR NO KEY UPDATE`,
          [ctx.tenantId, peek.execution_authority_id],
        )
      ).rows[0];
      const i = (
        await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
          ctx.tenantId,
          intentId,
        ])
      ).rows[0];
      if (i.state !== 'CREATED') return { kind: 'NOOP' as const, events: [] };

      const fail = async (reasonCode: string): Promise<Linearized> => {
        const up = await patch(c, 'commercial_intents', i, { state: 'FAILED', reason_code: reasonCode });
        await recordIntentTransition(c, ctx, i.id, 'CREATED', 'FAILED', reasonCode);
        const ev = await emitIntentStateChanged(c, ctx, up, 'CREATED', null, reasonCode);
        return { kind: 'FAILED', events: [ev], reasonCode };
      };

      if (!verifyAuthorityScope(authorityScopeOf(x), authoritySignatureOf(x), this.opts.authorityKeys))
        return fail('AUTHORITY_SIGNATURE_INVALID');
      if (x.status === 'REVOKED' || x.status === 'EXPIRED') return fail(`AUTHORITY_${x.status}`);
      if (!x.live) {
        await transitionAuthorityInTx(c, ctx, x, 'EXPIRED', 'AUTHORITY_EXPIRED');
        return fail('AUTHORITY_EXPIRED');
      }
      if (x.status === 'SUSPENDED') throw hold('AUTHORITY_SUSPENDED');
      const s = (
        await c.query(
          `SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
          [ctx.tenantId, x.id],
        )
      ).rows[0];
      if (s.external_outcome_state !== 'CONFIRMED')
        throw hold('KITE_SESSION_NOT_CONFIRMED', { sessionOutcome: s.external_outcome_state });
      const ok = (await c.query(`SELECT ub_approval_executable($1, $2) AS ok`, [ctx.tenantId, x.approval_id])).rows[0]
        .ok;
      if (!ok) return fail('APPROVAL_NOT_EXECUTABLE');
      const bound =
        i.approval_id === x.approval_id &&
        i.action_digest === x.action_digest &&
        i.subject_type === x.subject_type &&
        i.subject_id === x.subject_id &&
        i.provider_account_revision_id === x.provider_account_revision_id &&
        i.currency === x.currency &&
        BigInt(i.max_amount_minor) <= BigInt(x.per_action_limit_minor);
      if (!bound) return fail('INTENT_OUTSIDE_AUTHORITY');

      const f = await loadSubjectFacts(c, ctx.tenantId, { type: i.subject_type, id: i.subject_id }, x.approval_id);
      if (!f || f.recomputedActionDigest !== x.action_digest || f.storedActionDigest !== x.action_digest)
        return fail('ACTION_DIGEST_MISMATCH');
      if (f.invalidated) return fail('SUBJECT_INVALIDATED');
      if (
        f.merchantId !== x.merchant_id ||
        f.purpose !== x.purpose ||
        f.amount.currency !== x.currency ||
        f.amount.amountMinor !== BigInt(i.max_amount_minor) ||
        !x.allowed_action_kinds.includes(f.actionKind)
      )
        return fail('SUBJECT_OUTSIDE_AUTHORITY');
      const stale = await staleRevisionReason(c, ctx.tenantId, f);
      if (stale) return fail(stale);
      if (!(await providerRevisionCurrent(c, ctx.tenantId, x.provider_account_revision_id)))
        return fail('PROVIDER_ACCOUNT_REVISION_NOT_CURRENT');
      if (i.subject_type === 'PLAN_ACTION') {
        if (f.planHash !== x.plan_hash || !['APPROVED', 'EXECUTING'].includes(f.planState ?? ''))
          return fail('PLAN_NOT_EXECUTABLE');
        try {
          await assertDecisionExecutableInTx(
            c,
            ctx,
            { compatibilityDecisionId: f.compatibilityDecisionId!, actionDigest: x.action_digest },
            this.opts.compatibilitySigning,
          );
        } catch (e) {
          const reason = e instanceof DomainError ? String(e.details.reasonCode ?? e.code) : 'DECISION_NOT_EXECUTABLE';
          return fail(/^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : 'DECISION_NOT_EXECUTABLE');
        }
      }
      const authorized = {
        tenantId: ctx.tenantId,
        commercialIntentId: i.id,
        actionKind: f.actionKind,
        semanticOperation: i.semantic_operation,
        merchantId: x.merchant_id,
        purpose: x.purpose,
        amountMinor: BigInt(i.max_amount_minor),
        currency: i.currency,
        providerAccountRevisionId: i.provider_account_revision_id,
      };
      const cap = this.opts.adapter.assess(authorized);
      if (cap.kind === 'UNSUPPORTED') return fail('ADAPTER_CAPABILITY_UNSUPPORTED');
      const prepared = this.opts.adapter.prepare(authorized);

      // Linearization point: RESERVE + RESERVED + SEND_STARTED commit together, or not at all.
      const account = (
        await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [
          ctx.tenantId,
          i.budget_account_id,
        ])
      ).rows[0];
      // Gross authority left after open reservations and gross captures (refunds never replenish it).
      if (BigInt(account.available_minor) < BigInt(i.max_amount_minor))
        throw hold('INSUFFICIENT_AVAILABLE_AUTHORITY', { availableMinor: String(account.available_minor) });
      await insertMovement(c, ctx, {
        account,
        intent: i,
        movementType: 'RESERVE',
        amountMinor: BigInt(i.max_amount_minor),
        providerEventKey: `reserve:${i.client_operation_id}`,
        reasonCode: 'LINEARIZATION_RESERVE',
      });
      const reserved = await patch(c, 'commercial_intents', i, { state: 'RESERVED', reason_code: null });
      await recordIntentTransition(c, ctx, i.id, 'CREATED', 'RESERVED', 'RESERVE_AND_SEND_STARTED');
      const now = await dbNow(c);
      const attempt = (
        await c.query(
          `INSERT INTO external_attempts (tenant_id, id, intent_id, provider_account_id, provider_account_revision_id,
             client_operation_id, idempotency_key, request_digest, adapter_id, result_origin, transport_state,
             external_outcome_state, adapter_capability, send_lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SEND_STARTED', 'AUTHORIZED', 'ELIGIBLE', $11) RETURNING *`,
          [
            ctx.tenantId,
            newId('externalAttempt'),
            i.id,
            i.provider_account_id,
            i.provider_account_revision_id,
            i.client_operation_id,
            i.idempotency_key,
            prepared.requestDigest,
            this.opts.adapter.adapterId,
            this.opts.adapter.resultOrigin,
            new Date(Date.parse(now) + this.sendLeaseMs).toISOString(),
          ],
        )
      ).rows[0];
      if (i.subject_type === 'PLAN_ACTION' && f.planState === 'APPROVED') {
        transition('RECOVERY_PLAN', 'APPROVED', 'EXECUTING');
        await c.query(
          `UPDATE recovery_plans SET state = 'EXECUTING', version = version + 1 WHERE tenant_id = $1 AND id = $2
             AND state = 'APPROVED'`,
          [ctx.tenantId, f.planId],
        );
        await c.query(
          `INSERT INTO recovery_plan_transitions (tenant_id, id, plan_id, sequence, from_state, to_state, reason_code,
             actor_kind, actor_id)
           SELECT $1, 'plt_' || gen_random_uuid(), $2, coalesce(max(sequence), 0) + 1, 'APPROVED', 'EXECUTING',
                  'RESERVE_AND_SEND_STARTED', 'WORKER', 'kite-broker'
             FROM recovery_plan_transitions WHERE tenant_id = $1 AND plan_id = $2`,
          [ctx.tenantId, f.planId],
        );
      }
      const ev = await emitIntentStateChanged(c, ctx, reserved, 'CREATED', attempt, null);
      await emitSendStarted(c, ctx, reserved, attempt);
      await this.hook('IN_LINEARIZATION_BEFORE_COMMIT', i.id);
      return {
        kind: 'SENT' as const,
        events: [ev],
        attemptId: attempt.id,
        prepared,
        op: {
          clientOperationId: attempt.client_operation_id,
          idempotencyKey: attempt.idempotency_key,
          requestDigest: attempt.request_digest,
        },
      };
    });
  }

  private backoff(count: number): number {
    return Math.min(this.reconcileMaxMs, this.reconcileBaseMs * 2 ** Math.min(count, 10));
  }

  /** Apply one normalized outcome to the intent, its single attempt and the ledger, in one transaction. */
  private async applyOutcome(
    ctx: TenantContext,
    intentId: string,
    o: AdapterOutcome,
    source: 'EXECUTE' | 'RECONCILE' | 'RECOVERY',
  ): Promise<CommercialIntentStateChangedEvent[]> {
    return this.tx(ctx, async (c) => {
      const events: CommercialIntentStateChangedEvent[] = [];
      let i = (
        await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
          ctx.tenantId,
          intentId,
        ])
      ).rows[0];
      let a = (
        await c.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2 FOR NO KEY UPDATE`, [
          ctx.tenantId,
          intentId,
        ])
      ).rows[0];
      if (!a) return events;
      const live = ['RESERVED', 'SUBMITTED', 'UNKNOWN'].includes(i.state);
      if (source === 'EXECUTE' && i.state !== 'RESERVED') return events; // boot recovery or a reconcile got there first
      if (!live && !(i.state === 'CONFIRMED' && o.kind === 'CONFIRMED')) return events;
      const now = Date.parse(await dbNow(c));
      const obs = { raw_provider_status: o.rawProviderStatus, raw_response_digest: o.rawResponseDigest };
      let ref: Record<string, unknown> =
        'providerRef' in o && o.providerRef && !a.provider_ref ? { provider_ref: o.providerRef } : {};
      const sent = a.transport_state === 'SEND_STARTED';
      const moveAttempt = async (path: string[], extra: Record<string, unknown>) => {
        if (path.length === 0) a = await patch(c, 'external_attempts', a, extra);
        for (const [n, step] of path.entries())
          a = await patch(c, 'external_attempts', a, {
            external_outcome_state: step,
            ...(n === path.length - 1 ? extra : {}),
          });
      };
      const moveIntent = async (to: string, reasonCode: string | null) => {
        if (i.state === to) return;
        const prior = i.state;
        i = await patch(c, 'commercial_intents', i, { state: to, reason_code: reasonCode });
        await recordIntentTransition(c, ctx, i.id, prior, to, reasonCode ?? `${source}_${o.kind}`);
        events.push(await emitIntentStateChanged(c, ctx, i, prior, a, reasonCode));
      };
      const account = async () =>
        (
          await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [
            ctx.tenantId,
            i.budget_account_id,
          ])
        ).rows[0];
      const reload = async () =>
        (i = (await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, i.id]))
          .rows[0]);
      const origin = this.opts.adapter.resultOrigin;

      switch (o.kind) {
        case 'ACCEPTED': {
          if (i.state === 'SUBMITTED') {
            a = await patch(c, 'external_attempts', a, {
              ...obs,
              next_reconcile_at: new Date(now + this.backoff(a.reconcile_count)).toISOString(),
              reconcile_count: a.reconcile_count + 1,
            });
            break;
          }
          await moveAttempt(externalPath(a.external_outcome_state, 'ACCEPTED'), {
            ...(sent ? { transport_state: 'ACKNOWLEDGED' } : {}),
            ...obs,
            ...ref,
            send_lease_expires_at: null,
            reason_code: null,
            next_reconcile_at: new Date(now + this.reconcileBaseMs).toISOString(),
          });
          await recordReceipt(c, ctx, a, i, 'PROVIDER_ACCEPTANCE', origin, o);
          await emitAttemptEvent(c, ctx, 'external_attempt.accepted.v1', i, a);
          await moveIntent('SUBMITTED', null);
          break;
        }
        case 'CONFIRMED': {
          const captured = o.capturedMinor;
          const open = BigInt(i.open_reserved_minor);
          if (i.state !== 'CONFIRMED' && (captured <= 0n || captured > open)) {
            // The provider claims more than was reserved (or nothing): never capture beyond the reservation.
            await this.toManual(c, ctx, i, a, 'CAPTURE_OUTSIDE_RESERVATION', obs, events, now);
            break;
          }
          if (i.state === 'RESERVED') {
            // RESERVED -> SUBMITTED needs observed acknowledgement first; a synchronous confirmation implies it.
            await moveAttempt(externalPath(a.external_outcome_state, 'ACCEPTED'), {
              ...(sent ? { transport_state: 'ACKNOWLEDGED' } : {}),
              ...ref,
            });
            await moveIntent('SUBMITTED', null);
            ref = {};
          }
          if (i.state !== 'CONFIRMED') {
            await moveAttempt(externalPath(a.external_outcome_state, 'CONFIRMED'), {
              ...(a.transport_state === 'SEND_STARTED' ? { transport_state: 'ACKNOWLEDGED' } : {}),
              ...obs,
              ...ref,
              send_lease_expires_at: null,
              next_reconcile_at: null,
              reason_code: null,
            });
            await recordReceipt(c, ctx, a, i, 'PAYMENT_SETTLEMENT', origin, o);
            const cap = await insertMovement(c, ctx, {
              account: await account(),
              intent: i,
              movementType: 'CAPTURE',
              amountMinor: captured,
              providerEventKey: `capture:${i.client_operation_id}`,
              reasonCode: 'AUTHORITATIVE_CONFIRMATION',
            });
            await reload();
            if (BigInt(i.open_reserved_minor) > 0n)
              await insertMovement(c, ctx, {
                account: await account(),
                intent: i,
                movementType: 'RELEASE',
                amountMinor: BigInt(i.open_reserved_minor),
                providerEventKey: `release:${i.client_operation_id}`,
                reasonCode: 'UNCAPTURED_REMAINDER',
              });
            await reload();
            const fullReturn = o.returns.reduce((s, r) => s + r.amountMinor, 0n) >= captured && o.returns.length > 0;
            if (fullReturn && i.state === 'UNKNOWN') {
              // UNKNOWN -> REFUNDED/REVERSED: the proved CAPTURE is appended first, then the returns referencing it.
              await this.applyReturns(c, ctx, i, a, cap!.id, o.returns, origin, o);
              await reload();
              await moveIntent(finalReturnState(i), null);
              break;
            }
            if (i.state === 'UNKNOWN' || i.state === 'SUBMITTED') await moveIntent('CONFIRMED', null);
            await emitAttemptEvent(c, ctx, 'external_attempt.reconciled.v1', i, a);
          }
          if (o.returns.length > 0) {
            const capture = (
              await c.query(
                `SELECT * FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2 AND movement_type = 'CAPTURE'
                  ORDER BY seq LIMIT 1`,
                [ctx.tenantId, i.id],
              )
            ).rows[0];
            await this.applyReturns(c, ctx, i, a, capture.id, o.returns, origin, o);
            await reload();
            if (BigInt(i.net_settled_minor) === 0n && i.state === 'CONFIRMED')
              await moveIntent(finalReturnState(i), null);
          }
          break;
        }
        case 'FAILED':
        case 'CANCELLED': {
          await moveAttempt(externalPath(a.external_outcome_state, o.kind), {
            ...(sent ? { transport_state: 'DEFINITE_NO_EFFECT' } : {}),
            ...obs,
            send_lease_expires_at: null,
            next_reconcile_at: null,
            reason_code: o.kind === 'FAILED' ? o.reasonCode : 'PROVIDER_CANCELLED_BEFORE_CAPTURE',
          });
          await recordReceipt(c, ctx, a, i, 'NO_EFFECT_PROOF', origin, o);
          await insertMovement(c, ctx, {
            account: await account(),
            intent: i,
            movementType: 'RELEASE',
            amountMinor: BigInt(i.open_reserved_minor),
            providerEventKey: `release:${i.client_operation_id}`,
            reasonCode: 'NO_EFFECT_PROVED',
          });
          await reload();
          await emitAttemptEvent(c, ctx, 'external_attempt.reconciled.v1', i, a);
          await moveIntent('FAILED', o.kind === 'FAILED' ? o.reasonCode : 'PROVIDER_CANCELLED_BEFORE_CAPTURE');
          break;
        }
        case 'UNKNOWN': {
          const manual = !autonomousRecovery(this.opts.adapter.capability);
          if (i.state === 'SUBMITTED' && source !== 'EXECUTE') {
            // Still only acknowledged: keep polling on the bounded backoff.
            a = await patch(c, 'external_attempts', a, {
              ...obs,
              next_reconcile_at: new Date(now + this.backoff(a.reconcile_count)).toISOString(),
              reconcile_count: a.reconcile_count + 1,
            });
            break;
          }
          const fields = {
            ...(sent ? { transport_state: 'UNKNOWN' } : {}),
            ...obs,
            ...ref,
            send_lease_expires_at: null,
            adapter_capability: manual ? 'UNSUPPORTED' : a.adapter_capability,
            next_reconcile_at: manual ? null : new Date(now + this.backoff(a.reconcile_count)).toISOString(),
            reconcile_count: a.reconcile_count + (source === 'EXECUTE' ? 0 : 1),
            reason_code: o.reasonCode,
          };
          if (a.external_outcome_state === 'UNKNOWN') a = await patch(c, 'external_attempts', a, fields);
          else await moveAttempt(['UNKNOWN'], fields);
          await emitAttemptEvent(c, ctx, 'external_attempt.unknown.v1', i, a);
          if (manual) await emitAttemptEvent(c, ctx, 'external_attempt.capability_changed.v1', i, a);
          await moveIntent('UNKNOWN', null);
          break;
        }
        case 'RECONCILIATION_UNSUPPORTED':
          await this.toManual(c, ctx, i, a, o.reasonCode, obs, events, now);
          break;
      }
      return events;
    });
  }

  /** Capability UNSUPPORTED after possible egress: the effect stays UNKNOWN and reserved for manual resolution. */
  private async toManual(
    c: Tx,
    ctx: TenantContext,
    i: any,
    a: any,
    reasonCode: string,
    obs: Record<string, unknown>,
    events: CommercialIntentStateChangedEvent[],
    _now: number,
  ) {
    const fields = {
      ...(a.transport_state === 'SEND_STARTED' ? { transport_state: 'UNKNOWN' } : {}),
      ...obs,
      adapter_capability: 'UNSUPPORTED',
      next_reconcile_at: null,
      send_lease_expires_at: null,
      reason_code: reasonCode,
    };
    if (['UNKNOWN'].includes(a.external_outcome_state) || i.state === 'SUBMITTED')
      a = await patch(c, 'external_attempts', a, fields);
    else a = await patch(c, 'external_attempts', a, { ...fields, external_outcome_state: 'UNKNOWN' });
    await emitAttemptEvent(c, ctx, 'external_attempt.capability_changed.v1', i, a);
    if (i.state === 'RESERVED') {
      const up = await patch(c, 'commercial_intents', i, { state: 'UNKNOWN', reason_code: null });
      await recordIntentTransition(c, ctx, i.id, 'RESERVED', 'UNKNOWN', reasonCode);
      events.push(await emitIntentStateChanged(c, ctx, up, 'RESERVED', a, null));
    }
  }

  private async applyReturns(
    c: Tx,
    ctx: TenantContext,
    i: any,
    a: any,
    captureEntryId: string,
    returns: { kind: 'REFUND' | 'REVERSAL'; providerEventId: string; amountMinor: bigint }[],
    origin: string,
    o: AdapterOutcome,
  ) {
    for (const r of returns) {
      const account = (
        await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [
          ctx.tenantId,
          i.budget_account_id,
        ])
      ).rows[0];
      const entry = await insertMovement(c, ctx, {
        account,
        intent: i,
        movementType: r.kind,
        amountMinor: r.amountMinor,
        providerEventKey: `${r.kind.toLowerCase()}:${r.providerEventId}`,
        captureEntryId,
        reasonCode: r.kind === 'REFUND' ? 'PROVIDER_REFUND' : 'PROVIDER_REVERSAL',
      });
      if (entry) await recordReceipt(c, ctx, a, i, r.kind, origin, o, r.providerEventId);
    }
  }

  // ----- reconciliation ------------------------------------------------------------------------------------------

  async reconcile(reference: unknown): Promise<IntentRunResult & { replay: boolean }> {
    const { ctx, targetId, replay } = await this.admit(reference, 'COMMERCIAL_INTENT', 'RECONCILE');
    if (replay) return { ...(await this.result(ctx, targetId, [])), replay };
    const events = await this.reconcileIntent(ctx, targetId);
    return { ...(await this.result(ctx, targetId, events)), replay };
  }

  async reconcileAuthoritySession(reference: unknown): Promise<KiteSession> {
    const { ctx, targetId } = await this.admit(reference, 'EXECUTION_AUTHORITY', 'RECONCILE');
    return this.reconcileSessionOf(ctx, targetId);
  }

  async reconcileIntent(ctx: TenantContext, intentId: string): Promise<CommercialIntentStateChangedEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT a.*, i.state, a.send_lease_expires_at <= clock_timestamp() AS lease_lapsed
         FROM commercial_intents i LEFT JOIN external_attempts a ON a.tenant_id = i.tenant_id AND a.intent_id = i.id
        WHERE i.tenant_id = $1 AND i.id = $2`,
      [ctx.tenantId, intentId],
    );
    const r = rows[0];
    if (!r) throw referenceInvalid('WRONG_TARGET');
    if (!r.id || !['RESERVED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'].includes(r.state)) return [];
    if (r.adapter_capability === 'UNSUPPORTED') return []; // manual resolution only
    const events: CommercialIntentStateChangedEvent[] = [];
    if (r.transport_state === 'SEND_STARTED') {
      if (!r.lease_lapsed) return []; // the send is still in flight under its lease
      // Crash after the durable marker: reconstruct UNKNOWN (never REQUESTED or FAILED) with the original key.
      events.push(
        ...(await this.applyOutcome(ctx, intentId, unknownOutcome('SEND_STARTED_WITHOUT_RESULT'), 'RECOVERY')),
      );
      if (!autonomousRecovery(this.opts.adapter.capability)) return events;
    }
    const cap = this.opts.adapter.capability;
    const locator = {
      clientOperationId: r.client_operation_id,
      idempotencyKey: r.idempotency_key,
      providerRef: r.provider_ref,
    };
    let o: AdapterOutcome;
    try {
      if (cap.lookupByClientOperation) o = await this.opts.adapter.lookup(locator);
      else if (cap.sameKeyReplay && r.state !== 'CONFIRMED') o = await this.replaySameKey(ctx, intentId, r);
      else
        o = {
          kind: 'RECONCILIATION_UNSUPPORTED',
          reasonCode: 'NO_AUTHORITATIVE_RECONCILIATION',
          rawProviderStatus: null,
          rawResponseDigest: null,
          observedAt: new Date().toISOString(),
        };
    } catch {
      o = unknownOutcome('LOOKUP_UNAVAILABLE');
    }
    await this.hook('DURING_LOOKUP', intentId);
    if (r.state === 'CONFIRMED' && o.kind !== 'CONFIRMED') return events;
    events.push(...(await this.applyOutcome(ctx, intentId, o, 'RECONCILE')));
    return events;
  }

  /** Provider-guaranteed same-key replay: re-prepare deterministically and prove the request digest is unchanged. */
  private async replaySameKey(ctx: TenantContext, intentId: string, attempt: any): Promise<AdapterOutcome> {
    const i = (
      await this.pool.query(
        `SELECT i.*, x.merchant_id, x.purpose, x.allowed_action_kinds FROM commercial_intents i
           JOIN execution_authorities x ON x.tenant_id = i.tenant_id AND x.id = i.execution_authority_id
          WHERE i.tenant_id = $1 AND i.id = $2`,
        [ctx.tenantId, intentId],
      )
    ).rows[0];
    const prepared = this.opts.adapter.prepare({
      tenantId: ctx.tenantId,
      commercialIntentId: i.id,
      actionKind: i.allowed_action_kinds[0],
      semanticOperation: i.semantic_operation,
      merchantId: i.merchant_id,
      purpose: i.purpose,
      amountMinor: BigInt(i.max_amount_minor),
      currency: i.currency,
      providerAccountRevisionId: i.provider_account_revision_id,
    });
    if (prepared.requestDigest !== attempt.request_digest)
      return {
        kind: 'RECONCILIATION_UNSUPPORTED',
        reasonCode: 'REPLAY_REQUEST_DIGEST_CHANGED',
        rawProviderStatus: null,
        rawResponseDigest: null,
        observedAt: new Date().toISOString(),
      };
    return this.opts.adapter.execute(
      prepared,
      {
        clientOperationId: attempt.client_operation_id,
        idempotencyKey: attempt.idempotency_key,
        requestDigest: attempt.request_digest,
      },
      { onHandoff: () => {} },
    );
  }

  /**
   * Restart recovery and scheduled reconciliation across tenants: lapsed SEND_STARTED markers become UNKNOWN and every
   * due UNKNOWN/SUBMITTED attempt or session is looked up by its pre-egress identity. Bounded per run.
   */
  async sweep(opts: { limit?: number } = {}): Promise<{ intents: number; sessions: number }> {
    const limit = opts.limit ?? 50;
    const due = await this.pool.query(
      `SELECT a.tenant_id, a.intent_id FROM external_attempts a
        WHERE a.adapter_capability = 'ELIGIBLE'
          AND ((a.transport_state = 'SEND_STARTED' AND a.send_lease_expires_at <= clock_timestamp())
               OR (a.next_reconcile_at IS NOT NULL AND a.next_reconcile_at <= clock_timestamp()))
        ORDER BY coalesce(a.next_reconcile_at, a.send_lease_expires_at) LIMIT $1`,
      [limit],
    );
    for (const r of due.rows)
      await this.reconcileIntent(
        issueBrokerWorkerContext(r.tenant_id as TenantId, `sweep-${r.intent_id.slice(4, 40)}`),
        r.intent_id,
      );
    // Lapsed session sends become UNKNOWN; due sessions are looked up.
    const sessions = await this.pool.query(
      `SELECT tenant_id, id, execution_authority_id, transport_state FROM execution_authority_sessions
        WHERE adapter_capability = 'ELIGIBLE'
          AND ((transport_state = 'SEND_STARTED' AND send_lease_expires_at <= clock_timestamp())
               OR (next_reconcile_at IS NOT NULL AND next_reconcile_at <= clock_timestamp()))
        LIMIT $1`,
      [limit],
    );
    for (const s of sessions.rows) {
      const ctx = issueBrokerWorkerContext(s.tenant_id as TenantId, `sweep-${s.id.slice(4, 40)}`);
      if (s.transport_state === 'SEND_STARTED')
        await this.applySessionOutcome(ctx, s.id, unknownOutcome('SEND_STARTED_WITHOUT_RESULT'));
      await this.reconcileSessionOf(ctx, s.execution_authority_id);
    }
    // Lapsed authorities get their append-only EXPIRED event (in-flight effects keep reconciling).
    const lapsed = await this.pool.query(
      `SELECT DISTINCT tenant_id FROM execution_authorities WHERE status IN ('ACTIVE', 'SUSPENDED')
          AND expires_at <= clock_timestamp() LIMIT $1`,
      [limit],
    );
    for (const t of lapsed.rows) {
      const ctx = issueBrokerWorkerContext(t.tenant_id as TenantId, 'sweep-expiry');
      await this.tx(ctx, (c) => expireLapsedAuthoritiesInTx(c, ctx));
    }
    return { intents: due.rows.length, sessions: sessions.rows.length };
  }

  async intentView(tenantId: TenantId, intentId: string) {
    const ctx = issueBrokerWorkerContext(tenantId, `view-${intentId.slice(4, 40)}`);
    return this.tx(ctx, (c) => loadIntentViewInTx(c, tenantId, intentId));
  }
}

/** The legal external-outcome path from `from` to a target (REQUESTED is inferred only from a provider answer). */
export function externalPath(from: string, to: 'ACCEPTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'): string[] {
  if (from === to) return [];
  if (from === 'UNKNOWN') return [to];
  const head = from === 'AUTHORIZED' ? ['REQUESTED'] : from === 'PROPOSED' ? ['AUTHORIZED', 'REQUESTED'] : [];
  const after = from === 'ACCEPTED' ? [] : ['ACCEPTED'];
  if (to === 'ACCEPTED') return [...head, 'ACCEPTED'];
  if (to === 'CONFIRMED') return [...head, ...after, 'CONFIRMED'];
  return [...head, to];
}

const finalReturnState = (i: any) => (BigInt(i.refunded_minor) > 0n ? 'REFUNDED' : 'REVERSED');

export function unknownOutcome(reasonCode: string): AdapterOutcome {
  return {
    kind: 'UNKNOWN',
    providerRef: null,
    reasonCode,
    rawProviderStatus: null,
    rawResponseDigest: null,
    observedAt: new Date().toISOString(),
  };
}

/** Version-checked single-row update of a broker table (every guard requires version + 1). */
export async function patch(c: Tx, table: string, row: any, fields: Record<string, unknown>): Promise<any> {
  const cols = Object.keys(fields);
  const sets = cols.map((k, n) => `${k} = $${n + 4}`);
  if (['external_attempts', 'execution_authority_sessions', 'commercial_intents'].includes(table))
    sets.push('updated_at = clock_timestamp()');
  const { rows } = await c.query(
    `UPDATE ${table} SET ${sets.join(', ')}, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3
     RETURNING *`,
    [row.tenant_id, row.id, row.version, ...cols.map((k) => fields[k])],
  );
  if (!rows[0]) throw new DomainError('VERSION_CONFLICT', 'The resource changed; reload and retry.');
  return rows[0];
}

export { sha };
/* eslint-enable @typescript-eslint/no-explicit-any */
