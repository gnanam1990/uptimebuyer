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
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { humanActor, type TenantContext } from './context.js';
import { dbNow, isoNN, lockKey, type Db, type Queryable } from './db.js';
import { newDataId } from './ids.js';
import { RegistrySourceSchema, type RegistrySource } from './registry-core.js';

export const RetentionPolicySchema = z.strictObject({
  telemetryDays: z.int().min(1).max(3650),
  communicationDays: z.int().min(1).max(3650),
  auditDays: z.int().min(1).max(36500),
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

export async function publishPolicyRevision(
  pool: Db,
  ctx: TenantContext,
  input: PublishPolicyInput,
): Promise<{ policyRevisionId: PolicyRevisionId; revision: number; effectiveAt: UtcInstant }> {
  if (!Object.hasOwn(POLICY_SCHEMAS, input.policyKey)) throw validation('UNKNOWN_POLICY_KEY');
  if (!RegistrySourceSchema.safeParse(input.source).success) throw validation('INVALID_SOURCE');
  const { schemaName, schema } = POLICY_SCHEMAS[input.policyKey];
  let wire: Record<string, unknown>;
  try {
    wire = encodeWire(schema as z.ZodType, input.body) as Record<string, unknown>;
    // Round-trip so semantic refinements (e.g. the compatibility section's hard floors) run before storing.
    decodeWire(schema as z.ZodType, wire);
  } catch {
    throw validation('INVALID_POLICY_BODY');
  }
  const policyRevisionId = newId('policyRevision');
  const meta = { action: 'policy.publish', resourceType: 'policy_revision', resourceId: policyRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null }, undefined, { type: 'policy_revision' });
    if (input.policyKey === 'AUTHORITY') {
      const sites = [...new Set(input.body.approvalLimits.flatMap((r) => r.siteIds ?? []))];
      if (sites.length > 0) {
        const s = await c.query(`SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1 AND id = ANY($2)`, [
          ctx.tenantId,
          sites,
        ]);
        if (s.rows[0].n !== sites.length) throw unavailable(meta, null, 'site');
      }
    }
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
      schemaName,
      body: wire,
    });
    await c.query(
      `INSERT INTO policy_revisions (tenant_id, id, policy_id, revision, schema_name, body, body_digest, effective_at, published_by_user_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.tenantId,
        policyRevisionId,
        policyId,
        revision,
        schemaName,
        JSON.stringify(wire),
        bodyDigest,
        effectiveAt,
        humanActor(ctx),
        input.source,
      ],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { policyKey: input.policyKey, revision } });
    return { policyRevisionId, revision, effectiveAt };
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
