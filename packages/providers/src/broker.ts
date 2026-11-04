// Paid contact handoff through the M01 commercial-intent broker PORT (FR-08, INV-06, INV-07, INV-08). M07 never holds
// a paid credential or reaches paid egress: it validates the exact approval scope, submits one idempotent intent
// request whose subject is the immutable contact request (same identity and idempotency key on every retry), asks the
// broker once to execute it, and then only mirrors broker result events (commercial_intent.state_changed.v1). It
// never reconciles or retries a paid UNKNOWN; until M09 exists the port is the CONTRACT FAKE and every mirrored row
// says so (result_origin CONTRACT_FAKE).
import { DomainError, decodeWire, newId, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import {
  consumeOnce,
  recordAudit,
  unavailable,
  withTenantTransaction,
  type CommandMeta,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import {
  CommercialIntentStateChangedEventSchema,
  type CommercialIntentBrokerPort,
  type CommercialIntentRequest,
  type CommercialIntentStateChangedEvent,
} from '@uptimebuyer/kite-contracts';
import { emitAttempt, patchAttempt, toAttemptView, type AttemptRow } from './attempts.js';
import type { ExecuteContactResult } from './contacts.js';
import type { RequestRow } from './requests.js';
import { hold } from './errors.js';
import { newProviderId } from './ids.js';
import { appendAttemptEvent, type RevisionRow } from './internal.js';

export const BROKER_RESULT_CONSUMER = 'provider-broker-result.v1';

export interface PaidAuthority {
  approvalId: string;
  executionAuthorityId: string;
}

/** The approval must be the exact executable PLAN_ACTION scope of this paid contact request. */
export async function validatePaidAuthority(
  c: Tx,
  ctx: TenantContext,
  req: RequestRow,
  authority: PaidAuthority,
  meta: CommandMeta,
): Promise<void> {
  const { rows } = await c.query(
    `SELECT a.*, a.expires_at > clock_timestamp() AS live,
            EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id) AS terminal
       FROM approvals a WHERE a.tenant_id = $1 AND a.id = $2 FOR SHARE OF a`,
    [ctx.tenantId, authority.approvalId],
  );
  const a = rows[0];
  if (!a) throw unavailable(meta, authority.approvalId, 'approval');
  const scopeMatches =
    a.approval_kind === 'PLAN_ACTION' &&
    a.paid === true &&
    a.incident_id === req.incident_id &&
    a.site_id === req.site_id &&
    a.asset_revision_id === req.asset_revision_id &&
    a.evidence_revision_id === req.evidence_revision_id &&
    a.policy_revision_id === req.policy_revision_id &&
    a.action_digest === req.action_digest &&
    a.plan_hash === req.plan_hash &&
    a.provider_account_revision_id === req.provider_account_revision_id;
  if (!scopeMatches) throw hold('APPROVAL_SCOPE_MISMATCH');
  if (a.terminal || !a.live) throw hold('APPROVAL_NOT_EXECUTABLE');
  if (a.currency !== req.currency || BigInt(a.max_amount_minor) < BigInt(req.max_cost_minor))
    throw hold('APPROVAL_AMOUNT_BELOW_REQUEST');
}

/** Deterministic broker-request idempotency key: one per contact request and execution authority. */
export const paidIdempotencyKey = (requestId: string, executionAuthorityId: string) =>
  `pcr.${requestId.slice(4)}.${executionAuthorityId.slice(4)}`;

export async function executePaidContact(
  pool: Db,
  ctx: TenantContext,
  req: RequestRow,
  revision: RevisionRow,
  authority: PaidAuthority,
  attemptNumber: number,
  broker: CommercialIntentBrokerPort,
): Promise<ExecuteContactResult> {
  // Serialize the handoff per contact request so concurrent retries submit exactly one broker-port request.
  const lock = await pool.connect();
  const lockKey = `provider-contact-paid:${ctx.tenantId}:${req.id}`;
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const live = await withTenantTransaction(pool, ctx, async (c) => {
      const { rows } = await c.query<AttemptRow>(
        `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND contact_request_id = $2 AND NOT definite_no_effect`,
        [ctx.tenantId, req.id],
      );
      return rows[0];
    });
    if (live) return { contactRequestId: req.id, route: 'KITE_BROKER', created: false, attempt: toAttemptView(live) };

    const request: CommercialIntentRequest = {
      tenantId: ctx.tenantId,
      incidentId: req.incident_id,
      assetRevisionId: req.asset_revision_id,
      evidenceRevisionId: req.evidence_revision_id,
      policyRevisionId: req.policy_revision_id!,
      planHash: req.plan_hash!,
      actionDigest: req.action_digest!,
      approvalId: authority.approvalId,
      executionAuthorityId: authority.executionAuthorityId,
      providerAccountRevisionId: req.provider_account_revision_id,
      subject: { type: 'PROVIDER_CONTACT_REQUEST', id: req.id },
      semanticOperation: 'PAID_CONTACT',
      expectedMax: { amountMinor: BigInt(req.max_cost_minor), currency: req.currency },
      requestedBy:
        ctx.principal.kind === 'HUMAN'
          ? { kind: 'USER', userId: ctx.principal.id }
          : { kind: 'SERVICE', serviceIdentityId: ctx.principal.id },
      correlationId: ctx.correlationId,
      idempotencyKey: paidIdempotencyKey(req.id, authority.executionAuthorityId),
    } as unknown as CommercialIntentRequest;
    const created = await broker.createIntent(request);
    const i = created.intent;
    if (
      i.tenantId !== ctx.tenantId ||
      i.subject.type !== 'PROVIDER_CONTACT_REQUEST' ||
      i.subject.id !== req.id ||
      i.actionDigest !== req.action_digest ||
      i.executionAuthorityId !== authority.executionAuthorityId ||
      i.providerAccountRevisionId !== req.provider_account_revision_id
    )
      throw new DomainError('DEPENDENCY_FAILED', 'The broker result does not match the submitted request.', {
        reasonCode: 'BROKER_RESULT_MISMATCH',
      });

    const inserted = await withTenantTransaction(pool, ctx, async (c) => {
      const { rows } = await c.query<AttemptRow>(
        `INSERT INTO provider_contact_attempts (tenant_id, id, contact_request_id, attempt_number, provider_account_id,
           provider_account_revision_id, paid, commercial_intent_id, execution_authority_id, approval_id,
           client_operation_id, idempotency_key, request_digest, transport_state, external_outcome_state,
           adapter_capability, economic_state, result_origin, adapter_class)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11, $12, 'PREPARED', 'AUTHORIZED', 'ELIGIBLE', $13, $14,
                 'BROKER')
         ON CONFLICT (tenant_id, commercial_intent_id) WHERE commercial_intent_id IS NOT NULL DO NOTHING RETURNING *`,
        [
          ctx.tenantId,
          newProviderId('attempt'),
          req.id,
          attemptNumber,
          req.provider_account_id,
          req.provider_account_revision_id,
          i.commercialIntentId,
          authority.executionAuthorityId,
          authority.approvalId,
          newId('clientOperation'),
          request.idempotencyKey,
          req.request_digest,
          i.state,
          created.resultOrigin,
        ],
      );
      const row = rows[0];
      if (!row) return null;
      await appendAttemptEvent(c, ctx.tenantId, row.id, {
        kind: 'BROKER_SUBMITTED',
        transportState: row.transport_state,
        externalOutcomeState: row.external_outcome_state,
        adapterCapability: row.adapter_capability,
        economicState: row.economic_state,
      });
      await emitAttempt(c, ctx, row, req.incident_id);
      await recordAudit(c, ctx, {
        action: 'provider_contact_request.broker_submit',
        resourceType: 'provider_contact_request',
        resourceId: req.id,
        result: 'SUCCEEDED',
        metadata: { resultOrigin: created.resultOrigin },
      });
      return row;
    });

    if (inserted && i.state === 'CREATED') {
      // One hand-off request; the broker owns reserve + SEND_STARTED + egress and all reconciliation.
      try {
        const run = await broker.execute(created.executionReference);
        for (const event of run.events) await withTenantTransaction(pool, ctx, (c) => applyBrokerEvent(c, ctx, event));
      } catch (error) {
        const reason =
          error instanceof DomainError ? String(error.details.reasonCode ?? error.code) : 'BROKER_EXECUTE_ERROR';
        await withTenantTransaction(pool, ctx, (c) =>
          appendAttemptEvent(c, ctx.tenantId, inserted.id, {
            kind: 'BROKER_SUBMITTED',
            transportState: inserted.transport_state,
            externalOutcomeState: inserted.external_outcome_state,
            adapterCapability: inserted.adapter_capability,
            economicState: inserted.economic_state,
            reasonCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : 'BROKER_EXECUTE_ERROR',
          }),
        );
      }
    }
    const final = await withTenantTransaction(pool, ctx, async (c) => {
      const { rows } = await c.query<AttemptRow>(
        `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND commercial_intent_id = $2`,
        [ctx.tenantId, i.commercialIntentId],
      );
      return rows[0]!;
    });
    return {
      contactRequestId: req.id,
      route: 'KITE_BROKER',
      created: inserted !== null,
      attempt: toAttemptView(final),
    };
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => {});
    lock.release();
  }
}

