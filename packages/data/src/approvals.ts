// Approvals (FR-10 shared layer, INV-02, INV-03, INV-15). An approval is an immutable, server-computed signed scope
// bound to tenant, incident, site, exact asset/evidence/policy revisions, plan hash, action digest, exact provider-
// account revision for paid scope, amount (minor units + currency), actor and expiry. Authority comes only from the
// authenticated principal's role grants evaluated against the currently effective AUTHORITY policy revision.
// Revocation, invalidation and consumption are a single append-only approval event.
import {
  ApprovalIdSchema,
  AssetRevisionIdSchema,
  DomainError,
  EvidenceRevisionIdSchema,
  ExecutionAuthorityIdSchema,
  IncidentIdSchema,
  MoneySchema,
  PolicyRevisionIdSchema,
  ProviderAccountRevisionIdSchema,
  SiteIdSchema,
  UtcInstantSchema,
  VersionedDigestSchema,
  newId,
  type ApprovalId,
  type Money,
  type SiteId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import {
  ACTION_CLASSES,
  APPROVAL_KINDS,
  ENGINEERING_ACTION_CLASSES,
  requireAuthorized,
  type ActionClass,
  type ActionName,
  type ApprovalKind,
  type AuthorityPolicy,
} from './authz.js';
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { humanActor, type TenantContext } from './context.js';
import { dbNow, iso, isoNN, type Db } from './db.js';
import { appendOutboxEvent } from './outbox.js';
import { loadPolicyRevision } from './policy.js';

export interface ApprovalInput {
  approvalKind: ApprovalKind;
  incidentId: string;
  siteId: SiteId;
  assetRevisionId: string;
  evidenceRevisionId: string | null;
  policyRevisionId: string;
  planHash: string | null;
  actionDigest: string | null;
  actionClass: ActionClass;
  paid: boolean;
  providerAccountRevisionId: string | null;
  targetExecutionAuthorityId: string | null;
  maxAmount: Money;
  expiresAt: UtcInstant | string;
}

const ApprovalInputSchema = z
  .strictObject({
    approvalKind: z.enum(APPROVAL_KINDS),
    incidentId: IncidentIdSchema,
    siteId: SiteIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    evidenceRevisionId: EvidenceRevisionIdSchema.nullable(),
    policyRevisionId: PolicyRevisionIdSchema,
    planHash: VersionedDigestSchema.nullable(),
    actionDigest: VersionedDigestSchema.nullable(),
    actionClass: z.enum(ACTION_CLASSES),
    paid: z.boolean(),
    providerAccountRevisionId: ProviderAccountRevisionIdSchema.nullable(),
    targetExecutionAuthorityId: ExecutionAuthorityIdSchema.nullable(),
    maxAmount: z.strictObject({ amountMinor: z.bigint().min(0n), currency: MoneySchema.shape.currency }),
    expiresAt: UtcInstantSchema,
  })
  .superRefine((a, c) => {
    const issue = (path: string, message: string) => c.addIssue({ code: 'custom', path: [path], message });
    if (a.paid && a.providerAccountRevisionId === null)
      issue('providerAccountRevisionId', 'Paid scope must pin the exact provider-account revision.');
    if (a.approvalKind === 'PLAN_ACTION') {
      if (a.evidenceRevisionId === null) issue('evidenceRevisionId', 'Required for plan-action approval.');
      if (a.planHash === null) issue('planHash', 'Required for plan-action approval.');
      if (a.actionDigest === null) issue('actionDigest', 'Required for plan-action approval.');
      if (a.targetExecutionAuthorityId !== null)
        issue('targetExecutionAuthorityId', 'Only budget adjustments target an authority.');
    } else if (a.targetExecutionAuthorityId === null)
      issue('targetExecutionAuthorityId', 'A budget adjustment must target an execution authority.');
  });

const actionFor = (kind: ApprovalKind, cls: ActionClass): ActionName =>
  kind === 'BUDGET_ADJUSTMENT'
    ? 'approval.budget_adjustment'
    : (ENGINEERING_ACTION_CLASSES as readonly string[]).includes(cls)
      ? 'approval.engineering_exception'
      : 'approval.plan_action';

const hold = (reasonCode: string) =>
  new DomainError('POLICY_HOLD', 'This approval cannot be recorded under the current revisions.', { reasonCode });

export async function recordApproval(
  pool: Db,
  ctx: TenantContext,
  input: ApprovalInput,
): Promise<{ approvalId: ApprovalId; signatureDigest: string }> {
  const parsed = ApprovalInputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', {
      reasonCode: 'INVALID_APPROVAL',
      fieldErrors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), issue: i.code })),
    });
  const a = parsed.data;
  const action = actionFor(a.approvalKind, a.actionClass);
  const approvalId = newId('approval');
  const meta = { action, resourceType: 'approval', resourceId: approvalId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const policy = await loadPolicyRevision(c, ctx.tenantId, a.policyRevisionId);
    if (!policy || policy.policyKey !== 'AUTHORITY') throw unavailable(meta, a.policyRevisionId, 'policy_revision');
    if (!policy.effectiveNow) throw hold('POLICY_REVISION_NOT_EFFECTIVE');
    const decision = requireAuthorized(
      ctx,
      { action, siteId: a.siteId, approvalKind: a.approvalKind, actionClass: a.actionClass, amount: a.maxAmount },
      policy.body as AuthorityPolicy,
      { type: 'approval', id: approvalId },
    );
    const actorUserId = humanActor(ctx);

    const site = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, a.siteId]);
    if (site.rowCount !== 1) throw unavailable(meta, a.siteId, 'site');
    const ar = await c.query(
      `SELECT r.superseded_at, x.site_id FROM asset_revisions r JOIN assets x ON x.tenant_id = r.tenant_id AND x.id = r.asset_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [ctx.tenantId, a.assetRevisionId],
    );
    if (!ar.rows[0]) throw unavailable(meta, a.assetRevisionId, 'asset_revision');
    if (a.evidenceRevisionId !== null) {
      const ev = await c.query(
        `SELECT asset_revision_id, incident_id FROM evidence_revisions WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, a.evidenceRevisionId],
      );
      if (!ev.rows[0]) throw unavailable(meta, a.evidenceRevisionId, 'evidence_revision');
      if (ev.rows[0].asset_revision_id !== a.assetRevisionId || ev.rows[0].incident_id !== a.incidentId)
        throw hold('EVIDENCE_REVISION_NOT_BOUND');
    }
    if (a.providerAccountRevisionId !== null) {
      const pr = await c.query(
        `SELECT r.superseded_at, r.paid, p.status FROM provider_account_revisions r
           JOIN provider_accounts p ON p.tenant_id = r.tenant_id AND p.id = r.provider_account_id
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [ctx.tenantId, a.providerAccountRevisionId],
      );
      if (!pr.rows[0]) throw unavailable(meta, a.providerAccountRevisionId, 'provider_account_revision');
      if (pr.rows[0].superseded_at !== null || pr.rows[0].status !== 'ACTIVE')
        throw hold('PROVIDER_ACCOUNT_REVISION_NOT_CURRENT');
      if (pr.rows[0].paid !== a.paid) throw hold('PROVIDER_ACCOUNT_PAID_MISMATCH');
    }
    if (ar.rows[0].superseded_at !== null) throw hold('ASSET_REVISION_SUPERSEDED');
    if (ar.rows[0].site_id !== a.siteId) throw hold('ASSET_NOT_AT_SITE');
    const now = await dbNow(c);
    if (Date.parse(a.expiresAt) <= Date.parse(now)) throw hold('APPROVAL_ALREADY_EXPIRED');

    const signatureDigest = canonicalDigest('approval', 1, {
      tenantId: ctx.tenantId,
      approvalId,
      approvalKind: a.approvalKind,
      incidentId: a.incidentId,
      siteId: a.siteId,
      assetRevisionId: a.assetRevisionId,
      evidenceRevisionId: a.evidenceRevisionId,
      policyRevisionId: a.policyRevisionId,
      planHash: a.planHash,
      actionDigest: a.actionDigest,
      actionClass: a.actionClass,
      paid: a.paid,
      providerAccountRevisionId: a.providerAccountRevisionId,
      targetExecutionAuthorityId: a.targetExecutionAuthorityId,
      maxAmount: { amountMinor: a.maxAmount.amountMinor, currency: a.maxAmount.currency },
      expiresAt: a.expiresAt,
      actorUserId,
      actorRole: decision.role,
    });
    await c.query(
      `INSERT INTO approvals (tenant_id, id, approval_kind, target_execution_authority_id, incident_id, site_id, asset_revision_id,
         evidence_revision_id, policy_revision_id, plan_hash, action_digest, action_class, paid, provider_account_revision_id,
         actor_user_id, actor_role, max_amount_minor, currency, expires_at, signature_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        ctx.tenantId,
        approvalId,
        a.approvalKind,
        a.targetExecutionAuthorityId,
        a.incidentId,
        a.siteId,
        a.assetRevisionId,
        a.evidenceRevisionId,
        a.policyRevisionId,
        a.planHash,
        a.actionDigest,
        a.actionClass,
        a.paid,
        a.providerAccountRevisionId,
        actorUserId,
        decision.role,
        a.maxAmount.amountMinor.toString(),
        a.maxAmount.currency,
        a.expiresAt,
        signatureDigest,
      ],
    );
    await appendOutboxEvent(c, ctx, {
      eventType: 'approval.recorded.v1',
      aggregateType: 'approval',
      aggregateId: approvalId,
      aggregateVersion: 1,
      payload: { approvalId, approvalKind: a.approvalKind, incidentId: a.incidentId, signatureDigest },
      correlationId: ctx.correlationId,
      causationId: newId('command'),
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { approvalId, signatureDigest };
  });
}

