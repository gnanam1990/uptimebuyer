// Operator-surface reads (M12, additive to M02). Each authorizes against the resource's own site inside its tenant
// transaction and denies out-of-scope or missing resources identically (RESOURCE_UNAVAILABLE), so the HTTP API never
// needs its own SQL or its own authorization rules.
import {
  DomainError,
  type AssetId,
  type DeviceId,
  type SiteId,
  type TenantId,
  type UserId,
} from '@uptimebuyer/contracts';
import { authorize } from './authz.js';
import { Denial, resourceUnavailable, tenantCommand, unavailable, type CommandMeta } from './command.js';
import { HUMAN_ROLES, type TenantContext } from './context.js';
import type { Db } from './db.js';
import type { SensorChannelId } from './ids.js';

const ID = /^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;

function requireSiteRead(
  ctx: TenantContext,
  siteId: string,
  meta: CommandMeta,
  action: 'registry.read' | 'incident.read',
) {
  const d = authorize(ctx, { action, siteId: siteId as SiteId });
  if (!d.allowed)
    throw new Denial(resourceUnavailable(), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      reasonCode: d.reasonCode,
    });
}

export interface SessionProfile {
  userId: UserId;
  displayName: string;
  tenantId: TenantId;
  tenantName: string;
}

/** The authenticated human's own display name and the resolved tenant's name (nothing about other principals). */
export async function getSessionProfile(pool: Db, ctx: TenantContext): Promise<SessionProfile> {
  const meta = { action: 'session.read', resourceType: 'user', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (ctx.principal.kind !== 'HUMAN')
      throw new Denial(
        new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
          reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
        }),
        { ...meta, reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED' },
      );
    const { rows } = await c.query<{ display_name: string; name: string }>(
      `SELECT u.display_name, t.name FROM users u
         JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'ACTIVE'
         JOIN tenants t ON t.id = m.tenant_id
        WHERE u.id = $2`,
      [ctx.tenantId, ctx.principal.id],
    );
    if (!rows[0]) throw unavailable(meta);
    return {
      userId: ctx.principal.id,
      displayName: rows[0].display_name,
      tenantId: ctx.tenantId,
      tenantName: rows[0].name,
    };
  });
}

export interface AssignableMember {
  userId: UserId;
  displayName: string;
  /** Active human roles that cover the site (tenant-wide or site-scoped). */
  roles: string[];
}

/**
 * Active members of the caller's tenant who hold an operating role at `siteId` (assignment/handoff targets). Only
 * same-tenant principals are ever returned (UI-SPEC §8.0); the caller must be able to read incidents at the site.
 */
export async function listAssignableMembers(
  pool: Db,
  ctx: TenantContext,
  input: { siteId: SiteId | string },
): Promise<AssignableMember[]> {
  const meta = { action: 'member.list', resourceType: 'site', resourceId: String(input.siteId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (typeof input.siteId !== 'string' || !ID.test(input.siteId)) throw unavailable(meta);
    const site = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.siteId]);
    if (site.rowCount !== 1) throw unavailable(meta);
    requireSiteRead(ctx, input.siteId, meta, 'incident.read');
    const { rows } = await c.query<{ user_id: UserId; display_name: string; roles: string[] }>(
      `SELECT u.id AS user_id, u.display_name, array_agg(DISTINCT ra.role ORDER BY ra.role) AS roles
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
         JOIN role_assignments ra ON ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id AND ra.revoked_at IS NULL
        WHERE m.tenant_id = $1 AND m.status = 'ACTIVE' AND ra.principal_kind = 'HUMAN'
          AND ra.role = ANY($3::text[]) AND (ra.site_id IS NULL OR ra.site_id = $2)
        GROUP BY u.id, u.display_name ORDER BY u.display_name, u.id LIMIT 500`,
      [ctx.tenantId, input.siteId, ['operator', 'maintenance_approver', 'engineer']],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      roles: r.roles.filter((x) => (HUMAN_ROLES as readonly string[]).includes(x)),
    }));
  });
}

export interface AssetDevice {
  deviceId: DeviceId;
  siteId: SiteId;
  inputClass: 'PHYSICAL_SENSOR' | 'SIMULATOR';
  status: string;
  channels: { channelId: SensorChannelId; kind: string; unit: string; status: string }[];
}

/** Devices currently bound to an asset (open assignment interval) with their channels' current kind and unit. */
export async function listAssetDevices(
  pool: Db,
  ctx: TenantContext,
  assetId: AssetId | string,
): Promise<AssetDevice[]> {
  const meta = { action: 'asset_devices.list', resourceType: 'asset', resourceId: String(assetId).slice(0, 128) };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (typeof assetId !== 'string' || !ID.test(assetId)) throw unavailable(meta);
    const a = await c.query<{ site_id: SiteId }>(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      assetId,
    ]);
    if (!a.rows[0]) throw unavailable(meta);
    requireSiteRead(ctx, a.rows[0].site_id, meta, 'registry.read');
    const { rows } = await c.query<{
      device_id: DeviceId;
      site_id: SiteId;
      input_class: AssetDevice['inputClass'];
      status: string;
      channel_id: SensorChannelId | null;
      kind: string | null;
      unit: string | null;
      channel_status: string | null;
    }>(
      `SELECT d.id AS device_id, d.site_id, d.input_class, d.status, s.id AS channel_id, r.kind, r.unit,
              s.status AS channel_status
         FROM device_asset_assignments x
         JOIN devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
         LEFT JOIN sensor_channels s ON s.tenant_id = d.tenant_id AND s.device_id = d.id
         LEFT JOIN sensor_channel_revisions r ON r.tenant_id = s.tenant_id AND r.id = s.current_revision_id
        WHERE x.tenant_id = $1 AND x.asset_id = $2 AND x.valid_to IS NULL
        ORDER BY d.id, s.id LIMIT 200`,
      [ctx.tenantId, assetId],
    );
    const out = new Map<string, AssetDevice>();
    for (const r of rows) {
      let d = out.get(r.device_id);
      if (!d) {
        d = { deviceId: r.device_id, siteId: r.site_id, inputClass: r.input_class, status: r.status, channels: [] };
        out.set(r.device_id, d);
      }
      if (r.channel_id && r.kind && r.unit && r.channel_status)
        d.channels.push({ channelId: r.channel_id, kind: r.kind, unit: r.unit, status: r.channel_status });
    }
    return [...out.values()];
  });
}
