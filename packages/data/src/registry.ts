// Tenant/site/asset/device/channel registry repositories (FR-01, FR-02 shared layer, INV-03, INV-10, INV-16).
// Every function takes a server-issued TenantContext; every query is tenant-filtered; every write is authorized,
// audited and appends registry provenance. Asset identity edits append an immutable revision, advance the current
// pointer, rebind still-attached devices to the new revision and invalidate unexecuted approvals bound to the old
// one — all in one transaction, without rewriting any historical row.
import {
  AssetIdSchema,
  DeviceIdSchema,
  IanaTimezoneSchema,
  SiteIdSchema,
  newId,
  type AssetId,
  type AssetRevisionId,
  type DeviceId,
  type SiteId,
  type TenantId,
  type UtcInstant,
  DomainError,
  decodeWire,
  encodeWire,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { authorize, requireAuthorized } from './authz.js';
import { Denial, recordAudit, resourceUnavailable, tenantCommand, unavailable, type CommandMeta } from './command.js';
import { actorOf, assertTenantContext, type TenantContext } from './context.js';
import { assertTenantSecretRef } from './secret-ref.js';
import { dbNow, iso, isoNN, laterThan, UNIQUE_VIOLATION, pgCode, versionConflict, type Db, type Tx } from './db.js';
import { newDataId, type DeviceAssignmentId, type SensorChannelId, type SensorChannelRevisionId } from './ids.js';
import { enqueueJob } from './jobs.js';
import { appendOutboxEvent } from './outbox.js';
import {
  appendRegistryRevision,
  AssetIdentitySchema,
  REGISTRY_BODY_SCHEMAS,
  RegistrySourceSchema,
  type AssetIdentity,
  type RegistryBody,
  type RegistryEntityKind,
  type RegistrySource,
  type SafetyClass,
} from './registry-core.js';

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });
const source = (s: unknown): RegistrySource => {
  const r = RegistrySourceSchema.safeParse(s);
  if (!r.success) throw validation('INVALID_SOURCE');
  return r.data;
};

/** Reads that fall outside the caller's site scope look exactly like missing rows. */
function requireReadable(ctx: TenantContext, siteId: SiteId | null, meta: CommandMeta): void {
  const d = authorize(ctx, { action: 'registry.read', siteId });
  if (!d.allowed)
    throw new Denial(resourceUnavailable(), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      reasonCode: d.reasonCode === 'SITE_OUT_OF_SCOPE' ? 'SITE_OUT_OF_SCOPE' : d.reasonCode,
    });
}

const causation = () => newId('command');

// ---------------------------------------------------------------------------------------------------------------
// Sites

export interface SiteRecord {
  siteId: SiteId;
  tenantId: TenantId;
  name: string;
  timezone: string;
  status: 'ACTIVE' | 'CLOSED';
  version: number;
}
const toSite = (r: Record<string, unknown>): SiteRecord => ({
  siteId: r.id as SiteId,
  tenantId: r.tenant_id as TenantId,
  name: r.name as string,
  timezone: r.timezone as string,
  status: r.status as SiteRecord['status'],
  version: r.version as number,
});

const SiteInputSchema = z.strictObject({ name: z.string().min(1).max(200), timezone: IanaTimezoneSchema });

export async function createSite(
  pool: Db,
  ctx: TenantContext,
  input: { name: string; timezone: string; source: RegistrySource },
): Promise<{ siteId: SiteId; version: number }> {
  const { source: src, ...rest } = input;
  const parsed = SiteInputSchema.safeParse(rest);
  if (!parsed.success) throw validation('INVALID_SITE');
  const siteId = newId('site');
  const meta = { action: 'site.create', resourceType: 'site', resourceId: siteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'registry.write', siteId: null }, undefined, { type: 'site', id: siteId });
    await c.query(`INSERT INTO sites (tenant_id, id, name, timezone) VALUES ($1, $2, $3, $4)`, [
      ctx.tenantId,
      siteId,
      parsed.data.name,
      parsed.data.timezone,
    ]);
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'SITE',
      entityId: siteId,
      body: { name: parsed.data.name, timezone: parsed.data.timezone, status: 'ACTIVE' },
      actor: actorOf(ctx),
      source: source(src),
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { siteId, version: 1 };
  });
}

export async function updateSite(
  pool: Db,
  ctx: TenantContext,
  siteId: SiteId,
  patch: { name?: string; timezone?: string },
  opts: { expectedVersion: number; source: RegistrySource },
): Promise<{ version: number }> {
  const meta = { action: 'site.update', resourceType: 'site', resourceId: siteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`SELECT * FROM sites WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      ctx.tenantId,
      siteId,
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.write', siteId }, undefined, { type: 'site', id: siteId });
    const cur = toSite(rows[0]);
    const next = SiteInputSchema.safeParse({ name: patch.name ?? cur.name, timezone: patch.timezone ?? cur.timezone });
    if (!next.success) throw validation('INVALID_SITE');
    if (cur.version !== opts.expectedVersion) throw versionConflict();
    await c.query(
      `UPDATE sites SET name = $3, timezone = $4, version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, siteId, next.data.name, next.data.timezone],
    );
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'SITE',
      entityId: siteId,
      body: { name: next.data.name, timezone: next.data.timezone, status: cur.status },
      actor: actorOf(ctx),
      source: source(opts.source),
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { version: cur.version + 1 };
  });
}

