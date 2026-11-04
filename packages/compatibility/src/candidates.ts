// Revision-bound candidate actions (INV-03). A candidate names what is proposed (component, OEM part, quantity,
// vendor, provider-account revision, merchant, amount, purpose, offer snapshot) plus cited claims. Everything else is
// server-derived: the incident's site and asset, its latest evidence revision, the asset's current revision, the
// effective AUTHORITY policy revision and the canonical action digest. Claims must cite a span of the bound evidence
// revision that contains the claimed value; their source attributes (role, source kind, trust, observed time) are
// read from the evidence, never from the client. Registration is idempotent on the full content.
import {
  ActionKindSchema,
  CitationIdSchema,
  CurrencyCodeSchema,
  IncidentIdSchema,
  MerchantIdSchema,
  ProviderAccountRevisionIdSchema,
  PurposeCodeSchema,
  UtcInstantSchema,
  newId,
  type ActionKind,
  type CurrencyCode,
  type Money,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import {
  CanonicalKeySchema,
  CertificationCodeSchema,
  ExplanationSchema,
  SELLER_SOURCE_KINDS,
  canonicalDigest,
  computeActionDigest,
  normalizeComponentKey,
  normalizeFactValue,
  normalizeManufacturer,
  normalizePartNumber,
  type Explanation,
} from '@uptimebuyer/domain';
import {
  actorOf,
  lockKey,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import {
  currentAssetRevisionId,
  effectiveAuthorityRevisionId,
  hold,
  invalid,
  isoOf,
  latestEvidenceRevision,
} from './internal.js';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0 && s.trim().length === s.length, 'Untrimmed or blank text.');

const RegisterSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  kind: ActionKindSchema,
  /** Human-readable component; canonicalized into the single component key used by every rule. */
  component: z.string().min(1).max(200),
  manufacturer: text(128).nullable(),
  partNumber: text(80).nullable(),
  quantity: z.int().min(1).max(1_000_000),
  vendorId: text(80).nullable(),
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  merchantId: MerchantIdSchema,
  amount: z.strictObject({
    amountMinor: z.bigint().min(0n).max(9_223_372_036_854_775_807n),
    currency: CurrencyCodeSchema,
  }),
  purpose: PurposeCodeSchema,
  offerObservedAt: UtcInstantSchema.nullable(),
  specClaims: z
    .array(z.strictObject({ key: CanonicalKeySchema, value: text(200), citationId: CitationIdSchema }))
    .max(20),
  certificationClaims: z.array(z.strictObject({ code: CertificationCodeSchema, citationId: CitationIdSchema })).max(20),
  explanation: ExplanationSchema.optional(),
});

export interface RegisterCandidateInput {
  incidentId: string;
  kind: ActionKind;
  component: string;
  manufacturer: string | null;
  partNumber: string | null;
  quantity: number;
  vendorId: string | null;
  providerAccountRevisionId: string;
  merchantId: string;
  amount: Money;
  purpose: string;
  offerObservedAt: UtcInstant | string | null;
  specClaims: { key: string; value: string; citationId: string }[];
  certificationClaims: { code: string; citationId: string }[];
  explanation?: Explanation;
}

export interface ResolvedClaim {
  citationId: string;
  documentId: string;
  spanId: string;
  role: string;
  sourceKind: string;
  trustLevel: string;
  basis: 'CITED_EXACT_TEXT' | 'SEMANTIC_MATCH' | 'SELLER_TEXT';
  observedAt: UtcInstant;
}

export interface CandidateRegistration {
  candidateActionId: string;
  created: boolean;
  incidentId: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string;
  actionDigest: string;
  candidateKey: string;
}