export interface ApprovalStatus {
  approval: {
    approvalId: ApprovalId;
    approvalKind: ApprovalKind;
    incidentId: string;
    siteId: SiteId;
    assetRevisionId: string;
    evidenceRevisionId: string | null;
    policyRevisionId: string;
    providerAccountRevisionId: string | null;
    actionClass: ActionClass;
    maxAmount: Money;
    expiresAt: UtcInstant;
    signatureDigest: string;
    actorUserId: string;
    actorRole: string;
  };
  events: { eventType: 'REVOKED' | 'INVALIDATED' | 'CONSUMED'; reasonCode: string; createdAt: UtcInstant }[];
  executable: boolean;
}

export async function getApprovalStatus(pool: Db, ctx: TenantContext, approvalId: ApprovalId): Promise<ApprovalStatus> {
  const meta = { action: 'approval.read', resourceType: 'approval', resourceId: approvalId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!ApprovalIdSchema.safeParse(approvalId).success) throw unavailable(meta);
    const { rows } = await c.query(
      `SELECT *, expires_at > clock_timestamp() AS live FROM approvals WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, approvalId],
    );
    const r = rows[0];
    if (!r) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.read', siteId: r.site_id }, undefined, {
      type: 'approval',
      id: approvalId,
    });
    const ev = await c.query(
      `SELECT event_type, reason_code, created_at FROM approval_events WHERE tenant_id = $1 AND approval_id = $2 ORDER BY created_at`,
      [ctx.tenantId, approvalId],
    );
    const events = ev.rows.map((e) => ({
      eventType: e.event_type,
      reasonCode: e.reason_code,
      createdAt: isoNN(e.created_at),
    }));
    return {
      approval: {
        approvalId: r.id,
        approvalKind: r.approval_kind,
        incidentId: r.incident_id,
        siteId: r.site_id,
        assetRevisionId: r.asset_revision_id,
        evidenceRevisionId: r.evidence_revision_id,
        policyRevisionId: r.policy_revision_id,
        providerAccountRevisionId: r.provider_account_revision_id,
        actionClass: r.action_class,
        maxAmount: { amountMinor: BigInt(r.max_amount_minor), currency: r.currency },
        expiresAt: iso(r.expires_at)!,
        signatureDigest: r.signature_digest,
        actorUserId: r.actor_user_id,
        actorRole: r.actor_role,
      },
      events,
      executable: events.length === 0 && r.live === true,
    };
  });
}

/** Append-only revocation by an approver-capable human (the original approval row is never edited). */
export async function revokeApproval(
  pool: Db,
  ctx: TenantContext,
  approvalId: ApprovalId,
  reasonCode: string,
): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode))
    throw new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode: 'INVALID_REASON' });
  const meta = { action: 'approval.revoke', resourceType: 'approval', resourceId: approvalId };
  await tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`SELECT site_id FROM approvals WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      approvalId,
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'incident.acknowledge', siteId: rows[0].site_id });
    const r = await c.query(
      `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
       VALUES ($1, 'ape_' || gen_random_uuid(), $2, 'REVOKED', $3, 'HUMAN', $4)
       ON CONFLICT (tenant_id, approval_id) DO NOTHING`,
      [ctx.tenantId, approvalId, reasonCode, humanActor(ctx)],
    );
    if (r.rowCount !== 1) throw hold('APPROVAL_ALREADY_TERMINAL');
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode });
  });
}
