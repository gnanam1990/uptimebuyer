// Versioned recovery policy (FR-15, FR-21, INV-03). A revision is tenant-wide or site-scoped, effective-dated and
// immutable; the most specific revision in force applies (site over tenant). Evaluations pin the revision they used,
// so a later revision never rewrites a historical decision: an OPEN evaluation on an older revision is superseded by
// a new evaluation, a decided one stays as it was.
import { DomainError, SiteIdSchema, UtcInstantSchema, type SiteId } from '@uptimebuyer/contracts';
import {
  dbNow,
  humanActor,
  lockKey,
  recordAudit,
  tenantCommand,
  unavailable,
  type Db,
  type Queryable,
  type TenantContext,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { ms, newRecoveryId, parseInput, requireAt, validation } from './internal.js';

export const MILESTONE_TYPES = Object.freeze(['WORK_COMPLETED', 'PART_INSTALLED', 'TECHNICIAN_DEPARTED'] as const);
export type MilestoneType = (typeof MILESTONE_TYPES)[number];

export const RecoveryPolicySchema = z
  .strictObject({
    /** The policy-designated intervention-completion milestone that freezes the observation boundary. */
    completionMilestoneType: z.enum(MILESTONE_TYPES),
    milestoneSources: z
      .array(z.enum(['CMMS', 'AUTHORIZED_OPERATOR']))
      .min(1)
      .max(2),
    attestationRoles: z
      .array(z.enum(['operator', 'maintenance_approver', 'engineer']))
      .min(1)
      .max(3),
    requiredSignoffs: z
      .array(z.enum(['CMMS_WORK_ORDER', 'OPERATOR_ATTESTATION']))
      .min(1)
      .max(2),
    installedPartRequired: z.boolean(),
    maxBackdateMs: z.int().min(0).max(604_800_000),
    maxFutureSkewMs: z.int().min(0).max(300_000),
    stableWindowMs: z.int().min(60_000).max(604_800_000),
    maxGapMs: z.int().min(1_000).max(3_600_000),
    minSamples: z.int().min(2).max(100_000),
    maxTailAgeMs: z.int().min(1_000).max(3_600_000),
    maxObservationMs: z.int().min(60_000).max(2_592_000_000),
    lostSignalAfterMs: z.int().min(1_000).max(86_400_000),
    allowSimulatedInput: z.boolean(),
  })
  .refine((p) => p.maxObservationMs >= p.stableWindowMs, { path: ['maxObservationMs'] })
  .refine((p) => new Set(p.milestoneSources).size === p.milestoneSources.length, { path: ['milestoneSources'] })
  .refine((p) => new Set(p.requiredSignoffs).size === p.requiredSignoffs.length, { path: ['requiredSignoffs'] })
  .refine((p) => new Set(p.attestationRoles).size === p.attestationRoles.length, { path: ['attestationRoles'] });
export type RecoveryPolicyBody = z.input<typeof RecoveryPolicySchema>;

export interface PolicyRow {
  id: string;
  site_id: string | null;
  scope_key: string;
  revision: number;
  completion_milestone_type: MilestoneType;
  milestone_sources: ('CMMS' | 'AUTHORIZED_OPERATOR')[];
  attestation_roles: string[];
  required_signoffs: ('CMMS_WORK_ORDER' | 'OPERATOR_ATTESTATION')[];
  installed_part_required: boolean;
  max_backdate_ms: string;
  max_future_skew_ms: string;
  stable_window_ms: string;
  max_gap_ms: string;
  min_samples: number;
  max_tail_age_ms: string;
  max_observation_ms: string;
  lost_signal_after_ms: string;
  allow_simulated_input: boolean;
  effective_at: Date;
}

const PublishSchema = z.strictObject({
  siteId: SiteIdSchema.nullable(),
  body: RecoveryPolicySchema,
  effectiveAt: UtcInstantSchema.optional(),
});

export async function publishRecoveryPolicy(
  pool: Db,
  ctx: TenantContext,
  raw: { siteId: SiteId | string | null; body: RecoveryPolicyBody; effectiveAt?: string },
): Promise<{ recoveryPolicyRevisionId: string; revision: number; effectiveAt: string }> {
  const input = parseInput(PublishSchema, raw);
  const id = newRecoveryId('policyRevision');
  const meta = { action: 'recovery.policy.publish', resourceType: 'recovery_policy_revision', resourceId: id };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'recovery.policy_publish', input.siteId);
    const userId = humanActor(ctx);
    if (input.siteId) {
      const s = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.siteId]);
      if (s.rowCount !== 1) throw unavailable(meta, input.siteId, 'site');
    }
    const scope = input.siteId ?? 'TENANT';
    await lockKey(c, `recovery-policy:${ctx.tenantId}:${scope}`);
    const next = await c.query<{ n: number }>(
      `SELECT coalesce(max(revision), 0) + 1 AS n FROM recovery_policy_revisions WHERE tenant_id = $1 AND scope_key = $2`,
      [ctx.tenantId, scope],
    );
    const revision = next.rows[0]!.n;
    const now = await dbNow(c);
    const effectiveAt = input.effectiveAt ?? now;
    if (ms(effectiveAt) < ms(now) - 1000) throw validation('RETROACTIVE_POLICY');
    const b = input.body;
    const bodyDigest = canonicalDigest('recovery-policy', 1, { tenantId: ctx.tenantId, scope, revision, body: b });
    await c.query(
      `INSERT INTO recovery_policy_revisions (tenant_id, id, site_id, scope_key, revision, completion_milestone_type,
         milestone_sources, attestation_roles, required_signoffs, installed_part_required, max_backdate_ms,
         max_future_skew_ms, stable_window_ms, max_gap_ms, min_samples, max_tail_age_ms, max_observation_ms,
         lost_signal_after_ms, allow_simulated_input, body_digest, effective_at, published_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        ctx.tenantId,
        id,
        input.siteId,
        scope,
        revision,
        b.completionMilestoneType,
        b.milestoneSources,
        b.attestationRoles,
        b.requiredSignoffs,
        b.installedPartRequired,
        b.maxBackdateMs,
        b.maxFutureSkewMs,
        b.stableWindowMs,
        b.maxGapMs,
        b.minSamples,
        b.maxTailAgeMs,
        b.maxObservationMs,
        b.lostSignalAfterMs,
        b.allowSimulatedInput,
        bodyDigest,
        effectiveAt,
        userId,
      ],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { scope, revision } });
    return { recoveryPolicyRevisionId: id, revision, effectiveAt: new Date(ms(effectiveAt)).toISOString() };
  });
}

/** The recovery policy in force at `atMs` (default: database now) for a site: site-specific over tenant-wide. */
export async function effectivePolicy(
  q: Queryable,
  tenantId: string,
  siteId: string,
  at?: Date | string,
): Promise<PolicyRow | undefined> {
  const { rows } = await q.query<PolicyRow>(
    `SELECT * FROM recovery_policy_revisions
      WHERE tenant_id = $1 AND scope_key IN ($2, 'TENANT') AND effective_at <= coalesce($3::timestamptz, clock_timestamp())
      ORDER BY (scope_key = $2) DESC, effective_at DESC LIMIT 1`,
    [tenantId, siteId, at ?? null],
  );
  return rows[0];
}

export async function loadPolicy(q: Queryable, tenantId: string, id: string): Promise<PolicyRow> {
  const { rows } = await q.query<PolicyRow>(
    `SELECT * FROM recovery_policy_revisions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new DomainError('INTERNAL', 'Pinned recovery policy is missing.');
  return rows[0];
}

export const num = (v: string | number | bigint) => Number(v);