export interface CandidateActionView extends Omit<CandidateRegistration, 'created'> {
  siteId: string;
  assetId: string;
  kind: ActionKind;
  component: string;
  componentLabel: string;
  manufacturer: string | null;
  partNumber: string | null;
  quantity: number;
  vendorId: string | null;
  providerAccountRevisionId: string;
  merchantId: string;
  amount: Money;
  purpose: string;
  offerObservedAt: UtcInstant | null;
  specClaims: (ResolvedClaim & { key: string; value: string })[];
  certificationClaims: (ResolvedClaim & { code: string })[];
  explanation: (Explanation & { authority: 'NONE' }) | null;
  proposalId: string | null;
  createdAt: UtcInstant;
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Resolve a cited claim. The citation must belong to the bound evidence revision and its span must contain the
 * claimed text (else the claim is refused). It is an exact citation only when M05 extracted a fact with the expected
 * key and an exactly equal normalized value from that very span; containment alone is a SEMANTIC_MATCH, and a
 * seller-authored source is SELLER_TEXT. Neither can ever be authoritative (INV-04).
 */
async function resolveClaim(
  c: Tx,
  ctx: TenantContext,
  meta: { action: string; resourceType: string },
  evidenceRevisionId: string,
  citationId: string,
  mustContain: string,
  factKey: string,
): Promise<ResolvedClaim> {
  const { rows } = await c.query(
    `SELECT ct.id, ct.evidence_revision_id, s.id AS span_id, s.text, d.id AS document_id, d.role, d.source_kind,
            d.trust_level, d.created_at,
            EXISTS (SELECT 1 FROM evidence_document_facts f
                     WHERE f.tenant_id = s.tenant_id AND f.span_id = s.id AND f.fact_key = $3
                       AND regexp_replace(btrim(f.value), '\\s+', ' ', 'g') = $4) AS exact
       FROM citations ct
       JOIN evidence_document_spans s ON s.tenant_id = ct.tenant_id AND s.id = ct.span_id
       JOIN evidence_documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
      WHERE ct.tenant_id = $1 AND ct.id = $2`,
    [ctx.tenantId, citationId, factKey, normalizeFactValue(mustContain)],
  );
  const r = rows[0];
  if (!r || r.evidence_revision_id !== evidenceRevisionId) throw unavailable(meta, citationId, 'citation');
  if (!squash(r.text).includes(squash(mustContain))) throw invalid('CLAIM_NOT_IN_CITATION', { citationId });
  const basis: ResolvedClaim['basis'] = SELLER_SOURCE_KINDS.includes(r.source_kind)
    ? 'SELLER_TEXT'
    : r.exact === true
      ? 'CITED_EXACT_TEXT'
      : 'SEMANTIC_MATCH';
  return {
    citationId: r.id,
    documentId: r.document_id,
    spanId: r.span_id,
    role: r.role,
    sourceKind: r.source_kind,
    trustLevel: r.trust_level,
    basis,
    observedAt: isoOf(r.created_at)!,
  };
}

export async function registerCandidateAction(
  pool: Db,
  ctx: TenantContext,
  raw: RegisterCandidateInput,
): Promise<CandidateRegistration> {
  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid('INVALID_CANDIDATE', {
      fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), issue: i.code })),
    });
  const input = parsed.data;
  const component = normalizeComponentKey(input.component);
  if (!component) throw invalid('INVALID_COMPONENT');
  const meta = { action: 'compatibility.register', resourceType: 'candidate_action', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await c.query<{ site_id: string; asset_id: string }>(
      `SELECT site_id, asset_id FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.incidentId],
    );
    if (!inc.rows[0]) throw unavailable(meta, input.incidentId, 'incident');
    const { site_id: siteId, asset_id: assetId } = inc.rows[0];
    requireAuthorized(ctx, { action: 'compatibility.register', siteId: siteId as never }, undefined, {
      type: 'incident',
      id: input.incidentId,
    });
    const evr = await latestEvidenceRevision(c, ctx.tenantId, input.incidentId);
    if (!evr) throw hold('NO_EVIDENCE_REVISION');
    const assetRevisionId = await currentAssetRevisionId(c, ctx.tenantId, assetId);
    if (evr.asset_revision_id !== assetRevisionId) throw hold('EVIDENCE_REVISION_NOT_CURRENT');
    const policyRevisionId = await effectiveAuthorityRevisionId(c, ctx.tenantId);
    if (!policyRevisionId) throw hold('NO_EFFECTIVE_POLICY');
    const acct = await c.query(`SELECT 1 FROM provider_account_revisions WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      input.providerAccountRevisionId,
    ]);
    if (!acct.rowCount) throw unavailable(meta, input.providerAccountRevisionId, 'provider_account_revision');
    const proposalId = input.explanation?.proposalId ?? null;
    if (proposalId) {
      const p = await c.query(
        `SELECT 1 FROM reasoning_proposals WHERE tenant_id = $1 AND id = $2 AND incident_id = $3`,
        [ctx.tenantId, proposalId, input.incidentId],
      );
      if (!p.rowCount) throw unavailable(meta, proposalId, 'reasoning_proposal');
    }

    const specClaims = [];
    for (const cl of input.specClaims)
      specClaims.push({
        key: cl.key,
        value: cl.value,
        ...(await resolveClaim(c, ctx, meta, evr.id, cl.citationId, cl.value, `spec:${cl.key}`)),
      });
    const certificationClaims = [];
    for (const cl of input.certificationClaims)
      certificationClaims.push({
        code: cl.code,
        ...(await resolveClaim(
          c,
          ctx,
          meta,
          evr.id,
          cl.citationId,
          cl.code,
          `spec:certification-${normalizeComponentKey(cl.code)}`,
        )),
      });

    const amount = { amountMinor: input.amount.amountMinor, currency: input.amount.currency as CurrencyCode };
    const actionDigest = computeActionDigest({
      tenantId: ctx.tenantId,
      incidentId: input.incidentId,
      assetRevisionId: evr.asset_revision_id as never,
      evidenceRevisionId: evr.id as never,
      policyRevisionId: policyRevisionId as never,
      action: {
        kind: input.kind,
        subjectId: assetId as never,
        quantity: input.quantity,
        partNumber: input.partNumber,
        manufacturer: input.manufacturer,
      },
      providerAccountRevisionId: input.providerAccountRevisionId,
      merchantId: input.merchantId,
      amount: amount as Money,
      purpose: input.purpose,
    });
    const candidateKey = canonicalDigest('candidate-key', 1, {
      incidentId: input.incidentId,
      kind: input.kind,
      component,
      manufacturer: input.manufacturer === null ? null : normalizeManufacturer(input.manufacturer),
      partNumber: input.partNumber === null ? null : normalizePartNumber(input.partNumber),
      quantity: input.quantity,
      vendorId: input.vendorId,
      providerAccountRevisionId: input.providerAccountRevisionId,
      merchantId: input.merchantId,
      purpose: input.purpose,
    });
    const explanation = input.explanation ?? null;
    const claims = { specClaims, certificationClaims };
    const candidateDigest = canonicalDigest('candidate-registration', 1, {
      candidateKey,
      actionDigest,
      componentLabel: input.component,
      evidenceRevisionId: evr.id,
      assetRevisionId: evr.asset_revision_id,
      policyRevisionId,
      offerObservedAt: input.offerObservedAt,
      claims,
      explanation,
    });
    await lockKey(c, `candidate:${ctx.tenantId}:${candidateDigest}`);
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM candidate_actions WHERE tenant_id = $1 AND candidate_digest = $2`,
      [ctx.tenantId, candidateDigest],
    );
    const base = {
      incidentId: input.incidentId,
      assetRevisionId: evr.asset_revision_id,
      evidenceRevisionId: evr.id,
      policyRevisionId,
      actionDigest,
      candidateKey,
    };
    if (existing.rows[0]) return { candidateActionId: existing.rows[0].id, created: false, ...base };
    const id = newId('candidateAction');
    const actor = actorOf(ctx);
    await c.query(
      `INSERT INTO candidate_actions (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, evidence_revision_id,
         policy_revision_id, kind, component, component_label, manufacturer, part_number, quantity, vendor_id,
         provider_account_revision_id, merchant_id, amount_minor, currency, purpose, offer_observed_at, claims, explanation,
         proposal_id, action_digest, candidate_key, candidate_digest, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27, $28, $29)`,
      [
        ctx.tenantId,
        id,
        input.incidentId,
        siteId,
        assetId,
        evr.asset_revision_id,
        evr.id,
        policyRevisionId,
        input.kind,
        component,
        input.component,
        input.manufacturer,
        input.partNumber,
        input.quantity,
        input.vendorId,
        input.providerAccountRevisionId,
        input.merchantId,
        amount.amountMinor.toString(),
        amount.currency,
        input.purpose,
        input.offerObservedAt,
        JSON.stringify(claims),
        JSON.stringify(explanation ?? {}),
        proposalId,
        actionDigest,
        candidateKey,
        candidateDigest,
        actor.kind,
        actor.id.slice(0, 128),
      ],
    );
    await recordAudit(c, ctx, { ...meta, resourceId: id, result: 'SUCCEEDED' });
    return { candidateActionId: id, created: true, ...base };
  });
}

export interface CandidateRow {
  id: string;
  incident_id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  evidence_revision_id: string;
  policy_revision_id: string;
  kind: ActionKind;
  component: string;
  component_label: string;
  manufacturer: string | null;
  part_number: string | null;
  quantity: number;
  vendor_id: string | null;
  provider_account_revision_id: string;
  merchant_id: string;
  amount_minor: string;
  currency: string;
  purpose: string;
  offer_observed_at: Date | null;
  claims: {
    specClaims: CandidateActionView['specClaims'];
    certificationClaims: CandidateActionView['certificationClaims'];
  };
  explanation: Record<string, unknown>;
  proposal_id: string | null;
  action_digest: string;
  candidate_key: string;
  created_at: Date;
}

export const explanationOf = (e: Record<string, unknown> | null) =>
  e && Object.keys(e).length > 0 ? (e as Explanation) : undefined;

export function toCandidateView(r: CandidateRow): CandidateActionView {
  const ex = explanationOf(r.explanation);
  return {
    candidateActionId: r.id,
    incidentId: r.incident_id,
    siteId: r.site_id,
    assetId: r.asset_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    actionDigest: r.action_digest,
    candidateKey: r.candidate_key,
    kind: r.kind,
    component: r.component,
    componentLabel: r.component_label,
    manufacturer: r.manufacturer,
    partNumber: r.part_number,
    quantity: r.quantity,
    vendorId: r.vendor_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    merchantId: r.merchant_id,
    amount: { amountMinor: BigInt(r.amount_minor), currency: r.currency as CurrencyCode } as Money,
    purpose: r.purpose,
    offerObservedAt: isoOf(r.offer_observed_at),
    specClaims: r.claims.specClaims,
    certificationClaims: r.claims.certificationClaims,
    explanation: ex ? { ...ex, authority: 'NONE' } : null,
    proposalId: r.proposal_id,
    createdAt: isoOf(r.created_at)!,
  };
}

export async function getCandidateAction(
  pool: Db,
  ctx: TenantContext,
  candidateActionId: string,
): Promise<CandidateActionView> {
  const meta = { action: 'compatibility.read', resourceType: 'candidate_action', resourceId: candidateActionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query<CandidateRow>(`SELECT * FROM candidate_actions WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      String(candidateActionId),
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'compatibility.read', siteId: rows[0].site_id as never }, undefined, {
      type: 'candidate_action',
      id: candidateActionId,
    });
    return toCandidateView(rows[0]);
  });
}
