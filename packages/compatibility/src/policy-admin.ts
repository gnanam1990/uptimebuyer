// Versioned policy administration, M06 portion of FR-21: the compatibility/safety section (safety classes,
// authoritative sources, thresholds, auto-permit bounds) travels inside an immutable effective-dated AUTHORITY
// policy revision whose approval-limit rows name the approver roles. Publication validates the draft, audits, and
// (when effective immediately) activates it; a future-dated revision is activated by the engine's sweep once in force.
import type { UtcInstant } from '@uptimebuyer/contracts';
import {
  AuthorityPolicySchema,
  approvePolicyProposal,
  publishPolicyRevision,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type AuthorityPolicy,
  type Db,
  type RegistrySource,
  type TenantContext,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { invalid, isoOf } from './internal.js';
import { activateEffectivePolicy, type ActivationResult } from './invalidation.js';

export interface PolicyIssue {
  path: string;
  code: string;
  message: string;
}

/** Policy-authoring validation path: structural and semantic checks of a whole AUTHORITY body, nothing published. */
export function validatePolicyDraft(body: unknown): { ok: boolean; issues: PolicyIssue[] } {
  const enc = z.safeEncode(AuthorityPolicySchema, body as z.output<typeof AuthorityPolicySchema>);
  const wire = enc.success ? enc.data : body;
  const r = z.safeDecode(AuthorityPolicySchema, wire as z.input<typeof AuthorityPolicySchema>);
  const issues: PolicyIssue[] = r.success
    ? []
    : r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
  if (r.success && !r.data.compatibility)
    issues.push({ path: 'compatibility', code: 'required', message: 'The compatibility section is required.' });
  return { ok: issues.length === 0, issues };
}

export async function publishCompatibilityPolicy(
  pool: Db,
  ctx: TenantContext,
  input: { body: AuthorityPolicy; effectiveAt?: UtcInstant; source: RegistrySource },
): Promise<{
  policyRevisionId: string;
  revision: number;
  effectiveAt: UtcInstant;
  activation: ActivationResult | null;
}> {
  const v = validatePolicyDraft(input?.body);
  if (!v.ok) throw invalid('INVALID_POLICY_BODY', { issues: v.issues.slice(0, 50) });
  const sites = [...new Set(input.body.compatibility!.autoPermit.flatMap((r) => r.siteIds ?? []))];
  const meta = { action: 'policy.publish', resourceType: 'policy_revision', resourceId: null };
  await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: 'policy_revision' });
    if (sites.length === 0) return;
    const s = await c.query(`SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1 AND id = ANY($2)`, [
      ctx.tenantId,
      sites,
    ]);
    if (s.rows[0].n !== sites.length) throw unavailable(meta, null, 'site');
  });
  const r = await publishPolicyRevision(pool, ctx, {
    policyKey: 'AUTHORITY',
    body: input.body,
    ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
    source: input.source,
  });
  const act = await activateEffectivePolicy(pool, ctx);
  return { ...r, activation: act.policyRevisionId === r.policyRevisionId && act.activated ? act : null };
}

/**
 * M13 dual approval: a second administrator approves a proposed AUTHORITY revision (M02 proposal flow); when it is
 * effective immediately its compatibility section is activated exactly as a direct publication would be.
 */
export async function approveCompatibilityPolicyProposal(
  pool: Db,
  ctx: TenantContext,
  policyChangeProposalId: string,
): Promise<{
  policyRevisionId: string;
  revision: number;
  effectiveAt: UtcInstant;
  activation: ActivationResult | null;
}> {
  const r = await approvePolicyProposal(pool, ctx, { policyChangeProposalId });
  if (r.policyKey !== 'AUTHORITY') return { ...r, activation: null };
  const act = await activateEffectivePolicy(pool, ctx);
  return { ...r, activation: act.policyRevisionId === r.policyRevisionId && act.activated ? act : null };
}

export interface PolicyHistoryEntry {
  policyRevisionId: string;
  revision: number;
  ruleSet: string | null;
  bodyDigest: string;
  effectiveAt: UtcInstant;
  effectiveUntil: UtcInstant | null;
  publishedAt: UtcInstant;
  publishedBy: string;
  activatedAt: UtcInstant | null;
  current: boolean;
}

/** Every AUTHORITY revision with its effective window, publisher and activation (audit history, FR-21). */
export async function listPolicyHistory(pool: Db, ctx: TenantContext): Promise<PolicyHistoryEntry[]> {
  const meta = { action: 'policy.history', resourceType: 'policy', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.history', siteId: null });
    const { rows } = await c.query(
      `SELECT r.id, r.revision, r.body -> 'compatibility' ->> 'ruleSet' AS rule_set, r.body_digest, r.effective_at,
              r.published_at, r.published_by_user_id, a.activated_at,
              lead(r.effective_at) OVER (ORDER BY r.effective_at) AS effective_until,
              r.effective_at <= clock_timestamp() AND coalesce(lead(r.effective_at) OVER (ORDER BY r.effective_at) > clock_timestamp(), true) AS current
         FROM policy_revisions r
         JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id AND p.policy_key = 'AUTHORITY'
         LEFT JOIN compatibility_policy_activations a ON a.tenant_id = r.tenant_id AND a.policy_revision_id = r.id
        WHERE r.tenant_id = $1
        ORDER BY r.effective_at`,
      [ctx.tenantId],
    );
    return rows.map((r) => ({
      policyRevisionId: r.id,
      revision: r.revision,
      ruleSet: r.rule_set ?? null,
      bodyDigest: r.body_digest,
      effectiveAt: isoOf(r.effective_at)!,
      effectiveUntil: isoOf(r.effective_until),
      publishedAt: isoOf(r.published_at)!,
      publishedBy: r.published_by_user_id,
      activatedAt: isoOf(r.activated_at),
      current: r.current === true,
    }));
  });
}
