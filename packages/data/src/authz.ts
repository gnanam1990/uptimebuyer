// RBAC and approval authority (FR-10 shared layer, FR-24, INV-15, NFR-05). Pure, deny-by-default decision over a
// server-issued TenantContext: principal kind, role, tenant, site, action, approval kind, action class and an amount
// bound (integer minor units + currency) taken from the effective AUTHORITY policy revision. No role is global.
import {
  CurrencyCodeSchema,
  MinorUnitsSchema,
  SiteIdSchema,
  type CurrencyCode,
  type Money,
  type SiteId,
} from '@uptimebuyer/contracts';
import { CompatibilityPolicySchema, type CompatibilityPolicy } from '@uptimebuyer/domain';
import { z } from 'zod';
import { Denial, notPermitted } from './command.js';
import {
  assertTenantContext,
  HUMAN_ROLES,
  ROLES,
  type PrincipalKind,
  type Role,
  type TenantContext,
} from './context.js';

export const APPROVAL_KINDS = Object.freeze(['PLAN_ACTION', 'BUDGET_ADJUSTMENT'] as const);
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const ACTION_CLASSES = Object.freeze([
  'STANDARD',
  'SUBSTITUTE',
  'NON_EXACT_MATCH',
  'SAFETY_CRITICAL',
  'POLICY_OVERRIDE',
] as const);
export type ActionClass = (typeof ACTION_CLASSES)[number];
/** INV-15: these classes always require a named engineer, whatever the policy text says. */
export const ENGINEERING_ACTION_CLASSES = Object.freeze(['SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL'] as const);

type SiteRule = 'REQUIRED' | 'OPTIONAL' | 'TENANT';
interface ActionSpec {
  readonly principals: readonly PrincipalKind[];
  readonly roles: readonly Role[];
  /** REQUIRED: a site must be named. OPTIONAL: null targets the tenant level. TENANT: needs a tenant-wide grant. */
  readonly site: SiteRule;
  readonly approvalKind?: ApprovalKind;
  readonly actionClasses?: readonly ActionClass[];
  /** Outbox/job worker contexts may perform this (registry reads only). */
  readonly workerAllowed?: boolean;
}

const human = (roles: readonly Role[], site: SiteRule, extra: Partial<ActionSpec> = {}): ActionSpec => ({
  principals: ['HUMAN'],
  roles,
  site,
  ...extra,
});

