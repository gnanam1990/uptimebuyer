// Privacy lifecycle state (FR-23, NFR-06, INV-10): legal holds and privacy requests. Every hold and request stores
// its resolved scope chain (tenant > site > asset > incident). A deletion or redaction request is BLOCKED_LEGAL_HOLD
// when any active hold overlaps it — the hold is an ancestor of the requested scope, the same scope, or beneath it —
// i.e. the two chains agree on every level both define. Erasure workers (later modules) act only on RECEIVED
// requests and leave non-sensitive tombstones; immutable records are never silently erased here.
import { AssetIdSchema, DomainError, Sha256DigestSchema, type AssetId, type TenantId } from '@uptimebuyer/contracts';
import { requireAuthorized } from './authz.js';
import { recordAudit, tenantCommand, unavailable, type CommandMeta } from './command.js';
import { humanActor, type TenantContext } from './context.js';
import type { Db, Tx } from './db.js';
import { newDataId, type LegalHoldId, type PrivacyRequestId } from './ids.js';

export type HoldScopeType = 'TENANT' | 'SITE' | 'ASSET' | 'INCIDENT';
const SCOPE_TYPES: readonly HoldScopeType[] = ['TENANT', 'SITE', 'ASSET', 'INCIDENT'];

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

interface ScopeChain {
  siteId: string | null;
  assetId: string | null;
  incidentId: string | null;
}

/**
 * Resolve a scope to its ancestor chain inside the caller's tenant. Incidents are not yet a table (M04), so an
 * INCIDENT scope must name its asset; it must agree with any evidence revision or approval already recorded for the
 * incident. M04 should resolve the chain from `incidents` instead.
 */
async function resolveChain(
  c: Tx,
  tenantId: TenantId,
  meta: CommandMeta,
  scopeType: HoldScopeType,
  scopeId: string,
  parentAssetId: AssetId | undefined,
): Promise<ScopeChain> {
  switch (scopeType) {
    case 'TENANT':
      if (scopeId !== tenantId) throw unavailable(meta);
      return { siteId: null, assetId: null, incidentId: null };
    case 'SITE': {
      const r = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [tenantId, scopeId]);
      if (r.rowCount !== 1) throw unavailable(meta);
      return { siteId: scopeId, assetId: null, incidentId: null };
    }
    case 'ASSET': {
      const r = await c.query(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [tenantId, scopeId]);
      if (!r.rows[0]) throw unavailable(meta);
      return { siteId: r.rows[0].site_id, assetId: scopeId, incidentId: null };
    }
    case 'INCIDENT': {
      const r = await c.query(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [tenantId, parentAssetId]);
      if (!r.rows[0]) throw unavailable(meta, parentAssetId ?? null, 'asset');
      const bound = await c.query<{ asset_id: string }>(
        `SELECT DISTINCT r.asset_id FROM (
           SELECT asset_revision_id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2
           UNION SELECT asset_revision_id FROM approvals WHERE tenant_id = $1 AND incident_id = $2) x
         JOIN asset_revisions r ON r.tenant_id = $1 AND r.id = x.asset_revision_id`,
        [tenantId, scopeId],
      );
      if (bound.rows.some((b) => b.asset_id !== parentAssetId)) throw validation('INCIDENT_ASSET_MISMATCH');
      return { siteId: r.rows[0].site_id, assetId: parentAssetId!, incidentId: scopeId };
    }
  }
}

function checkScope(scopeType: unknown, scopeId: unknown, parentAssetId: unknown): void {
  if (!SCOPE_TYPES.includes(scopeType as HoldScopeType) || typeof scopeId !== 'string')
    throw validation('INVALID_SCOPE');
  if (scopeType === 'INCIDENT') {
    if (!/^inc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(scopeId)) throw validation('INVALID_SCOPE');
    if (parentAssetId === undefined) throw validation('INCIDENT_ASSET_REQUIRED');
    if (!AssetIdSchema.safeParse(parentAssetId).success) throw validation('INVALID_SCOPE');
  } else if (parentAssetId !== undefined) throw validation('PARENT_ASSET_ONLY_FOR_INCIDENT');
}

