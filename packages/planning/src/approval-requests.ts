// Approval-request preparation (TDD §10, STATE-MACHINES §4, INV-02, INV-03, INV-05 input). Preparation only: the
// engine assembles the exact scope an approver would sign — action kind and class, exact provider-account revision,
// maximum amount and currency, incident, asset/evidence/policy revisions, action digest, plan hash and expiry — from
// the persisted plan action, never from the caller. It requires an APPROVABLE plan whose hash the caller names, a
// RANKED action, and a recomputation of the plan from current inputs that reproduces the same hash; a stale plan is
// invalidated (committed) and the request held. Approval itself and executable authority are M09's.
import { canonicalDigest } from '@uptimebuyer/domain';
import { UtcInstantSchema, type Money, type UtcInstant } from '@uptimebuyer/contracts';
import type { AuthoritySigning } from '@uptimebuyer/compatibility';
import {
  ENGINEERING_ACTION_CLASSES,
  dbNow,
  lockKey,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type ActionClass,
  type Db,
  type TenantContext,
} from '@uptimebuyer/data';
import { DomainError } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { actorFields, hold, invalid, isoOf, newPlanningId, planningLock, refOk } from './internal.js';
import { invalidatePlans } from './lifecycle.js';
import { computePlan, loadPlanRow } from './plans.js';

/** Longest an approval request (and so the approval M09 records from it) may stay open. */
export const MAX_APPROVAL_REQUEST_TTL_MS = 4 * 3_600_000;

const PrepareSchema = z.strictObject({
  planId: z.string().refine((v) => refOk('pln', v)),
  planHash: z.string().regex(/^recovery-plan\.v1:sha256:[0-9a-f]{64}$/),
  planActionId: z.string().refine((v) => refOk('pla', v)),
  /** A shorter expiry the caller wants; the server caps it (never extends it). */
  expiresAt: UtcInstantSchema.optional(),
});
export type PrepareApprovalRequestInput = z.input<typeof PrepareSchema>;

