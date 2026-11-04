// Deterministic evaluation and the decision record (FR-06, FR-10, INV-02, INV-03, INV-04, INV-10). Only the server
// engine evaluates: it reloads the candidate's bound tuple, refuses a stale tuple (a new candidate binds the new
// revisions), assembles the exact input from the bound evidence revision, registry snapshots, cited claims and the
// authority evidence (signature verified with the service keyring, roles resolved from the role registry), runs the
// pure evaluator, and persists one immutable row per exact tuple. The previous CURRENT row of the candidate lineage
// is superseded in the lifecycle column only. Execution-time checks re-verify everything a decision depends on.
import { DomainError, decodeWire, encodeWire, newId, type CurrencyCode, type UtcInstant } from '@uptimebuyer/contracts';
import {
  CompatibilityInputSchema,
  canonicalDigest,
  canonicalize,
  evaluateCompatibility,
  verifyAuthorityRecord,
  type CompatibilityInput,
  type CompatibilityResult,
  type Fact,
  type FactSource,
} from '@uptimebuyer/domain';
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
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { loadAuthorityEvidence } from './authority.js';
import { explanationOf, type CandidateRow } from './candidates.js';
import {
  assertSigning,
  currentAssetRevisionId,
  effectiveAuthorityRevisionId,
  hold,
  isoOf,
  latestEvidenceRevision,
  loadGoverning,
  PURCHASE_KINDS,
  type AuthoritySigning,
} from './internal.js';

export interface DecisionView {
  compatibilityDecisionId: string;
  tenantId: string;
  incidentId: string;
  siteId: string;
  candidateActionId: string;
  candidateKey: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string;
  actionDigest: string;
  authoritySetDigest: string;
  decision: CompatibilityResult['decision'];
  lifecycle: 'CURRENT' | 'SUPERSEDED';
  reasonCodes: string[];
  blockingReasons: string[];
  satisfiedChecks: string[];
  missingFields: string[];
  conflictingFields: string[];
  requiredAuthorities: CompatibilityResult['requiredAuthorities'];
  recoveryPaths: string[];
  appliedAuthorityIds: string[];
  exceptionClassesApplied: string[];
  overridesApplied: string[];
  authorityFindings: CompatibilityResult['authorityFindings'];
  approvalRoute: CompatibilityResult['approvalRoute'];
  safetyClass: CompatibilityResult['safetyClass'];
  exactMatch: boolean;
  inputDigest: string;
  ruleVersion: string;
  policyRuleSet: string | null;
  explanation: CompatibilityResult['explanation'];
  decidedAt: UtcInstant;
  supersededAt: UtcInstant | null;
  supersededReason: string | null;
  supersededByDecisionId: string | null;
  label: 'DETERMINISTIC DECISION';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toView(r: any): DecisionView {
  return {
    compatibilityDecisionId: r.id,
    tenantId: r.tenant_id,
    incidentId: r.incident_id,
    siteId: r.site_id,
    candidateActionId: r.candidate_action_id,
    candidateKey: r.candidate_key,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    actionDigest: r.action_digest,
    authoritySetDigest: r.authority_set_digest,
    decision: r.decision,
    lifecycle: r.lifecycle,
    reasonCodes: r.reason_codes,
    blockingReasons: r.blocking_reasons,
    satisfiedChecks: r.satisfied_checks,
    missingFields: r.missing_fields,
    conflictingFields: r.conflicting_fields,
    requiredAuthorities: r.required_authorities,
    recoveryPaths: r.recovery_paths,
    appliedAuthorityIds: r.applied_authority_ids,
    exceptionClassesApplied: r.exception_classes_applied,
    overridesApplied: r.overrides_applied,
    authorityFindings: r.authority_findings,
    approvalRoute: r.approval_route,
    safetyClass: r.safety_class,
    exactMatch: r.exact_match,
    inputDigest: r.input_digest,
    ruleVersion: r.rule_version,
    policyRuleSet: r.policy_rule_set,
    explanation: r.explanation,
    decidedAt: isoOf(r.decided_at)!,
    supersededAt: isoOf(r.superseded_at),
    supersededReason: r.superseded_reason,
    supersededByDecisionId: r.superseded_by_decision_id,
    label: 'DETERMINISTIC DECISION',
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const fieldsOf = (text: string) => {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 2).trim());
  }
  return m;
};