export const ACTIONS = Object.freeze({
  'registry.read': human(HUMAN_ROLES, 'OPTIONAL', { workerAllowed: true }),
  'registry.write': human(['admin'], 'OPTIONAL'),
  'incident.acknowledge': human(['operator'], 'REQUIRED'),
  /** Incident projections and timelines at the incident's site (M04); outbox/job workers may read. */
  'incident.read': human(HUMAN_ROLES, 'REQUIRED', { workerAllowed: true }),
  /** Assignment, escalation, pause/resume, reopen and deadline commands at the incident's site (M04). */
  'incident.manage': human(['operator'], 'REQUIRED'),
  /** Authorized manual fault report at the asset's site (M04, T-020). */
  'incident.report': human(['operator'], 'REQUIRED'),
  /** Server-side incident engine: rule evaluation, system transitions, deadline sweep (M04). */
  'incident.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  'evidence.submit': human(['operator'], 'OPTIONAL'),
  /** Publishing or withdrawing manufacturer (OEM) library documents: tenant-wide curators only (M05 hardening). */
  'evidence.library_write': human(['operator', 'admin'], 'TENANT'),
  /** Evidence revisions, retrieval, search and citation re-opening at the incident's site (M05); workers may read. */
  'evidence.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Server-side evidence engine: automated evidence revisions and bounded reasoning runs (M05). */
  'evidence.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Register a revision-bound candidate action for compatibility evaluation at the incident's site (M06). */
  'compatibility.register': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Read candidates, decisions and authority records at the incident's site (M06); workers may read. */
  'compatibility.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Deterministic server engine: evaluation, executability checks, policy activation and invalidation (M06). */
  'compatibility.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** INV-15 named-engineer authority for substitutes, non-exact matches and safety-critical work (M06). */
  'compatibility.engineer_exception': human(['engineer'], 'REQUIRED'),
  /** Approver-capable humans; the governing policy revision must also name the actor's role (M06). */
  'compatibility.policy_approval': human(['maintenance_approver', 'finance_approver', 'admin'], 'REQUIRED'),
  /** Policy revision history, effective windows and activations (FR-21). */
  'policy.history': human(['admin', 'auditor'], 'TENANT'),
  'approval.plan_action': human(['maintenance_approver'], 'REQUIRED', {
    approvalKind: 'PLAN_ACTION',
    actionClasses: ['STANDARD', 'POLICY_OVERRIDE'],
  }),
  'approval.budget_adjustment': human(['finance_approver'], 'REQUIRED', {
    approvalKind: 'BUDGET_ADJUSTMENT',
    actionClasses: ['STANDARD'],
  }),
  'approval.engineering_exception': human(['engineer'], 'REQUIRED', {
    approvalKind: 'PLAN_ACTION',
    actionClasses: ENGINEERING_ACTION_CLASSES,
  }),
  'policy.publish': human(['admin'], 'TENANT'),
  /** Execute a privacy request (erasure/export) for the tenant (M13, FR-23). */
  'privacy.execute': human(['admin'], 'TENANT'),
  /** Run the retention sweep for the tenant: an administrator or the tenant's worker identity (M13, FR-23). */
  'privacy.retention_sweep': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['admin', 'worker'],
    site: 'TENANT',
    workerAllowed: true,
  },
  'role.assign': human(['admin'], 'TENANT'),
  'provider_account.manage': human(['admin'], 'TENANT'),
  'audit.read': human(['admin', 'auditor'], 'TENANT'),
  'audit.export': human(['admin', 'auditor'], 'TENANT'),
  'evidence.export': human(['admin', 'auditor'], 'TENANT'),
  /** Telemetry samples, gaps, disclosures and health projections at a device's site (M03; M04 reads as a worker). */
  'telemetry.read': human(HUMAN_ROLES, 'REQUIRED', { workerAllowed: true }),
  'telemetry.ingest': { principals: ['DEVICE'], roles: ['device'], site: 'REQUIRED' },
  'job.execute': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT' },
  'outbox.dispatch': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT' },
  'provider_callback.ingest': { principals: ['INTEGRATION'], roles: ['integration'], site: 'TENANT' },
  /** Provider searches, candidates, contact requests/attempts and quotes at the incident's site (M07). */
  'provider.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Run a bounded provider discovery search for an incident (M07). */
  'provider.search': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Prepare/execute contact requests and record consent for them (M07). Paid execution also needs an approval. */
  'provider.contact': human(['operator'], 'REQUIRED'),
  /** Record a normalized quote or an observed communication for a contact request (M07). */
  'provider.quote': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Server-side provider engine: dispatch, reconciliation sweeps, broker results, model excerpts (M07). */
  'provider.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Redacted communication/transcript display at the incident's site (INV-13 role scope; M07). */
  'provider.communication.read': human(
    ['operator', 'maintenance_approver', 'engineer', 'admin', 'auditor'],
    'REQUIRED',
  ),
  /** Redacted communication export with declared omissions (M07). */
  'provider.communication.export': human(['admin', 'auditor'], 'TENANT'),
  /** Privacy erasure of raw communication content, refused under legal hold (M07, FR-23). */
  'provider.communication.erase': human(['admin'], 'TENANT'),
  /** Link a discovered provider to an approved-vendor registry record (separate from discovery; M07). */
  'provider.vendor_link': human(['admin'], 'TENANT'),
  /** Read recovery plans, their exposed cost inputs and approval requests at the incident's site (M08). */
  'planning.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Deterministic planning engine: build plans, prepare approval requests, revalidate/invalidate (M08). */
  'planning.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Publish a versioned tenant risk estimate (tenant-wide needs a tenant-wide grant; FR-09, FR-21). */
  'planning.risk_publish': human(['admin'], 'OPTIONAL'),
  /** Execution authorities, Kite-session outcomes, budget projections, intents and attempts at the site (M09). */
  'commerce.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Materialize the one immutable execution authority of an already-recorded paid approval (M09). */
  'commerce.authority_issue': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'maintenance_approver', 'finance_approver', 'worker'],
    site: 'REQUIRED',
  },
  /** Suspend, reactivate or revoke an execution authority (append-only lifecycle; M09). */
  'commerce.authority_manage': human(['maintenance_approver', 'finance_approver', 'admin'], 'REQUIRED'),
  /** Create the commercial intent of an authorized action (plan action or paid contact; M09). */
  'commerce.intent_create': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
  },
  /** Apply a signed BUDGET_ADJUSTMENT approval as an AUTHORITY_CREDIT/AUTHORITY_DEBIT movement (M09). */
  'commerce.budget_adjust': human(['finance_approver'], 'REQUIRED'),
  /** Record a manual resolution of an UNKNOWN effect from reviewed authoritative evidence (M09, INV-08). */
  'commerce.manual_resolve': human(['finance_approver', 'admin'], 'REQUIRED'),
  /** The exclusive broker's own server engine: linearization, reconciliation and decision gates (M09). */
  'commerce.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Purchase orders, service jobs, observations, change proposals and the fulfillment gate at the site (M10). */
  'orders.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Request (create) the order/job of an issued authority, dispatch it to the broker and reconcile it (M10). */
  'orders.request': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
  },
  /** Record receiving inspection / work verification (VERIFIED or DISPUTED) of a delivered order or completed job. */
  'orders.verify': human(['operator'], 'REQUIRED'),
  /** Revoke an order/job intent (cancellation request; serializes with the broker linearization; M10). */
  'orders.manage': human(['maintenance_approver', 'finance_approver', 'admin'], 'REQUIRED'),
  /** Server-side order engine: apply provider observations, poll, mirror broker results, drive incidents (M10). */
  'orders.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Recovery evidence, milestones, evaluations, closeouts, metrics and CMMS updates at the incident's site (M11). */
  'recovery.read': {
    principals: ['HUMAN', 'SERVICE'],
    roles: [...HUMAN_ROLES, 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /**
   * Record post-intervention evidence at the incident's site (M11): operators record notes/technician records and,
   * when the recovery policy names their role, attestations and installed-part scans; workers record provider,
   * receipt and model facts (always labelled, never authority).
   */
  'recovery.evidence': {
    principals: ['HUMAN', 'SERVICE'],
    roles: ['operator', 'worker'],
    site: 'REQUIRED',
    workerAllowed: true,
  },
  /** Dispute recorded recovery evidence (fails an open evaluation / reopens a closed incident; M11). */
  'recovery.dispute': human(['operator'], 'REQUIRED'),
  /** Deterministic recovery engine: milestones, assessment/closeout, lost-signal sweep, CMMS writes (M11). */
  'recovery.engine': { principals: ['SERVICE'], roles: ['worker'], site: 'TENANT', workerAllowed: true },
  /** Publish a versioned recovery policy (tenant-wide needs a tenant-wide grant; FR-21, M11). */
  'recovery.policy_publish': human(['admin'], 'OPTIONAL'),
  /** Bind or revoke a CMMS integration for a site (M11). */
  'recovery.cmms_manage': human(['admin'], 'OPTIONAL'),
  /** Signed CMMS record ingestion by an authenticated CMMS integration identity (M11). */
  'recovery.cmms_ingest': { principals: ['INTEGRATION'], roles: ['integration'], site: 'TENANT' },
} as const satisfies Record<string, ActionSpec>);
export type ActionName = keyof typeof ACTIONS;

