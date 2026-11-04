// The compatibility and safety section of a governing policy revision (FR-06, FR-10, FR-21, INV-04, INV-15). It is
// authored by an administrator, published as part of an immutable effective-dated AUTHORITY policy revision, and
// validated here before publication. Hard floors that no policy can lower are encoded in this file, not in policy
// text: seller-authored, provider-reported and model/semantic evidence can never be declared authoritative; known
// incompatibility, missing exact identity, conflicts, safety classification and substitution are never overridable
// by a policy approver; a safety class can only be raised, never lowered.
import {
  ActionKindSchema,
  CurrencyCodeSchema,
  EVIDENCE_TRUST_LEVELS,
  MinorUnitsSchema,
  SiteIdSchema,
} from '@uptimebuyer/contracts';
import { z } from 'zod';

export const FACT_CATEGORIES = Object.freeze([
  'PART_IDENTITY',
  'ELECTRICAL',
  'MECHANICAL',
  'CERTIFICATION',
  'WARRANTY',
  'VENDOR',
] as const);
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** M05 document roles and source kinds (the evidence a fact may come from). */
export const EVIDENCE_ROLES = Object.freeze([
  'MANUAL',
  'PARTS_LIST',
  'WARRANTY',
  'WORK_ORDER',
  'VENDOR_RECORD',
  'TRANSCRIPT',
  'OTHER',
] as const);
export const EVIDENCE_SOURCE_KINDS = Object.freeze([
  'OEM_PUBLICATION',
  'TENANT_RECORD',
  'SERVICE_HISTORY',
  'PROVIDER_DOCUMENT',
  'COMMUNICATION',
  'REGISTRY_SNAPSHOT',
] as const);
/** Seller/provider-authored source kinds: never authoritative, whatever a policy says (INV-04). */
export const SELLER_SOURCE_KINDS: readonly string[] = Object.freeze(['PROVIDER_DOCUMENT', 'COMMUNICATION']);
/** Trust levels that can never be authoritative for compatibility. */
export const NON_AUTHORITATIVE_TRUST: readonly string[] = Object.freeze(['PROVIDER_REPORTED']);

export const INTERVENTION_SAFETY_CLASSES = Object.freeze(['STANDARD', 'SAFETY_CRITICAL', 'PROHIBITED'] as const);
export type InterventionSafetyClass = (typeof INTERVENTION_SAFETY_CLASSES)[number];
export const ASSET_SAFETY_CLASSES = Object.freeze(['STANDARD', 'ELEVATED', 'SAFETY_CRITICAL'] as const);

/** The only HOLD reasons a policy-named approver may override (a business exception, never a compatibility one). */
export const OVERRIDABLE_REASONS = Object.freeze([
  'VENDOR_NOT_APPROVED',
  'VENDOR_STATUS_UNKNOWN',
  'WARRANTY_REQUIRES_OEM_PART',
  'WARRANTY_STATUS_UNKNOWN',
] as const);
export type OverridableReason = (typeof OVERRIDABLE_REASONS)[number];

/** Human roles a policy may name as approver for overrides and out-of-bounds amounts (never viewer/operator/auditor). */
export const APPROVER_CAPABLE_ROLES: readonly string[] = Object.freeze([
  'maintenance_approver',
  'finance_approver',
  'admin',
]);
/** INV-15: substitutes, non-exact matches and safety-critical work always need this role. */
export const NAMED_ENGINEER_ROLE = 'engineer';

export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ComponentKeySchema = z.string().regex(KEY_RE);
export const CertificationCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9 ./-]{0,38}[A-Za-z0-9])?$/)
  .refine((s) => !/\s{2}/.test(s), 'Single spaces only.');

const nonEmpty = <T extends z.ZodType>(t: T, max: number) => z.array(t).min(1).max(max);
const MS_DAY = 86_400_000;

const AuthoritativeSourceRuleSchema = z.strictObject({
  category: z.enum(FACT_CATEGORIES),
  roles: nonEmpty(z.enum(EVIDENCE_ROLES), EVIDENCE_ROLES.length),
  sourceKinds: nonEmpty(z.enum(EVIDENCE_SOURCE_KINDS), EVIDENCE_SOURCE_KINDS.length),
  trustLevels: nonEmpty(z.enum(EVIDENCE_TRUST_LEVELS), EVIDENCE_TRUST_LEVELS.length),
});

const SafetyClassRuleSchema = z.strictObject({
  components: nonEmpty(ComponentKeySchema, 200).nullable(),
  actionKinds: nonEmpty(ActionKindSchema, 10).nullable(),
  assetSafetyClasses: nonEmpty(z.string().regex(/^[A-Z][A-Z_]{0,39}$/), 20).nullable(),
  safetyClass: z.enum(INTERVENTION_SAFETY_CLASSES),
});

const AutoPermitRuleSchema = z.strictObject({
  siteIds: nonEmpty(SiteIdSchema, 1000).nullable(),
  currency: CurrencyCodeSchema,
  maxAmountMinor: MinorUnitsSchema,
  actionKinds: nonEmpty(ActionKindSchema, 10),
});

