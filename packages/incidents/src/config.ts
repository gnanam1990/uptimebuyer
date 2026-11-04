// Versioned incident configuration (FR-21 for incidents): immutable operating-procedure revisions (SOP deadline rule,
// basis, permitted adjustments, initial owner) and immutable incident-rule revisions (threshold/window/quorum,
// stale-data behaviour, fault window, watch and recovery windows, procedure key). Publishing appends a revision;
// nothing is edited and nothing takes effect retroactively. Tenant administrators only.
import { SiteIdSchema, AssetIdSchema, UserIdSchema, UtcInstantSchema, type UserId } from '@uptimebuyer/contracts';
import {
  dbNow,
  humanActor,
  isoNN,
  lockKey,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type Queryable,
  type TenantContext,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { deny, newIncidentDataId, ownerEligibility, parseInput, validation } from './internal.js';

const KEY = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const CODE = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const msBetween = (min: number, max: number) => z.int().min(min).max(max);
const DAY = 86_400_000;

export const PublishProcedureInputSchema = z.strictObject({
  procedureKey: KEY,
  deadlineKind: z.enum(['RESPONSE', 'CONTAINMENT']),
  deadlineBasis: z.enum(['TRIGGER_EVENT_AT', 'OPENED_AT']),
  responseDeadlineMs: msBetween(60_000, 7 * DAY),
  pauseAllowed: z.boolean(),
  maxExtensionMs: msBetween(0, 7 * DAY),
  adjustRole: z.enum(['operator', 'maintenance_approver', 'engineer', 'admin']),
  initialAssigneeUserId: UserIdSchema,
  timezoneBasis: z.enum(['SITE_LOCAL', 'UTC']),
  effectiveAt: UtcInstantSchema.optional(),
});
export type PublishProcedureInput = Omit<z.input<typeof PublishProcedureInputSchema>, 'initialAssigneeUserId'> & {
  initialAssigneeUserId: UserId | string;
};

export const PublishIncidentRuleInputSchema = z
  .strictObject({
    ruleKey: KEY,
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
    siteId: SiteIdSchema.nullable(),
    assetId: AssetIdSchema.nullable(),
    channelKind: z.enum(['TEMPERATURE', 'CURRENT', 'POWER', 'DOOR']),
    comparator: z.enum(['ABOVE', 'BELOW']),
    thresholdInt: z.int().min(-1_000_000_000).max(1_000_000_000),
    hysteresisInt: z.int().min(0).max(1_000_000_000),
    durationMs: msBetween(0, DAY),
    minSamples: z.int().min(1).max(1000),
    quorumChannels: z.int().min(1).max(16),
    maxGapMs: msBetween(1000, 3_600_000),
    maxEvaluationLagMs: msBetween(1000, 3_600_000),
    staleBehavior: z.enum(['HOLD', 'ESCALATE_ACTIVE']),
    faultWindowKey: KEY,
    faultFamily: CODE,
    urgency: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
    watchWindowMs: msBetween(0, 30 * DAY),
    recoveryWindowMs: msBetween(60_000, 7 * DAY),
    procedureKey: KEY,
    effectiveAt: UtcInstantSchema.optional(),
  })
  .refine((r) => r.assetId === null || r.siteId !== null, { message: 'An asset-scoped rule names its site.' });
export type PublishIncidentRuleInput = z.input<typeof PublishIncidentRuleInputSchema>;

export interface ProcedureRevisionRecord {
  procedureRevisionId: string;
  procedureKey: string;
  revision: number;
  deadlineKind: 'RESPONSE' | 'CONTAINMENT';
  deadlineBasis: 'TRIGGER_EVENT_AT' | 'OPENED_AT';
  responseDeadlineMs: number;
  pauseAllowed: boolean;
  maxExtensionMs: number;
  adjustRole: 'operator' | 'maintenance_approver' | 'engineer' | 'admin';
  initialAssigneeUserId: string;
  timezoneBasis: 'SITE_LOCAL' | 'UTC';
  bodyDigest: string;
  effectiveAt: string;
}

export interface RuleRevisionRecord {
  ruleRevisionId: string;
  ruleKey: string;
  revision: number;
  status: 'ACTIVE' | 'RETIRED';
  siteId: string | null;
  assetId: string | null;
  channelKind: 'TEMPERATURE' | 'CURRENT' | 'POWER' | 'DOOR';
  comparator: 'ABOVE' | 'BELOW';
  thresholdInt: number;
  hysteresisInt: number;
  durationMs: number;
  minSamples: number;
  quorumChannels: number;
  maxGapMs: number;
  maxEvaluationLagMs: number;
  staleBehavior: 'HOLD' | 'ESCALATE_ACTIVE';
  faultWindowKey: string;
  faultFamily: string;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  watchWindowMs: number;
  recoveryWindowMs: number;
  procedureKey: string;
  bodyDigest: string;
  effectiveAt: string;
}

export function toProcedure(r: Record<string, unknown>): ProcedureRevisionRecord {
  return {
    procedureRevisionId: r.id as string,
    procedureKey: r.procedure_key as string,
    revision: r.revision as number,
    deadlineKind: r.deadline_kind as ProcedureRevisionRecord['deadlineKind'],
    deadlineBasis: r.deadline_basis as ProcedureRevisionRecord['deadlineBasis'],
    responseDeadlineMs: Number(r.response_deadline_ms),
    pauseAllowed: r.pause_allowed as boolean,
    maxExtensionMs: Number(r.max_extension_ms),
    adjustRole: r.adjust_role as ProcedureRevisionRecord['adjustRole'],
    initialAssigneeUserId: r.initial_assignee_user_id as string,
    timezoneBasis: r.timezone_basis as ProcedureRevisionRecord['timezoneBasis'],
    bodyDigest: r.body_digest as string,
    effectiveAt: isoNN(r.effective_at as Date),
  };
}

export function toRule(r: Record<string, unknown>): RuleRevisionRecord {
  return {
    ruleRevisionId: r.id as string,
    ruleKey: r.rule_key as string,
    revision: r.revision as number,
    status: r.status as RuleRevisionRecord['status'],
    siteId: (r.site_id as string | null) ?? null,
    assetId: (r.asset_id as string | null) ?? null,
    channelKind: r.channel_kind as RuleRevisionRecord['channelKind'],
    comparator: r.comparator as RuleRevisionRecord['comparator'],
    thresholdInt: Number(r.threshold_int),
    hysteresisInt: Number(r.hysteresis_int),
    durationMs: Number(r.duration_ms),
    minSamples: r.min_samples as number,
    quorumChannels: r.quorum_channels as number,
    maxGapMs: Number(r.max_gap_ms),
    maxEvaluationLagMs: Number(r.max_evaluation_lag_ms),
    staleBehavior: r.stale_behavior as RuleRevisionRecord['staleBehavior'],
    faultWindowKey: r.fault_window_key as string,
    faultFamily: r.fault_family as string,
    urgency: r.urgency as RuleRevisionRecord['urgency'],
    watchWindowMs: Number(r.watch_window_ms),
    recoveryWindowMs: Number(r.recovery_window_ms),
    procedureKey: r.procedure_key as string,
    bodyDigest: r.body_digest as string,
    effectiveAt: isoNN(r.effective_at as Date),
  };
}

async function effectiveFrom(c: Queryable, now: string, requested: string | undefined): Promise<string> {
  const effectiveAt = requested ?? now;
  if (Date.parse(effectiveAt) < Date.parse(now) - 1000) throw validation('RETROACTIVE_REVISION');
  void c;
  return effectiveAt;
}

export async function publishOperatingProcedure(
  pool: Db,
  ctx: TenantContext,
  raw: PublishProcedureInput,
): Promise<{ procedureRevisionId: string; revision: number; effectiveAt: string; bodyDigest: string }> {
  const input = parseInput(PublishProcedureInputSchema, raw, 'INVALID_PROCEDURE');
  const procedureRevisionId = newIncidentDataId('procedureRevision');
  const meta = {
    action: 'incident.procedure.publish',
    resourceType: 'operating_procedure_revision',
    resourceId: procedureRevisionId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: meta.resourceType });
    const owner = await ownerEligibility(c, ctx.tenantId, input.initialAssigneeUserId, null);
    if (owner === 'NOT_MEMBER') throw unavailable(meta, input.initialAssigneeUserId, 'user');
    if (owner === 'NO_ROLE') throw deny(meta, 'ASSIGNEE_NOT_ELIGIBLE');
    await lockKey(c, `incident-procedure:${ctx.tenantId}:${input.procedureKey}`);
    const next = await c.query<{ n: number }>(
      `SELECT coalesce(max(revision), 0) + 1 AS n FROM operating_procedure_revisions WHERE tenant_id = $1 AND procedure_key = $2`,
      [ctx.tenantId, input.procedureKey],
    );
    const revision = next.rows[0]!.n;
    const effectiveAt = await effectiveFrom(c, await dbNow(c), input.effectiveAt);
    const { effectiveAt: _e, ...body } = input;
    const bodyDigest = canonicalDigest('incident-procedure', 1, { tenantId: ctx.tenantId, revision, ...body });
    await c.query(
      `INSERT INTO operating_procedure_revisions (tenant_id, id, procedure_key, revision, deadline_kind, deadline_basis,
         response_deadline_ms, pause_allowed, max_extension_ms, adjust_role, initial_assignee_user_id, timezone_basis,
         body_digest, effective_at, published_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        ctx.tenantId,
        procedureRevisionId,
        input.procedureKey,
        revision,
        input.deadlineKind,
        input.deadlineBasis,
        input.responseDeadlineMs,
        input.pauseAllowed,
        input.maxExtensionMs,
        input.adjustRole,
        input.initialAssigneeUserId,
        input.timezoneBasis,
        bodyDigest,
        effectiveAt,
        humanActor(ctx),
      ],
    );
    await recordAudit(c, ctx, {
      ...meta,
      result: 'SUCCEEDED',
      metadata: { procedureKey: input.procedureKey, revision },
    });
    return { procedureRevisionId, revision, effectiveAt, bodyDigest };
  });
}

export async function publishIncidentRule(
  pool: Db,
  ctx: TenantContext,
  raw: PublishIncidentRuleInput,
): Promise<{ ruleRevisionId: string; revision: number; effectiveAt: string; bodyDigest: string }> {
  const input = parseInput(PublishIncidentRuleInputSchema, raw, 'INVALID_INCIDENT_RULE');
  const ruleRevisionId = newIncidentDataId('ruleRevision');
  const meta = { action: 'incident.rule.publish', resourceType: 'incident_rule_revision', resourceId: ruleRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: meta.resourceType });
    if (input.siteId !== null) {
      const s = await c.query(
        `SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2
           AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM assets WHERE tenant_id = $1 AND site_id = $2 AND id = $3))`,
        [ctx.tenantId, input.siteId, input.assetId],
      );
      if (s.rowCount !== 1) throw unavailable(meta, input.assetId ?? input.siteId, input.assetId ? 'asset' : 'site');
    }
    const now = await dbNow(c);
    const effectiveAt = await effectiveFrom(c, now, input.effectiveAt);
    // A rule must name a procedure that is already in force when the rule takes effect, so every opening can pin one.
    const proc = await c.query(
      `SELECT 1 FROM operating_procedure_revisions WHERE tenant_id = $1 AND procedure_key = $2 AND effective_at <= $3 LIMIT 1`,
      [ctx.tenantId, input.procedureKey, effectiveAt],
    );
    if (proc.rowCount !== 1) throw validation('PROCEDURE_NOT_EFFECTIVE');
    await lockKey(c, `incident-rule:${ctx.tenantId}:${input.ruleKey}`);
    const next = await c.query<{ n: number }>(
      `SELECT coalesce(max(revision), 0) + 1 AS n FROM incident_rule_revisions WHERE tenant_id = $1 AND rule_key = $2`,
      [ctx.tenantId, input.ruleKey],
    );
    const revision = next.rows[0]!.n;
    const status = input.status ?? 'ACTIVE';
    const { effectiveAt: _e, status: _s, ...body } = input;
    const bodyDigest = canonicalDigest('incident-rule', 1, { tenantId: ctx.tenantId, revision, status, ...body });
    await c.query(
      `INSERT INTO incident_rule_revisions (tenant_id, id, rule_key, revision, status, site_id, asset_id, channel_kind,
         comparator, threshold_int, hysteresis_int, duration_ms, min_samples, quorum_channels, max_gap_ms,
         max_evaluation_lag_ms, stale_behavior, fault_window_key, fault_family, urgency, watch_window_ms,
         recovery_window_ms, procedure_key, body_digest, effective_at, published_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26)`,
      [
        ctx.tenantId,
        ruleRevisionId,
        input.ruleKey,
        revision,
        status,
        input.siteId,
        input.assetId,
        input.channelKind,
        input.comparator,
        input.thresholdInt,
        input.hysteresisInt,
        input.durationMs,
        input.minSamples,
        input.quorumChannels,
        input.maxGapMs,
        input.maxEvaluationLagMs,
        input.staleBehavior,
        input.faultWindowKey,
        input.faultFamily,
        input.urgency,
        input.watchWindowMs,
        input.recoveryWindowMs,
        input.procedureKey,
        bodyDigest,
        effectiveAt,
        humanActor(ctx),
      ],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { ruleKey: input.ruleKey, revision } });
    return { ruleRevisionId, revision, effectiveAt, bodyDigest };
  });
}

/** Rules in force for an asset at `at`: per rule key the newest effective revision, if ACTIVE and in scope. */
export async function effectiveRulesForAsset(
  c: Queryable,
  tenantId: string,
  asset: { id: string; siteId: string },
  at: string,
  ruleKey?: string,
): Promise<RuleRevisionRecord[]> {
  const { rows } = await c.query(
    `SELECT DISTINCT ON (rule_key) * FROM incident_rule_revisions
      WHERE tenant_id = $1 AND effective_at <= $2 AND ($3::text IS NULL OR rule_key = $3)
      ORDER BY rule_key, effective_at DESC`,
    [tenantId, at, ruleKey ?? null],
  );
  return rows
    .map(toRule)
    .filter(
      (r) =>
        r.status === 'ACTIVE' &&
        (r.siteId === null || r.siteId === asset.siteId) &&
        (r.assetId === null || r.assetId === asset.id),
    )
    .slice(0, 64);
}

/** The procedure revision of `procedureKey` in force at `at`. */
export async function effectiveProcedure(
  c: Queryable,
  tenantId: string,
  procedureKey: string,
  at: string,
): Promise<ProcedureRevisionRecord | undefined> {
  const { rows } = await c.query(
    `SELECT * FROM operating_procedure_revisions WHERE tenant_id = $1 AND procedure_key = $2 AND effective_at <= $3
      ORDER BY effective_at DESC LIMIT 1`,
    [tenantId, procedureKey, at],
  );
  return rows[0] ? toProcedure(rows[0]) : undefined;
}

export async function loadProcedure(c: Queryable, tenantId: string, id: string): Promise<ProcedureRevisionRecord> {
  const { rows } = await c.query(`SELECT * FROM operating_procedure_revisions WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return toProcedure(rows[0]!);
}
