// Execution authorities (FR-11, INV-02, INV-03, INV-05, INV-15; STATE-MACHINES §5). Idempotent issuance materializes
// ONE immutable Ed25519-signed scope per paid PLAN_ACTION approval, reloading the approval and its subject from
// PostgreSQL and recomputing the action digest; it opens the budget account with the signed base limit and persists
// the separate Kite-session activation operation (its own pre-egress operation identity, PREPARED/PROPOSED). The
// local lifecycle ACTIVE/SUSPENDED/REVOKED/EXPIRED is append-only and serializes with the broker's reserve
// transaction through the authority row lock; it never erases or relabels a possibly in-flight effect.
import { createHash, randomUUID } from 'node:crypto';
import {
  ApprovalIdSchema,
  DomainError,
  ExecutionAuthorityIdSchema,
  newId,
  type ExecutionAuthority,
  type KiteSession,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalize, transition } from '@uptimebuyer/domain';
import {
  UNIQUE_VIOLATION,
  dbNow,
  pgCode,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { emitAuthorityIssued, emitAuthorityStateChanged } from './events.js';
import {
  actorFields,
  digestMismatch,
  hold,
  invalid,
  mapGuardError,
  newCommerceId,
  semanticOperationFor,
} from './internal.js';
import { signAuthorityScope, type AuthorityScope, type AuthoritySigner } from './signing.js';
import { loadSubjectFacts, providerRevisionCurrent, type SubjectRef } from './subjects.js';
import { toBudget, toExecutionAuthority, toExternalAttempt, toKiteSession, type BudgetProjection } from './views.js';

const IssueSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  subject: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('PLAN_ACTION'), id: z.string().regex(/^cand_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/) }),
    z.strictObject({
      type: z.literal('PROVIDER_CONTACT_REQUEST'),
      id: z.string().regex(/^pcr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
    }),
  ]),
});
export type IssueExecutionAuthorityInput = z.input<typeof IssueSchema>;

