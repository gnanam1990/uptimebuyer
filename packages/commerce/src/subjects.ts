// Subject facts (INV-03, INV-07). An execution authority and its intent bind ONE subject: an M06 candidate action
// approved through an M08 plan action, or an M07 paid provider-contact request. The broker and the issuer reload the
// subject from PostgreSQL and recompute its canonical action digest from the stored facts; a caller can never name a
// digest, merchant, amount or purpose of its own (digest substitution), and a changed input yields a new digest.
import { computeActionDigest } from '@uptimebuyer/domain';
import type { Queryable } from '@uptimebuyer/data';

export interface SubjectRef {
  type: 'PLAN_ACTION' | 'PROVIDER_CONTACT_REQUEST';
  id: string;
}

export interface SubjectFacts {
  subject: SubjectRef;
  incidentId: string;
  siteId: string;
  assetId: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string | null;
  actionKind: string;
  providerAccountId: string;
  providerAccountRevisionId: string;
  merchantId: string;
  purpose: string;
  amount: { amountMinor: bigint; currency: string };
  storedActionDigest: string;
  recomputedActionDigest: string | null;
  /** Plan hash the approval must carry (plan hash of the bound plan, or the contact request's single-action plan). */
  planHash: string | null;
  planId: string | null;
  planActionId: string | null;
  planState: string | null;
  compatibilityDecisionId: string | null;
  /** The subject itself was invalidated (contact request supersession). */
  invalidated: boolean;
}

