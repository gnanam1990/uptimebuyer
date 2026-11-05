// Effective-dated, immutable policy revisions (FR-21). Publishing appends a revision; nothing is edited, and a
// revision cannot take effect before it was published. Decisions pin `policy_revision_id`.
import {
  DomainError,
  decodeWire,
  encodeWire,
  newId,
  type PolicyRevisionId,
  type TenantId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { AuthorityPolicySchema, requireAuthorized, type AuthorityPolicy } from './authz.js';
import { Denial, notPermitted, recordAudit, tenantCommand, unavailable } from './command.js';
import { humanActor, type TenantContext } from './context.js';
import { dbNow, isoNN, lockKey, sha256Digest, type Db, type Queryable, type Tx } from './db.js';
import { newDataId } from './ids.js';
import { RegistrySourceSchema, type RegistrySource } from './registry-core.js';

export const RetentionPolicySchema = z.strictObject({
  telemetryDays: z.int().min(1).max(3650),
  communicationDays: z.int().min(1).max(3650),
  auditDays: z.int().min(1).max(36500),
  /** M13: raw fulfillment-webhook bodies (M10). Absent: communicationDays applies. */
  fulfillmentRawDays: z.int().min(1).max(3650).optional(),
  /** M13: raw CMMS record bodies (M11). Absent: communicationDays applies. */
  cmmsRawDays: z.int().min(1).max(3650).optional(),
});
export type RetentionPolicy = z.output<typeof RetentionPolicySchema>;

export const POLICY_SCHEMAS = {
  AUTHORITY: { schemaName: 'policy.authority.v1', schema: AuthorityPolicySchema },
  RETENTION: { schemaName: 'policy.retention.v1', schema: RetentionPolicySchema },
} as const;
export type PolicyKey = keyof typeof POLICY_SCHEMAS;
export type PolicyBody<K extends PolicyKey> = K extends 'AUTHORITY' ? AuthorityPolicy : RetentionPolicy;

export type PublishPolicyInput =
  | { policyKey: 'AUTHORITY'; body: AuthorityPolicy; effectiveAt?: UtcInstant; source: RegistrySource }
  | { policyKey: 'RETENTION'; body: RetentionPolicy; effectiveAt?: UtcInstant; source: RegistrySource };

export interface PolicyRevisionRecord<K extends PolicyKey = PolicyKey> {
  policyRevisionId: PolicyRevisionId;
  tenantId: TenantId;
  policyKey: K;
  revision: number;
  schemaName: string;
  body: PolicyBody<K>;
  bodyDigest: string;
  effectiveAt: UtcInstant;
  publishedAt: UtcInstant;
}

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

const holdErr = (reasonCode: string) =>
  new DomainError('POLICY_HOLD', 'The policy change needs a second administrator.', { reasonCode });

/** Validate and wire-encode a policy body (round-trip so semantic refinements run before storing). */
function encodeBody(input: PublishPolicyInput): { schemaName: string; wire: Record<string, unknown> } {
  if (!Object.hasOwn(POLICY_SCHEMAS, input.policyKey)) throw validation('UNKNOWN_POLICY_KEY');
  if (!RegistrySourceSchema.safeParse(input.source).success) throw validation('INVALID_SOURCE');
  const { schemaName, schema } = POLICY_SCHEMAS[input.policyKey];
  try {
    const wire = encodeWire(schema as z.ZodType, input.body) as Record<string, unknown>;
    decodeWire(schema as z.ZodType, wire);
    return { schemaName, wire };
  } catch {
    throw validation('INVALID_POLICY_BODY');
  }
}

async function assertSitesExist(
  c: Tx,
  ctx: TenantContext,
  input: PublishPolicyInput,
  meta: { action: string; resourceType: string; resourceId: string | null },
) {
  if (input.policyKey !== 'AUTHORITY') return;
  const sites = [...new Set(input.body.approvalLimits.flatMap((r) => r.siteIds ?? []))];
  if (sites.length === 0) return;
  const s = await c.query(`SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1 AND id = ANY($2)`, [
    ctx.tenantId,
    sites,
  ]);
  if (s.rows[0].n !== sites.length) throw unavailable(meta, null, 'site');
}

/**
 * Does publishing this key need a second administrator (M13, UI-SPEC §10; security review S5)? Decided over the
 * AUTHORITY revision in force and every scheduled one: AUTHORITY while any of them has a non-empty separationOfDuties
 * section, any other key while any of them names it in dualApprovalPolicyKeys (migration 0022).
 */
export async function dualApprovalRequired(q: Queryable, tenantId: TenantId, policyKey: PolicyKey): Promise<boolean> {
  const { rows } = await q.query<{ required: boolean }>(`SELECT ub_policy_dual_approval_required($1, $2) AS required`, [
    tenantId,
    policyKey,
  ]);
  return rows[0]?.required === true;
}

/**
 * M13 security review S2/S5: enabling separation of duties must not be pre-empted by a revision queued before it. When
 * an AUTHORITY body carries a non-empty separationOfDuties section, refuse while any unreviewed (no proposal)
 * future-dated revision of AUTHORITY or a key it names for dual approval is queued: it would take effect later and
 * could silently undo the control. The database guard (migration 0022) enforces the same rule.
 */
async function assertNoQueuedBypass(c: Tx, tenantId: TenantId, policyKey: PolicyKey, wire: Record<string, unknown>) {
  if (policyKey !== 'AUTHORITY') return;
  const sod = wire.separationOfDuties as { dualApprovalPolicyKeys?: unknown; spend?: unknown } | undefined;
  const keys = Array.isArray(sod?.dualApprovalPolicyKeys) ? (sod.dualApprovalPolicyKeys as string[]) : [];
  const spend = Array.isArray(sod?.spend) ? sod.spend : [];
  if (keys.length === 0 && spend.length === 0) return;
  const { rowCount } = await c.query(
    `SELECT 1 FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE r.tenant_id = $1 AND p.policy_key = ANY($2) AND r.effective_at > clock_timestamp() AND r.proposal_id IS NULL
      LIMIT 1`,
    [tenantId, [...new Set(['AUTHORITY', ...keys])]],
  );
  if ((rowCount ?? 0) > 0) throw holdErr('PENDING_UNREVIEWED_FUTURE_REVISION');
}

async function insertRevision(
  c: Tx,
  ctx: TenantContext,
  input: {
    policyKey: PolicyKey;
    schemaName: string;
    wire: Record<string, unknown>;
    effectiveAt?: UtcInstant;
    source: RegistrySource;
  },
  publishedBy: string,
  dual: { proposalId: string; approvedBy: string } | null,
): Promise<{ policyRevisionId: PolicyRevisionId; revision: number; effectiveAt: UtcInstant }> {
  const policyRevisionId = newId('policyRevision');
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO policies (tenant_id, id, policy_key) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, policy_key) DO UPDATE SET policy_key = EXCLUDED.policy_key RETURNING id`,
    [ctx.tenantId, newDataId('policy'), input.policyKey],
  );
  const policyId = rows[0]!.id;
  await lockKey(c, `policy:${ctx.tenantId}:${policyId}`);
  const next = await c.query<{ n: number }>(
    `SELECT coalesce(max(revision), 0) + 1 AS n FROM policy_revisions WHERE tenant_id = $1 AND policy_id = $2`,
    [ctx.tenantId, policyId],
  );
  const revision = next.rows[0]!.n;
  const now = await dbNow(c);
  const effectiveAt = input.effectiveAt ?? now;
  if (Date.parse(effectiveAt) < Date.parse(now) - 1000) throw validation('RETROACTIVE_POLICY');
  const bodyDigest = canonicalDigest('policy', 1, {
    tenantId: ctx.tenantId,
    policyKey: input.policyKey,
    revision,
    schemaName: input.schemaName,
    body: input.wire,
  });
  await c.query(
    `INSERT INTO policy_revisions (tenant_id, id, policy_id, revision, schema_name, body, body_digest, effective_at,
       published_by_user_id, source, proposal_id, approved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      ctx.tenantId,
      policyRevisionId,
      policyId,
      revision,
      input.schemaName,
      JSON.stringify(input.wire),
      bodyDigest,
      effectiveAt,
      publishedBy,
      input.source,
      dual?.proposalId ?? null,
      dual?.approvedBy ?? null,
    ],
  );
  return { policyRevisionId, revision, effectiveAt };
}