export interface ExecutionAuthorityView {
  authority: ExecutionAuthority;
  scope: {
    siteId: string;
    subject: SubjectRef;
    semanticOperation: string;
    providerAccountId: string;
    signature: { algorithm: 'ED25519'; keyId: string };
  };
  session: KiteSession;
  sessionReasonCode: string | null;
  budget: BudgetProjection;
  unresolvedAttempts: ReturnType<typeof toExternalAttempt>[];
  /** The authority is local bounded authority only; ACTIVE never implies that Kite created a session. */
  executable: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadView(c: Tx, tenantId: string, authorityId: string): Promise<ExecutionAuthorityView | null> {
  const x = (
    await c.query(`SELECT * FROM execution_authorities WHERE tenant_id = $1 AND id = $2`, [tenantId, authorityId])
  ).rows[0];
  if (!x) return null;
  const s = (
    await c.query(`SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`, [
      tenantId,
      authorityId,
    ])
  ).rows[0];
  const b = (
    await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`, [
      tenantId,
      authorityId,
    ])
  ).rows[0];
  const open = await c.query(
    `SELECT a.* FROM external_attempts a JOIN commercial_intents i ON i.tenant_id = a.tenant_id AND i.id = a.intent_id
      WHERE a.tenant_id = $1 AND i.execution_authority_id = $2 AND i.state IN ('RESERVED', 'SUBMITTED', 'UNKNOWN')
      ORDER BY a.created_at`,
    [tenantId, authorityId],
  );
  const live = (
    await c.query(
      `SELECT expires_at > clock_timestamp() AS live FROM execution_authorities
     WHERE tenant_id = $1 AND id = $2`,
      [tenantId, authorityId],
    )
  ).rows[0].live;
  return {
    authority: toExecutionAuthority(x),
    scope: {
      siteId: x.site_id,
      subject: { type: x.subject_type, id: x.subject_id },
      semanticOperation: x.semantic_operation,
      providerAccountId: x.provider_account_id,
      signature: { algorithm: 'ED25519', keyId: x.signature_key_id },
    },
    session: toKiteSession(s),
    sessionReasonCode: s.reason_code,
    budget: toBudget(b),
    unresolvedAttempts: open.rows.map(toExternalAttempt),
    executable: x.status === 'ACTIVE' && live && s.external_outcome_state === 'CONFIRMED',
  };
}

export async function issueExecutionAuthority(
  pool: Db,
  ctx: TenantContext,
  raw: IssueExecutionAuthorityInput,
  signer: AuthoritySigner,
): Promise<ExecutionAuthorityView & { created: boolean }> {
  const parsed = IssueSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_AUTHORITY_REQUEST');
  const input = parsed.data;
  const meta = { action: 'commerce.authority_issue', resourceType: 'approval', resourceId: input.approvalId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const a = (
      await c.query(
        `SELECT a.*, a.expires_at > clock_timestamp() AS live,
                EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id) AS terminal
           FROM approvals a WHERE a.tenant_id = $1 AND a.id = $2 FOR SHARE OF a`,
        [ctx.tenantId, input.approvalId],
      )
    ).rows[0];
    if (!a) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.authority_issue', siteId: a.site_id }, undefined, {
      type: 'approval',
      id: a.id,
    });
    // Idempotent: one authority per approval; a repeat returns it (and its one session operation).
    const existing = (
      await c.query(
        `SELECT id, subject_type, subject_id FROM execution_authorities WHERE tenant_id = $1 AND approval_id = $2`,
        [ctx.tenantId, a.id],
      )
    ).rows[0];
    if (existing) {
      if (existing.subject_type !== input.subject.type || existing.subject_id !== input.subject.id)
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'This approval already issued an authority for another subject.',
        );
      return { ...(await loadView(c, ctx.tenantId, existing.id))!, created: false };
    }
    if (a.approval_kind !== 'PLAN_ACTION' || a.paid !== true) throw hold('APPROVAL_NOT_PAID_PLAN_ACTION');
    if (a.terminal || !a.live) throw hold('APPROVAL_NOT_EXECUTABLE');

    const f = await loadSubjectFacts(c, ctx.tenantId, input.subject, a.id);
    if (!f) throw unavailable(meta, input.subject.id, 'subject');
    if (input.subject.type === 'PLAN_ACTION' && f.planHash === null) throw hold('APPROVAL_NOT_BOUND_TO_PLAN_ACTION');
    if (f.invalidated) throw hold('SUBJECT_INVALIDATED');
    if (f.recomputedActionDigest === null || f.recomputedActionDigest !== f.storedActionDigest)
      throw digestMismatch('SUBJECT_DIGEST_NOT_REPRODUCIBLE');
    if (a.action_digest !== f.storedActionDigest) throw digestMismatch('APPROVAL_DIGEST_MISMATCH');
    const scopeMatches =
      a.incident_id === f.incidentId &&
      a.site_id === f.siteId &&
      a.asset_revision_id === f.assetRevisionId &&
      a.evidence_revision_id === f.evidenceRevisionId &&
      a.policy_revision_id === f.policyRevisionId &&
      a.plan_hash === f.planHash &&
      a.provider_account_revision_id === f.providerAccountRevisionId &&
      a.currency === f.amount.currency;
    if (!scopeMatches) throw hold('APPROVAL_SCOPE_MISMATCH');
    if (BigInt(a.max_amount_minor) < f.amount.amountMinor || f.amount.amountMinor <= 0n)
      throw hold('APPROVAL_AMOUNT_BELOW_ACTION');
    if (!(await providerRevisionCurrent(c, ctx.tenantId, f.providerAccountRevisionId)))
      throw hold('PROVIDER_ACCOUNT_REVISION_NOT_CURRENT');

    const now = await dbNow(c);
    const executionAuthorityId = newId('executionAuthority');
    const scope: AuthorityScope = {
      tenantId: ctx.tenantId,
      executionAuthorityId,
      approvalId: a.id,
      incidentId: f.incidentId,
      siteId: f.siteId,
      assetRevisionId: f.assetRevisionId,
      evidenceRevisionId: f.evidenceRevisionId,
      policyRevisionId: f.policyRevisionId!,
      planHash: f.planHash!,
      actionDigest: f.storedActionDigest,
      subject: { type: f.subject.type, id: f.subject.id },
      semanticOperation: semanticOperationFor(f.actionKind),
      providerAccountId: f.providerAccountId,
      providerAccountRevisionId: f.providerAccountRevisionId,
      merchantId: f.merchantId,
      purpose: f.purpose,
      allowedActionKinds: [f.actionKind],
      perActionLimit: { amountMinor: f.amount.amountMinor, currency: f.amount.currency },
      baseLimit: { amountMinor: BigInt(a.max_amount_minor), currency: a.currency },
      issuedAt: now,
      expiresAt: new Date(a.expires_at).toISOString(),
    };
    const sig = signAuthorityScope(scope, signer);
    const actor = actorFields(ctx);
    let x: any;
    try {
      const ins = await c.query(
        `INSERT INTO execution_authorities (tenant_id, id, approval_id, incident_id, site_id, asset_revision_id,
           evidence_revision_id, policy_revision_id, plan_hash, action_digest, subject_type, subject_id, semantic_operation,
           provider_account_id, provider_account_revision_id, merchant_id, purpose, allowed_action_kinds,
           per_action_limit_minor, base_limit_minor, currency, issued_at, expires_at, scope_digest, signature_algorithm,
           signature_key_id, signature_value, status, issued_by_kind, issued_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                 $24, 'ED25519', $25, $26, 'ACTIVE', $27, $28)
         ON CONFLICT (tenant_id, approval_id) DO NOTHING RETURNING *`,
        [
          ctx.tenantId,
          executionAuthorityId,
          a.id,
          scope.incidentId,
          scope.siteId,
          scope.assetRevisionId,
          scope.evidenceRevisionId,
          scope.policyRevisionId,
          scope.planHash,
          scope.actionDigest,
          scope.subject.type,
          scope.subject.id,
          scope.semanticOperation,
          scope.providerAccountId,
          scope.providerAccountRevisionId,
          scope.merchantId,
          scope.purpose,
          scope.allowedActionKinds,
          scope.perActionLimit.amountMinor.toString(),
          scope.baseLimit.amountMinor.toString(),
          scope.baseLimit.currency,
          scope.issuedAt,
          scope.expiresAt,
          sig.scopeDigest,
          sig.keyId,
          sig.value,
          actor.kind,
          actor.id,
        ],
      );
      x = ins.rows[0];
    } catch (e) {
      mapGuardError(e);
    }
    if (!x) {
      // A concurrent issuance for the same approval won; return it.
      const won = (
        await c.query(`SELECT id FROM execution_authorities WHERE tenant_id = $1 AND approval_id = $2`, [
          ctx.tenantId,
          a.id,
        ])
      ).rows[0];
      return { ...(await loadView(c, ctx.tenantId, won.id))!, created: false };
    }
    await c.query(
      `INSERT INTO execution_authority_events (tenant_id, id, execution_authority_id, sequence, event_type, prior_status,
         new_status, reason_code, actor_kind, actor_id, effective_at)
       VALUES ($1, $2, $3, 1, 'ISSUED', NULL, 'ACTIVE', 'APPROVAL_MATERIALIZED', $4, $5, $6)`,
      [ctx.tenantId, newCommerceId('authorityEvent'), x.id, actor.kind, actor.id, now],
    );
    await c.query(
      `INSERT INTO budget_accounts (tenant_id, id, execution_authority_id, base_limit_minor, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.tenantId, newCommerceId('budgetAccount'), x.id, x.base_limit_minor, x.currency],
    );
    const sessionScope = canonicalize({
      executionAuthorityId: x.id,
      scopeDigest: x.scope_digest,
      providerAccountRevisionId: x.provider_account_revision_id,
    });
    await c.query(
      `INSERT INTO execution_authority_sessions (tenant_id, id, execution_authority_id, provider_account_id,
         provider_account_revision_id, client_operation_id, idempotency_key, request_digest, transport_state,
         external_outcome_state, adapter_capability)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PREPARED', 'PROPOSED', 'ELIGIBLE')`,
      [
        ctx.tenantId,
        newId('kiteSession'),
        x.id,
        x.provider_account_id,
        x.provider_account_revision_id,
        newId('clientOperation'),
        `kite-session.${randomUUID()}`,
        `sha256:${createHash('sha256').update(`kite-session.v1\n${sessionScope}`).digest('hex')}`,
      ],
    );
    await emitAuthorityIssued(c, ctx, x);
    await recordAudit(c, ctx, { ...meta, resourceType: 'execution_authority', resourceId: x.id, result: 'SUCCEEDED' });
    return { ...(await loadView(c, ctx.tenantId, x.id))!, created: true };
  });
}

