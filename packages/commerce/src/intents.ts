// Commercial intents (FR-12, INV-03, INV-05, INV-07). Creation is the durable CREATED intent only: never a reserve,
// a network submission or a purchase. The request names identities; every bound value is reloaded and must equal the
// signed authority, which must itself be bound to the named approval (the M07 broker-port contract). The stable
// action digest plus authority maps to at most one intent (duplicates return it); a successor under fresh authority
// exists only when every prior intent for the digest is FAILED (terminal definite-no-effect), enforced by the
// partial unique index across authorities. The pre-generated client operation identity is fixed here.
import { randomUUID } from 'node:crypto';
import {
  CommercialIntentIdSchema,
  DomainError,
  decodeWire,
  encodeWire,
  newId,
  type CommercialIntent,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import {
  UNIQUE_VIOLATION,
  lockKey,
  pgCode,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import {
  CommercialIntentRequestSchema,
  type CommercialIntentRequest,
  type CreateIntentResult,
} from '@uptimebuyer/kite-contracts';
import { emitIntentCreated, recordIntentTransition, RESULT_ORIGIN } from './events.js';
import { actionDigestLock, actorFields, digestMismatch, hold, mapGuardError, successorBlocked } from './internal.js';
import { issueReference, type ReferenceSigner } from './signing.js';
import { loadSubjectFacts } from './subjects.js';
import { toCommercialIntent, toExternalAttempt, toIntentMoney, type IntentMoney } from './views.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function createCommercialIntentInTx(
  c: Tx,
  ctx: TenantContext,
  request: CommercialIntentRequest,
  meta: { action: string; resourceType: string },
): Promise<{ row: any; created: boolean }> {
  const x = (
    await c.query(
      `SELECT *, expires_at > clock_timestamp() AS live FROM execution_authorities WHERE tenant_id = $1 AND id = $2
        FOR SHARE`,
      [ctx.tenantId, request.executionAuthorityId],
    )
  ).rows[0];
  if (!x) throw unavailable(meta, request.executionAuthorityId, 'execution_authority');
  requireAuthorized(ctx, { action: 'commerce.intent_create', siteId: x.site_id }, undefined, {
    type: 'execution_authority',
    id: x.id,
  });
  // M07 contract: the authority must belong to the named approval; every bound field must equal the signed scope.
  if (x.approval_id !== request.approvalId) throw hold('AUTHORITY_NOT_BOUND_TO_APPROVAL');
  const scopeMatches =
    x.incident_id === request.incidentId &&
    x.asset_revision_id === request.assetRevisionId &&
    x.evidence_revision_id === request.evidenceRevisionId &&
    x.policy_revision_id === request.policyRevisionId &&
    x.plan_hash === request.planHash &&
    x.provider_account_revision_id === request.providerAccountRevisionId &&
    x.subject_type === request.subject.type &&
    x.subject_id === request.subject.id &&
    x.semantic_operation === request.semanticOperation;
  if (!scopeMatches) throw hold('INTENT_REQUEST_OUTSIDE_AUTHORITY');
  if (x.action_digest !== request.actionDigest) throw digestMismatch('ACTION_DIGEST_NOT_AUTHORIZED');
  if (request.expectedMax.currency !== x.currency) throw hold('CURRENCY_MISMATCH');
  if (request.expectedMax.amountMinor !== BigInt(x.per_action_limit_minor)) throw hold('EXPECTED_MAX_MISMATCH');

  const material = {
    tenantId: request.tenantId,
    incidentId: request.incidentId,
    assetRevisionId: request.assetRevisionId,
    evidenceRevisionId: request.evidenceRevisionId,
    policyRevisionId: request.policyRevisionId,
    planHash: request.planHash,
    actionDigest: request.actionDigest,
    approvalId: request.approvalId,
    executionAuthorityId: request.executionAuthorityId,
    providerAccountRevisionId: request.providerAccountRevisionId,
    subject: request.subject,
    semanticOperation: request.semanticOperation,
    expectedMax: { amountMinor: request.expectedMax.amountMinor, currency: request.expectedMax.currency },
  };
  const requestDigest = canonicalDigest('intent-request', 1, material);
  await lockKey(c, actionDigestLock(ctx.tenantId, x.action_digest));
  const same = (
    await c.query(
      `SELECT * FROM commercial_intents WHERE tenant_id = $1 AND action_digest = $2 AND execution_authority_id = $3`,
      [ctx.tenantId, x.action_digest, x.id],
    )
  ).rows[0];
  if (same) {
    if (same.request_digest !== requestDigest)
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This intent identity was already used for a different request.');
    return { row: same, created: false };
  }
  if (x.status !== 'ACTIVE') throw hold('AUTHORITY_NOT_ACTIVE', { status: x.status });
  if (!x.live) throw hold('AUTHORITY_EXPIRED');
  const approvalLive = (await c.query(`SELECT ub_approval_executable($1, $2) AS ok`, [ctx.tenantId, x.approval_id]))
    .rows[0].ok;
  if (!approvalLive) throw hold('APPROVAL_NOT_EXECUTABLE');
  // Changed action input requires a new digest: the subject must still reproduce the authorized digest.
  const f = await loadSubjectFacts(c, ctx.tenantId, request.subject, x.approval_id);
  if (!f || f.recomputedActionDigest !== x.action_digest || f.storedActionDigest !== x.action_digest)
    throw digestMismatch('SUBJECT_DIGEST_CHANGED');
  if (f.merchantId !== x.merchant_id || f.purpose !== x.purpose || f.amount.currency !== x.currency)
    throw hold('SUBJECT_OUTSIDE_AUTHORITY');

  const priors = (
    await c.query(
      `SELECT id, state FROM commercial_intents WHERE tenant_id = $1 AND action_digest = $2
        ORDER BY created_at DESC, id DESC FOR NO KEY UPDATE`,
      [ctx.tenantId, x.action_digest],
    )
  ).rows;
  if (priors.some((p) => p.state !== 'FAILED')) throw successorBlocked();
  const account = (
    await c.query(`SELECT id FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`, [
      ctx.tenantId,
      x.id,
    ])
  ).rows[0];
  const intentKey = canonicalDigest('commercial-intent-key', 1, {
    tenantId: ctx.tenantId,
    incidentId: x.incident_id,
    assetRevisionId: x.asset_revision_id,
    evidenceRevisionId: x.evidence_revision_id,
    policyRevisionId: x.policy_revision_id,
    planHash: x.plan_hash,
    actionDigest: x.action_digest,
    executionAuthorityId: x.id,
    providerAccountRevisionId: x.provider_account_revision_id,
    semanticOperation: x.semantic_operation,
  });
  const actor = actorFields(ctx);
  let row: any;
  try {
    row = (
      await c.query(
        `INSERT INTO commercial_intents (tenant_id, id, incident_id, site_id, asset_revision_id, evidence_revision_id,
           policy_revision_id, plan_hash, subject_type, subject_id, approval_id, execution_authority_id, budget_account_id,
           provider_account_id, provider_account_revision_id, action_digest, semantic_operation, intent_key, request_digest,
           request_idempotency_key, client_operation_id, idempotency_key, max_amount_minor, currency, state,
           supersedes_intent_id, correlation_id, created_by_kind, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                 $24, 'CREATED', $25, $26, $27, $28) RETURNING *`,
        [
          ctx.tenantId,
          newId('commercialIntent'),
          x.incident_id,
          x.site_id,
          x.asset_revision_id,
          x.evidence_revision_id,
          x.policy_revision_id,
          x.plan_hash,
          x.subject_type,
          x.subject_id,
          x.approval_id,
          x.id,
          account.id,
          x.provider_account_id,
          x.provider_account_revision_id,
          x.action_digest,
          x.semantic_operation,
          intentKey,
          requestDigest,
          request.idempotencyKey,
          newId('clientOperation'),
          `cin-op.${randomUUID()}`,
          x.per_action_limit_minor,
          x.currency,
          priors[0]?.id ?? null,
          ctx.correlationId,
          actor.kind,
          actor.id,
        ],
      )
    ).rows[0];
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw successorBlocked();
    mapGuardError(e);
  }
  await recordIntentTransition(
    c,
    ctx,
    row.id,
    null,
    'CREATED',
    priors[0] ? 'SUCCESSOR_UNDER_FRESH_AUTHORITY' : 'CREATED',
  );
  await emitIntentCreated(c, ctx, row);
  await recordAudit(c, ctx, { ...meta, resourceType: 'commercial_intent', resourceId: row.id, result: 'SUCCEEDED' });
  return { row, created: true };
}

/** Create (or return) the one intent for a request; returns the signed COMMERCIAL_INTENT reference for the broker. */
export async function createCommercialIntent(
  pool: Db,
  ctx: TenantContext,
  rawRequest: CommercialIntentRequest,
  signer: ReferenceSigner,
): Promise<CreateIntentResult> {
  let request: CommercialIntentRequest;
  try {
    request = decodeWire(CommercialIntentRequestSchema, encodeWire(CommercialIntentRequestSchema, rawRequest));
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', {
      reasonCode: 'INVALID_INTENT_REQUEST',
    });
  }
  const meta = {
    action: 'commerce.intent_create',
    resourceType: 'execution_authority',
    resourceId: request.executionAuthorityId,
  };
  if (request.tenantId !== ctx.tenantId)
    throw new DomainError('FORBIDDEN', 'The requested resource is not available.', {
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
  const { row, created } = await tenantCommand(pool, ctx, meta, (c) =>
    createCommercialIntentInTx(c, ctx, request, meta),
  );
  return {
    intent: toCommercialIntent(row),
    executionReference: issueReference(signer, ctx.tenantId, { kind: 'COMMERCIAL_INTENT', commercialIntentId: row.id }),
    created,
    resultOrigin: RESULT_ORIGIN,
  };
}

export interface CommercialIntentView {
  intent: CommercialIntent;
  money: IntentMoney;
  semanticOperation: string;
  reasonCode: string | null;
  attempt: ReturnType<typeof toExternalAttempt> | null;
  transitions: { sequence: number; from: string | null; to: string; reasonCode: string; at: string }[];
  /** Separate evidence kinds; a payment observation is never fulfillment or recovery. */
  receipts: { kind: string; resultOrigin: string; normalizedDigest: string; observedAt: string }[];
  resultOrigin: string | null;
}

export async function loadIntentViewInTx(
  c: Tx,
  tenantId: string,
  intentId: string,
): Promise<CommercialIntentView | null> {
  const i = (await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [tenantId, intentId]))
    .rows[0];
  if (!i) return null;
  const a = (
    await c.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [tenantId, intentId])
  ).rows[0];
  const t = await c.query(
    `SELECT * FROM commercial_intent_transitions WHERE tenant_id = $1 AND intent_id = $2 ORDER BY sequence`,
    [tenantId, intentId],
  );
  const r = await c.query(
    `SELECT * FROM external_receipts WHERE tenant_id = $1 AND intent_id = $2 ORDER BY created_at`,
    [tenantId, intentId],
  );
  return {
    intent: toCommercialIntent(i),
    money: toIntentMoney(i),
    semanticOperation: i.semantic_operation,
    reasonCode: i.reason_code,
    attempt: a ? toExternalAttempt(a) : null,
    transitions: t.rows.map((x) => ({
      sequence: x.sequence,
      from: x.from_state,
      to: x.to_state,
      reasonCode: x.reason_code,
      at: new Date(x.created_at).toISOString(),
    })),
    receipts: r.rows.map((x) => ({
      kind: x.kind,
      resultOrigin: x.result_origin,
      normalizedDigest: x.normalized_digest,
      observedAt: new Date(x.observed_at).toISOString(),
    })),
    resultOrigin: a ? a.result_origin : null,
  };
}

export async function getCommercialIntent(
  pool: Db,
  ctx: TenantContext,
  intentId: string,
): Promise<CommercialIntentView> {
  const meta = {
    action: 'commerce.read',
    resourceType: 'commercial_intent',
    resourceId: String(intentId).slice(0, 128),
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!CommercialIntentIdSchema.safeParse(intentId).success) throw unavailable(meta, null);
    const i = (
      await c.query(`SELECT site_id FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, intentId])
    ).rows[0];
    if (!i) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.read', siteId: i.site_id }, undefined, {
      type: 'commercial_intent',
      id: intentId,
    });
    return (await loadIntentViewInTx(c, ctx.tenantId, intentId))!;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
