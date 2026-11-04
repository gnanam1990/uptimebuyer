// T-037 — Bounded session approval. Idempotent issuance persists and returns one immutable Ed25519-signed execution
// authority per approval with the exact incident, revisions, plan hash, action digest, provider-account revision,
// merchant, purpose, action kinds, per-action/aggregate cap, currency, expiry, local state and the separate
// Kite-session operation; restart preserves it. A paid reserve waits for ACTIVE + session CONFIRMED. Races against
// expiry, suspension, revocation and a bound-revision change deny new work while in-flight effects reconcile.
// Successors under fresh approval exist only after definite-no-effect predecessors. All provider effects come from the
// RECORDED_CONTRACT adapter (not Kite).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorityScopeOf,
  authoritySignatureOf,
  changeExecutionAuthorityStatus,
  createCommercialIntent,
  exportAuthorityPublicKey,
  getCommercialIntent,
  getExecutionAuthority,
  importAuthorityPublicKey,
  intentRequestFor,
  verifyAuthorityScope,
} from '@uptimebuyer/commerce';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import {
  createBrokerWorld,
  createIntentFor,
  freshApproval,
  inProcessBroker,
  intentRef,
  issue,
  newEvidenceRevision,
  paidPlanAction,
  readyIntent,
  rejection,
  rowOf,
  sessionRef,
  sleep,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t037');
});
afterAll(async () => w?.close());