export async function getExecutionAuthority(
  pool: Db,
  ctx: TenantContext,
  executionAuthorityId: string,
): Promise<ExecutionAuthorityView> {
  const meta = {
    action: 'commerce.read',
    resourceType: 'execution_authority',
    resourceId: String(executionAuthorityId).slice(0, 128),
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!ExecutionAuthorityIdSchema.safeParse(executionAuthorityId).success) throw unavailable(meta, null);
    const x = (
      await c.query(`SELECT site_id FROM execution_authorities WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        executionAuthorityId,
      ])
    ).rows[0];
    if (!x) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.read', siteId: x.site_id }, undefined, {
      type: 'execution_authority',
      id: executionAuthorityId,
    });
    return (await loadView(c, ctx.tenantId, executionAuthorityId))!;
  });
}

const EVENT_FOR: Record<string, string> = {
  SUSPENDED: 'SUSPENDED',
  ACTIVE: 'REACTIVATED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
};

/** One append-only lifecycle move under the authority row lock (serializes with the broker's reserve). */
export async function transitionAuthorityInTx(
  c: Tx,
  ctx: TenantContext,
  x: any,
  to: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED',
  reasonCode: string,
): Promise<any> {
  transition('EXECUTION_AUTHORITY', x.status, to);
  const actor = actorFields(ctx);
  const now = await dbNow(c);
  const up = await c.query(
    `UPDATE execution_authorities SET status = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $4
     RETURNING *`,
    [ctx.tenantId, x.id, to, x.version],
  );
  if (!up.rows[0]) throw new DomainError('VERSION_CONFLICT', 'The resource changed; reload and retry.');
  await c.query(
    `INSERT INTO execution_authority_events (tenant_id, id, execution_authority_id, sequence, event_type, prior_status,
       new_status, reason_code, actor_kind, actor_id, effective_at)
     SELECT $1, $2, $3, coalesce(max(sequence), 0) + 1, $4, $5, $6, $7, $8, $9, $10
       FROM execution_authority_events WHERE tenant_id = $1 AND execution_authority_id = $3`,
    [
      ctx.tenantId,
      newCommerceId('authorityEvent'),
      x.id,
      EVENT_FOR[to],
      x.status,
      to,
      reasonCode,
      actor.kind,
      actor.id,
      now,
    ],
  );
  await emitAuthorityStateChanged(c, ctx, up.rows[0], x.status, reasonCode, now);
  return up.rows[0];
}

const ChangeSchema = z.strictObject({
  executionAuthorityId: ExecutionAuthorityIdSchema,
  to: z.enum(['SUSPENDED', 'ACTIVE', 'REVOKED']),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
});

/**
 * Suspend, reactivate or revoke (API `:revoke`). Blocks new reserves from the moment it commits; it never releases,
 * relabels or erases a possibly in-flight effect, which keeps reconciling under the pinned historical authority.
 */
export async function changeExecutionAuthorityStatus(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof ChangeSchema>,
): Promise<ExecutionAuthorityView> {
  const parsed = ChangeSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_AUTHORITY_CHANGE');
  const input = parsed.data;
  const meta = {
    action: 'commerce.authority_manage',
    resourceType: 'execution_authority',
    resourceId: input.executionAuthorityId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const x = (
      await c.query(
        `SELECT *, expires_at <= clock_timestamp() AS lapsed FROM execution_authorities WHERE tenant_id = $1 AND id = $2
          FOR NO KEY UPDATE`,
        [ctx.tenantId, input.executionAuthorityId],
      )
    ).rows[0];
    if (!x) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.authority_manage', siteId: x.site_id }, undefined, {
      type: 'execution_authority',
      id: x.id,
    });
    if (x.status === input.to) return (await loadView(c, ctx.tenantId, x.id))!;
    if (x.status === 'REVOKED' || x.status === 'EXPIRED') throw hold('AUTHORITY_TERMINAL', { status: x.status });
    if (input.to === 'ACTIVE' && x.lapsed) throw hold('AUTHORITY_EXPIRED');
    await transitionAuthorityInTx(c, ctx, x, input.to, input.reasonCode);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
    return (await loadView(c, ctx.tenantId, x.id))!;
  });
}

/** Worker/broker sweep: append EXPIRED for every lapsed ACTIVE/SUSPENDED authority of the tenant. */
export async function expireLapsedAuthoritiesInTx(c: Tx, ctx: TenantContext): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT * FROM execution_authorities WHERE tenant_id = $1 AND status IN ('ACTIVE', 'SUSPENDED')
        AND expires_at <= clock_timestamp() ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`,
    [ctx.tenantId],
  );
  for (const x of rows) await transitionAuthorityInTx(c, ctx, x, 'EXPIRED', 'AUTHORITY_EXPIRED');
  return rows.map((r) => r.id);
}

export async function expireLapsedAuthorities(pool: Db, ctx: TenantContext): Promise<string[]> {
  const meta = { action: 'commerce.engine', resourceType: 'execution_authority' };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'commerce.engine', siteId: null });
    return expireLapsedAuthoritiesInTx(c, ctx);
  });
}

export { loadView as loadAuthorityViewInTx };
export const isUniqueViolation = (e: unknown) => pgCode(e) === UNIQUE_VIOLATION;
export type { UtcInstant };
/* eslint-enable @typescript-eslint/no-explicit-any */
