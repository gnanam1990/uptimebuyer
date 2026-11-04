// Server-side assembly of a plan's inputs (FR-09, INV-03, INV-04, INV-16). Every value is reloaded inside the
// caller's transaction from this tenant's records; the client names only candidate and quote references.
//   - Eligibility: the candidate's CURRENT M06 decision must be ALLOW and pass M06's execution gate for the
//     candidate's own action digest right now (revisions current, offer fresh, authorities valid). Anything else is
//     HELD/REJECTED with reasons and never priced.
//   - Purchase/service cost: the candidate's amount (the amount its action digest binds); the quote must corroborate
//     it exactly (amount + tax, currency), be the latest revision of an un-invalidated contact request of this
//     incident, unexpired, of a compatible scope and part, and come from the provider linked to the candidate's
//     approved vendor. Expected delay is the quote's ETA. Availability gives the provider score.
//   - Economics: the versioned tenant risk estimate; inventory value: the asset's latest FOOD_AT_RISK record.
//   - Deadline: only the incident's current_response_deadline_at projection and its latest deadline event.
//   - Advisory: optional (model) food-risk estimates are exposed NON_AUTHORITATIVE and never used.
import {
  normalizeManufacturer,
  normalizePartNumber,
  type CandidateEligibility,
  type DeadlineInput,
  type InputIssue,
  type MoneyInput,
  type PlanCandidateInput,
  type RecoveryPlanInput,
} from '@uptimebuyer/domain';
import { assertDecisionExecutableInTx, type AuthoritySigning } from '@uptimebuyer/compatibility';
import { DomainError, type CurrencyCode } from '@uptimebuyer/contracts';
import { unavailable, type CommandMeta, type TenantContext, type Tx } from '@uptimebuyer/data';
import { isoOf, type IncidentRow } from './internal.js';
import { economicsOf, repeatFailureFor, selectRiskEstimate } from './risk.js';

export interface CandidateRef {
  candidateActionId: string;
  quoteId: string | null;
}

/** Per-candidate facts persisted beside the evaluation (not part of the pure input). */
export interface CandidateMeta {
  candidateActionId: string;
  amountMinor: bigint;
  currency: CurrencyCode;
  providerAccountRevisionId: string;
  merchantId: string;
}

export interface AssembledPlan {
  input: RecoveryPlanInput;
  meta: Map<string, CandidateMeta>;
  riskEstimateId: string | null;
  inventoryRegistryRevisionId: string | null;
}

/** Quote scope kinds that can price each action kind. */
const SCOPES_FOR: Record<string, readonly string[]> = {
  PART_PURCHASE: ['PART_SUPPLY'],
  CONTAINMENT_PURCHASE: ['CONTAINMENT'],
  SERVICE_JOB: ['REPAIR_LABOR'],
  DIAGNOSTIC_SERVICE: ['DIAGNOSTIC_VISIT'],
  PAID_CONTACT: [],
};
/** Deterministic provider score from quoted availability (higher is better). */
const SCORE_FOR: Record<string, number | null> = { AVAILABLE: 1_000_000, LIMITED: 500_000, UNKNOWN: null };