export async function getSite(pool: Db, ctx: TenantContext, siteId: SiteId): Promise<SiteRecord> {
  const meta = { action: 'site.read', resourceType: 'site', resourceId: siteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`SELECT * FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, siteId]);
    if (!rows[0]) throw unavailable(meta);
    requireReadable(ctx, siteId, meta);
    return toSite(rows[0]);
  });
}

export async function listSites(pool: Db, ctx: TenantContext): Promise<SiteRecord[]> {
  const meta = { action: 'site.list', resourceType: 'site' };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const scope = readableScope(ctx, meta);
    const { rows } = await c.query(
      `SELECT * FROM sites WHERE tenant_id = $1 AND ($2::text[] IS NULL OR id = ANY($2)) ORDER BY created_at, id`,
      [ctx.tenantId, scope],
    );
    return rows.map(toSite);
  });
}

function readableScope(ctx: TenantContext, meta: CommandMeta): SiteId[] | null {
  if (authorize(ctx, { action: 'registry.read', siteId: null }).allowed) return null;
  const sites = [
    ...new Set(
      ctx.grants
        .map((g) => g.siteId)
        .filter((s): s is SiteId => s !== null && authorize(ctx, { action: 'registry.read', siteId: s }).allowed),
    ),
  ];
  if (sites.length === 0) requireReadable(ctx, null, meta);
  return sites;
}

// ---------------------------------------------------------------------------------------------------------------
// Assets and immutable asset revisions

export interface AssetRevisionRecord {
  assetRevisionId: AssetRevisionId;
  tenantId: TenantId;
  assetId: AssetId;
  revision: number;
  manufacturer: string;
  model: string;
  serial: string | null;
  safetyClass: SafetyClass;
  bomRevision: string;
  validFrom: UtcInstant;
  supersededAt: UtcInstant | null;
  identityDigest: string;
}
export interface AssetRecord {
  assetId: AssetId;
  tenantId: TenantId;
  siteId: SiteId;
  status: 'ACTIVE' | 'RETIRED';
  version: number;
  currentRevisionId: AssetRevisionId;
  current: AssetRevisionRecord;
}

const toRevision = (r: Record<string, unknown>): AssetRevisionRecord => ({
  assetRevisionId: r.id as AssetRevisionId,
  tenantId: r.tenant_id as TenantId,
  assetId: r.asset_id as AssetId,
  revision: r.revision as number,
  manufacturer: r.manufacturer as string,
  model: r.model as string,
  serial: (r.serial as string | null) ?? null,
  safetyClass: r.safety_class as SafetyClass,
  bomRevision: r.bom_revision as string,
  validFrom: isoNN(r.valid_from as Date),
  supersededAt: iso((r.superseded_at as Date | null) ?? null),
  identityDigest: r.identity_digest as string,
});

const ASSET_SELECT = `
  SELECT a.id AS a_id, a.tenant_id AS a_tenant_id, a.site_id AS a_site_id, a.status AS a_status, a.version AS a_version,
         a.current_revision_id AS a_current_revision_id, r.*
    FROM assets a
    JOIN asset_revisions r ON r.tenant_id = a.tenant_id AND r.asset_id = a.id AND r.id = a.current_revision_id`;

const toAsset = (r: Record<string, unknown>): AssetRecord => ({
  assetId: r.a_id as AssetId,
  tenantId: r.a_tenant_id as TenantId,
  siteId: r.a_site_id as SiteId,
  status: r.a_status as AssetRecord['status'],
  version: r.a_version as number,
  currentRevisionId: r.a_current_revision_id as AssetRevisionId,
  current: toRevision(r),
});

const identityDigest = (tenantId: TenantId, assetId: AssetId, revision: number, id: AssetIdentity) =>
  canonicalDigest('asset-identity', 1, { tenantId, assetId, revision, ...id });

async function insertAssetRevision(
  c: Tx,
  ctx: TenantContext,
  assetId: AssetId,
  revision: number,
  identity: AssetIdentity,
  validFrom: UtcInstant,
  src: RegistrySource,
): Promise<{ assetRevisionId: AssetRevisionId; identityDigest: string }> {
  const assetRevisionId = newId('assetRevision');
  const digest = identityDigest(ctx.tenantId, assetId, revision, identity);
  const actor = actorOf(ctx);
  try {
    await c.query(
      `INSERT INTO asset_revisions (tenant_id, id, asset_id, revision, manufacturer, model, serial, safety_class, bom_revision,
                                    valid_from, identity_digest, actor_kind, actor_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        ctx.tenantId,
        assetRevisionId,
        assetId,
        revision,
        identity.manufacturer,
        identity.model,
        identity.serial,
        identity.safetyClass,
        identity.bomRevision,
        validFrom,
        digest,
        actor.kind,
        actor.id,
        src,
      ],
    );
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw versionConflict('DUPLICATE_ASSET_IDENTITY');
    throw e;
  }
  return { assetRevisionId, identityDigest: digest };
}