export const ApprovalLimitRuleSchema = z.strictObject({
  approvalKind: z.enum(APPROVAL_KINDS),
  actionClass: z.enum(ACTION_CLASSES),
  role: z.enum(ROLES),
  currency: CurrencyCodeSchema,
  maxAmountMinor: MinorUnitsSchema,
  siteIds: z.array(SiteIdSchema).max(1000).nullable(),
});
/**
 * The AUTHORITY policy body. `compatibility` (M06, FR-21) is the optional compatibility/safety section: safety
 * classes, authoritative sources, thresholds and auto-permit bounds. Approver roles for overrides and out-of-bounds
 * amounts are named by `approvalLimits`. A revision without the section makes every compatibility evaluation HOLD.
 */
/**
 * M13 separation of duties (SECURITY.md §4, UI-SPEC §10). `spend`: for an approval in a listed currency at or above
 * `minAmountMinor`, the execution authority must be issued by a different human holding finance_approver, and budget
 * adjustments by a finance approver who neither approved nor issued it. `dualApprovalPolicyKeys`: revisions of these
 * policy keys are published only through a second administrator's approval of a proposal.
 */
export const SeparationOfDutiesSchema = z.strictObject({
  spend: z
    .array(z.strictObject({ currency: CurrencyCodeSchema, minAmountMinor: MinorUnitsSchema }))
    .max(20)
    .optional(),
  dualApprovalPolicyKeys: z
    .array(z.enum(['AUTHORITY', 'RETENTION']))
    .max(2)
    .optional(),
});
export type SeparationOfDuties = {
  readonly spend?: readonly { readonly currency: CurrencyCode; readonly minAmountMinor: bigint }[];
  readonly dualApprovalPolicyKeys?: readonly ('AUTHORITY' | 'RETENTION')[];
};

export const AuthorityPolicySchema = z.strictObject({
  approvalLimits: z.array(ApprovalLimitRuleSchema).max(500),
  compatibility: CompatibilityPolicySchema.optional(),
  separationOfDuties: SeparationOfDutiesSchema.optional(),
});

/** Does the policy's spend SoD rule cover this approval amount? */
export function spendSeparationRequired(policy: AuthorityPolicy | undefined, amount: Money): boolean {
  return (policy?.separationOfDuties?.spend ?? []).some(
    (r) => r.currency === amount.currency && amount.amountMinor >= r.minAmountMinor,
  );
}
export type AuthorityPolicy = {
  readonly approvalLimits: readonly {
    readonly approvalKind: ApprovalKind;
    readonly actionClass: ActionClass;
    readonly role: Role;
    readonly currency: CurrencyCode;
    readonly maxAmountMinor: bigint;
    readonly siteIds: readonly SiteId[] | null;
  }[];
  readonly compatibility?: CompatibilityPolicy;
  readonly separationOfDuties?: SeparationOfDuties;
};