const TRANSPORT_EDGES = new Set([
  'PREPARED>SEND_STARTED',
  'SEND_STARTED>ACKNOWLEDGED',
  'SEND_STARTED>UNKNOWN',
  'SEND_STARTED>DEFINITE_NO_EFFECT',
]);
const OUTCOME_EDGES = new Set([
  'PROPOSED>AUTHORIZED',
  'AUTHORIZED>REQUESTED',
  'REQUESTED>ACCEPTED',
  'ACCEPTED>CONFIRMED',
  'REQUESTED>FAILED',
  'REQUESTED>CANCELLED',
  'ACCEPTED>FAILED',
  'ACCEPTED>CANCELLED',
  'AUTHORIZED>UNKNOWN',
  'REQUESTED>UNKNOWN',
  'ACCEPTED>UNKNOWN',
  'UNKNOWN>ACCEPTED',
  'UNKNOWN>CONFIRMED',
  'UNKNOWN>FAILED',
  'UNKNOWN>CANCELLED',
  'AUTHORIZED>ACCEPTED',
  'AUTHORIZED>CONFIRMED',
  'AUTHORIZED>FAILED',
  'REQUESTED>CONFIRMED',
]);

export type BrokerEventDisposition = 'APPLIED' | 'STALE' | 'QUARANTINED' | 'DUPLICATE';