export async function placeLegalHold(
  pool: Db,
  ctx: TenantContext,
  input: { scopeType: HoldScopeType; scopeId: string; reasonCode: string; parentAssetId?: AssetId },
): Promise<{ legalHoldId: LegalHoldId }> {
  checkScope(input.scopeType, input.scopeId, input.parentAssetId);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode)) throw validation('INVALID_LEGAL_HOLD');
  const meta = { action: 'legal_hold.place', resourceType: input.scopeType.toLowerCase(), resourceId: input.scopeId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null });
    const chain = await resolveChain(c, ctx.tenantId, meta, input.scopeType, input.scopeId, input.parentAssetId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`legal-hold:${ctx.tenantId}`]);
    const legalHoldId = newDataId('legalHold') as LegalHoldId;
    await c.query(
      `INSERT INTO legal_holds (tenant_id, id, scope_type, scope_id, reason_code, placed_by_user_id, site_id, asset_id, incident_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        legalHoldId,
        input.scopeType,
        input.scopeId,
        input.reasonCode,
        humanActor(ctx),
        chain.siteId,
        chain.assetId,
        chain.incidentId,
      ],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
    return { legalHoldId };
  });
}

export async function releaseLegalHold(pool: Db, ctx: TenantContext, legalHoldId: LegalHoldId): Promise<void> {
  const meta = { action: 'legal_hold.release', resourceType: 'legal_hold', resourceId: legalHoldId };
  await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null });
    const r = await c.query(
      `UPDATE legal_holds SET released_at = clock_timestamp(), released_by_user_id = $3
        WHERE tenant_id = $1 AND id = $2 AND released_at IS NULL`,
      [ctx.tenantId, legalHoldId, humanActor(ctx)],
    );
    if (r.rowCount !== 1) throw unavailable(meta);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
  });
}

/** Active holds overlap when their chains agree on every level both define (NULL = whole subtree). */
async function overlappingHold(c: Tx, tenantId: TenantId, chain: ScopeChain): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM legal_holds h
      WHERE h.tenant_id = $1 AND h.released_at IS NULL
        AND ($2::text IS NULL OR h.site_id IS NULL OR h.site_id = $2)
        AND ($3::text IS NULL OR h.asset_id IS NULL OR h.asset_id = $3)
        AND ($4::text IS NULL OR h.incident_id IS NULL OR h.incident_id = $4)
      LIMIT 1
      FOR SHARE`,
    [tenantId, chain.siteId, chain.assetId, chain.incidentId],
  );
  return rowCount === 1;
}

export async function createPrivacyRequest(
  pool: Db,
  ctx: TenantContext,
  input: {
    requestType: 'EXPORT' | 'REDACTION' | 'DELETION';
    subjectKind: 'CONTACT' | 'USER' | 'COMMUNICATION';
    subjectRefDigest: string;
    scopeType: HoldScopeType;
    scopeId: string;
    parentAssetId?: AssetId;
  },
): Promise<{ privacyRequestId: PrivacyRequestId; state: 'RECEIVED' | 'BLOCKED_LEGAL_HOLD' }> {
  if (
    !['EXPORT', 'REDACTION', 'DELETION'].includes(input.requestType) ||
    !['CONTACT', 'USER', 'COMMUNICATION'].includes(input.subjectKind) ||
    !Sha256DigestSchema.safeParse(input.subjectRefDigest).success
  )
    throw validation('INVALID_PRIVACY_REQUEST');
  checkScope(input.scopeType, input.scopeId, input.parentAssetId);
  const meta = { action: 'privacy_request.create', resourceType: 'privacy_request', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null });
    const chain = await resolveChain(c, ctx.tenantId, meta, input.scopeType, input.scopeId, input.parentAssetId);
    // Serialize with hold placement for this tenant so a concurrent hold cannot slip past the check.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`legal-hold:${ctx.tenantId}`]);
    const held = input.requestType !== 'EXPORT' && (await overlappingHold(c, ctx.tenantId, chain));
    const state = held ? 'BLOCKED_LEGAL_HOLD' : 'RECEIVED';
    const privacyRequestId = newDataId('privacyRequest') as PrivacyRequestId;
    await c.query(
      `INSERT INTO privacy_requests (tenant_id, id, request_type, subject_kind, subject_ref_digest, scope_type, scope_id, state,
                                     requested_by_user_id, site_id, asset_id, incident_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        ctx.tenantId,
        privacyRequestId,
        input.requestType,
        input.subjectKind,
        input.subjectRefDigest,
        input.scopeType,
        input.scopeId,
        state,
        humanActor(ctx),
        chain.siteId,
        chain.assetId,
        chain.incidentId,
      ],
    );
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: privacyRequestId,
      result: 'SUCCEEDED',
      reasonCode: held ? 'LEGAL_HOLD' : null,
    });
    return { privacyRequestId, state };
  });
}