function factOf(values: Map<string, FactSource[]>): Fact {
  return {
    values: [...values.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, sources]) => ({ value, sources })),
  };
}
const add = (m: Map<string, Map<string, FactSource[]>>, key: string, value: string, src: FactSource) => {
  const values = m.get(key) ?? new Map<string, FactSource[]>();
  m.set(key, values);
  values.set(value, [...(values.get(value) ?? []), src]);
};

/** Assemble the decision facts for a candidate from its bound evidence revision (all server-derived). */
async function buildFacts(
  c: Tx,
  tenantId: string,
  cand: CandidateRow,
  evaluatedAt: string,
): Promise<CompatibilityInput['facts']> {
  const docFacts = await c.query<{
    fact_key: string;
    value: string;
    document_id: string;
    span_id: string;
    role: string;
    source_kind: string;
    trust_level: string;
    created_at: Date;
  }>(
    `SELECT f.fact_key, f.value, f.document_id, f.span_id, d.role, d.source_kind, d.trust_level, d.created_at
       FROM evidence_revision_documents rd
       JOIN evidence_documents d ON d.tenant_id = rd.tenant_id AND d.id = rd.document_id
       JOIN evidence_document_facts f ON f.tenant_id = d.tenant_id AND f.document_id = d.id
      WHERE rd.tenant_id = $1 AND rd.evidence_revision_id = $2 AND (f.fact_key = $3 OR f.fact_key LIKE 'spec:%')
      ORDER BY f.fact_key, f.value, f.document_id, f.span_id`,
    [tenantId, cand.evidence_revision_id, `part:${cand.component}`],
  );
  const byKey = new Map<string, Map<string, FactSource[]>>();
  for (const f of docFacts.rows)
    add(byKey, f.fact_key, f.value, {
      ref: `${f.document_id}/${f.span_id}`,
      role: f.role,
      sourceKind: f.source_kind,
      trustLevel: f.trust_level,
      basis: 'EXACT_EXTRACTION',
      observedAt: isoOf(f.created_at)!,
    } as FactSource);

  const claimSource = (
    cl: CandidateRow['claims']['specClaims'][number] | CandidateRow['claims']['certificationClaims'][number],
  ) =>
    ({
      ref: `${cl.documentId}/${cl.spanId}`,
      role: cl.role,
      sourceKind: cl.sourceKind,
      trustLevel: cl.trustLevel,
      basis: cl.basis,
      observedAt: cl.observedAt,
    }) as FactSource;
  const claimed = new Map<string, Map<string, FactSource[]>>();
  for (const cl of cand.claims.specClaims) add(claimed, cl.key, cl.value, claimSource(cl));
  const certs = new Map<string, Map<string, FactSource[]>>();
  for (const cl of cand.claims.certificationClaims) add(certs, cl.code, 'CERTIFIED', claimSource(cl));

  // Registry snapshots bound into the evidence revision (M05 REGISTRY_SNAPSHOT documents).
  const snaps = await c.query<{
    text: string;
    document_id: string;
    span_id: string;
    role: string;
    source_kind: string;
    trust_level: string;
    created_at: Date;
  }>(
    `SELECT s.text, s.document_id, s.id AS span_id, d.role, d.source_kind, d.trust_level, d.created_at
       FROM evidence_revision_documents rd
       JOIN evidence_documents d ON d.tenant_id = rd.tenant_id AND d.id = rd.document_id
       JOIN evidence_document_spans s ON s.tenant_id = d.tenant_id AND s.document_id = d.id
      WHERE rd.tenant_id = $1 AND rd.evidence_revision_id = $2 AND d.source_kind = 'REGISTRY_SNAPSHOT'
        AND d.role IN ('WARRANTY', 'VENDOR_RECORD')
      ORDER BY d.id, s.ordinal`,
    [tenantId, cand.evidence_revision_id],
  );
  const warranty = new Map<string, FactSource[]>();
  const vendor = new Map<string, FactSource[]>();
  for (const s of snaps.rows) {
    const src = {
      ref: `${s.document_id}/${s.span_id}`,
      role: s.role,
      sourceKind: s.source_kind,
      trustLevel: s.trust_level,
      basis: 'STRUCTURED_RECORD',
      observedAt: isoOf(s.created_at)!,
    } as FactSource;
    const f = fieldsOf(s.text);
    if (s.role === 'WARRANTY') {
      const exp = /^\d{4}-\d{2}-\d{2}$/.test(f.get('expires_on') ?? '') ? f.get('expires_on')! : null;
      if (!exp) continue;
      const value = Date.parse(evaluatedAt) <= Date.parse(`${exp}T23:59:59.999Z`) ? 'IN_WARRANTY' : 'OUT_OF_WARRANTY';
      warranty.set(value, [...(warranty.get(value) ?? []), src]);
    } else if (cand.vendor_id !== null && f.get('vendor_id') === cand.vendor_id) {
      const value = f.get('status') === 'APPROVED' ? 'APPROVED' : 'NOT_APPROVED';
      vendor.set(value, [...(vendor.get(value) ?? []), src]);
    }
  }
  const empty = new Map<string, FactSource[]>();
  return {
    requiredPart: factOf(byKey.get(`part:${cand.component}`) ?? empty),
    requiredConstraints: [...byKey.entries()]
      .filter(([k]) => k.startsWith('spec:') && !k.startsWith('spec:certification-'))
      .map(([k, v]) => ({ key: k.slice(5), fact: factOf(v) })),
    candidateConstraints: [...claimed.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, v]) => ({ key, fact: factOf(v) })),
    certifications: [...certs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, v]) => ({ code, fact: factOf(v) })),
    warranty: factOf(warranty),
    vendor: factOf(vendor),
  };
}

