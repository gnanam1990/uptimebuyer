// Tenant/site scoping shared by the M05 repositories (INV-16). Reads outside the caller's scope look exactly like a
// nonexistent resource (RESOURCE_UNAVAILABLE); writes use the audited permission denial.
import type { SiteId } from '@uptimebuyer/contracts';
import {
  Denial,
  authorize,
  notPermitted,
  requireAuthorized,
  unavailable,
  type CommandMeta,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';

export interface IncidentRow {
  id: string;
  site_id: SiteId;
  asset_id: string;
  asset_revision_id: string;
  policy_revision_id: string | null;
  state: string;
  urgency: string;
  fault_family: string;
  trigger_kind: string;
}

export async function loadIncident(c: Tx, ctx: TenantContext, meta: CommandMeta, incidentId: string): Promise<IncidentRow> {
  if (typeof incidentId !== 'string' || !/^inc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(incidentId)) throw unavailable(meta);
  const { rows } = await c.query<IncidentRow>(
    `SELECT id, site_id, asset_id, asset_revision_id, policy_revision_id, state, urgency, fault_family, trigger_kind
       FROM incidents WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, incidentId],
  );
  if (!rows[0]) throw unavailable(meta, incidentId, 'incident');
  return rows[0];
}

/** Read access to evidence at `siteId`; anything else is indistinguishable from absence. */
export function requireEvidenceRead(ctx: TenantContext, siteId: SiteId, meta: CommandMeta, resourceId?: string): void {
  if (!authorize(ctx, { action: 'evidence.read', siteId }).allowed) throw unavailable(meta, resourceId);
}

/** Read access to tenant-wide (model-level) evidence: any evidence.read grant in the tenant. */
export function requireAnyEvidenceRead(ctx: TenantContext, meta: CommandMeta, resourceId?: string): void {
  if (ctx.principal.kind === 'WORKER') return requireEvidenceRead(ctx, 'sit_any-site' as SiteId, meta, resourceId);
  const ok = ctx.grants.some((g) =>
    authorize(ctx, { action: 'evidence.read', siteId: (g.siteId ?? 'sit_tenant-wide') as SiteId }).allowed,
  );
  if (!ok) throw unavailable(meta, resourceId);
}

/** Write access: a human needs evidence.submit at the site (null = tenant-wide); servers need evidence.engine. */
export function requireEvidenceWrite(ctx: TenantContext, siteId: SiteId | null, resource: { type: string; id: string | null }) {
  if (ctx.principal.kind === 'HUMAN') {
    requireAuthorized(ctx, { action: 'evidence.submit', siteId }, undefined, resource);
    return;
  }
  requireAuthorized(ctx, { action: 'evidence.engine' }, undefined, resource);
}

/** The evidence engine (reasoning runs, automated revisions) is reserved to server workloads. */
export function requireEngine(ctx: TenantContext, meta: CommandMeta): void {
  const d = authorize(ctx, { action: 'evidence.engine' });
  if (!d.allowed)
    throw new Denial(notPermitted(d.reasonCode), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      reasonCode: d.reasonCode,
    });
}