export const CompatibilityPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** Administrator-chosen label for the rule set (shown in history; the revision id is the identity). */
    ruleSet: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    authoritativeSources: nonEmpty(AuthoritativeSourceRuleSchema, 50),
    mandatoryConstraints: nonEmpty(
      z.strictObject({ key: ComponentKeySchema, category: z.enum(['ELECTRICAL', 'MECHANICAL']) }),
      50,
    ),
    requiredCertifications: z
      .array(
        z.strictObject({ code: CertificationCodeSchema, components: nonEmpty(ComponentKeySchema, 200).nullable() }),
      )
      .max(50),
    warranty: z.strictObject({ statusRequired: z.boolean() }),
    substitution: z.strictObject({ mode: z.enum(['FORBIDDEN', 'ENGINEER_EXCEPTION']) }),
    safetyClasses: z.array(SafetyClassRuleSchema).max(200),
    overridableReasons: z.array(z.enum(OVERRIDABLE_REASONS)).max(OVERRIDABLE_REASONS.length),
    freshness: z.strictObject({
      maxOfferAgeMs: z
        .int()
        .min(60_000)
        .max(30 * MS_DAY),
    }),
    autoPermit: z.array(AutoPermitRuleSchema).max(200),
    authorityMaxTtlMs: z
      .int()
      .min(60_000)
      .max(30 * MS_DAY),
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    p.authoritativeSources.forEach((r, i) => {
      if (r.sourceKinds.some((k) => SELLER_SOURCE_KINDS.includes(k)))
        issue(['authoritativeSources', i, 'sourceKinds'], 'Seller-authored sources can never be authoritative.');
      if (r.trustLevels.some((t) => NON_AUTHORITATIVE_TRUST.includes(t)))
        issue(['authoritativeSources', i, 'trustLevels'], 'Provider-reported evidence can never be authoritative.');
      if (new Set(r.roles).size !== r.roles.length || new Set(r.sourceKinds).size !== r.sourceKinds.length)
        issue(['authoritativeSources', i], 'Duplicate role or source kind.');
    });
    p.safetyClasses.forEach((r, i) => {
      // A catch-all STANDARD rule would classify every unknown component as STANDARD (fail-open).
      if (r.components === null && r.safetyClass === 'STANDARD')
        issue(['safetyClasses', i, 'components'], 'A STANDARD classification must name its components.');
    });
    const keys = p.mandatoryConstraints.map((c) => c.key);
    if (new Set(keys).size !== keys.length) issue(['mandatoryConstraints'], 'Duplicate constraint key.');
    const codes = p.requiredCertifications.map((c) => c.code);
    if (new Set(codes).size !== codes.length) issue(['requiredCertifications'], 'Duplicate certification code.');
    if (new Set(p.overridableReasons).size !== p.overridableReasons.length)
      issue(['overridableReasons'], 'Duplicate overridable reason.');
  });
export type CompatibilityPolicy = z.output<typeof CompatibilityPolicySchema>;

/** The approval-limit rows of the same AUTHORITY revision (M02 shape): they name approver roles per class/amount/site. */
export interface ApprovalLimitRule {
  readonly approvalKind: string;
  readonly actionClass: string;
  readonly role: string;
  readonly currency: string;
  readonly maxAmountMinor: bigint;
  readonly siteIds: readonly string[] | null;
}

/** Everything the evaluator needs from the governing policy revision. */
export interface GoverningPolicy {
  policyRevisionId: string;
  /** The immutable revision's body digest; bound into every input digest. */
  bodyDigest: string;
  /** null = the revision carries no compatibility rules (every evaluation HOLDs). */
  compatibility: CompatibilityPolicy | null;
  approvalLimits: readonly ApprovalLimitRule[];
}

export interface PolicyIssue {
  path: string;
  code: string;
  message: string;
}

/** Policy-authoring validation path: structural and semantic checks without publishing anything. */
export function validateCompatibilityPolicy(
  body: unknown,
): { ok: true; policy: CompatibilityPolicy; issues: [] } | { ok: false; issues: PolicyIssue[] } {
  let wire: unknown;
  const first = z.safeEncode(CompatibilityPolicySchema, body as CompatibilityPolicy);
  if (first.success) wire = first.data;
  else wire = body; // accept already-wire bodies (string minor units) as well
  const r = z.safeDecode(CompatibilityPolicySchema, wire as z.input<typeof CompatibilityPolicySchema>);
  if (r.success) return { ok: true, policy: r.data, issues: [] };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
  };
}

/**
 * Roles the policy names as approver for `actionClass` at `siteId` for `amount` (approval-limit rows of kind
 * PLAN_ACTION, exact currency, amount within the bound). Only approver-capable roles count, so a misconfigured row
 * naming an engineer or operator never makes them an approver.
 */
export function policyApproverRoles(
  policy: GoverningPolicy,
  actionClass: 'POLICY_OVERRIDE' | 'STANDARD',
  siteId: string,
  amount: { amountMinor: bigint; currency: string },
): string[] {
  const roles = policy.approvalLimits
    .filter(
      (r) =>
        r.approvalKind === 'PLAN_ACTION' &&
        r.actionClass === actionClass &&
        APPROVER_CAPABLE_ROLES.includes(r.role) &&
        r.currency === amount.currency &&
        amount.amountMinor <= r.maxAmountMinor &&
        (r.siteIds === null || r.siteIds.includes(siteId)),
    )
    .map((r) => r.role);
  return [...new Set(roles)].sort();
}