async function loadCandidate(c: Tx, tenantId: string, id: string): Promise<CandidateRow | undefined> {
  const { rows } = await c.query<CandidateRow>(`SELECT * FROM candidate_actions WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    String(id),
  ]);
  return rows[0];
}

async function staleFields(
  c: Tx,
  tenantId: string,
  r: {
    incident_id: string;
    asset_id: string;
    evidence_revision_id: string;
    asset_revision_id: string;
    policy_revision_id: string;
  },
) {
  const stale: string[] = [];
  const evr = await latestEvidenceRevision(c, tenantId, r.incident_id);
  if (evr?.id !== r.evidence_revision_id) stale.push('EVIDENCE_REVISION');
  if ((await currentAssetRevisionId(c, tenantId, r.asset_id)) !== r.asset_revision_id) stale.push('ASSET_REVISION');
  if ((await effectiveAuthorityRevisionId(c, tenantId)) !== r.policy_revision_id) stale.push('POLICY_REVISION');
  return stale;
}

export async function evaluateCandidate(
  pool: Db,
  ctx: TenantContext,
  input: { candidateActionId: string },
  signing: AuthoritySigning,
): Promise<DecisionView & { created: boolean }> {
  const keys = assertSigning(signing);
  const meta = {
    action: 'compatibility.evaluate',
    resourceType: 'candidate_action',
    resourceId: input?.candidateActionId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const cand = await loadCandidate(c, ctx.tenantId, input.candidateActionId);
    if (!cand) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'compatibility.engine', siteId: null }, undefined, {
      type: 'candidate_action',
      id: cand.id,
    });
    await lockKey(c, `compatibility:${ctx.tenantId}:${cand.incident_id}:${cand.candidate_key}`);
    const stale = await staleFields(c, ctx.tenantId, cand);
    if (stale.length > 0) throw hold('CANDIDATE_TUPLE_STALE', { staleFields: stale });
    const governing = await loadGoverning(c, ctx.tenantId, cand.policy_revision_id);
    if (!governing) throw unavailable(meta, cand.policy_revision_id, 'policy_revision');
    const now = await dbNow(c);
    const asset = await c.query(
      `SELECT manufacturer, model, serial, bom_revision, safety_class FROM asset_revisions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, cand.asset_revision_id],
    );
    const a = asset.rows[0];
    const authorities = await loadAuthorityEvidence(c, ctx.tenantId, { candidateActionId: cand.id });
    const compatInput: CompatibilityInput = {
      schemaVersion: 1,
      binding: {
        tenantId: ctx.tenantId,
        siteId: cand.site_id,
        incidentId: cand.incident_id,
        candidateActionId: cand.id,
        assetRevisionId: cand.asset_revision_id,
        evidenceRevisionId: cand.evidence_revision_id,
        policyRevisionId: cand.policy_revision_id,
        actionDigest: cand.action_digest,
      } as CompatibilityInput['binding'],
      state: {
        assetRevisionCurrent: true,
        evidenceRevisionCurrent: true,
        evidenceAssetRevisionId: cand.asset_revision_id as CompatibilityInput['state']['evidenceAssetRevisionId'],
        policyRevisionEffective: governing.effectiveNow,
      },
      asset: {
        manufacturer: a.manufacturer ?? null,
        model: a.model ?? null,
        serial: a.serial ?? null,
        bomRevision: a.bom_revision ?? null,
        safetyClass: a.safety_class,
      },
      candidate: {
        actionKind: cand.kind,
        component: cand.component,
        manufacturer: cand.manufacturer,
        partNumber: cand.part_number,
        quantity: cand.quantity,
        vendorId: cand.vendor_id,
        amount: { amountMinor: BigInt(cand.amount_minor), currency: cand.currency as CurrencyCode },
        offerObservedAt: isoOf(cand.offer_observed_at),
      },
      facts: await buildFacts(c, ctx.tenantId, cand, now),
      authorities: authorities.map(({ record, heldRoles }) => ({ record, heldRoles })),
      evaluatedAt: now,
    };
    const result = evaluateCompatibility(compatInput, governing, {
      explanation: explanationOf(cand.explanation),
      keyring: keys.keyring,
    });
    // The tuple's authority evidence: each record's signature, lifecycle, expiry at this instant and exact grants.
    const authoritySetDigest = canonicalDigest(
      'compatibility-authority-set',
      1,
      authorities.map((e) => ({
        authorityRecordId: e.record.authorityRecordId,
        signature: e.record.signature.value,
        status: e.record.status,
        expired: Date.parse(e.record.expiresAt) <= Date.parse(now),
        grantIds: e.grantIds,
      })),
    );
    const existing = await c.query(
      `SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND candidate_action_id = $2 AND authority_set_digest = $3`,
      [ctx.tenantId, cand.id, authoritySetDigest],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].lifecycle !== 'CURRENT') throw hold('DECISION_TUPLE_SUPERSEDED');
      return { ...toView(existing.rows[0]), created: false };
    }

    const id = newId('compatibilityDecision');
    const prior = await c.query<{ id: string }>(
      `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED', superseded_at = clock_timestamp(),
              superseded_reason = 'NEW_EVALUATION', superseded_by_decision_id = $4
        WHERE tenant_id = $1 AND incident_id = $2 AND candidate_key = $3 AND lifecycle = 'CURRENT' RETURNING id`,
      [ctx.tenantId, cand.incident_id, cand.candidate_key, id],
    );
    const storedInput = encodeWire(CompatibilityInputSchema, compatInput);
    const { rows } = await c.query(
      `INSERT INTO compatibility_decisions (tenant_id, id, candidate_action_id, incident_id, site_id, asset_revision_id,
         evidence_revision_id, policy_revision_id, action_digest, candidate_key, authority_set_digest, decision, reason_codes,
         blocking_reasons, satisfied_checks, missing_fields, conflicting_fields, required_authorities, recovery_paths,
         applied_authority_ids, exception_classes_applied, overrides_applied, authority_findings, approval_route, safety_class,
         exact_match, input, input_digest, explanation, rule_version, policy_rule_set, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27, $28, $29, $30, $31, $32)
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        cand.id,
        cand.incident_id,
        cand.site_id,
        cand.asset_revision_id,
        cand.evidence_revision_id,
        cand.policy_revision_id,
        cand.action_digest,
        cand.candidate_key,
        authoritySetDigest,
        result.decision,
        result.reasonCodes,
        result.blockingReasons,
        result.satisfiedChecks,
        result.missingFields,
        result.conflictingFields,
        JSON.stringify(result.requiredAuthorities),
        result.recoveryPaths,
        result.appliedAuthorityIds,
        result.exceptionClassesApplied,
        result.overridesApplied,
        JSON.stringify(result.authorityFindings),
        JSON.stringify(result.approvalRoute),
        result.safetyClass,
        result.exactMatch,
        JSON.stringify(storedInput),
        result.inputDigest,
        result.explanation === null ? null : JSON.stringify(result.explanation),
        result.ruleVersion,
        result.policyRuleSet,
        now,
      ],
    );
    for (const authorityRecordId of result.appliedAuthorityIds)
      await c.query(
        `INSERT INTO compatibility_decision_authorities (tenant_id, decision_id, authority_record_id) VALUES ($1, $2, $3)`,
        [ctx.tenantId, id, authorityRecordId],
      );
    const payload = {
      compatibilityDecisionId: id,
      incidentId: cand.incident_id,
      candidateActionId: cand.id,
      decision: result.decision,
      reasonCodes: result.reasonCodes,
      actionDigest: cand.action_digest,
      assetRevisionId: cand.asset_revision_id,
      evidenceRevisionId: cand.evidence_revision_id,
      policyRevisionId: cand.policy_revision_id,
      inputDigest: result.inputDigest,
      supersededDecisionId: prior.rows[0]?.id ?? null,
      approved: false,
    };
    await appendSystemEvidence(c, ctx, {
      kind: 'POLICY_DECISION',
      trust: 'AUTHORITATIVE',
      subject: { aggregateType: 'compatibility_decision', aggregateId: id },
      incidentId: cand.incident_id,
      payloadSchema: 'compatibility.decision.v1',
      payloadDigest: sha256Digest(canonicalize(payload)),
      payloadRef: null,
      supersedesEvidenceId: null,
    });
    await appendOutboxEvent(c, ctx, {
      eventType: 'compatibility.evaluated.v1',
      aggregateType: 'compatibility_decision',
      aggregateId: id,
      aggregateVersion: 1,
      payload,
      correlationId: ctx.correlationId,
      causationId: newId('command'),
    });
    await recordAudit(c, ctx, {
      action: 'compatibility.evaluate',
      resourceType: 'compatibility_decision',
      resourceId: id,
      result: 'SUCCEEDED',
      reasonCode: result.decision,
    });
    return { ...toView(rows[0]), created: true };
  });
}

async function readDecision(c: Tx, ctx: TenantContext, meta: { action: string; resourceType: string }, id: string) {
  const { rows } = await c.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
    ctx.tenantId,
    String(id),
  ]);
  if (!rows[0]) throw unavailable(meta, id);
  requireAuthorized(ctx, { action: 'compatibility.read', siteId: rows[0].site_id }, undefined, {
    type: 'compatibility_decision',
    id,
  });
  return rows[0];
}

export async function getDecision(
  pool: Db,
  ctx: TenantContext,
  compatibilityDecisionId: string,
): Promise<DecisionView> {
  const meta = {
    action: 'compatibility.read',
    resourceType: 'compatibility_decision',
    resourceId: compatibilityDecisionId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => toView(await readDecision(c, ctx, meta, compatibilityDecisionId)));
}

export async function listDecisions(
  pool: Db,
  ctx: TenantContext,
  input: { incidentId: string; lifecycle?: 'CURRENT' | 'SUPERSEDED' },
): Promise<DecisionView[]> {
  const meta = { action: 'compatibility.read', resourceType: 'incident', resourceId: input?.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await c.query(`SELECT site_id FROM incidents WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      String(input.incidentId),
    ]);
    if (!inc.rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'compatibility.read', siteId: inc.rows[0].site_id }, undefined, {
      type: 'incident',
      id: input.incidentId,
    });
    const { rows } = await c.query(
      `SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND incident_id = $2 AND ($3::text IS NULL OR lifecycle = $3)
        ORDER BY decided_at, id LIMIT 1000`,
      [ctx.tenantId, input.incidentId, input.lifecycle ?? null],
    );
    return rows.map(toView);
  });
}