export async function registerAsset(
  pool: Db,
  ctx: TenantContext,
  input: { siteId: SiteId; identity: AssetIdentity; source: RegistrySource },
): Promise<{ assetId: AssetId; assetRevisionId: AssetRevisionId; version: number }> {
  const identity = AssetIdentitySchema.safeParse(input.identity);
  if (!identity.success || !SiteIdSchema.safeParse(input.siteId).success) throw validation('INVALID_ASSET');
  const src = source(input.source);
  const assetId = newId('asset');
  const meta = { action: 'asset.register', resourceType: 'site', resourceId: input.siteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const site = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.siteId]);
    if (site.rowCount !== 1) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.write', siteId: input.siteId }, undefined, {
      type: 'asset',
      id: assetId,
    });
    const now = await dbNow(c);
    const pendingRevisionId = newId('assetRevision');
    // The deferred composite FK checks at commit that the pointer names this asset's own revision.
    await c.query(`INSERT INTO assets (tenant_id, id, site_id, current_revision_id) VALUES ($1, $2, $3, $4)`, [
      ctx.tenantId,
      assetId,
      input.siteId,
      pendingRevisionId,
    ]);
    const rev = await insertAssetRevision(c, ctx, assetId, 1, identity.data, now, src);
    await c.query(`UPDATE assets SET current_revision_id = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      assetId,
      rev.assetRevisionId,
    ]);
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'ASSET',
      entityId: assetId,
      body: {
        siteId: input.siteId,
        assetId,
        assetRevisionId: rev.assetRevisionId,
        revision: 1,
        identity: identity.data,
        identityDigest: rev.identityDigest,
      },
      actor: actorOf(ctx),
      source: src,
    });
    await recordAudit(c, ctx, {
      action: 'asset.register',
      resourceType: 'asset',
      resourceId: assetId,
      result: 'SUCCEEDED',
    });
    return { assetId, assetRevisionId: rev.assetRevisionId, version: 1 };
  });
}

export interface AssetRevisionChange {
  assetRevisionId: AssetRevisionId;
  revision: number;
  version: number;
  invalidatedApprovalIds: string[];
  reboundAssignmentIds: DeviceAssignmentId[];
}

/**
 * INV-03: an identity edit appends a new immutable revision, stamps the old one superseded, advances the pointer,
 * closes and re-creates every open device assignment against the new revision, invalidates unexecuted approvals
 * bound to the superseded revision (append-only event) and enqueues plan revalidation work.
 */
export async function reviseAssetIdentity(
  pool: Db,
  ctx: TenantContext,
  assetId: AssetId,
  identityInput: AssetIdentity,
  opts: { expectedVersion: number; source: RegistrySource },
): Promise<AssetRevisionChange> {
  const identity = AssetIdentitySchema.safeParse(identityInput);
  if (!identity.success) throw validation('INVALID_ASSET');
  const src = source(opts.source);
  const meta = { action: 'asset.revise', resourceType: 'asset', resourceId: assetId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`${ASSET_SELECT} WHERE a.tenant_id = $1 AND a.id = $2 FOR UPDATE OF a`, [
      ctx.tenantId,
      assetId,
    ]);
    if (!rows[0]) throw unavailable(meta);
    const asset = toAsset(rows[0]);
    requireAuthorized(ctx, { action: 'registry.write', siteId: asset.siteId }, undefined, {
      type: 'asset',
      id: assetId,
    });
    if (asset.version !== opts.expectedVersion) throw versionConflict();
    const old = asset.current;
    const same =
      old.manufacturer === identity.data.manufacturer &&
      old.model === identity.data.model &&
      old.serial === identity.data.serial &&
      old.safetyClass === identity.data.safetyClass &&
      old.bomRevision === identity.data.bomRevision;
    if (same) throw validation('IDENTITY_UNCHANGED');

    const now = laterThan(await dbNow(c), old.validFrom);
    await c.query(`UPDATE asset_revisions SET superseded_at = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      old.assetRevisionId,
      now,
    ]);
    const revision = old.revision + 1;
    const rev = await insertAssetRevision(c, ctx, assetId, revision, identity.data, now, src);
    await c.query(
      `UPDATE assets SET current_revision_id = $3, version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, assetId, rev.assetRevisionId],
    );

    // Rebind still-attached devices: close the open interval, append a new one bound to the new revision.
    const open = await c.query(
      `SELECT device_id FROM device_asset_assignments
        WHERE tenant_id = $1 AND asset_id = $2 AND valid_to IS NULL ORDER BY device_id FOR UPDATE`,
      [ctx.tenantId, assetId],
    );
    const reboundAssignmentIds: DeviceAssignmentId[] = [];
    for (const { device_id } of open.rows as { device_id: DeviceId }[]) {
      const r = await appendAssignment(c, ctx, device_id, assetId, rev.assetRevisionId, now, src);
      reboundAssignmentIds.push(r.assignmentId);
    }

    // Invalidate (never edit) unexecuted, unexpired approvals bound to the superseded revision.
    const inv = await c.query<{ approval_id: string }>(
      `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
       SELECT a.tenant_id, 'ape_' || gen_random_uuid(), a.id, 'INVALIDATED', 'ASSET_REVISION_SUPERSEDED', $3, $4
         FROM approvals a
        WHERE a.tenant_id = $1 AND a.asset_revision_id = $2 AND a.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id)
       ON CONFLICT (tenant_id, approval_id) DO NOTHING
       RETURNING approval_id`,
      [ctx.tenantId, old.assetRevisionId, actorOf(ctx).kind, actorOf(ctx).id],
    );
    await enqueueJob(c, ctx, {
      kind: 'plan.revalidate_for_asset_revision',
      payload: { assetId, supersededAssetRevisionId: old.assetRevisionId, currentAssetRevisionId: rev.assetRevisionId },
      dedupeKey: `asset-revision-superseded:${old.assetRevisionId}`,
    });
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'ASSET',
      entityId: assetId,
      body: {
        siteId: asset.siteId,
        assetId,
        assetRevisionId: rev.assetRevisionId,
        revision,
        identity: identity.data,
        identityDigest: rev.identityDigest,
      },
      actor: actorOf(ctx),
      source: src,
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { invalidatedApprovals: inv.rowCount ?? 0 } });
    return {
      assetRevisionId: rev.assetRevisionId,
      revision,
      version: asset.version + 1,
      invalidatedApprovalIds: inv.rows.map((r) => r.approval_id).sort(),
      reboundAssignmentIds,
    };
  });
}

export async function getAsset(pool: Db, ctx: TenantContext, assetId: AssetId): Promise<AssetRecord> {
  const meta = { action: 'asset.read', resourceType: 'asset', resourceId: assetId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`${ASSET_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`, [ctx.tenantId, assetId]);
    if (!rows[0]) throw unavailable(meta);
    const asset = toAsset(rows[0]);
    requireReadable(ctx, asset.siteId, meta);
    return asset;
  });
}

export async function listAssets(pool: Db, ctx: TenantContext, filter: { siteId?: SiteId }): Promise<AssetRecord[]> {
  const meta = { action: 'asset.list', resourceType: 'asset' };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const scope = readableScope(ctx, meta);
    const { rows } = await c.query(
      `${ASSET_SELECT} WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.site_id = $2)
         AND ($3::text[] IS NULL OR a.site_id = ANY($3)) ORDER BY a.created_at, a.id`,
      [ctx.tenantId, filter.siteId ?? null, scope],
    );
    return rows.map(toAsset);
  });
}

export async function getAssetRevision(
  pool: Db,
  ctx: TenantContext,
  assetRevisionId: AssetRevisionId,
): Promise<AssetRevisionRecord> {
  const meta = { action: 'asset_revision.read', resourceType: 'asset_revision', resourceId: assetRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT r.*, a.site_id AS a_site_id FROM asset_revisions r
         JOIN assets a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [ctx.tenantId, assetRevisionId],
    );
    if (!rows[0]) throw unavailable(meta);
    requireReadable(ctx, rows[0].a_site_id, meta);
    return toRevision(rows[0]);
  });
}

export async function listAssetRevisions(
  pool: Db,
  ctx: TenantContext,
  assetId: AssetId,
): Promise<AssetRevisionRecord[]> {
  const meta = { action: 'asset_revision.list', resourceType: 'asset', resourceId: assetId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const a = await c.query(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, assetId]);
    if (!a.rows[0]) throw unavailable(meta);
    requireReadable(ctx, a.rows[0].site_id, meta);
    const { rows } = await c.query(
      `SELECT * FROM asset_revisions WHERE tenant_id = $1 AND asset_id = $2 ORDER BY revision`,
      [ctx.tenantId, assetId],
    );
    return rows.map(toRevision);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Devices and immutable effective-dated device-to-asset assignments

const DEVICE_STATUSES = ['PROVISIONED', 'ONLINE', 'STALE', 'OFFLINE', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
const SecretRef = z.string().regex(/^secretref:[a-z0-9-]{1,32}\/[A-Za-z0-9._/-]{1,200}$/);

export async function registerDevice(
  pool: Db,
  ctx: TenantContext,
  input: { siteId: SiteId; credentialRef: string; source: RegistrySource },
): Promise<{ deviceId: DeviceId }> {
  assertTenantContext(ctx);
  if (!SiteIdSchema.safeParse(input.siteId).success || !SecretRef.safeParse(input.credentialRef).success)
    throw validation('INVALID_DEVICE');
  assertTenantSecretRef(ctx.tenantId, input.credentialRef, 'credentialRef');
  const src = source(input.source);
  const deviceId = newId('device');
  const meta = { action: 'device.register', resourceType: 'site', resourceId: input.siteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const site = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.siteId]);
    if (site.rowCount !== 1) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.write', siteId: input.siteId }, undefined, {
      type: 'device',
      id: deviceId,
    });
    await c.query(`INSERT INTO devices (tenant_id, id, site_id, credential_ref) VALUES ($1, $2, $3, $4)`, [
      ctx.tenantId,
      deviceId,
      input.siteId,
      input.credentialRef,
    ]);
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'DEVICE',
      entityId: deviceId,
      body: { deviceId, siteId: input.siteId, status: 'PROVISIONED', credentialRef: input.credentialRef },
      actor: actorOf(ctx),
      source: src,
    });
    await recordAudit(c, ctx, {
      action: 'device.register',
      resourceType: 'device',
      resourceId: deviceId,
      result: 'SUCCEEDED',
    });
    return { deviceId };
  });
}

export async function setDeviceStatus(
  pool: Db,
  ctx: TenantContext,
  deviceId: DeviceId,
  status: DeviceStatus,
  opts: { source?: RegistrySource } = {},
): Promise<void> {
  if (!(DEVICE_STATUSES as readonly string[]).includes(status)) throw validation('INVALID_DEVICE_STATUS');
  const meta = { action: 'device.status', resourceType: 'device', resourceId: deviceId };
  await tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`SELECT * FROM devices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      ctx.tenantId,
      deviceId,
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.write', siteId: rows[0].site_id }, undefined, {
      type: 'device',
      id: deviceId,
    });
    if (rows[0].status === 'REVOKED' && status !== 'REVOKED') throw validation('DEVICE_REVOKED');
    await c.query(
      `UPDATE devices SET status = $3, version = version + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, deviceId, status],
    );
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'DEVICE',
      entityId: deviceId,
      body: { deviceId, siteId: rows[0].site_id, status, credentialRef: rows[0].credential_ref },
      actor: actorOf(ctx),
      source: source(opts.source ?? 'API'),
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { status } });
  });
}

/** Close the device's open interval (if any) and append the next immutable assignment revision. */
async function appendAssignment(
  c: Tx,
  ctx: TenantContext,
  deviceId: DeviceId,
  assetId: AssetId,
  assetRevisionId: AssetRevisionId,
  at: UtcInstant,
  src: RegistrySource,
): Promise<{ assignmentId: DeviceAssignmentId; revision: number; validFrom: UtcInstant }> {
  const prev = await c.query<{ id: string; revision: number; valid_from: Date }>(
    `SELECT id, revision, valid_from FROM device_asset_assignments
      WHERE tenant_id = $1 AND device_id = $2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
    [ctx.tenantId, deviceId],
  );
  const last = prev.rows[0];
  const validFrom = last ? laterThan(at, last.valid_from) : at;
  await c.query(
    `UPDATE device_asset_assignments SET valid_to = $3 WHERE tenant_id = $1 AND device_id = $2 AND valid_to IS NULL`,
    [ctx.tenantId, deviceId, validFrom],
  );
  const revision = (last?.revision ?? 0) + 1;
  const assignmentId = newDataId('deviceAssignment') as DeviceAssignmentId;
  const actor = actorOf(ctx);
  const digest = canonicalDigest('device-assignment', 1, {
    tenantId: ctx.tenantId,
    deviceId,
    assetId,
    assetRevisionId,
    revision,
    validFrom,
  });
  await c.query(
    `INSERT INTO device_asset_assignments (tenant_id, id, device_id, asset_id, asset_revision_id, revision, valid_from,
                                           assignment_digest, actor_kind, actor_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.tenantId,
      assignmentId,
      deviceId,
      assetId,
      assetRevisionId,
      revision,
      validFrom,
      digest,
      actor.kind,
      actor.id,
      src,
    ],
  );
  await appendOutboxEvent(c, ctx, {
    eventType: 'device.asset_assignment_changed.v1',
    aggregateType: 'device',
    aggregateId: deviceId,
    aggregateVersion: revision,
    payload: { deviceId, assignmentId, assetId, assetRevisionId, revision, validFrom },
    correlationId: ctx.correlationId,
    causationId: causation(),
  });
  return { assignmentId, revision, validFrom };
}

export async function assignDeviceToAsset(
  pool: Db,
  ctx: TenantContext,
  input: { deviceId: DeviceId; assetId: AssetId; source: RegistrySource },
): Promise<{ assignmentId: DeviceAssignmentId; revision: number; assetRevisionId: AssetRevisionId }> {
  const src = source(input.source);
  const meta = { action: 'device.assign', resourceType: 'device', resourceId: input.deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!DeviceIdSchema.safeParse(input.deviceId).success) throw unavailable(meta);
    if (!AssetIdSchema.safeParse(input.assetId).success) throw unavailable(meta, input.assetId, 'asset');
    const dev = await c.query(`SELECT site_id FROM devices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      ctx.tenantId,
      input.deviceId,
    ]);
    if (!dev.rows[0]) throw unavailable(meta);
    const asset = await c.query(`SELECT site_id, current_revision_id FROM assets WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      input.assetId,
    ]);
    if (!asset.rows[0]) throw unavailable(meta, input.assetId, 'asset');
    requireAuthorized(ctx, { action: 'registry.write', siteId: dev.rows[0].site_id }, undefined, {
      type: 'device',
      id: input.deviceId,
    });
    if (asset.rows[0].site_id !== dev.rows[0].site_id) throw validation('DEVICE_AND_ASSET_SITE_MISMATCH');
    const r = await appendAssignment(
      c,
      ctx,
      input.deviceId,
      input.assetId,
      asset.rows[0].current_revision_id,
      await dbNow(c),
      src,
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { assignmentId: r.assignmentId, revision: r.revision, assetRevisionId: asset.rows[0].current_revision_id };
  });
}

export interface DeviceAssignmentRecord {
  assignmentId: DeviceAssignmentId;
  deviceId: DeviceId;
  assetId: AssetId;
  assetRevisionId: AssetRevisionId;
  revision: number;
  validFrom: UtcInstant;
  validTo: UtcInstant | null;
  assignmentDigest: string;
}

export async function listDeviceAssignments(
  pool: Db,
  ctx: TenantContext,
  deviceId: DeviceId,
): Promise<DeviceAssignmentRecord[]> {
  const meta = { action: 'device_assignment.list', resourceType: 'device', resourceId: deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const dev = await c.query(`SELECT site_id FROM devices WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, deviceId]);
    if (!dev.rows[0]) throw unavailable(meta);
    requireReadable(ctx, dev.rows[0].site_id, meta);
    const { rows } = await c.query(
      `SELECT * FROM device_asset_assignments WHERE tenant_id = $1 AND device_id = $2 ORDER BY revision`,
      [ctx.tenantId, deviceId],
    );
    return rows.map((r) => ({
      assignmentId: r.id,
      deviceId: r.device_id,
      assetId: r.asset_id,
      assetRevisionId: r.asset_revision_id,
      revision: r.revision,
      validFrom: isoNN(r.valid_from),
      validTo: iso(r.valid_to),
      assignmentDigest: r.assignment_digest,
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Sensor channels and immutable effective-dated kind/unit/calibration revisions

const CHANNEL_KIND_UNIT = {
  TEMPERATURE: 'MILLI_CELSIUS',
  CURRENT: 'MILLI_AMPERE',
  POWER: 'MILLI_WATT',
  DOOR: 'BOOLEAN',
  HEARTBEAT: 'NONE',
} as const;
export type ChannelKind = keyof typeof CHANNEL_KIND_UNIT;
export interface ChannelRevisionInput {
  kind: ChannelKind;
  unit: (typeof CHANNEL_KIND_UNIT)[ChannelKind];
  sourceUnit?: 'CELSIUS' | 'FAHRENHEIT' | 'KELVIN' | null;
  calibrationRevision: number;
  calibrationOffsetMilli?: number;
  source: RegistrySource;
}

function checkChannel(input: ChannelRevisionInput) {
  const ok =
    Object.hasOwn(CHANNEL_KIND_UNIT, input.kind) &&
    CHANNEL_KIND_UNIT[input.kind] === input.unit &&
    (input.kind === 'TEMPERATURE'
      ? ['CELSIUS', 'FAHRENHEIT', 'KELVIN'].includes(input.sourceUnit ?? '')
      : (input.sourceUnit ?? null) === null) &&
    Number.isSafeInteger(input.calibrationRevision) &&
    input.calibrationRevision >= 1 &&
    Number.isSafeInteger(input.calibrationOffsetMilli ?? 0);
  if (!ok) throw validation('INVALID_CHANNEL_REVISION');
  return {
    kind: input.kind,
    unit: input.unit,
    sourceUnit: input.sourceUnit ?? null,
    calibrationRevision: input.calibrationRevision,
    calibrationOffsetMilli: input.calibrationOffsetMilli ?? 0,
    source: source(input.source),
  };
}

async function appendChannelRevision(
  c: Tx,
  ctx: TenantContext,
  channelId: SensorChannelId,
  deviceId: DeviceId,
  revision: number,
  ch: ReturnType<typeof checkChannel>,
  validFrom: UtcInstant,
): Promise<SensorChannelRevisionId> {
  const id = newDataId('sensorChannelRevision') as SensorChannelRevisionId;
  const actor = actorOf(ctx);
  const digest = canonicalDigest('sensor-channel', 1, {
    tenantId: ctx.tenantId,
    channelId,
    revision,
    kind: ch.kind,
    unit: ch.unit,
    sourceUnit: ch.sourceUnit,
    calibrationRevision: ch.calibrationRevision,
    calibrationOffsetMilli: ch.calibrationOffsetMilli,
    validFrom,
  });
  await c.query(
    `INSERT INTO sensor_channel_revisions (tenant_id, id, channel_id, revision, kind, unit, source_unit, calibration_revision,
                                           calibration_offset_milli, valid_from, channel_digest, actor_kind, actor_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ctx.tenantId,
      id,
      channelId,
      revision,
      ch.kind,
      ch.unit,
      ch.sourceUnit,
      ch.calibrationRevision,
      ch.calibrationOffsetMilli,
      validFrom,
      digest,
      actor.kind,
      actor.id,
      ch.source,
    ],
  );
  await appendRegistryRevision(c, {
    tenantId: ctx.tenantId,
    entityKind: 'SENSOR_CHANNEL',
    entityId: channelId,
    body: {
      deviceId,
      channelRevisionId: id,
      revision,
      kind: ch.kind,
      unit: ch.unit,
      sourceUnit: ch.sourceUnit,
      calibrationRevision: ch.calibrationRevision,
      calibrationOffsetMilli: ch.calibrationOffsetMilli,
    },
    actor,
    source: ch.source,
  });
  await appendOutboxEvent(c, ctx, {
    eventType: 'sensor_channel.revision_changed.v1',
    aggregateType: 'sensor_channel',
    aggregateId: channelId,
    aggregateVersion: revision,
    payload: { channelId, channelRevisionId: id, revision, calibrationRevision: ch.calibrationRevision, validFrom },
    correlationId: ctx.correlationId,
    causationId: causation(),
  });
  return id;
}

export async function createSensorChannel(
  pool: Db,
  ctx: TenantContext,
  input: ChannelRevisionInput & { deviceId: DeviceId },
): Promise<{ channelId: SensorChannelId; channelRevisionId: SensorChannelRevisionId }> {
  const ch = checkChannel(input);
  const channelId = newDataId('sensorChannel') as SensorChannelId;
  const meta = { action: 'sensor_channel.create', resourceType: 'device', resourceId: input.deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const dev = await c.query(`SELECT site_id FROM devices WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      input.deviceId,
    ]);
    if (!dev.rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.write', siteId: dev.rows[0].site_id }, undefined, {
      type: 'sensor_channel',
      id: channelId,
    });
    const now = await dbNow(c);
    const pending = newDataId('sensorChannelRevision');
    await c.query(
      `INSERT INTO sensor_channels (tenant_id, id, device_id, current_revision_id) VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, channelId, input.deviceId, pending],
    );
    const revId = await appendChannelRevision(c, ctx, channelId, input.deviceId, 1, ch, now);
    await c.query(`UPDATE sensor_channels SET current_revision_id = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      channelId,
      revId,
    ]);
    await recordAudit(c, ctx, { ...meta, resourceType: 'sensor_channel', resourceId: channelId, result: 'SUCCEEDED' });
    return { channelId, channelRevisionId: revId };
  });
}

