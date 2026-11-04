// Privacy lifecycle state (FR-23, NFR-06): legal holds and privacy requests. A deletion or redaction request that
// touches a held scope is recorded as BLOCKED_LEGAL_HOLD rather than executed; erasure workers (later modules) act
// only on RECEIVED requests and leave non-sensitive tombstones. Immutable records are never silently erased here.
import { DomainError, Sha256DigestSchema, type TenantId } from '@uptimebuyer/contracts';
import { requireAuthorized } from './authz.js';
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { humanActor, type TenantContext } from './context.js';
import type { Db, Tx } from './db.js';
import { newDataId, type LegalHoldId, type PrivacyRequestId } from './ids.js';

export type HoldScopeType = 'TENANT' | 'SITE' | 'ASSET' | 'INCIDENT';
const SCOPE_TABLE: Record<HoldScopeType, string | null> = {
  TENANT: null,
  SITE: 'sites',
  ASSET: 'assets',
  INCIDENT: null,
};

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

async function scopeExists(c: Tx, tenantId: TenantId, type: HoldScopeType, id: string): Promise<boolean> {
  if (type === 'TENANT') return id === tenantId;
  if (type === 'INCIDENT') return /^inc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(id);
  const r = await c.query(`SELECT 1 FROM ${SCOPE_TABLE[type]} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}

export async function placeLegalHold(
  pool: Db,
  ctx: TenantContext,
  input: { scopeType: HoldScopeType; scopeId: string; reasonCode: string },
): Promise<{ legalHoldId: LegalHoldId }> {
  if (!Object.hasOwn(SCOPE_TABLE, input.scopeType) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode))
    throw validation('INVALID_LEGAL_HOLD');
  const meta = { action: 'legal_hold.place', resourceType: input.scopeType.toLowerCase(), resourceId: input.scopeId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!(await scopeExists(c, ctx.tenantId, input.scopeType, input.scopeId))) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null });
    const legalHoldId = newDataId('legalHold') as LegalHoldId;
    await c.query(
      `INSERT INTO legal_holds (tenant_id, id, scope_type, scope_id, reason_code, placed_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.tenantId, legalHoldId, input.scopeType, input.scopeId, input.reasonCode, humanActor(ctx)],
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

export async function createPrivacyRequest(
  pool: Db,
  ctx: TenantContext,
  input: {
    requestType: 'EXPORT' | 'REDACTION' | 'DELETION';
    subjectKind: 'CONTACT' | 'USER' | 'COMMUNICATION';
    subjectRefDigest: string;
    scopeType: HoldScopeType;
    scopeId: string;
  },
): Promise<{ privacyRequestId: PrivacyRequestId; state: 'RECEIVED' | 'BLOCKED_LEGAL_HOLD' }> {
  if (
    !['EXPORT', 'REDACTION', 'DELETION'].includes(input.requestType) ||
    !['CONTACT', 'USER', 'COMMUNICATION'].includes(input.subjectKind) ||
    !Sha256DigestSchema.safeParse(input.subjectRefDigest).success ||
    !Object.hasOwn(SCOPE_TABLE, input.scopeType)
  )
    throw validation('INVALID_PRIVACY_REQUEST');
  const meta = { action: 'privacy_request.create', resourceType: 'privacy_request', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!(await scopeExists(c, ctx.tenantId, input.scopeType, input.scopeId))) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'policy.publish', siteId: null });
    const held =
      input.requestType !== 'EXPORT' &&
      (
        await c.query(
          `SELECT 1 FROM legal_holds WHERE tenant_id = $1 AND released_at IS NULL
             AND (scope_type = 'TENANT' OR (scope_type = $2 AND scope_id = $3)) LIMIT 1`,
          [ctx.tenantId, input.scopeType, input.scopeId],
        )
      ).rowCount === 1;
    const state = held ? 'BLOCKED_LEGAL_HOLD' : 'RECEIVED';
    const privacyRequestId = newDataId('privacyRequest') as PrivacyRequestId;
    await c.query(
      `INSERT INTO privacy_requests (tenant_id, id, request_type, subject_kind, subject_ref_digest, scope_type, scope_id, state, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