function recompute(input: Parameters<typeof computeActionDigest>[0]): string | null {
  try {
    return computeActionDigest(input);
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadSubjectFacts(
  q: Queryable,
  tenantId: string,
  subject: SubjectRef,
  approvalId: string,
): Promise<SubjectFacts | null> {
  if (subject.type === 'PLAN_ACTION') {
    const { rows } = await q.query(
      `SELECT c.*, r.provider_account_id,
              b.plan_id, b.plan_action_id, p.plan_hash, p.state AS plan_state, pa.compatibility_decision_id,
              pa.candidate_action_id AS bound_candidate
         FROM candidate_actions c
         JOIN provider_account_revisions r ON r.tenant_id = c.tenant_id AND r.id = c.provider_account_revision_id
         LEFT JOIN plan_approval_bindings b ON b.tenant_id = c.tenant_id AND b.approval_id = $3
         LEFT JOIN plan_actions pa ON pa.tenant_id = b.tenant_id AND pa.plan_id = b.plan_id AND pa.id = b.plan_action_id
         LEFT JOIN recovery_plans p ON p.tenant_id = b.tenant_id AND p.id = b.plan_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, subject.id, approvalId],
    );
    const c: any = rows[0];
    if (!c) return null;
    const bound = c.bound_candidate === c.id;
    return {
      subject,
      incidentId: c.incident_id,
      siteId: c.site_id,
      assetId: c.asset_id,
      assetRevisionId: c.asset_revision_id,
      evidenceRevisionId: c.evidence_revision_id,
      policyRevisionId: c.policy_revision_id,
      actionKind: c.kind,
      providerAccountId: c.provider_account_id,
      providerAccountRevisionId: c.provider_account_revision_id,
      merchantId: c.merchant_id,
      purpose: c.purpose,
      amount: { amountMinor: BigInt(c.amount_minor), currency: c.currency },
      storedActionDigest: c.action_digest,
      recomputedActionDigest: recompute({
        tenantId: tenantId as never,
        incidentId: c.incident_id,
        assetRevisionId: c.asset_revision_id,
        evidenceRevisionId: c.evidence_revision_id,
        policyRevisionId: c.policy_revision_id,
        action: {
          kind: c.kind,
          subjectId: c.asset_id,
          quantity: c.quantity,
          partNumber: c.part_number,
          manufacturer: c.manufacturer,
        },
        providerAccountRevisionId: c.provider_account_revision_id,
        merchantId: c.merchant_id,
        amount: { amountMinor: BigInt(c.amount_minor), currency: c.currency },
        purpose: c.purpose,
      } as never),
      planHash: bound ? c.plan_hash : null,
      planId: bound ? c.plan_id : null,
      planActionId: bound ? c.plan_action_id : null,
      planState: bound ? c.plan_state : null,
      compatibilityDecisionId: bound ? c.compatibility_decision_id : null,
      invalidated: false,
    };
  }
  const { rows } = await q.query(`SELECT * FROM provider_contact_requests WHERE tenant_id = $1 AND id = $2 AND paid`, [
    tenantId,
    subject.id,
  ]);
  const r: any = rows[0];
  if (!r || r.merchant_id === null || r.action_digest === null) return null;
  return {
    subject,
    incidentId: r.incident_id,
    siteId: r.site_id,
    assetId: r.asset_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    actionKind: 'PAID_CONTACT',
    providerAccountId: r.provider_account_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    merchantId: r.merchant_id,
    purpose: r.purpose_code,
    amount: { amountMinor: BigInt(r.max_cost_minor), currency: r.currency },
    storedActionDigest: r.action_digest,
    recomputedActionDigest: recompute({
      tenantId: tenantId as never,
      incidentId: r.incident_id,
      assetRevisionId: r.asset_revision_id,
      evidenceRevisionId: r.evidence_revision_id,
      policyRevisionId: r.policy_revision_id,
      action: {
        kind: 'PAID_CONTACT',
        subjectId: r.service_provider_id,
        quantity: 1,
        partNumber: null,
        manufacturer: null,
      },
      providerAccountRevisionId: r.provider_account_revision_id,
      merchantId: r.merchant_id,
      amount: { amountMinor: BigInt(r.max_cost_minor), currency: r.currency },
      purpose: r.purpose_code,
    } as never),
    planHash: r.plan_hash,
    planId: null,
    planActionId: null,
    planState: null,
    compatibilityDecisionId: null,
    invalidated: r.invalidated_at !== null,
  };
}

/** Why the bound asset/evidence/policy revisions are no longer current, or null when they all still are. */
export async function staleRevisionReason(q: Queryable, tenantId: string, f: SubjectFacts): Promise<string | null> {
  const { rows } = await q.query(
    `SELECT (SELECT current_revision_id FROM assets WHERE tenant_id = $1 AND id = $2) AS asset_revision_id,
            (SELECT id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $3 ORDER BY revision DESC LIMIT 1)
              AS evidence_revision_id,
            (SELECT r.id FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
              WHERE r.tenant_id = $1 AND p.policy_key = 'AUTHORITY' AND r.effective_at <= clock_timestamp()
              ORDER BY r.effective_at DESC LIMIT 1) AS policy_revision_id`,
    [tenantId, f.assetId, f.incidentId],
  );
  const cur: any = rows[0];
  if (cur.asset_revision_id !== f.assetRevisionId) return 'ASSET_REVISION_SUPERSEDED';
  if (cur.evidence_revision_id !== f.evidenceRevisionId) return 'EVIDENCE_REVISION_NOT_CURRENT';
  if (f.policyRevisionId !== null && cur.policy_revision_id !== f.policyRevisionId)
    return 'POLICY_REVISION_NOT_EFFECTIVE';
  return null;
}

/** The pinned paid revision is still the account's current, active, broker-owned paid revision. */
export async function providerRevisionCurrent(q: Queryable, tenantId: string, revisionId: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM provider_account_revisions r JOIN provider_accounts p ON p.tenant_id = r.tenant_id
         AND p.id = r.provider_account_id
      WHERE r.tenant_id = $1 AND r.id = $2 AND r.superseded_at IS NULL AND p.current_revision_id = r.id
        AND p.status = 'ACTIVE' AND r.paid AND r.owner_service = 'KITE_BROKER_PAID'`,
    [tenantId, revisionId],
  );
  return rows.length === 1;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