export async function reviseSensorChannel(
  pool: Db,
  ctx: TenantContext,
  channelId: SensorChannelId,
  input: ChannelRevisionInput,
): Promise<{ channelRevisionId: SensorChannelRevisionId; revision: number }> {
  const ch = checkChannel(input);
  const meta = { action: 'sensor_channel.revise', resourceType: 'sensor_channel', resourceId: channelId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT s.device_id, d.site_id, s.version, r.revision, r.valid_from, r.id AS rev_id
         FROM sensor_channels s
         JOIN devices d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
         JOIN sensor_channel_revisions r ON r.tenant_id = s.tenant_id AND r.id = s.current_revision_id
        WHERE s.tenant_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [ctx.tenantId, channelId],
    );
    if (!rows[0]) throw unavailable(meta);
    const cur = rows[0];
    requireAuthorized(ctx, { action: 'registry.write', siteId: cur.site_id }, undefined, {
      type: 'sensor_channel',
      id: channelId,
    });
    const validFrom = laterThan(await dbNow(c), cur.valid_from);
    await c.query(`UPDATE sensor_channel_revisions SET valid_to = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      cur.rev_id,
      validFrom,
    ]);
    const revision = cur.revision + 1;
    const revId = await appendChannelRevision(c, ctx, channelId, cur.device_id, revision, ch, validFrom);
    await c.query(
      `UPDATE sensor_channels SET current_revision_id = $3, version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, channelId, revId],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { channelRevisionId: revId, revision };
  });
}

