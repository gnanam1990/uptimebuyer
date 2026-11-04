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
export const AuthorityPolicySchema = z.strictObject({ approvalLimits: z.array(ApprovalLimitRuleSchema).max(500) });
export type AuthorityPolicy = {
  readonly approvalLimits: readonly {
    readonly approvalKind: ApprovalKind;
    readonly actionClass: ActionClass;
    readonly role: Role;
    readonly currency: CurrencyCode;
    readonly maxAmountMinor: bigint;
    readonly siteIds: readonly SiteId[] | null;
  }[];
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