export interface ApprovalRequestView {
  approvalRequestId: string;
  planId: string;
  planActionId: string;
  planHash: string;
  state: 'PENDING' | 'INVALIDATED';
  invalidatedAt: UtcInstant | null;
  invalidatedReason: string | null;
  scope: {
    actionKind: string;
    actionClass: ActionClass;
    incidentId: string;
    siteId: string;
    assetRevisionId: string;
    evidenceRevisionId: string;
    policyRevisionId: string;
    actionDigest: string;
    compatibilityDecisionId: string;
    providerAccountRevisionId: string;
    merchantId: string;
    paid: boolean;
    maxAmount: Money;
    expiresAt: UtcInstant;
  };
  approvalRoute: Record<string, unknown>;
  requestDigest: string;
  requestedAt: UtcInstant;
  authority: 'NONE';
  executable: false;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toView(r: any): ApprovalRequestView {
  return {
    approvalRequestId: r.id,
    planId: r.plan_id,
    planActionId: r.plan_action_id,
    planHash: r.plan_hash,
    state: r.invalidated_at ? 'INVALIDATED' : 'PENDING',
    invalidatedAt: isoOf(r.invalidated_at),
    invalidatedReason: r.invalidated_reason,
    scope: {
      actionKind: r.action_kind,
      actionClass: r.action_class,
      incidentId: r.incident_id,
      siteId: r.site_id,
      assetRevisionId: r.asset_revision_id,
      evidenceRevisionId: r.evidence_revision_id,
      policyRevisionId: r.policy_revision_id,
      actionDigest: r.action_digest,
      compatibilityDecisionId: r.compatibility_decision_id,
      providerAccountRevisionId: r.provider_account_revision_id,
      merchantId: r.merchant_id,
      paid: r.paid,
      maxAmount: { amountMinor: BigInt(r.max_amount_minor), currency: r.currency } as Money,
      expiresAt: isoOf(r.expires_at)!,
    },
    approvalRoute: r.approval_route,
    requestDigest: r.request_digest,
    requestedAt: isoOf(r.created_at)!,
    authority: 'NONE',
    executable: false,
  };
}

/** The approval class an approver must hold (INV-15): engineering classes before overrides before standard. */
function actionClassOf(d: any): ActionClass {
  const ex: string[] = d.exception_classes_applied ?? [];
  if (ex.includes('SAFETY_CRITICAL') || d.safety_class === 'SAFETY_CRITICAL') return 'SAFETY_CRITICAL';
  if (ex.includes('SUBSTITUTE')) return 'SUBSTITUTE';
  if (ex.includes('NON_EXACT_MATCH') || d.exact_match === false) return 'NON_EXACT_MATCH';
  if ((d.overrides_applied ?? []).length > 0) return 'POLICY_OVERRIDE';
  return 'STANDARD';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function prepareApprovalRequest(
  pool: Db,
  ctx: TenantContext,
  raw: PrepareApprovalRequestInput,
  signing: AuthoritySigning,
): Promise<ApprovalRequestView & { created: boolean }> {
  const parsed = PrepareSchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_APPROVAL_REQUEST');
  const input = parsed.data;
  const meta = { action: 'planning.prepare_approval', resourceType: 'recovery_plan', resourceId: input.planId };
  const outcome = await tenantCommand(pool, ctx, meta, async (c) => {
    const first = await loadPlanRow(c, ctx, meta, input.planId);
    requireAuthorized(ctx, { action: 'planning.engine', siteId: null }, undefined, {
      type: 'recovery_plan',
      id: first.id,
    });
    await lockKey(c, planningLock(ctx.tenantId, first.incident_id));
    const plan = await loadPlanRow(c, ctx, meta, input.planId, true);
    if (plan.plan_hash !== input.planHash)
      throw new DomainError('DIGEST_MISMATCH', 'The named plan hash is not this plan.', {
        reasonCode: 'PLAN_HASH_MISMATCH',
      });
    const action = (
      await c.query(`SELECT * FROM plan_actions WHERE tenant_id = $1 AND plan_id = $2 AND id = $3`, [
        ctx.tenantId,
        plan.id,
        input.planActionId,
      ])
    ).rows[0];
    if (!action) throw unavailable(meta, input.planActionId, 'plan_action');
    const existing = (
      await c.query(`SELECT * FROM plan_approval_requests WHERE tenant_id = $1 AND plan_action_id = $2`, [
        ctx.tenantId,
        action.id,
      ])
    ).rows[0];
    if (plan.state !== 'APPROVABLE')
      throw hold('PLAN_NOT_APPROVABLE', { state: plan.state, outcome: plan.outcome, holdReasons: plan.hold_reasons });
    if (action.disposition !== 'RANKED') throw hold('ACTION_NOT_RANKED');

    // Recompute from current inputs: the plan must still be exactly what it was.
    const refs = (
      await c.query(`SELECT candidate_action_id, quote_id FROM plan_actions WHERE tenant_id = $1 AND plan_id = $2`, [
        ctx.tenantId,
        plan.id,
      ])
    ).rows.map((r) => ({ candidateActionId: r.candidate_action_id, quoteId: r.quote_id }));
    const again = await computePlan(c, ctx, plan.incident_id, refs, signing, meta);
    if (again.evaluation.planHash !== plan.plan_hash) {
      await invalidatePlans(
        c,
        ctx,
        plan.incident_id,
        [{ id: plan.id, state: plan.state, version: plan.version, plan_hash: plan.plan_hash, stale: ['RECOMPUTE'] }],
        'PLAN_INPUT_STALE',
      );
      return { stale: true as const };
    }
    if (existing) {
      if (existing.invalidated_at) throw hold('APPROVAL_REQUEST_INVALIDATED');
      return { stale: false as const, row: existing, created: false };
    }

    const decision = (
      await c.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        action.compatibility_decision_id,
      ])
    ).rows[0];
    const account = (
      await c.query(`SELECT paid FROM provider_account_revisions WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        action.provider_account_revision_id,
      ])
    ).rows[0];
    const quote = (
      await c.query(`SELECT valid_until FROM provider_quotes WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        action.quote_id,
      ])
    ).rows[0];
    const now = Date.parse(await dbNow(c));
    const bounds = [now + MAX_APPROVAL_REQUEST_TTL_MS, Date.parse(isoOf(quote.valid_until)!)];
    if (input.expiresAt !== undefined) bounds.push(Date.parse(input.expiresAt));
    const expiresAtMs = Math.min(...bounds);
    if (expiresAtMs <= now + 1_000) throw hold('APPROVAL_WINDOW_TOO_SHORT');
    const expiresAt = new Date(expiresAtMs).toISOString();
    const actionClass = actionClassOf(decision);
    if (
      (ENGINEERING_ACTION_CLASSES as readonly string[]).includes(actionClass) &&
      decision.applied_authority_ids.length === 0
    )
      throw hold('ENGINEER_AUTHORITY_REQUIRED');
    const scope = {
      tenantId: ctx.tenantId,
      planId: plan.id,
      planActionId: action.id,
      planHash: plan.plan_hash,
      actionKind: action.action_kind,
      actionClass,
      incidentId: plan.incident_id,
      siteId: plan.site_id,
      assetRevisionId: plan.asset_revision_id,
      evidenceRevisionId: plan.evidence_revision_id,
      policyRevisionId: plan.policy_revision_id,
      actionDigest: action.action_digest,
      compatibilityDecisionId: action.compatibility_decision_id,
      providerAccountRevisionId: action.provider_account_revision_id,
      merchantId: action.merchant_id,
      paid: account.paid === true,
      maxAmountMinor: BigInt(action.amount_minor),
      currency: action.currency,
      expiresAt,
    };
    const requestDigest = canonicalDigest('plan-approval-request', 1, scope);
    const actor = actorFields(ctx);
    const { rows } = await c.query(
      `INSERT INTO plan_approval_requests (tenant_id, id, plan_id, plan_action_id, incident_id, site_id, plan_hash,
         action_digest, action_kind, action_class, compatibility_decision_id, approval_route, provider_account_revision_id,
         merchant_id, paid, asset_revision_id, evidence_revision_id, policy_revision_id, max_amount_minor, currency,
         expires_at, request_digest, requested_by_kind, requested_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       RETURNING *`,
      [
        ctx.tenantId,
        newPlanningId('approvalRequest'),
        plan.id,
        action.id,
        plan.incident_id,
        plan.site_id,
        plan.plan_hash,
        action.action_digest,
        action.action_kind,
        actionClass,
        action.compatibility_decision_id,
        JSON.stringify(decision.approval_route ?? {}),
        action.provider_account_revision_id,
        action.merchant_id,
        scope.paid,
        plan.asset_revision_id,
        plan.evidence_revision_id,
        plan.policy_revision_id,
        action.amount_minor,
        action.currency,
        expiresAt,
        requestDigest,
        actor.kind,
        actor.id,
      ],
    );
    await recordAudit(c, ctx, { ...meta, resourceId: rows[0].id, result: 'SUCCEEDED', reasonCode: actionClass });
    return { stale: false as const, row: rows[0], created: true };
  });
  if (outcome.stale) throw hold('PLAN_STALE');
  return { ...toView(outcome.row), created: outcome.created };
}

export async function getApprovalRequest(
  pool: Db,
  ctx: TenantContext,
  approvalRequestId: string,
): Promise<ApprovalRequestView> {
  const meta = {
    action: 'planning.read',
    resourceType: 'plan_approval_request',
    resourceId: String(approvalRequestId).slice(0, 128),
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!refOk('apq', approvalRequestId)) throw unavailable(meta, null);
    const { rows } = await c.query(`SELECT * FROM plan_approval_requests WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      approvalRequestId,
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'planning.read', siteId: rows[0].site_id }, undefined, {
      type: 'plan_approval_request',
      id: approvalRequestId,
    });
    return toView(rows[0]);
  });
}