export interface SensorChannelRevisionRecord {
  channelRevisionId: SensorChannelRevisionId;
  channelId: SensorChannelId;
  revision: number;
  kind: ChannelKind;
  unit: string;
  sourceUnit: string | null;
  calibrationRevision: number;
  calibrationOffsetMilli: number;
  validFrom: UtcInstant;
  validTo: UtcInstant | null;
  channelDigest: string;
}

export async function listSensorChannelRevisions(
  pool: Db,
  ctx: TenantContext,
  channelId: SensorChannelId,
): Promise<SensorChannelRevisionRecord[]> {
  const meta = { action: 'sensor_channel.read', resourceType: 'sensor_channel', resourceId: channelId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const s = await c.query(
      `SELECT d.site_id FROM sensor_channels s JOIN devices d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [ctx.tenantId, channelId],
    );
    if (!s.rows[0]) throw unavailable(meta);
    requireReadable(ctx, s.rows[0].site_id, meta);
    const { rows } = await c.query(
      `SELECT * FROM sensor_channel_revisions WHERE tenant_id = $1 AND channel_id = $2 ORDER BY revision`,
      [ctx.tenantId, channelId],
    );
    return rows.map((r) => ({
      channelRevisionId: r.id,
      channelId: r.channel_id,
      revision: r.revision,
      kind: r.kind,
      unit: r.unit,
      sourceUnit: r.source_unit,
      calibrationRevision: r.calibration_revision,
      calibrationOffsetMilli: r.calibration_offset_milli,
      validFrom: isoNN(r.valid_from),
      validTo: iso(r.valid_to),
      channelDigest: r.channel_digest,
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Generic registry edits (warranty, approved vendor, food-at-risk) and provenance reads

export type RegistryEditKind = 'WARRANTY' | 'APPROVED_VENDOR' | 'FOOD_AT_RISK';
export type RegistryEditInput =
  | { entityKind: 'WARRANTY'; entityId: AssetId; body: RegistryBody<'WARRANTY'>; source: RegistrySource }
  | { entityKind: 'FOOD_AT_RISK'; entityId: AssetId; body: RegistryBody<'FOOD_AT_RISK'>; source: RegistrySource }
  | {
      entityKind: 'APPROVED_VENDOR';
      entityId: string | null;
      body: RegistryBody<'APPROVED_VENDOR'>;
      source: RegistrySource;
    };

export async function recordRegistryEdit(
  pool: Db,
  ctx: TenantContext,
  input: RegistryEditInput,
): Promise<{ entityId: string; revision: number; registryRevisionId: string }> {
  const kind = input.entityKind;
  if (!['WARRANTY', 'APPROVED_VENDOR', 'FOOD_AT_RISK'].includes(kind)) throw validation('INVALID_REGISTRY_KIND');
  // Bodies arrive in domain (output) form, e.g. money as bigint; validate by encoding to the wire form.
  let body: { data: unknown };
  try {
    const schema = REGISTRY_BODY_SCHEMAS[kind] as z.ZodType;
    body = { data: decodeWire(schema, encodeWire(schema, input.body as never)) };
  } catch {
    throw validation('INVALID_REGISTRY_BODY');
  }
  const src = source(input.source);
  const entityId =
    kind === 'APPROVED_VENDOR' && input.entityId === null ? newDataId('approvedVendor') : (input.entityId as string);
  const meta = { action: 'registry.edit', resourceType: kind.toLowerCase(), resourceId: entityId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    let siteId: SiteId | null = null;
    if (kind === 'WARRANTY' || kind === 'FOOD_AT_RISK') {
      const a = await c.query(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, entityId]);
      if (!a.rows[0]) throw unavailable(meta);
      siteId = a.rows[0].site_id;
      const terms = kind === 'WARRANTY' ? (body.data as RegistryBody<'WARRANTY'>).termsBlobId : null;
      if (terms) {
        const b = await c.query(`SELECT 1 FROM evidence_blobs WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, terms]);
        if (b.rowCount !== 1) throw unavailable(meta, terms, 'evidence_blob');
      }
    } else {
      if (input.entityId !== null) {
        const v = await c.query(
          `SELECT 1 FROM registry_revisions WHERE tenant_id = $1 AND entity_kind = 'APPROVED_VENDOR' AND entity_id = $2 LIMIT 1`,
          [ctx.tenantId, entityId],
        );
        if (v.rowCount !== 1) throw unavailable(meta);
      }
      const sites = (body.data as RegistryBody<'APPROVED_VENDOR'>).siteIds;
      if (sites.length > 0) {
        const s = await c.query(`SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1 AND id = ANY($2)`, [
          ctx.tenantId,
          sites,
        ]);
        if (s.rows[0].n !== new Set(sites).size) throw unavailable(meta, null, 'site');
      }
    }
    requireAuthorized(ctx, { action: 'registry.write', siteId }, undefined, { type: meta.resourceType, id: entityId });
    const r = await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: kind,
      entityId,
      body: body.data as never,
      actor: actorOf(ctx),
      source: src,
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { entityId, revision: r.revision, registryRevisionId: r.registryRevisionId };
  });
}