export interface AuthorizationRequest {
  readonly action: ActionName;
  readonly siteId?: SiteId | null;
  readonly approvalKind?: ApprovalKind;
  readonly actionClass?: ActionClass;
  readonly amount?: Money;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly role: Role | null; readonly reasonCode: 'ALLOWED' }
  | { readonly allowed: false; readonly reasonCode: string };

const deny = (reasonCode: string): AuthorizationDecision => ({ allowed: false, reasonCode });

export function authorize(
  ctx: TenantContext,
  req: AuthorizationRequest,
  policy?: AuthorityPolicy,
): AuthorizationDecision {
  assertTenantContext(ctx);
  const spec: ActionSpec | undefined = Object.hasOwn(ACTIONS, req.action)
    ? (ACTIONS as Record<string, ActionSpec>)[req.action]
    : undefined;
  if (!spec) return deny('UNKNOWN_ACTION');
  const p = ctx.principal;
  if (p.kind === 'WORKER')
    return spec.workerAllowed
      ? { allowed: true, role: null, reasonCode: 'ALLOWED' }
      : deny('PRINCIPAL_KIND_NOT_PERMITTED');
  if (!spec.principals.includes(p.kind)) return deny('PRINCIPAL_KIND_NOT_PERMITTED');

  if (spec.approvalKind !== undefined) {
    if (req.approvalKind !== spec.approvalKind) return deny('APPROVAL_KIND_MISMATCH');
    if (req.actionClass === undefined || !spec.actionClasses?.includes(req.actionClass))
      return deny('ACTION_CLASS_MISMATCH');
  }

  const requestedSite = req.siteId ?? null;
  if (spec.site === 'REQUIRED' && requestedSite === null) return deny('SITE_REQUIRED');
  const target = spec.site === 'TENANT' ? null : requestedSite;

  const roleGrants = ctx.grants.filter((g) => spec.roles.includes(g.role));
  if (roleGrants.length === 0) return deny('ROLE_NOT_GRANTED');
  const covering = roleGrants.filter((g) => g.siteId === null || (target !== null && g.siteId === target));
  if (covering.length === 0) return deny('SITE_OUT_OF_SCOPE');
  if (spec.approvalKind === undefined) return { allowed: true, role: covering[0]!.role, reasonCode: 'ALLOWED' };

  // Approval authority: an exact policy rule for this kind, class, role, site and currency must cover the amount.
  if (!req.amount) return deny('AMOUNT_REQUIRED');
  if (typeof req.amount.amountMinor !== 'bigint' || req.amount.amountMinor < 0n) return deny('AMOUNT_INVALID');
  if (!policy) return deny('POLICY_REQUIRED');
  const amount = req.amount;
  const heldRoles = new Set(covering.map((g) => g.role));
  const rule = policy.approvalLimits.find(
    (r) =>
      r.approvalKind === req.approvalKind &&
      r.actionClass === req.actionClass &&
      spec.roles.includes(r.role) &&
      heldRoles.has(r.role) &&
      r.currency === amount.currency &&
      amount.amountMinor <= r.maxAmountMinor &&
      (r.siteIds === null || (target !== null && r.siteIds.includes(target))),
  );
  if (!rule) return deny('NO_MATCHING_AUTHORITY_RULE');
  return { allowed: true, role: rule.role, reasonCode: 'ALLOWED' };
}

/** Authorize inside a tenant command; a denial is thrown as an audited `Denial` (FORBIDDEN). */
export function requireAuthorized(
  ctx: TenantContext,
  req: AuthorizationRequest,
  policy?: AuthorityPolicy,
  resource: { type?: string; id?: string | null } = {},
): Extract<AuthorizationDecision, { allowed: true }> {
  const decision = authorize(ctx, req, policy);
  if (!decision.allowed)
    throw new Denial(notPermitted(decision.reasonCode), {
      action: req.action,
      resourceType: resource.type ?? null,
      resourceId: resource.id ?? null,
      reasonCode: decision.reasonCode,
    });
  return decision;
}

/** Sites the context may read: null = every site in the tenant. */
export function readableSites(ctx: TenantContext): SiteId[] | null {
  if (authorize(ctx, { action: 'registry.read', siteId: null }).allowed) return null;
  return [
    ...new Set(
      ctx.grants
        .filter((g) => g.siteId !== null && authorize(ctx, { action: 'registry.read', siteId: g.siteId }).allowed)
        .map((g) => g.siteId as SiteId),
    ),
  ];
}