/** Re-run the pure evaluator on the stored input under the policy body that governed it (INV-10). */
export async function reproduceDecision(
  pool: Db,
  ctx: TenantContext,
  compatibilityDecisionId: string,
  signing: AuthoritySigning,
): Promise<{
  reproduced: boolean;
  decision: string;
  inputDigest: string;
  policyRevisionId: string;
  evidenceRevisionId: string;
  assetRevisionId: string;
}> {
  const keys = assertSigning(signing);
  const meta = {
    action: 'compatibility.read',
    resourceType: 'compatibility_decision',
    resourceId: compatibilityDecisionId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await readDecision(c, ctx, meta, compatibilityDecisionId);
    const governing = await loadGoverning(c, ctx.tenantId, r.policy_revision_id);
    if (!governing) throw unavailable(meta, r.policy_revision_id, 'policy_revision');
    const storedInput = decodeWire(CompatibilityInputSchema, r.input);
    const { authority: _a, ...explanation } = (r.explanation ?? {}) as Record<string, unknown>;
    const again = evaluateCompatibility(storedInput, governing, {
      explanation: r.explanation ? (explanation as never) : undefined,
      keyring: keys.keyring,
    });
    const reproduced =
      again.decision === r.decision &&
      again.inputDigest === r.input_digest &&
      canonicalize(again.reasonCodes) === canonicalize(r.reason_codes) &&
      canonicalize(again.appliedAuthorityIds) === canonicalize(r.applied_authority_ids);
    return {
      reproduced,
      decision: again.decision,
      inputDigest: again.inputDigest,
      policyRevisionId: r.policy_revision_id,
      evidenceRevisionId: r.evidence_revision_id,
      assetRevisionId: r.asset_revision_id,
    };
  });
}

