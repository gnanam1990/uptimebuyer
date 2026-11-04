// Recovery plans (FR-09, INV-03, INV-04, INV-10): the planning engine evaluates the named candidates of an open
// incident and persists one immutable plan revision per distinct plan hash. Same inputs in any order reproduce the
// same hash and return the existing live (not INVALIDATED) revision; a new revision supersedes (invalidates) the
// incident's open plans, and an invalidated revision never blocks re-planning the same inputs.
// The plan is advisory: it never approves, reserves, spends or executes (approved: false).
import { canonicalize, evaluateRecoveryPlan, type CostResult, type RecoveryPlanEvaluation } from '@uptimebuyer/domain';
import { decodeWire, newId, type Money, type UtcInstant } from '@uptimebuyer/contracts';
import type { AuthoritySigning } from '@uptimebuyer/compatibility';
import {
  appendOutboxEvent,
  appendSystemEvidence,
  dbNow,
  lockKey,
  recordAudit,
  requireAuthorized,
  sha256Digest,
  tenantCommand,
  unavailable,
  type CommandMeta,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { assemblePlanInput, type AssembledPlan, type CandidateRef } from './assemble.js';
import { PlanCreatedPayloadSchema } from './events.js';
import { actorFields, hold, invalid, isoOf, loadIncident, newPlanningId, planningLock, refOk } from './internal.js';
import { invalidatePlans, transitionPlan } from './lifecycle.js';

const CreateSchema = z.strictObject({
  incidentId: z.string().refine((v) => refOk('inc', v)),
  candidates: z
    .array(
      z.strictObject({
        candidateActionId: z.string().refine((v) => refOk('cand', v)),
        quoteId: z
          .string()
          .refine((v) => refOk('pqt', v))
          .nullable(),
      }),
    )
    .min(1)
    .max(50)
    .refine((xs) => new Set(xs.map((x) => x.candidateActionId)).size === xs.length, 'Duplicate candidate.'),
});
export type CreatePlanInput = z.input<typeof CreateSchema>;

/** JSON form of a cost result as stored and returned (bigints as decimal strings in the stored computation). */
const big = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export interface PlanActionView {
  planActionId: string;
  candidateActionId: string;
  compatibilityDecisionId: string | null;
  quoteId: string | null;
  actionDigest: string;
  actionKind: string;
  disposition: 'RANKED' | 'ELIGIBLE_UNRANKED' | 'INCOMPLETE' | 'HELD' | 'REJECTED';
  ordinal: number | null;
  reasonCodes: string[];
  providerScore: number | null;
  amount: Money | null;
  providerAccountRevisionId: string | null;
  merchantId: string | null;
  currency: string | null;
  expectedCostMinor: bigint | null;
  expectedCostRange: { lowMinor: bigint; highMinor: bigint } | null;
  deadlinePenaltyMinor: bigint | null;
  expectedDelayMs: number | null;
  deadlineFit: string | null;
  recoveryEtaAt: UtcInstant | null;
  components: {
    key: string;
    formula: string;
    unit: string;
    exact: { num: string; den: string };
    displayMinor: string;
  }[];
  inputs: {
    field: string;
    value: string | null;
    unit: string;
    currency: string | null;
    status: string;
    provenance: { source: string; ref: string; revision: number | null; asOf: string } | null;
    uncertainty: { low: string; high: string } | null;
  }[];
  issues: { field: string; reason: string; detail?: string }[];
}

export interface OptionalRiskEstimateView {
  riskEstimateId: string;
  estimatorKind: string;
  sourceRevision: string;
  asOf: UtcInstant;
  safeTimeRemainingMs: number;
  lowerBoundMs: number;
  upperBoundMs: number;
  confidencePpm: number;
  authority: 'NON_AUTHORITATIVE';
  usedInCost: false;
  canMoveDeadline: false;
}

export interface RecoveryPlanView {
  planId: string;
  tenantId: string;
  incidentId: string;
  siteId: string;
  assetId: string;
  revision: number;
  planHash: string;
  state: string;
  version: number;
  outcome: RecoveryPlanEvaluation['outcome'];
  incomplete: boolean;
  holdReasons: string[];
  binding: {
    assetRevisionId: string;
    evidenceRevisionId: string;
    policyRevisionId: string;
    riskEstimateId: string | null;
    inventoryRegistryRevisionId: string | null;
  };
  deadline: {
    currentResponseDeadlineAt: UtcInstant | null;
    status: string | null;
    eventSequence: number | null;
    procedureRevisionId: string;
    source: 'INCIDENT_PROJECTION';
  };
  evaluatedAt: UtcInstant;
  ruleVersion: string;
  tieBreakRule: string[];
  actions: PlanActionView[];
  advisory: { optionalRiskEstimates: OptionalRiskEstimateView[] };
  inFlightReconciliation: boolean;
  invalidatedAt: UtcInstant | null;
  invalidatedReason: string | null;
  transitions: { sequence: number; from: string | null; to: string; reasonCode: string; at: UtcInstant }[];
  label: 'ADVISORY RANKING';
  approved: false;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function actionView(r: any): PlanActionView {
  return {
    planActionId: r.id,
    candidateActionId: r.candidate_action_id,
    compatibilityDecisionId: r.compatibility_decision_id,
    quoteId: r.quote_id,
    actionDigest: r.action_digest,
    actionKind: r.action_kind,
    disposition: r.disposition,
    ordinal: r.ordinal,
    reasonCodes: r.reason_codes,
    providerScore: r.provider_score,
    amount: r.amount_minor === null ? null : ({ amountMinor: BigInt(r.amount_minor), currency: r.currency } as Money),
    providerAccountRevisionId: r.provider_account_revision_id,
    merchantId: r.merchant_id,
    currency: r.currency,
    expectedCostMinor: r.expected_cost_minor === null ? null : BigInt(r.expected_cost_minor),
    expectedCostRange:
      r.expected_cost_low_minor === null
        ? null
        : { lowMinor: BigInt(r.expected_cost_low_minor), highMinor: BigInt(r.expected_cost_high_minor) },
    deadlinePenaltyMinor: r.deadline_penalty_minor === null ? null : BigInt(r.deadline_penalty_minor),
    expectedDelayMs: r.expected_delay_ms === null ? null : Number(r.expected_delay_ms),
    deadlineFit: r.deadline_fit,
    recoveryEtaAt: isoOf(r.recovery_eta_at),
    components: r.components,
    inputs: r.inputs,
    issues: r.issues,
  };
}

async function loadView(c: Tx, tenantId: string, plan: any): Promise<RecoveryPlanView> {
  const actions = await c.query(
    `SELECT * FROM plan_actions WHERE tenant_id = $1 AND plan_id = $2
      ORDER BY ordinal NULLS LAST, candidate_action_id COLLATE "C"`,
    [tenantId, plan.id],
  );
  const transitions = await c.query(
    `SELECT sequence, from_state, to_state, reason_code, created_at FROM recovery_plan_transitions
      WHERE tenant_id = $1 AND plan_id = $2 ORDER BY sequence`,
    [tenantId, plan.id],
  );
  const advisory = await c.query(
    `SELECT id, estimator_kind, source_revision, as_of, safe_time_remaining_ms, lower_bound_ms, upper_bound_ms, confidence_ppm
       FROM incident_risk_estimates WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recorded_at, id LIMIT 100`,
    [tenantId, plan.incident_id],
  );
  return {
    planId: plan.id,
    tenantId: plan.tenant_id,
    incidentId: plan.incident_id,
    siteId: plan.site_id,
    assetId: plan.asset_id,
    revision: plan.revision,
    planHash: plan.plan_hash,
    state: plan.state,
    version: plan.version,
    outcome: plan.outcome,
    incomplete: plan.outcome === 'INCOMPLETE',
    holdReasons: plan.hold_reasons,
    binding: {
      assetRevisionId: plan.asset_revision_id,
      evidenceRevisionId: plan.evidence_revision_id,
      policyRevisionId: plan.policy_revision_id,
      riskEstimateId: plan.risk_estimate_id,
      inventoryRegistryRevisionId: plan.inventory_registry_revision_id,
    },
    deadline: {
      currentResponseDeadlineAt: isoOf(plan.deadline_at),
      status: plan.deadline_status,
      eventSequence: plan.deadline_event_sequence,
      procedureRevisionId: plan.procedure_revision_id,
      source: 'INCIDENT_PROJECTION',
    },
    evaluatedAt: isoOf(plan.evaluated_at)!,
    ruleVersion: plan.rule_version,
    tieBreakRule: plan.computation.tieBreakRule,
    actions: actions.rows.map(actionView),
    advisory: {
      optionalRiskEstimates: advisory.rows.map((r) => ({
        riskEstimateId: r.id,
        estimatorKind: r.estimator_kind,
        sourceRevision: r.source_revision,
        asOf: isoOf(r.as_of)!,
        safeTimeRemainingMs: Number(r.safe_time_remaining_ms),
        lowerBoundMs: Number(r.lower_bound_ms),
        upperBoundMs: Number(r.upper_bound_ms),
        confidencePpm: r.confidence_ppm,
        authority: 'NON_AUTHORITATIVE',
        usedInCost: false,
        canMoveDeadline: false,
      })),
    },
    inFlightReconciliation: plan.in_flight_reconciliation,
    invalidatedAt: isoOf(plan.invalidated_at),
    invalidatedReason: plan.invalidated_reason,
    transitions: transitions.rows.map((t) => ({
      sequence: t.sequence,
      from: t.from_state,
      to: t.to_state,
      reasonCode: t.reason_code,
      at: isoOf(t.created_at)!,
    })),
    label: 'ADVISORY RANKING',
    approved: false,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const componentsJson = (cost: CostResult | null) =>
  (cost?.components ?? []).map((k) => ({
    key: k.key,
    formula: k.formula,
    unit: k.unit,
    exact: { num: k.exact.num.toString(), den: k.exact.den.toString() },
    displayMinor: k.displayMinor.toString(),
  }));
const issuesJson = (cost: CostResult | null) =>
  (cost?.issues ?? []).map((i) => (i.detail === undefined ? { field: i.field, reason: i.reason } : { ...i }));

/** Recompute the plan for `refs` now (used by creation and by approval preparation's staleness check). */
export async function computePlan(
  c: Tx,
  ctx: TenantContext,
  incidentId: string,
  refs: readonly CandidateRef[],
  signing: AuthoritySigning,
  meta: CommandMeta,
): Promise<{ assembled: AssembledPlan; evaluation: RecoveryPlanEvaluation; evaluatedAt: UtcInstant }> {
  const incident = await loadIncident(c, ctx.tenantId, incidentId, meta, { lock: true });
  if (incident.state === 'RECOVERED') throw hold('INCIDENT_NOT_OPEN');
  const evaluatedAt = await dbNow(c);
  const assembled = await assemblePlanInput(c, ctx, incident, refs, signing, evaluatedAt, meta);
  return { assembled, evaluation: evaluateRecoveryPlan(assembled.input), evaluatedAt };
}

export async function createRecoveryPlan(
  pool: Db,
  ctx: TenantContext,
  raw: CreatePlanInput,
  signing: AuthoritySigning,
): Promise<RecoveryPlanView & { created: boolean }> {
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid('INVALID_PLAN_REQUEST', {
      fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), issue: i.code })),
    });
  const input = parsed.data;
  const meta = { action: 'planning.build', resourceType: 'incident', resourceId: input.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const incident = await loadIncident(c, ctx.tenantId, input.incidentId, meta);
    requireAuthorized(ctx, { action: 'planning.engine', siteId: null }, undefined, {
      type: 'incident',
      id: incident.id,
    });
    await lockKey(c, planningLock(ctx.tenantId, incident.id));
    const executing = await c.query(
      `SELECT 1 FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 AND state IN ('APPROVED', 'EXECUTING')`,
      [ctx.tenantId, incident.id],
    );
    if (executing.rowCount) throw hold('PLAN_APPROVED_OR_EXECUTING');
    const { assembled, evaluation, evaluatedAt } = await computePlan(
      c,
      ctx,
      incident.id,
      input.candidates,
      signing,
      meta,
    );
    const existing = await c.query(
      `SELECT * FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 AND plan_hash = $3
          AND state <> 'INVALIDATED'`,
      [ctx.tenantId, incident.id, evaluation.planHash],
    );
    if (existing.rows[0]) return { ...(await loadView(c, ctx.tenantId, existing.rows[0])), created: false };

    const b = assembled.input.binding;
    const next = await c.query<{ n: number }>(
      `SELECT coalesce(max(revision), 0) + 1 AS n FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2`,
      [ctx.tenantId, incident.id],
    );
    const revision = next.rows[0]!.n;
    const planId = newPlanningId('plan');
    const actor = actorFields(ctx);
    const computation = JSON.parse(
      canonicalize({
        ruleVersion: evaluation.ruleVersion,
        tieBreakRule: [...evaluation.tieBreakRule],
        outcome: evaluation.outcome,
        holdReasons: evaluation.holdReasons,
        ranking: evaluation.ranking,
        evaluatedAt,
      }),
    );
    const dl = assembled.input.deadline;
    await c.query(
      `INSERT INTO recovery_plans (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, evidence_revision_id,
         policy_revision_id, risk_estimate_id, inventory_registry_revision_id, revision, plan_hash, rule_version, state,
         outcome, hold_reasons, deadline_at, deadline_status, deadline_event_sequence, procedure_revision_id, evaluated_at,
         computation, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'DRAFT', $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        ctx.tenantId,
        planId,
        incident.id,
        incident.site_id,
        incident.asset_id,
        b.assetRevisionId,
        b.evidenceRevisionId,
        b.policyRevisionId,
        assembled.riskEstimateId,
        assembled.inventoryRegistryRevisionId,
        revision,
        evaluation.planHash,
        evaluation.ruleVersion,
        evaluation.outcome,
        evaluation.holdReasons,
        dl?.currentResponseDeadlineAt ?? null,
        dl?.status ?? null,
        dl?.eventSequence ?? null,
        incident.procedure_revision_id,
        evaluatedAt,
        JSON.stringify(computation),
        actor.kind,
        actor.id,
      ],
    );
    await c.query(
      `INSERT INTO recovery_plan_transitions (tenant_id, id, plan_id, sequence, from_state, to_state, reason_code, actor_kind, actor_id)
       VALUES ($1, $2, $3, 1, NULL, 'DRAFT', 'PLAN_REQUESTED', $4, $5)`,
      [ctx.tenantId, newPlanningId('planTransition'), planId, actor.kind, actor.id],
    );
    for (const e of evaluation.candidates) {
      const m = assembled.meta.get(e.candidateId)!;
      const cost = e.cost;
      const priced = cost !== null && cost.complete;
      await c.query(
        `INSERT INTO plan_actions (tenant_id, id, plan_id, incident_id, candidate_action_id, compatibility_decision_id, quote_id,
           action_digest, action_kind, disposition, ordinal, reason_codes, provider_score, amount_minor, currency,
           provider_account_revision_id, merchant_id, expected_cost_minor, expected_cost_low_minor, expected_cost_high_minor,
           deadline_penalty_minor, expected_delay_ms, deadline_fit, recovery_eta_at, inputs, components, issues)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
           $24, $25, $26, $27)`,
        [
          ctx.tenantId,
          newPlanningId('planAction'),
          planId,
          incident.id,
          e.candidateId,
          e.compatibilityDecisionId,
          e.quoteId,
          e.actionDigest,
          e.actionKind,
          e.disposition,
          e.ordinal,
          e.reasonCodes,
          Number.isSafeInteger(e.providerScore) ? e.providerScore : null,
          m.amountMinor.toString(),
          m.currency,
          m.providerAccountRevisionId,
          m.merchantId,
          priced ? big(cost.expectedCostMinor) : null,
          priced ? big(cost.range?.lowMinor) : null,
          priced ? big(cost.range?.highMinor) : null,
          priced ? big(cost.deadlinePenaltyMinor) : null,
          cost?.inputs.find((i) => i.field === 'expectedDelay')?.value ?? null,
          priced ? cost.deadlineFit : null,
          priced ? cost.recoveryEtaAt : null,
          JSON.stringify(cost?.inputs ?? []),
          JSON.stringify(componentsJson(cost)),
          JSON.stringify(issuesJson(cost)),
        ],
      );
    }
    const draft = { id: planId, state: 'DRAFT', version: 1 };
    const evaluated = { ...draft, ...(await transitionPlan(c, ctx, draft, 'EVALUATED', 'CANDIDATES_EVALUATED')) };
    const to = evaluation.outcome === 'RANKED' ? 'APPROVABLE' : 'HELD';
    const reason =
      evaluation.outcome === 'RANKED'
        ? 'ELIGIBLE_ACTION_RANKED'
        : evaluation.outcome === 'INCOMPLETE'
          ? 'ECONOMIC_INPUT_INCOMPLETE'
          : 'NO_ELIGIBLE_CANDIDATE';
    await transitionPlan(c, ctx, evaluated, to, reason);

    // The new revision supersedes the incident's other open (pre-approval) plans.
    const older = await c.query(
      `SELECT id, state, version, plan_hash FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 AND id <> $3
          AND state IN ('DRAFT', 'EVALUATED', 'APPROVABLE') ORDER BY revision FOR UPDATE`,
      [ctx.tenantId, incident.id, planId],
    );
    await invalidatePlans(
      c,
      ctx,
      incident.id,
      older.rows.map((r) => ({ ...r, stale: [] })),
      'PLAN_SUPERSEDED_BY_REVISION',
    );

    const payload = decodeWire(PlanCreatedPayloadSchema, {
      planId,
      incidentId: incident.id,
      revision,
      planHash: evaluation.planHash,
      state: to,
      outcome: evaluation.outcome,
      assetRevisionId: b.assetRevisionId,
      evidenceRevisionId: b.evidenceRevisionId,
      policyRevisionId: b.policyRevisionId,
      riskEstimateId: assembled.riskEstimateId,
      rankedActionDigests: evaluation.candidates.filter((x) => x.ordinal !== null).map((x) => x.actionDigest),
      supersededPlanIds: older.rows.map((r) => r.id).sort(),
      approved: false,
    });
    await appendSystemEvidence(c, ctx, {
      kind: 'POLICY_DECISION',
      trust: 'AUTHORITATIVE',
      subject: { aggregateType: 'plan', aggregateId: planId },
      incidentId: incident.id,
      payloadSchema: 'planning.recovery_plan.v1',
      payloadDigest: sha256Digest(canonicalize({ planHash: evaluation.planHash, computation })),
      payloadRef: null,
      supersedesEvidenceId: null,
    });
    await appendOutboxEvent(c, ctx, {
      eventType: 'plan.created.v1',
      aggregateType: 'plan',
      aggregateId: planId,
      aggregateVersion: 1,
      payload,
      correlationId: ctx.correlationId,
      causationId: newId('command'),
    });
    await recordAudit(c, ctx, {
      action: 'planning.build',
      resourceType: 'recovery_plan',
      resourceId: planId,
      result: 'SUCCEEDED',
      reasonCode: evaluation.outcome,
    });
    const row = await c.query(`SELECT * FROM recovery_plans WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, planId]);
    return { ...(await loadView(c, ctx.tenantId, row.rows[0])), created: true };
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadPlanRow(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  planId: string,
  lock = false,
): Promise<any> {
  if (!refOk('pln', planId)) throw unavailable(meta, null);
  const { rows } = await c.query(
    `SELECT * FROM recovery_plans WHERE tenant_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [ctx.tenantId, planId],
  );
  if (!rows[0]) throw unavailable(meta);
  return rows[0];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getRecoveryPlan(pool: Db, ctx: TenantContext, planId: string): Promise<RecoveryPlanView> {
  const meta = { action: 'planning.read', resourceType: 'recovery_plan', resourceId: String(planId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const plan = await loadPlanRow(c, ctx, meta, planId);
    requireAuthorized(ctx, { action: 'planning.read', siteId: plan.site_id }, undefined, {
      type: 'recovery_plan',
      id: plan.id,
    });
    return loadView(c, ctx.tenantId, plan);
  });
}

/** Plans of an incident, newest revision first (bounded). */
export async function listIncidentPlans(pool: Db, ctx: TenantContext, incidentId: string): Promise<RecoveryPlanView[]> {
  const meta = { action: 'planning.read', resourceType: 'incident', resourceId: String(incidentId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!refOk('inc', incidentId)) throw unavailable(meta, null);
    const incident = await loadIncident(c, ctx.tenantId, incidentId, meta);
    requireAuthorized(ctx, { action: 'planning.read', siteId: incident.site_id as never }, undefined, {
      type: 'incident',
      id: incident.id,
    });
    const { rows } = await c.query(
      `SELECT * FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2 ORDER BY revision DESC LIMIT 100`,
      [ctx.tenantId, incident.id],
    );
    const out: RecoveryPlanView[] = [];
    for (const r of rows) out.push(await loadView(c, ctx.tenantId, r));
    return out;
  });
}