export async function publishPolicyRevision(
  pool: Db,
  ctx: TenantContext,
  input: PublishPolicyInput,
): Promise<{ policyRevisionId: PolicyRevisionId; revision: number; effectiveAt: UtcInstant }> {
  const { schemaName, wire } = encodeBody(input);
  const meta = { action: 'policy.publish', resourceType: 'policy_revision', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: 'policy_revision' });
    await assertSitesExist(c, ctx, input, meta);
    // Serialize with other policy changes so a concurrent AUTHORITY change cannot slip dual approval in or out.
    await lockKey(c, `policy-governance:${ctx.tenantId}`);
    if (await dualApprovalRequired(c, ctx.tenantId, input.policyKey)) throw holdErr('DUAL_APPROVAL_REQUIRED');
    await assertNoQueuedBypass(c, ctx.tenantId, input.policyKey, wire);
    const r = await insertRevision(
      c,
      ctx,
      {
        policyKey: input.policyKey,
        schemaName,
        wire,
        ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
        source: input.source,
      },
      humanActor(ctx),
      null,
    );
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: r.policyRevisionId,
      result: 'SUCCEEDED',
      metadata: { policyKey: input.policyKey, revision: r.revision },
    });
    return r;
  });
}

/**
 * Propose a policy revision for a second administrator's approval (M13 dual approval, UI-SPEC §10). Always allowed for
 * an administrator; required for keys the effective AUTHORITY policy names in `separationOfDuties.dualApprovalPolicyKeys`.
 */