async function receipt(
  c: Tx,
  ctx: TenantContext,
  e: CommercialIntentStateChangedEvent,
  disposition: Exclude<BrokerEventDisposition, 'DUPLICATE'>,
  attemptId: string | null,
  reasonCode: string | null,
) {
  await c.query(
    `INSERT INTO provider_broker_event_receipts (tenant_id, id, event_id, commercial_intent_id, aggregate_version,
       attempt_id, disposition, reason_code, result_origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ctx.tenantId,
      newProviderId('brokerReceipt'),
      e.eventId,
      e.payload.commercialIntentId,
      e.aggregateVersion,
      attemptId,
      disposition,
      reasonCode,
      e.payload.resultOrigin,
    ],
  );
  if (disposition === 'QUARANTINED')
    await recordAudit(c, ctx, {
      action: 'provider_broker_result.consume',
      resourceType: 'commercial_intent',
      resourceId: null,
      result: 'DENIED',
      reasonCode,
    });
  return disposition;
}

/**
 * Mirror one broker result event onto the M07 attempt (separate axes; never a retry). Unknown intents, binding or
 * origin mismatches are quarantined without mutating workflow state; older versions are recorded as STALE.
 */
export async function applyBrokerEvent(
  c: Tx,
  ctx: TenantContext,
  raw: CommercialIntentStateChangedEvent | DomainEventEnvelope,
): Promise<BrokerEventDisposition> {
  const e = decodeWire(CommercialIntentStateChangedEventSchema, raw as never);
  const seen = await c.query(`SELECT 1 FROM provider_broker_event_receipts WHERE tenant_id = $1 AND event_id = $2`, [
    ctx.tenantId,
    e.eventId,
  ]);
  if (seen.rowCount === 1) return 'DUPLICATE';
  if (e.tenantId !== ctx.tenantId) return receipt(c, ctx, e, 'QUARANTINED', null, 'TENANT_MISMATCH');
  const p = e.payload;
  const { rows } = await c.query<AttemptRow & { action_digest: string | null; incident_id: string }>(
    `SELECT a.*, q.action_digest, q.incident_id FROM provider_contact_attempts a
       JOIN provider_contact_requests q ON q.tenant_id = a.tenant_id AND q.id = a.contact_request_id
      WHERE a.tenant_id = $1 AND a.commercial_intent_id = $2 FOR UPDATE OF a`,
    [ctx.tenantId, p.commercialIntentId],
  );
  const cur0 = rows[0];
  if (!cur0) return receipt(c, ctx, e, 'QUARANTINED', null, 'UNKNOWN_INTENT');
  if (cur0.action_digest !== p.actionDigest || cur0.execution_authority_id !== p.executionAuthorityId)
    return receipt(c, ctx, e, 'QUARANTINED', cur0.id, 'BINDING_MISMATCH');
  if (cur0.result_origin !== p.resultOrigin) return receipt(c, ctx, e, 'QUARANTINED', cur0.id, 'ORIGIN_MISMATCH');
  if (cur0.last_broker_event_version !== null && e.aggregateVersion <= cur0.last_broker_event_version)
    return receipt(c, ctx, e, 'STALE', cur0.id, null);

  let cur: AttemptRow = cur0;
  const target = p.attempt;
  const obs = {
    kind: 'BROKER_EVENT' as const,
    sourceEventId: e.eventId,
    rawProviderStatus: `broker:${p.state.toLowerCase()}`,
  };
  // Fold the broker's pre-egress marker into the mirror (the broker committed it before its egress).
  if (target && cur.transport_state === 'PREPARED' && target.transportState !== 'PREPARED')
    cur = await patchAttempt(
      c,
      ctx,
      cur,
      { transport_state: 'SEND_STARTED' },
      { ...obs, reasonCode: 'MIRROR_SEND_STARTED' },
      cur0.incident_id,
    );
  const transport =
    target && TRANSPORT_EDGES.has(`${cur.transport_state}>${target.transportState}`)
      ? target.transportState
      : cur.transport_state;
  let outcome = cur.external_outcome_state;
  const wanted = target?.externalOutcomeState ?? (p.state === 'FAILED' ? 'FAILED' : outcome);
  if (wanted !== outcome) {
    if (!OUTCOME_EDGES.has(`${outcome}>${wanted}`))
      return receipt(c, ctx, e, 'QUARANTINED', cur.id, 'ILLEGAL_MIRROR_TRANSITION');
    outcome = wanted;
  }
  const capabilityLost = target?.adapterCapability === 'UNSUPPORTED' && cur.adapter_capability === 'ELIGIBLE';
  const unknown = p.state === 'UNKNOWN';
  cur = await patchAttempt(
    c,
    ctx,
    cur,
    {
      transport_state: transport,
      external_outcome_state: outcome,
      economic_state: p.state,
      provider_ref: target?.providerRef ?? cur.provider_ref,
      next_reconcile_at: unknown ? p.nextReconcileAt : null,
      manual_review:
        unknown && (capabilityLost || cur.adapter_capability === 'UNSUPPORTED' || p.nextReconcileAt === null),
      definite_no_effect: p.state === 'FAILED' ? true : cur.definite_no_effect,
      raw_provider_status: obs.rawProviderStatus.slice(0, 64),
      last_broker_event_version: e.aggregateVersion,
    },
    { ...obs, reasonCode: p.reasonCode },
    cur0.incident_id,
  );
  if (capabilityLost)
    // Capability axis only: the effect stays UNKNOWN and reserved at the broker, in manual review.
    cur = await patchAttempt(
      c,
      ctx,
      cur,
      { adapter_capability: 'UNSUPPORTED', capability_reason: 'BROKER_RECONCILIATION_UNSUPPORTED' },
      { kind: 'CAPABILITY_CHANGE', sourceEventId: e.eventId, reasonCode: 'BROKER_RECONCILIATION_UNSUPPORTED' },
      cur0.incident_id,
    );
  return receipt(c, ctx, e, 'APPLIED', cur.id, null);
}

/** Outbox consumer for commercial_intent.state_changed.v1 (consumeOnce; receipt commits with the mirror). */
export async function handleBrokerResultEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE'> {
  return consumeOnce(pool, BROKER_RESULT_CONSUMER, envelope, async (c, ctx) => {
    await applyBrokerEvent(c, ctx, envelope);
  });
}
