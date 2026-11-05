// Plan-action approval (FR-10, FR-11, INV-02, INV-03, INV-15; STATE-MACHINES §4). The approver signs exactly the
// scope that M08 prepared — never a caller-supplied amount, revision, account or digest. The M02 approval is recorded
// with the approver's own role authority under the effective AUTHORITY policy, then bound to its PENDING request under
// the planning lock (so it serializes with plan invalidation) and the plan moves APPROVABLE -> APPROVED. A second
// approval for the same request (a fresh approval after a failed predecessor) leaves an already APPROVED/EXECUTING
// plan where it is. If the request or plan was invalidated meanwhile, the just-recorded approval is invalidated too.
import { IdempotencyKeySchema, type ApprovalId, type Money } from '@uptimebuyer/contracts';
import { transition } from '@uptimebuyer/domain';
import {
  Denial,
  appendOperatorEvidence,
  lockKey,
  notPermitted,
  recordApproval,
  sha256Digest,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type ActionClass,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { actorFields, hold, invalid, isoNN, newCommerceId, planningLock } from './internal.js';

const ApproveSchema = z.strictObject({
  approvalRequestId: z.string().regex(/^apq_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  planHash: z.string().regex(/^recovery-plan\.v1:sha256:[0-9a-f]{64}$/),
  idempotencyKey: IdempotencyKeySchema,
});
export type ApprovePlanActionInput = z.input<typeof ApproveSchema>;

export interface PlanActionApproval {
  approvalId: ApprovalId;
  approvalRequestId: string;
  planId: string;
  planActionId: string;
  candidateActionId: string;
  actionDigest: string;
  maxAmount: Money;
  expiresAt: string;
  created: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadRequest(c: Tx, ctx: TenantContext, id: string, meta: { action: string; resourceType: string }) {
  const r = (
    await c.query(
      `SELECT q.*, q.expires_at > clock_timestamp() AS live, p.state AS plan_state, p.version AS plan_version,
              pa.candidate_action_id
         FROM plan_approval_requests q
         JOIN recovery_plans p ON p.tenant_id = q.tenant_id AND p.id = q.plan_id
         JOIN plan_actions pa ON pa.tenant_id = q.tenant_id AND pa.id = q.plan_action_id
        WHERE q.tenant_id = $1 AND q.id = $2`,
      [ctx.tenantId, id],
    )
  ).rows[0];
  if (!r) throw unavailable(meta, id);
  return r;
}

async function existingBinding(c: Tx, ctx: TenantContext, requestId: string, key: string) {
  return (
    await c.query(
      `SELECT b.*, a.max_amount_minor, a.currency, a.expires_at, a.action_digest FROM plan_approval_bindings b
         JOIN approvals a ON a.tenant_id = b.tenant_id AND a.id = b.approval_id
        WHERE b.tenant_id = $1 AND b.approval_request_id = $2 AND b.idempotency_key = $3`,
      [ctx.tenantId, requestId, key],
    )
  ).rows[0];
}

const viewOf = (b: any, r: any, created: boolean): PlanActionApproval => ({
  approvalId: b.approval_id,
  approvalRequestId: b.approval_request_id,
  planId: b.plan_id,
  planActionId: b.plan_action_id,
  candidateActionId: r.candidate_action_id,
  actionDigest: r.action_digest,
  maxAmount: { amountMinor: BigInt(r.max_amount_minor), currency: r.currency } as Money,
  expiresAt: isoNN(r.expires_at),
  created,
});

export async function approvePlanAction(
  pool: Db,
  ctx: TenantContext,
  raw: ApprovePlanActionInput,
): Promise<PlanActionApproval> {
  const parsed = ApproveSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_PLAN_APPROVAL');
  const input = parsed.data;
  const meta = {
    action: 'approval.plan_action',
    resourceType: 'plan_approval_request',
    resourceId: input.approvalRequestId,
  };

  // Phase 1: read the prepared scope (and return an idempotent repeat).
  const pre = await tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRequest(c, ctx, input.approvalRequestId, meta);
    requireAuthorized(ctx, { action: 'planning.read', siteId: r.site_id }, undefined, {
      type: 'plan_approval_request',
      id: r.id,
    });
    const b = await existingBinding(c, ctx, r.id, input.idempotencyKey);
    if (b) return { done: viewOf(b, r, false) };
    if (r.plan_hash !== input.planHash) throw hold('PLAN_HASH_MISMATCH');
    if (r.invalidated_at) throw hold('APPROVAL_REQUEST_INVALIDATED');
    if (!r.live) throw hold('APPROVAL_REQUEST_EXPIRED');
    if (!['APPROVABLE', 'APPROVED', 'EXECUTING'].includes(r.plan_state)) throw hold('PLAN_NOT_APPROVABLE');
    return { request: r };
  });
  if ('done' in pre) return pre.done!;
  const r = pre.request;

  // Phase 2: the approver's own signed M02 approval of exactly the prepared scope.
  const approval = await recordApproval(pool, ctx, {
    approvalKind: 'PLAN_ACTION',
    incidentId: r.incident_id,
    siteId: r.site_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    planHash: r.plan_hash,
    actionDigest: r.action_digest,
    actionClass: r.action_class as ActionClass,
    paid: r.paid,
    providerAccountRevisionId: r.provider_account_revision_id,
    targetExecutionAuthorityId: null,
    maxAmount: { amountMinor: BigInt(r.max_amount_minor), currency: r.currency } as Money,
    expiresAt: isoNN(r.expires_at),
  });

  // Phase 3: bind under the planning lock and move the plan, or invalidate the approval if the scope went stale.
  const outcome = await tenantCommand(pool, ctx, meta, async (c) => {
    await lockKey(c, planningLock(ctx.tenantId, r.incident_id));
    const cur = await loadRequest(c, ctx, r.id, meta);
    const actor = actorFields(ctx);
    const stale =
      cur.invalidated_at !== null || !cur.live || !['APPROVABLE', 'APPROVED', 'EXECUTING'].includes(cur.plan_state);
    if (stale) {
      await c.query(
        `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ape_' || gen_random_uuid(), $2, 'INVALIDATED', 'PLAN_APPROVAL_SCOPE_STALE', $3, $4)
         ON CONFLICT (tenant_id, approval_id) DO NOTHING`,
        [ctx.tenantId, approval.approvalId, actor.kind, actor.id],
      );
      return { stale: true as const };
    }
    const ins = await c.query(
      `INSERT INTO plan_approval_bindings (tenant_id, id, approval_request_id, approval_id, plan_id, plan_action_id,
         idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, approval_request_id, idempotency_key) DO NOTHING RETURNING *`,
      [
        ctx.tenantId,
        newCommerceId('planApprovalBinding'),
        cur.id,
        approval.approvalId,
        cur.plan_id,
        cur.plan_action_id,
        input.idempotencyKey,
      ],
    );
    if (!ins.rows[0]) {
      // A concurrent identical command won; ours never becomes executable.
      await c.query(
        `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ape_' || gen_random_uuid(), $2, 'INVALIDATED', 'DUPLICATE_APPROVAL_COMMAND', $3, $4)
         ON CONFLICT (tenant_id, approval_id) DO NOTHING`,
        [ctx.tenantId, approval.approvalId, actor.kind, actor.id],
      );
      return { binding: await existingBinding(c, ctx, cur.id, input.idempotencyKey), created: false };
    }
    if (cur.plan_state === 'APPROVABLE') {
      transition('RECOVERY_PLAN', 'APPROVABLE', 'APPROVED');
      await c.query(
        `UPDATE recovery_plans SET state = 'APPROVED', version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3`,
        [ctx.tenantId, cur.plan_id, cur.plan_version],
      );
      await c.query(
        `INSERT INTO recovery_plan_transitions (tenant_id, id, plan_id, sequence, from_state, to_state, reason_code,
           actor_kind, actor_id)
         SELECT $1, 'plt_' || gen_random_uuid(), $2, coalesce(max(sequence), 0) + 1, 'APPROVABLE', 'APPROVED',
                'SIGNED_APPROVAL_RECORDED', $3, $4
           FROM recovery_plan_transitions WHERE tenant_id = $1 AND plan_id = $2`,
        [ctx.tenantId, cur.plan_id, actor.kind, actor.id],
      );
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { approvalId: approval.approvalId } });
    return { binding: { ...ins.rows[0] }, created: true };
  });
  if ('stale' in outcome) throw hold('PLAN_APPROVAL_SCOPE_STALE');
  return viewOf(outcome.binding, r, outcome.created);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const HoldSchema = z.strictObject({
  approvalRequestId: z.string().regex(/^apq_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
});
const HOLD_ROLES = new Set(['maintenance_approver', 'finance_approver', 'engineer']);

/**
 * Record an approver's explicit HOLD of a pending plan-action approval request (M12 operator surface, additive). A
 * hold authorizes nothing and changes no lifecycle: the request stays PENDING, the plan stays APPROVABLE, and the
 * decision is appended to the evidence ledger as the approver's own attested material input (FR-18) with an audit
 * entry. Only a human holding an approver role at the request's site, who may also submit evidence there, can hold.
 */
export async function recordApprovalHold(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof HoldSchema>,
): Promise<{ approvalRequestId: string; held: true; ledgerEntryId: string; reasonCode: string }> {
  const parsed = HoldSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_APPROVAL_HOLD');
  const input = parsed.data;
  const meta = { action: 'approval.hold', resourceType: 'plan_approval_request', resourceId: input.approvalRequestId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRequest(c, ctx, input.approvalRequestId, meta);
    requireAuthorized(ctx, { action: 'planning.read', siteId: r.site_id }, undefined, {
      type: 'plan_approval_request',
      id: input.approvalRequestId,
    });
    if (
      ctx.principal.kind !== 'HUMAN' ||
      !ctx.grants.some((g) => HOLD_ROLES.has(g.role) && (g.siteId === null || g.siteId === r.site_id))
    )
      throw new Denial(notPermitted('APPROVER_ROLE_REQUIRED'), {
        ...meta,
        reasonCode: 'APPROVER_ROLE_REQUIRED',
      });
    if (r.invalidated_at) throw hold('APPROVAL_REQUEST_INVALIDATED');
    const entry = await appendOperatorEvidence(
      c,
      ctx,
      {
        kind: 'MATERIAL_INPUT',
        trust: 'OPERATOR_ATTESTED',
        subject: { aggregateType: 'plan', aggregateId: r.plan_id },
        incidentId: r.incident_id,
        payloadSchema: 'approval.hold.v1',
        payloadDigest: sha256Digest(
          JSON.stringify({ approvalRequestId: r.id, requestDigest: r.request_digest, reasonCode: input.reasonCode }),
        ),
        payloadRef: null,
        supersedesEvidenceId: null,
      },
      { siteId: r.site_id },
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { reasonCode: input.reasonCode } });
    return {
      approvalRequestId: r.id,
      held: true as const,
      ledgerEntryId: entry.evidenceId,
      reasonCode: input.reasonCode,
    };
  });
}