export interface ExecutableDecision {
  executable: true;
  compatibilityDecisionId: string;
  decision: 'ALLOW';
  actionDigest: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string;
  appliedAuthorityIds: string[];
  checkedAt: UtcInstant;
}

/**
 * Execution-time gate for M08/M09, inside the caller's transaction (FOR SHARE on the decision row, so a concurrent
 * supersession serializes with the caller's linearization): the decision is CURRENT ALLOW for exactly this action
 * digest, its asset/evidence/policy revisions are still current, its offer is still fresh, and every applied
 * authority record still verifies (signature, lifecycle, expiry, registry role) now. Any failure throws.
 */
export async function assertDecisionExecutableInTx(
  c: Tx,
  ctx: TenantContext,
  input: { compatibilityDecisionId: string; actionDigest: string },
  signing: AuthoritySigning,
): Promise<ExecutableDecision> {
  const keys = assertSigning(signing);
  const meta = {
    action: 'compatibility.execute_check',
    resourceType: 'compatibility_decision',
    resourceId: input.compatibilityDecisionId,
  };
  const { rows } = await c.query(
    `SELECT d.*, ca.asset_id, ca.offer_observed_at, ca.kind FROM compatibility_decisions d
       JOIN candidate_actions ca ON ca.tenant_id = d.tenant_id AND ca.id = d.candidate_action_id
      WHERE d.tenant_id = $1 AND d.id = $2 FOR SHARE OF d`,
    [ctx.tenantId, String(input.compatibilityDecisionId)],
  );
  const d = rows[0];
  if (!d) throw unavailable(meta);
  requireAuthorized(ctx, { action: 'compatibility.engine', siteId: null }, undefined, {
    type: 'compatibility_decision',
    id: d.id,
  });
  if (d.lifecycle !== 'CURRENT') throw hold('DECISION_NOT_CURRENT');
  if (d.action_digest !== input.actionDigest)
    throw new DomainError('DIGEST_MISMATCH', 'The decision is bound to another action digest.', {
      reasonCode: 'ACTION_DIGEST_MISMATCH',
    });
  if ((await effectiveAuthorityRevisionId(c, ctx.tenantId)) !== d.policy_revision_id)
    throw hold('POLICY_REVISION_NOT_EFFECTIVE');
  if ((await latestEvidenceRevision(c, ctx.tenantId, d.incident_id))?.id !== d.evidence_revision_id)
    throw hold('EVIDENCE_REVISION_NOT_CURRENT');
  if ((await currentAssetRevisionId(c, ctx.tenantId, d.asset_id)) !== d.asset_revision_id)
    throw hold('ASSET_REVISION_SUPERSEDED');
  if (d.decision !== 'ALLOW') throw hold('DECISION_NOT_ALLOW');
  const now = await dbNow(c);
  const governing = await loadGoverning(c, ctx.tenantId, d.policy_revision_id);
  if (PURCHASE_KINDS.includes(d.kind)) {
    const o = d.offer_observed_at ? Date.parse(isoOf(d.offer_observed_at)!) : null;
    const max = governing?.compatibility?.freshness.maxOfferAgeMs ?? 0;
    if (o === null || Date.parse(now) - o > max) throw hold('STALE_PRICE_OR_STOCK');
  }
  if (d.applied_authority_ids.length > 0) {
    const stored = decodeWire(CompatibilityInputSchema, d.input);
    const atNow = { ...stored, evaluatedAt: now };
    const evidence = await loadAuthorityEvidence(c, ctx.tenantId, { authorityRecordIds: d.applied_authority_ids });
    if (evidence.length !== d.applied_authority_ids.length) throw hold('AUTHORITY_MISSING');
    for (const e of evidence) {
      const v = verifyAuthorityRecord({ record: e.record, heldRoles: e.heldRoles }, atNow, governing!, keys.keyring);
      if (!v.valid) throw hold(v.reasonCode, { authorityRecordId: e.record.authorityRecordId });
    }
  }
  return {
    executable: true,
    compatibilityDecisionId: d.id,
    decision: 'ALLOW',
    actionDigest: d.action_digest,
    assetRevisionId: d.asset_revision_id,
    evidenceRevisionId: d.evidence_revision_id,
    policyRevisionId: d.policy_revision_id,
    appliedAuthorityIds: d.applied_authority_ids,
    checkedAt: now,
  };
}

export async function checkDecisionExecutable(
  pool: Db,
  ctx: TenantContext,
  input: { compatibilityDecisionId: string; actionDigest: string },
  signing: AuthoritySigning,
): Promise<ExecutableDecision> {
  const meta = {
    action: 'compatibility.execute_check',
    resourceType: 'compatibility_decision',
    resourceId: input?.compatibilityDecisionId,
  };
  return tenantCommand(pool, ctx, meta, (c) => assertDecisionExecutableInTx(c, ctx, input, signing));
}
