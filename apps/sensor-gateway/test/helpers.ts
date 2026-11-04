// Shared fixtures for the M03 gateway integration tests: a throwaway database (M02 helpers), a seeded tenant with
// a site, an asset, provisioned devices with runtime-generated credentials, sensor channels and assignments, an
// in-process gateway driven by a manual clock, and a signed-request helper. No secret is persisted anywhere.
import { randomBytes } from 'node:crypto';
import type { AssetId, DeviceId, SiteId, TenantId } from '@uptimebuyer/contracts';
import {
  InMemoryCredentialResolver,
  assignDeviceToAsset,
  createSensorChannel,
  createSite,
  registerAsset,
  registerDevice,
  signPrincipalToken,
  type ChannelKind,
  type SensorChannelId,
  type TenantContext,
} from '@uptimebuyer/data';
import {
  ManualClock,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signTelemetryBody,
  type DeviceMessage,
  type TelemetrySample,
} from '@uptimebuyer/telemetry';
import {
  createTestDatabase,
  dbScripts,
  seedTenant,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from '../../../packages/data/test/helpers.js';
import { buildSensorGateway, type GatewayOptions, type SensorGateway } from '../src/index.js';

export { createTestDatabase, dbScripts, seedTenant, TestIdentityProvider };
export type { SeededTenant, TestDatabase };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TestDevice {
  deviceId: DeviceId;
  siteId: SiteId;
  key: Uint8Array;
  credentialRef: string;
  channels: Record<string, SensorChannelId>;
  assignmentId: string | null;
}

export interface World {
  db: TestDatabase;
  idp: TestIdentityProvider;
  tenant: SeededTenant;
  admin: TenantContext;
  siteId: SiteId;
  assetId: AssetId;
  creds: InMemoryCredentialResolver;
  clock: ManualClock;
  gw: SensorGateway;
  close(): Promise<void>;
}

type ChannelSpec = { name: string; kind: ChannelKind; sourceUnit?: 'CELSIUS' | 'FAHRENHEIT' | 'KELVIN' };
const UNIT_FOR: Record<ChannelKind, string> = {
  TEMPERATURE: 'MILLI_CELSIUS',
  CURRENT: 'MILLI_AMPERE',
  POWER: 'MILLI_WATT',
  DOOR: 'BOOLEAN',
  HEARTBEAT: 'NONE',
};

export const DEFAULT_CHANNELS: ChannelSpec[] = [
  { name: 'temp', kind: 'TEMPERATURE', sourceUnit: 'CELSIUS' },
  { name: 'door', kind: 'DOOR' },
  { name: 'heartbeat', kind: 'HEARTBEAT' },
];

/** Provision a device with a runtime-generated 256-bit key, channels and (optionally) an asset assignment. */
export async function provisionDevice(
  w: Pick<World, 'db' | 'admin' | 'creds'>,
  opts: {
    siteId: SiteId;
    assetId?: AssetId | null;
    channels?: ChannelSpec[];
    inputClass?: 'PHYSICAL_SENSOR' | 'SIMULATOR';
    admin?: TenantContext;
    creds?: InMemoryCredentialResolver;
  },
): Promise<TestDevice> {
  const admin = opts.admin ?? w.admin;
  const creds = opts.creds ?? w.creds;
  const label = randomBytes(6).toString('hex');
  const credentialRef = `secretref:device/tenants/${admin.tenantId}/${label}`;
  const key = new Uint8Array(randomBytes(32));
  creds.set(credentialRef, key);
  const { deviceId } = await registerDevice(w.db.pool, admin, {
    siteId: opts.siteId,
    credentialRef,
    source: 'PROVISIONING',
    ...(opts.inputClass ? { inputClass: opts.inputClass } : {}),
  });
  let assignmentId: string | null = null;
  if (opts.assetId) {
    const a = await assignDeviceToAsset(w.db.pool, admin, { deviceId, assetId: opts.assetId, source: 'API' });
    assignmentId = a.assignmentId;
  }
  const channels: Record<string, SensorChannelId> = {};
  for (const c of opts.channels ?? DEFAULT_CHANNELS) {
    const r = await createSensorChannel(w.db.pool, admin, {
      deviceId,
      kind: c.kind,
      unit: UNIT_FOR[c.kind] as never,
      sourceUnit: c.kind === 'TEMPERATURE' ? (c.sourceUnit ?? 'CELSIUS') : null,
      calibrationRevision: 1,
      calibrationOffsetMilli: 0,
      source: 'API',
    });
    channels[c.name] = r.channelId;
  }
  return { deviceId, siteId: opts.siteId, key, credentialRef, channels, assignmentId };
}

export async function createWorld(label: string, gatewayOptions: Partial<GatewayOptions> = {}): Promise<World> {
  const db = await createTestDatabase(label);
  await (await dbScripts()).migrate(db.url);
  const idp = await TestIdentityProvider.create();
  const tenant = await seedTenant(db.pool, idp, `${label}-alpha`);
  const admin = tenant.admin;
  const site = await createSite(db.pool, admin, { name: `${label} store`, timezone: 'Europe/London', source: 'API' });
  const asset = await registerAsset(db.pool, admin, {
    siteId: site.siteId,
    identity: {
      manufacturer: 'True',
      model: 'T-49',
      serial: `${label}-SN-${randomBytes(3).toString('hex')}`,
      safetyClass: 'STANDARD',
      bomRevision: 'BOM-3',
    },
    source: 'API',
  });
  const creds = new InMemoryCredentialResolver();
  // The manual clock starts at real time (database effective dates come from the database clock).
  const clock = new ManualClock(Date.now());
  const gw = await buildSensorGateway({ pool: db.pool, credentials: creds, clock, ...gatewayOptions });
  return {
    db,
    idp,
    tenant,
    admin,
    siteId: site.siteId,
    assetId: asset.assetId,
    creds,
    clock,
    gw,
    async close() {
      await gw.close();
      await db.drop();
    },
  };
}

/**
 * Move the manual clock up to real time plus a small lead (registry effective dates come from the database clock,
 * so readings stamped shortly before "now" still postdate a just-provisioned binding; open intervals cover the
 * lead). The clock never moves backwards, so a test that advanced it keeps its later notion of "now".
 */
export function syncClock(w: Pick<World, 'clock'>, aheadMs = 1_000): number {
  w.clock.set(Math.max(w.clock.now(), Date.now() + aheadMs));
  return w.clock.now();
}

/** The identity fields of an asset revision (what reviseAssetIdentity accepts). */
export function identityOf(r: {
  manufacturer: string;
  model: string;
  serial: string | null;
  safetyClass: 'STANDARD' | 'ELEVATED' | 'SAFETY_CRITICAL';
  bomRevision: string;
}) {
  return {
    manufacturer: r.manufacturer,
    model: r.model,
    serial: r.serial,
    safetyClass: r.safetyClass,
    bomRevision: r.bomRevision,
  };
}

export const iso = (ms: number) => new Date(ms).toISOString() as DeviceMessage['eventAt'];

export function message(
  sequence: number,
  eventAtMs: number,
  samples: TelemetrySample[],
  bootId = 'boot_fixture-0001',
): DeviceMessage {
  return { bootId, sequence, eventAt: iso(eventAtMs), samples };
}

export const temp = (channel: string, valueInt: number, extra: Partial<TelemetrySample> = {}): TelemetrySample => ({
  channel,
  valueInt,
  unit: 'mC',
  quality: 'GOOD',
  ...extra,
});

export interface PostOptions {
  delivery?: 'LIVE' | 'BACKFILL';
  token?: string | null;
  tokenKey?: Uint8Array;
  signingKey?: Uint8Array;
  timestampMs?: number;
  signature?: string | null;
  tenantHeader?: string;
  bodyDeviceId?: string;
  mutateBody?: (raw: string) => string;
  extra?: Record<string, unknown>;
  disclosures?: unknown[];
}

export interface PostResult {
  status: number;
  body: Record<string, unknown> & {
    results?: { status: string; reasonCode: string | null; sequence: number; channel: string; sampleId?: string }[];
  };
  headers: Record<string, unknown>;
}

/** Sign and post one batch exactly as a device would; every component can be overridden to build attacks. */
export async function post(
  w: Pick<World, 'gw' | 'clock'>,
  device: TestDevice,
  messages: DeviceMessage[],
  o: PostOptions = {},
): Promise<PostResult> {
  const batch = {
    schemaVersion: 1,
    deviceId: o.bodyDeviceId ?? device.deviceId,
    delivery: o.delivery ?? 'LIVE',
    sentAt: iso(w.clock.now()),
    messages,
    disclosures: o.disclosures ?? [],
    ...o.extra,
  };
  let raw = JSON.stringify(batch);
  const ts = o.timestampMs ?? w.clock.now();
  const signature =
    o.signature === undefined ? signTelemetryBody(o.signingKey ?? device.key, ts, device.deviceId, raw) : o.signature;
  if (o.mutateBody) raw = o.mutateBody(raw);
  const token =
    o.token === undefined ? await signPrincipalToken('DEVICE', device.deviceId, o.tokenKey ?? device.key) : o.token;
  const headers: Record<string, string> = { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (signature !== null) headers[SIGNATURE_HEADER] = signature;
  if (o.tenantHeader !== undefined) headers['x-tenant-id'] = o.tenantHeader;
  const res = await w.gw.app.inject({ method: 'POST', url: '/v1/device/telemetry:batch', headers, payload: raw });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

/** Row counts of every M03 table, to prove a rejected request changed nothing. */
export async function telemetryCounts(db: TestDatabase, tenantId?: TenantId): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [
    'telemetry_batches',
    'telemetry_samples',
    'telemetry_rejections',
    'telemetry_sequence_gaps',
    'telemetry_drop_disclosures',
    'telemetry_channel_health',
  ]) {
    const r = await db.admin(
      `SELECT count(*)::int AS n FROM ${t}${tenantId ? ' WHERE tenant_id = $1' : ''}`,
      tenantId ? [tenantId] : [],
    );
    out[t] = r.rows[0].n;
  }
  return out;
}

/** Full-row digest of a sample, to prove it never changes. */
export async function sampleRowDigest(db: TestDatabase, sampleId: string): Promise<string> {
  const r = await db.admin(`SELECT md5(to_jsonb(s)::text) AS d FROM telemetry_samples s WHERE id = $1`, [sampleId]);
  return r.rows[0].d;
}