async function gate(
  c: Tx,
  ctx: TenantContext,
  decisionId: string,
  actionDigest: string,
  signing: AuthoritySigning,
): Promise<CandidateEligibility> {
  await c.query('SAVEPOINT planning_gate');
  try {
    await assertDecisionExecutableInTx(c, ctx, { compatibilityDecisionId: decisionId, actionDigest }, signing);
    await c.query('RELEASE SAVEPOINT planning_gate');
    return { status: 'ALLOW_EXECUTABLE' };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT planning_gate');
    if (e instanceof DomainError && (e.code === 'POLICY_HOLD' || e.code === 'DIGEST_MISMATCH'))
      return {
        status: 'NOT_EXECUTABLE',
        reasonCodes: [String((e.details as { reasonCode?: string } | undefined)?.reasonCode ?? e.code)],
      };
    throw e;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function assemblePlanInput(
  c: Tx,
  ctx: TenantContext,
  incident: IncidentRow,
  refs: readonly CandidateRef[],
  signing: AuthoritySigning,
  evaluatedAt: string,
  meta: CommandMeta,
): Promise<AssembledPlan> {
  const tenantId = ctx.tenantId;
  const evr = await c.query<{ id: string; asset_revision_id: string }>(
    `SELECT id, asset_revision_id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2
      ORDER BY revision DESC LIMIT 1`,
    [tenantId, incident.id],
  );
  const asset = await c.query<{ current_revision_id: string }>(
    `SELECT current_revision_id FROM assets WHERE tenant_id = $1 AND id = $2`,
    [tenantId, incident.asset_id],
  );
  const policy = await c.query<{ id: string }>(
    `SELECT r.id FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE r.tenant_id = $1 AND p.policy_key = 'AUTHORITY' AND r.effective_at <= clock_timestamp()
      ORDER BY r.effective_at DESC LIMIT 1`,
    [tenantId],
  );
  const evidenceRevisionId = evr.rows[0]?.id;
  const assetRevisionId = asset.rows[0]?.current_revision_id;
  const policyRevisionId = policy.rows[0]?.id;
  if (!evidenceRevisionId)
    throw new DomainError('POLICY_HOLD', 'Planning holds this request.', { reasonCode: 'NO_EVIDENCE_REVISION' });
  if (!policyRevisionId)
    throw new DomainError('POLICY_HOLD', 'Planning holds this request.', { reasonCode: 'NO_EFFECTIVE_POLICY' });
  if (evr.rows[0]!.asset_revision_id !== assetRevisionId)
    throw new DomainError('POLICY_HOLD', 'Planning holds this request.', {
      reasonCode: 'EVIDENCE_REVISION_NOT_CURRENT',
    });

  const deadline: DeadlineInput = {
    currentResponseDeadlineAt: isoOf(incident.current_response_deadline_at)!,
    status: incident.deadline_status,
    eventSequence: incident.deadline_event_sequence ?? 1,
    procedureRevisionId: incident.procedure_revision_id,
    provenance: {
      source: 'INCIDENT_DEADLINE_PROJECTION',
      ref: incident.id,
      revision: incident.deadline_event_sequence ?? 1,
      asOf: isoOf(incident.deadline_event_at ?? incident.current_response_deadline_at)!,
    },
  };

  const risk = await selectRiskEstimate(c, tenantId, incident.site_id);
  const economics = risk ? economicsOf(risk) : null;
  const inv = await c.query<{ id: string; revision: number; body: any; recorded_at: Date }>(
    `SELECT id, revision, body, recorded_at FROM registry_revisions
      WHERE tenant_id = $1 AND entity_kind = 'FOOD_AT_RISK' AND entity_id = $2 ORDER BY revision DESC LIMIT 1`,
    [tenantId, incident.asset_id],
  );
  const invRow = inv.rows[0];
  const inventoryValue: MoneyInput | null = invRow
    ? {
        amountMinor: BigInt(invRow.body.value.amountMinor),
        currency: invRow.body.value.currency,
        provenance: {
          source: 'REGISTRY_FOOD_AT_RISK',
          ref: invRow.id,
          revision: invRow.revision,
          asOf: isoOf(invRow.recorded_at)!,
        },
      }
    : null;

  const metaOut = new Map<string, CandidateMeta>();
  const candidates: PlanCandidateInput[] = [];
  for (const ref of refs) {
    const cand = (
      await c.query(`SELECT * FROM candidate_actions WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        ref.candidateActionId,
      ])
    ).rows[0];
    if (!cand || cand.incident_id !== incident.id) throw unavailable(meta, ref.candidateActionId, 'candidate_action');
    const currency = cand.currency as CurrencyCode;
    const amountMinor = BigInt(cand.amount_minor);
    metaOut.set(cand.id, {
      candidateActionId: cand.id,
      amountMinor,
      currency,
      providerAccountRevisionId: cand.provider_account_revision_id,
      merchantId: cand.merchant_id,
    });
    const decision = (
      await c.query(
        `SELECT id, decision, reason_codes FROM compatibility_decisions
          WHERE tenant_id = $1 AND candidate_action_id = $2 AND lifecycle = 'CURRENT' ORDER BY decided_at DESC, id LIMIT 1`,
        [tenantId, cand.id],
      )
    ).rows[0];
    let eligibility: CandidateEligibility;
    if (!decision) eligibility = { status: 'NO_DECISION', reasonCodes: ['NO_CURRENT_DECISION'] };
    else if (decision.decision === 'REJECT')
      eligibility = { status: 'POLICY_REJECT', reasonCodes: decision.reason_codes };
    else if (decision.decision === 'HOLD') eligibility = { status: 'POLICY_HOLD', reasonCodes: decision.reason_codes };
    else eligibility = await gate(c, ctx, decision.id, cand.action_digest, signing);
    // An unbound stored decision id for a superseded decision is reported for traceability.
    const decisionId: string | null = decision?.id ?? null;

    const issues: InputIssue[] = [];
    let expectedDelay: PlanCandidateInput['expectedDelay'] = null;
    let providerScore: number | null = null;
    let quoteId: string | null = null;
    if (ref.quoteId === null) {
      issues.push({ field: 'purchaseOrService', reason: 'MISSING', detail: 'QUOTE_MISSING' });
    } else {
      const q = (
        await c.query(
          `SELECT q.*, r.invalidated_at AS request_invalidated_at, sp.approved_vendor_status, sp.approved_vendor_ref,
                  (SELECT max(x.revision) FROM provider_quotes x WHERE x.tenant_id = q.tenant_id
                     AND x.contact_request_id = q.contact_request_id) AS latest_revision,
                  clock_timestamp() AS now
             FROM provider_quotes q
             JOIN provider_contact_requests r ON r.tenant_id = q.tenant_id AND r.id = q.contact_request_id
             JOIN service_providers sp ON sp.tenant_id = q.tenant_id AND sp.id = q.service_provider_id
            WHERE q.tenant_id = $1 AND q.id = $2`,
          [tenantId, ref.quoteId],
        )
      ).rows[0];
      if (!q || q.incident_id !== incident.id) throw unavailable(meta, ref.quoteId, 'provider_quote');
      quoteId = q.id;
      const mismatch = (detail: string, field = 'purchaseOrService') =>
        issues.push({ field, reason: 'MISMATCH', detail });
      if (q.revision !== q.latest_revision)
        issues.push({ field: 'purchaseOrService', reason: 'STALE', detail: 'QUOTE_SUPERSEDED' });
      if (q.request_invalidated_at !== null)
        issues.push({ field: 'purchaseOrService', reason: 'STALE', detail: 'QUOTE_REQUEST_INVALIDATED' });
      if (q.valid_until === null)
        issues.push({ field: 'purchaseOrService', reason: 'MISSING', detail: 'QUOTE_VALIDITY_MISSING' });
      else if (new Date(q.valid_until).getTime() <= new Date(q.now).getTime())
        issues.push({ field: 'purchaseOrService', reason: 'STALE', detail: 'QUOTE_EXPIRED' });
      if (q.amount_minor === null || q.tax_minor === null)
        issues.push({ field: 'purchaseOrService', reason: 'MISSING', detail: 'QUOTE_AMOUNT_MISSING' });
      else if (q.currency !== currency || BigInt(q.amount_minor) + BigInt(q.tax_minor) !== amountMinor)
        mismatch('QUOTE_AMOUNT_MISMATCH');
      if (!(SCOPES_FOR[cand.kind] ?? []).includes(q.scope_kind)) mismatch('QUOTE_SCOPE_MISMATCH');
      if (
        (q.part_number !== null &&
          (cand.part_number === null ||
            normalizePartNumber(q.part_number) !== normalizePartNumber(cand.part_number))) ||
        (q.manufacturer !== null &&
          (cand.manufacturer === null ||
            normalizeManufacturer(q.manufacturer) !== normalizeManufacturer(cand.manufacturer)))
      )
        mismatch('QUOTE_PART_MISMATCH');
      if (
        cand.vendor_id === null ||
        q.approved_vendor_status !== 'APPROVED' ||
        q.approved_vendor_ref !== cand.vendor_id
      )
        mismatch('QUOTE_PROVIDER_NOT_CANDIDATE_VENDOR');
      if (q.eta_minutes !== null)
        expectedDelay = {
          ms: q.eta_minutes * 60_000,
          provenance: { source: 'PROVIDER_QUOTE', ref: q.id, revision: q.revision, asOf: isoOf(q.recorded_at)! },
        };
      if (q.availability_status === 'UNAVAILABLE' && eligibility.status === 'ALLOW_EXECUTABLE')
        eligibility = { status: 'NOT_EXECUTABLE', reasonCodes: ['PROVIDER_UNAVAILABLE'] };
      providerScore = SCORE_FOR[q.availability_status] ?? null;
    }
    candidates.push({
      candidateId: cand.id,
      actionDigest: cand.action_digest,
      actionKind: cand.kind,
      compatibilityDecisionId: decisionId,
      quoteId,
      eligibility,
      providerScore,
      purchaseOrService: {
        amountMinor,
        currency,
        provenance: { source: 'CANDIDATE_ACTION', ref: cand.id, revision: null, asOf: isoOf(cand.created_at)! },
      },
      expectedDelay,
      repeatFailureProbability: risk ? repeatFailureFor(risk, cand.kind) : null,
      issues,
    });
  }
  return {
    input: {
      binding: {
        tenantId,
        incidentId: incident.id,
        assetRevisionId: assetRevisionId!,
        evidenceRevisionId,
        policyRevisionId,
      },
      evaluatedAt,
      deadline,
      economics,
      inventoryValue,
      candidates,
    },
    meta: metaOut,
    riskEstimateId: risk?.id ?? null,
    inventoryRegistryRevisionId: invRow?.id ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