export async function proposePolicyRevision(
  pool: Db,
  ctx: TenantContext,
  input: PublishPolicyInput,
): Promise<{ policyChangeProposalId: string; bodyDigest: string }> {
  const { schemaName, wire } = encodeBody(input);
  const policyChangeProposalId = newDataId('policyChangeProposal');
  const meta = { action: 'policy.propose', resourceType: 'policy_change_proposal', resourceId: policyChangeProposalId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: 'policy_change_proposal' });
    await assertSitesExist(c, ctx, input, meta);
    const bodyDigest = sha256Digest(JSON.stringify({ policyKey: input.policyKey, schemaName, body: wire }));
    await c.query(
      `INSERT INTO policy_change_proposals (tenant_id, id, policy_key, schema_name, body, body_digest, effective_at, source,
         proposed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        policyChangeProposalId,
        input.policyKey,
        schemaName,
        JSON.stringify(wire),
        bodyDigest,
        input.effectiveAt ?? null,
        input.source,
        humanActor(ctx),
      ],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { policyKey: input.policyKey } });
    return { policyChangeProposalId, bodyDigest };
  });
}

/**
 * A second administrator approves a proposal: the revision is published (proposer as publisher, approver recorded)
 * and the proposal stamped APPROVED in one transaction. The proposer can never approve their own proposal.
 */
export async function approvePolicyProposal(
  pool: Db,
  ctx: TenantContext,
  input: { policyChangeProposalId: string },
): Promise<{ policyRevisionId: PolicyRevisionId; revision: number; effectiveAt: UtcInstant; policyKey: PolicyKey }> {
  const id = String(input?.policyChangeProposalId ?? '');
  const meta = { action: 'policy.approve_proposal', resourceType: 'policy_change_proposal', resourceId: id };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, {
      type: 'policy_change_proposal',
      id,
    });
    if (!/^pcp_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(id)) throw unavailable(meta);
    await lockKey(c, `policy-governance:${ctx.tenantId}`);
    const p = (
      await c.query(`SELECT * FROM policy_change_proposals WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
        ctx.tenantId,
        id,
      ])
    ).rows[0];
    if (!p) throw unavailable(meta);
    const approver = humanActor(ctx);
    if (p.proposed_by_user_id === approver)
      throw new Denial(notPermitted('SELF_APPROVAL_DENIED'), {
        action: meta.action,
        resourceType: meta.resourceType,
        resourceId: id,
        reasonCode: 'SELF_APPROVAL_DENIED',
      });
    if (p.decision !== null) throw holdErr('PROPOSAL_ALREADY_DECIDED');
    const policyKey = p.policy_key as PolicyKey;
    // Re-validate against the current schema (a proposal never bypasses body validation).
    try {
      decodeWire(POLICY_SCHEMAS[policyKey].schema as z.ZodType, p.body);
    } catch {
      throw validation('INVALID_POLICY_BODY');
    }
    await assertNoQueuedBypass(c, ctx.tenantId, policyKey, p.body);
    const r = await insertRevision(
      c,
      ctx,
      {
        policyKey,
        schemaName: p.schema_name,
        wire: p.body,
        ...(p.effective_at ? { effectiveAt: isoNN(p.effective_at) } : {}),
        source: p.source,
      },
      p.proposed_by_user_id,
      { proposalId: id, approvedBy: approver },
    );
    await c.query(
      `UPDATE policy_change_proposals SET decision = 'APPROVED', decided_by_user_id = $3, decided_at = clock_timestamp(),
              published_policy_revision_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, id, approver, r.policyRevisionId],
    );
    await recordAudit(c, ctx, {
      ...meta,
      result: 'SUCCEEDED',
      metadata: { policyKey, revision: r.revision, policyRevisionId: r.policyRevisionId },
    });
    return { ...r, policyKey };
  });
}

function toPolicy(r: Record<string, unknown>): PolicyRevisionRecord {
  const key = r.policy_key as PolicyKey;
  return {
    policyRevisionId: r.id as PolicyRevisionId,
    tenantId: r.tenant_id as TenantId,
    policyKey: key,
    revision: r.revision as number,
    schemaName: r.schema_name as string,
    body: decodeWire(POLICY_SCHEMAS[key].schema as z.ZodType, r.body) as never,
    bodyDigest: r.body_digest as string,
    effectiveAt: isoNN(r.effective_at as Date),
    publishedAt: isoNN(r.published_at as Date),
  };
}

const POLICY_SELECT = `SELECT r.*, p.policy_key FROM policy_revisions r
  JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id`;

/** @internal Load a policy revision by id within the tenant (no authorization; callers authorize). */
export async function loadPolicyRevision(
  q: Queryable,
  tenantId: TenantId,
  policyRevisionId: string,
): Promise<(PolicyRevisionRecord & { effectiveNow: boolean }) | undefined> {
  const { rows } = await q.query(
    `SELECT r.*, p.policy_key, eff.effective_id FROM policy_revisions r
       JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
       LEFT JOIN LATERAL (
        SELECT id AS effective_id FROM policy_revisions e
         WHERE e.tenant_id = r.tenant_id AND e.policy_id = r.policy_id AND e.effective_at <= clock_timestamp()
         ORDER BY e.effective_at DESC LIMIT 1) eff ON true
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [tenantId, policyRevisionId],
  );
  if (!rows[0]) return undefined;
  return { ...toPolicy(rows[0]), effectiveNow: rows[0].effective_id === rows[0].id };
}

/** The revision in force at `at` (default now) for a policy key. */
export async function getEffectivePolicyRevision<K extends PolicyKey>(
  pool: Db,
  ctx: TenantContext,
  policyKey: K,
  at?: UtcInstant,
): Promise<PolicyRevisionRecord<K>> {
  const meta = { action: 'policy.read', resourceType: 'policy', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'registry.read', siteId: null });
    const { rows } = await c.query(
      `${POLICY_SELECT} WHERE r.tenant_id = $1 AND p.policy_key = $2 AND r.effective_at <= coalesce($3::timestamptz, clock_timestamp())
        ORDER BY r.effective_at DESC LIMIT 1`,
      [ctx.tenantId, policyKey, at ?? null],
    );
    if (!rows[0]) throw unavailable(meta);
    return toPolicy(rows[0]) as PolicyRevisionRecord<K>;
  });
}