export interface RegistryRevisionRecord {
  registryRevisionId: string;
  entityKind: RegistryEntityKind;
  entityId: string;
  revision: number;
  schemaName: string;
  body: Record<string, unknown>;
  bodyDigest: string;
  actor: { kind: string; id: string | null };
  source: RegistrySource;
  recordedAt: UtcInstant;
}

async function siteOfEntity(c: Tx, tenantId: TenantId, kind: RegistryEntityKind, id: string): Promise<SiteId | null> {
  const q = async (sql: string) =>
    ((await c.query(sql, [tenantId, id])).rows[0]?.site_id as SiteId | undefined) ?? null;
  switch (kind) {
    case 'SITE':
      return id as SiteId;
    case 'ASSET':
    case 'WARRANTY':
    case 'FOOD_AT_RISK':
      return q(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`);
    case 'DEVICE':
      return q(`SELECT site_id FROM devices WHERE tenant_id = $1 AND id = $2`);
    case 'SENSOR_CHANNEL':
      return q(`SELECT d.site_id FROM sensor_channels s JOIN devices d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
                 WHERE s.tenant_id = $1 AND s.id = $2`);
    default:
      return null;
  }
}

export async function listRegistryRevisions(
  pool: Db,
  ctx: TenantContext,
  entityKind: RegistryEntityKind,
  entityId: string,
): Promise<RegistryRevisionRecord[]> {
  const meta = { action: 'registry.history', resourceType: entityKind.toLowerCase(), resourceId: entityId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM registry_revisions WHERE tenant_id = $1 AND entity_kind = $2 AND entity_id = $3 ORDER BY revision`,
      [ctx.tenantId, entityKind, entityId],
    );
    if (rows.length === 0) throw unavailable(meta);
    requireReadable(ctx, await siteOfEntity(c, ctx.tenantId, entityKind, entityId), meta);
    return rows.map((r) => ({
      registryRevisionId: r.id,
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      revision: r.revision,
      schemaName: r.schema_name,
      body: r.body,
      bodyDigest: r.body_digest,
      actor: { kind: r.actor_kind, id: r.actor_id },
      source: r.source,
      recordedAt: isoNN(r.recorded_at),
    }));
  });
}