const count = async (table: string, where: string, params: unknown[]) =>
  (
    await w.db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${where}`, [
      w.tenant.tenantId,
      ...params,
    ])
  ).rows[0].n as number;

describe('T-037 bounded session approval', () => {
  it('issues exactly one immutable signed authority per approval, idempotently and concurrently, with the exact scope', async () => {
    const p = await paidPlanAction(w);
    const results = await Promise.all([issue(w, p), issue(w, p), issue(w, p)]);
    const ids = new Set(results.map((r) => r.authority.executionAuthorityId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const v = results[0]!;
    const id = v.authority.executionAuthorityId;
    expect(await count('execution_authorities', 'approval_id = $2', [p.approvalId])).toBe(1);
    expect(await count('execution_authority_sessions', 'execution_authority_id = $2', [id])).toBe(1);
    expect(await count('budget_accounts', 'execution_authority_id = $2', [id])).toBe(1);
    expect(
      await count('execution_authority_events', "execution_authority_id = $2 AND event_type = 'ISSUED'", [id]),
    ).toBe(1);

    const approval = await rowOf(w, 'approvals', p.approvalId);
    const a = v.authority;
    expect([
      a.approvalId,
      a.incidentId,
      a.assetRevisionId,
      a.evidenceRevisionId,
      a.policyRevisionId,
      a.planHash,
      a.actionDigest,
    ]).toEqual([
      approval.id,
      approval.incident_id,
      approval.asset_revision_id,
      approval.evidence_revision_id,
      approval.policy_revision_id,
      approval.plan_hash,
      approval.action_digest,
    ]);
    expect(a.providerAccountRevisionId).toBe(approval.provider_account_revision_id);
    expect(a.allowedActionKinds).toEqual(['PART_PURCHASE']);
    expect(a.perActionLimit).toEqual({ amountMinor: 18_500n, currency: 'USD' });
    expect(a.baseLimit).toEqual({ amountMinor: BigInt(approval.max_amount_minor), currency: 'USD' });
    expect(a.merchantId).toMatch(/^mer_/);
    expect(a.purpose).toBe('PART_PURCHASE');
    expect(a.expiresAt).toBe(new Date(approval.expires_at).toISOString());
    expect(a.status).toBe('ACTIVE');
    expect(v.scope.subject).toEqual({ type: 'PLAN_ACTION', id: p.candidateActionId });
    // Local ACTIVE is not a Kite session: the session operation exists before egress, PREPARED/PROPOSED, no reference.
    expect([v.session.transportState, v.session.externalOutcomeState, v.session.providerSessionRef]).toEqual([
      'PREPARED',
      'PROPOSED',
      null,
    ]);
    expect(v.session.clientOperationId).toMatch(/^op_/);
    expect(v.executable).toBe(false);

    // Restart: a fresh connection pool reloads the same signed scope, and the signature verifies.
    const pool = new pg.Pool({ connectionString: w.db.url, max: 2 });
    try {
      const row = (
        await pool.query(`SELECT * FROM execution_authorities WHERE tenant_id = $1 AND id = $2`, [
          w.tenant.tenantId,
          id,
        ])
      ).rows[0];
      const keys = { [w.authoritySigner.keyId]: importAuthorityPublicKey(exportAuthorityPublicKey(w.authoritySigner)) };
      expect(verifyAuthorityScope(authorityScopeOf(row), authoritySignatureOf(row), keys)).toBe(true);
      expect(
        verifyAuthorityScope(
          { ...authorityScopeOf(row), merchantId: 'mer_attacker-0001' },
          authoritySignatureOf(row),
          keys,
        ),
      ).toBe(false);
    } finally {
      await pool.end();
    }
    const again = await getExecutionAuthority(w.db.pool, w.viewerCtx, id);
    expect(again.authority).toEqual(a);
    expect((await issue(w, p)).created).toBe(false);

    // Immutable: no edit, no delete, no forged second authority for the approval or a widened scope.
    for (const sql of [
      `UPDATE execution_authorities SET merchant_id = 'mer_attacker-0001' WHERE tenant_id = $1 AND id = $2`,
      `UPDATE execution_authorities SET base_limit_minor = base_limit_minor + 1 WHERE tenant_id = $1 AND id = $2`,
      `DELETE FROM execution_authorities WHERE tenant_id = $1 AND id = $2`,
    ])
      await expect(w.db.pool.query(sql, [w.tenant.tenantId, id])).rejects.toMatchObject({ code: 'UB001' });
    await expect(
      w.db.pool.query(
        `INSERT INTO execution_authorities SELECT tenant_id, 'xau_forged-' || substr(md5(random()::text), 1, 12), approval_id,
           incident_id, site_id, asset_revision_id, evidence_revision_id, policy_revision_id, plan_hash, action_digest,
           subject_type, subject_id, semantic_operation, provider_account_id, provider_account_revision_id, merchant_id,
           purpose, allowed_action_kinds, per_action_limit_minor, base_limit_minor * 2, currency, issued_at, expires_at,
           scope_digest, signature_algorithm, signature_key_id, signature_value, 'ACTIVE', 1, issued_by_kind, issued_by_id
           FROM execution_authorities WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(UB091|23505)$/) });
  });

  it('blocks a paid reserve until the local authority is ACTIVE and the separate Kite session is CONFIRMED', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    const xau = auth.authority.executionAuthorityId;
    const created = await createIntentFor(w, auth);
    const intentId = created.intent.commercialIntentId;
    expect(created.intent.state).toBe('CREATED');
    expect(created.resultOrigin).toBe('KITE_BROKER');

    // No session yet: hold, nothing reserved, nothing sent.
    const before = await rejection(broker.execute(intentRef(w, intentId)));
    expect([before.code, before.reasonCode]).toEqual(['POLICY_HOLD', 'KITE_SESSION_NOT_CONFIRMED']);

    // Session accepted (human approval pending at the provider) is still not executable.
    adapter.sessionModes.push('PENDING');
    const pending = await broker.activateSession(sessionRef(w, xau));
    expect([pending.session.transportState, pending.session.externalOutcomeState]).toEqual([
      'ACKNOWLEDGED',
      'ACCEPTED',
    ]);
    expect(pending.session.nextReconcileAt).not.toBeNull();
    const still = await rejection(broker.execute(intentRef(w, intentId)));
    expect(still.reasonCode).toBe('KITE_SESSION_NOT_CONFIRMED');
    // Activation is never re-sent: a second reference returns the same operation.
    const repeat = await broker.activateSession(sessionRef(w, xau));
    expect(repeat.session.clientOperationId).toBe(pending.session.clientOperationId);
    expect(adapter.sessions.size).toBe(1);

    adapter.activate(pending.session.idempotencyKey);
    const confirmed = await broker.reconcileAuthoritySession(sessionRef(w, xau));
    expect(confirmed.externalOutcomeState).toBe('CONFIRMED');
    expect(confirmed.providerSessionRef).toMatch(/^recsess_/);
    expect(await count('budget_ledger_entries', 'intent_id = $2', [intentId])).toBe(0);
    expect(adapter.executeCalls).toBe(0);

    const run = await broker.execute(intentRef(w, intentId));
    expect(run.intent.state).toBe('CONFIRMED');
    expect(run.events.map((e) => e.payload.state)).toEqual(['RESERVED', 'SUBMITTED', 'CONFIRMED']);
    expect(run.events[0]!.payload.attempt).toMatchObject({
      transportState: 'SEND_STARTED',
      externalOutcomeState: 'AUTHORIZED',
    });
    expect((await getExecutionAuthority(w.db.pool, w.viewerCtx, xau)).executable).toBe(true);

    // A lost session response is UNKNOWN (not failed) and reconciles by the session's own operation key.
    const p2 = await paidPlanAction(w);
    const auth2 = await issue(w, p2);
    adapter.sessionModes.push('DROP_RESPONSE');
    const lost = await broker.activateSession(sessionRef(w, auth2.authority.executionAuthorityId));
    expect([lost.session.transportState, lost.session.externalOutcomeState]).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(lost.session.nextReconcileAt).not.toBeNull();
    const found = await broker.reconcileAuthoritySession(sessionRef(w, auth2.authority.executionAuthorityId));
    expect(found.externalOutcomeState).toBe('CONFIRMED');
    expect(found.clientOperationId).toBe(lost.session.clientOperationId);
  });

  it('suspension and revocation serialize with the reserve: new work is denied, in-flight work keeps reconciling', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);

    // Suspension wins before the reserve: hold, no egress; reactivation lets the same intent proceed.
    const a = await readyIntent(w, broker);
    const xa = a.auth.authority.executionAuthorityId;
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: xa,
      to: 'SUSPENDED',
      reasonCode: 'OPERATOR_PAUSE',
    });
    const held = await rejection(broker.execute(intentRef(w, a.intentId)));
    expect(held.reasonCode).toBe('AUTHORITY_SUSPENDED');
    expect(adapter.executeCalls).toBe(0);
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: xa,
      to: 'ACTIVE',
      reasonCode: 'OPERATOR_RESUME',
    });
    expect((await broker.execute(intentRef(w, a.intentId))).intent.state).toBe('CONFIRMED');

    // Revocation wins before the reserve: definite-no-effect FAILED, no reserve, no egress.
    const b = await readyIntent(w, broker);
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: b.auth.authority.executionAuthorityId,
      to: 'REVOKED',
      reasonCode: 'OPERATOR_REVOKE',
    });
    const calls = adapter.executeCalls;
    const failed = await broker.execute(intentRef(w, b.intentId));
    expect(failed.intent.state).toBe('FAILED');
    expect(failed.events[0]!.payload.reasonCode).toBe('AUTHORITY_REVOKED');
    expect(adapter.executeCalls).toBe(calls);
    expect(await count('budget_ledger_entries', 'intent_id = $2', [b.intentId])).toBe(0);

    // Revocation commits while the request is in flight (after reserve + SEND_STARTED): the effect is not erased.
    let revoke: Promise<unknown> | null = null;
    const racing = inProcessBroker(w, adapter, {
      hooks: {
        AFTER_SEND_STARTED: async () => {
          revoke = changeExecutionAuthorityStatus(w.db.pool, w.approver, {
            executionAuthorityId: c.auth.authority.executionAuthorityId,
            to: 'REVOKED',
            reasonCode: 'OPERATOR_REVOKE',
          });
          await revoke;
        },
      },
    });
    const c = await readyIntent(w, racing);
    const inFlight = await racing.execute(intentRef(w, c.intentId));
    await revoke;
    expect(inFlight.intent.state).toBe('CONFIRMED');
    expect((await rowOf(w, 'execution_authorities', c.auth.authority.executionAuthorityId)).status).toBe('REVOKED');
    expect((await getCommercialIntent(w.db.pool, w.viewerCtx, c.intentId)).money.capturedGrossMinor).toBe(18_500n);
    // ...but no further intent under the revoked authority can be created.
    const p2 = await paidPlanAction(w);
    const auth2 = await issue(w, p2);
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: auth2.authority.executionAuthorityId,
      to: 'REVOKED',
      reasonCode: 'OPERATOR_REVOKE',
    });
    expect((await rejection(createIntentFor(w, auth2))).reasonCode).toBe('AUTHORITY_NOT_ACTIVE');

    // Concurrent suspension vs reserve: exactly one order wins and the outcome is consistent with it.
    for (let n = 0; n < 4; n++) {
      const r = await readyIntent(w, broker);
      const before = adapter.executeCalls;
      const [ex, sus] = await Promise.allSettled([
        broker.execute(intentRef(w, r.intentId)),
        changeExecutionAuthorityStatus(w.db.pool, w.approver, {
          executionAuthorityId: r.auth.authority.executionAuthorityId,
          to: 'SUSPENDED',
          reasonCode: 'OPERATOR_PAUSE',
        }),
      ]);
      expect(sus.status).toBe('fulfilled');
      const state = (await rowOf(w, 'commercial_intents', r.intentId)).state;
      if (ex.status === 'rejected') {
        expect(state).toBe('CREATED');
        expect(adapter.executeCalls).toBe(before);
      } else expect(state).toBe('CONFIRMED');
    }
  });

  it('races issuance and intent creation against expiry and a bound-revision change', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    // Approval and authority expire before the reserve: FAILED + EXPIRED appended, nothing sent.
    const short = await paidPlanAction(w, 18_500n, { expiresAt: new Date(Date.now() + 6_000).toISOString() });
    const auth = await issue(w, short);
    await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const created = await createIntentFor(w, auth);
    const lateApproval = await paidPlanAction(w, 18_500n, { expiresAt: new Date(Date.now() + 2_500).toISOString() });
    await sleep(6_200);
    const out = await broker.execute(intentRef(w, created.intent.commercialIntentId));
    expect(out.intent.state).toBe('FAILED');
    expect(out.events[0]!.payload.reasonCode).toMatch(/^(AUTHORITY_EXPIRED|APPROVAL_NOT_EXECUTABLE)$/);
    expect((await rowOf(w, 'execution_authorities', auth.authority.executionAuthorityId)).status).toBe('EXPIRED');
    expect(adapter.executeCalls).toBe(0);
    // Issuance after the approval expired is refused.
    expect((await rejection(issue(w, lateApproval))).reasonCode).toBe('APPROVAL_NOT_EXECUTABLE');
    // The duplicate request returns the one (FAILED) intent; it is never revived or rebound.
    const dup = await createIntentFor(w, auth);
    expect([dup.created, dup.intent.state]).toEqual([false, 'FAILED']);

    // A bound evidence revision changes after issuance: the CREATED intent fails definite-no-effect at revalidation.
    const p = await paidPlanAction(w);
    const a2 = await issue(w, p);
    await broker.activateSession(sessionRef(w, a2.authority.executionAuthorityId));
    const i2 = await createIntentFor(w, a2);
    await newEvidenceRevision(w, p);
    const stale = await broker.execute(intentRef(w, i2.intent.commercialIntentId));
    expect(stale.intent.state).toBe('FAILED');
    expect(stale.events[0]!.payload.reasonCode).toBe('EVIDENCE_REVISION_NOT_CURRENT');
    expect(adapter.executeCalls).toBe(0);
    // The FAILED intent is immutable and cannot be rebound: the same authority returns it, never a new one.
    const again = await createIntentFor(w, a2);
    expect([again.created, again.intent.commercialIntentId, again.intent.state]).toEqual([
      false,
      i2.intent.commercialIntentId,
      'FAILED',
    ]);
    await expect(
      w.db.pool.query(
        `UPDATE commercial_intents SET state = 'CREATED', version = version + 1 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, i2.intent.commercialIntentId],
      ),
    ).rejects.toMatchObject({ code: 'UB001' });
  });

  it('a changed action input needs a new digest; fresh approval yields at most one linked successor after definite no effect', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const req = intentRequestFor(auth, w.operator, w.key('intent'));
    const forged = await rejection(
      createCommercialIntent(
        w.db.pool,
        w.operator,
        { ...req, actionDigest: `action.v1:sha256:${'0'.repeat(64)}` as never },
        w.referenceSigner,
      ),
    );
    expect(forged.code).toBe('DIGEST_MISMATCH');
    const other = await paidPlanAction(w, 19_000n);
    const swapped = await rejection(
      createCommercialIntent(
        w.db.pool,
        w.operator,
        { ...req, subject: { type: 'PLAN_ACTION', id: other.candidateActionId as never } },
        w.referenceSigner,
      ),
    );
    expect(swapped.reasonCode).toBe('INTENT_REQUEST_OUTSIDE_AUTHORITY');

    // Predecessor fails definite-no-effect (revoked before reserve).
    const first = await createIntentFor(w, auth);
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: auth.authority.executionAuthorityId,
      to: 'REVOKED',
      reasonCode: 'OPERATOR_REVOKE',
    });
    expect((await broker.execute(intentRef(w, first.intent.commercialIntentId))).intent.state).toBe('FAILED');

    // Two fresh approvals of the unchanged inputs: two new authorities, but at most ONE successor intent.
    const [b1, b2] = [await issue(w, p, await freshApproval(w, p)), await issue(w, p, await freshApproval(w, p))];
    expect(b1.authority.actionDigest).toBe(auth.authority.actionDigest);
    expect(b1.authority.executionAuthorityId).not.toBe(b2.authority.executionAuthorityId);
    for (const b of [b1, b2]) await broker.activateSession(sessionRef(w, b.authority.executionAuthorityId));
    const settled = await Promise.allSettled([createIntentFor(w, b1), createIntentFor(w, b2)]);
    const ok = settled
      .filter((s) => s.status === 'fulfilled')
      .map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof createIntentFor>>>).value);
    expect(ok).toHaveLength(1);
    expect(
      ((settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code,
    ).toBe('INTENT_SUCCESSOR_BLOCKED');
    const successor = ok[0]!.intent;
    expect(successor.supersedesIntentId).toBe(first.intent.commercialIntentId);
    expect(successor.actionDigest).toBe(first.intent.actionDigest);
    const succRow = await rowOf(w, 'commercial_intents', successor.commercialIntentId);
    const firstRow = await rowOf(w, 'commercial_intents', first.intent.commercialIntentId);
    expect(succRow.client_operation_id).not.toBe(firstRow.client_operation_id);

    // A possibly effective predecessor (UNKNOWN) blocks every further successor.
    adapter.nextModes.push('DROP_RESPONSE');
    expect((await broker.execute(intentRef(w, successor.commercialIntentId))).intent.state).toBe('UNKNOWN');
    const b3 = await issue(w, p, await freshApproval(w, p));
    expect((await rejection(createIntentFor(w, b3))).code).toBe('INTENT_SUCCESSOR_BLOCKED');
    // ...and so does a fully refunded one (it had an economic effect).
    const key = succRow.idempotency_key;
    adapter.addReturn(key, { kind: 'REFUND', providerEventId: 'rf-full-1', amountMinor: 18_500n });
    const refunded = await broker.reconcile(intentRef(w, successor.commercialIntentId));
    expect(refunded.intent.state).toBe('REFUNDED');
    expect((await rejection(createIntentFor(w, b3))).code).toBe('INTENT_SUCCESSOR_BLOCKED');
    await expect(
      w.db.pool.query(
        `INSERT INTO commercial_intents SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, successor.commercialIntentId],
      ),
    ).rejects.toBeDefined();
  });
});
