// Versioned registry provenance (FR-01): every registration or edit of a tenant, site, asset, device, sensor
// channel, warranty, approved vendor or food-at-risk value appends one immutable `registry_revisions` row with
// actor, source and time. Bodies are runtime-validated, wire-encoded and digested canonically.
import {
  AssetIdSchema,
  AssetRevisionIdSchema,
  BlobIdSchema,
  DeviceIdSchema,
  MoneySchema,
  SiteIdSchema,
  encodeWire,
  type TenantId,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { lockKey, type Tx } from './db.js';
import { newDataId } from './ids.js';
import type { ActorKind } from './context.js';

export const REGISTRY_ENTITY_KINDS = Object.freeze([
  'TENANT',
  'SITE',
  'ASSET',
  'DEVICE',
  'SENSOR_CHANNEL',
  'WARRANTY',
  'APPROVED_VENDOR',
  'FOOD_AT_RISK',
] as const);
export type RegistryEntityKind = (typeof REGISTRY_ENTITY_KINDS)[number];

export const REGISTRY_SOURCES = Object.freeze(['API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION'] as const);
export type RegistrySource = (typeof REGISTRY_SOURCES)[number];
export const RegistrySourceSchema = z.enum(REGISTRY_SOURCES);

const text = (max: number) => z.string().min(1).max(max);
const SAFETY_CLASSES = ['STANDARD', 'ELEVATED', 'SAFETY_CRITICAL'] as const;
export const SafetyClassSchema = z.enum(SAFETY_CLASSES);
export type SafetyClass = z.infer<typeof SafetyClassSchema>;

export const AssetIdentitySchema = z.strictObject({
  manufacturer: text(200),
  model: text(200),
  serial: text(200).nullable(),
  safetyClass: SafetyClassSchema,
  bomRevision: text(100),
});
export type AssetIdentity = z.infer<typeof AssetIdentitySchema>;

export const WarrantyBodySchema = z.strictObject({
  provider: text(200),
  expiresOn: z.iso.date(),
  termsBlobId: BlobIdSchema.nullable(),
});
export const ApprovedVendorBodySchema = z.strictObject({
  vendorName: text(200),
  status: z.enum(['APPROVED', 'SUSPENDED', 'REMOVED']),
  siteIds: z.array(SiteIdSchema).max(1000),
});
export const FoodAtRiskBodySchema = z.strictObject({
  value: MoneySchema,
  basis: z.enum(['INVENTORY_COUNT', 'ESTIMATE', 'POS_IMPORT']),
});

/** Body schema per entity kind (schema name `registry.<kind>.v1`). */
export const REGISTRY_BODY_SCHEMAS = {
  TENANT: z.strictObject({ name: text(200), status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) }),
  SITE: z.strictObject({ name: text(200), timezone: text(64), status: z.enum(['ACTIVE', 'CLOSED']) }),
  ASSET: z.strictObject({
    siteId: SiteIdSchema,
    assetId: AssetIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    revision: z.int().min(1),
    identity: AssetIdentitySchema,
    identityDigest: z.string(),
  }),
  DEVICE: z.strictObject({
    deviceId: DeviceIdSchema,
    siteId: SiteIdSchema,
    status: z.enum(['PROVISIONED', 'ONLINE', 'STALE', 'OFFLINE', 'REVOKED']),
    credentialRef: z.string(),
  }),
  SENSOR_CHANNEL: z.strictObject({
    deviceId: DeviceIdSchema,
    channelRevisionId: z.string(),
    revision: z.int().min(1),
    kind: z.string(),
    unit: z.string(),
    sourceUnit: z.string().nullable(),
    calibrationRevision: z.int().min(1),
    calibrationOffsetMilli: z.int(),
  }),
  WARRANTY: WarrantyBodySchema,
  APPROVED_VENDOR: ApprovedVendorBodySchema,
  FOOD_AT_RISK: FoodAtRiskBodySchema,
} as const satisfies Record<RegistryEntityKind, z.ZodType>;
export type RegistryBody<K extends RegistryEntityKind> = z.output<(typeof REGISTRY_BODY_SCHEMAS)[K]>;

export const schemaNameOf = (kind: RegistryEntityKind) => `registry.${kind.toLowerCase()}.v1`;

export interface RegistryAppend<K extends RegistryEntityKind> {
  tenantId: TenantId;
  entityKind: K;
  entityId: string;
  body: RegistryBody<K>;
  actor: { kind: ActorKind; id: string | null };
  source: RegistrySource;
}

export async function appendRegistryRevision<K extends RegistryEntityKind>(
  client: Tx,
  input: RegistryAppend<K>,
): Promise<{ registryRevisionId: string; revision: number; bodyDigest: string }> {
  const schema = REGISTRY_BODY_SCHEMAS[input.entityKind] as z.ZodType;
  const wire = encodeWire(schema, input.body) as Record<string, unknown>;
  await lockKey(client, `registry:${input.tenantId}:${input.entityKind}:${input.entityId}`);
  const { rows } = await client.query<{ next: number }>(
    `SELECT coalesce(max(revision), 0) + 1 AS next FROM registry_revisions
      WHERE tenant_id = $1 AND entity_kind = $2 AND entity_id = $3`,
    [input.tenantId, input.entityKind, input.entityId],
  );
  const revision = rows[0]!.next;
  const schemaName = schemaNameOf(input.entityKind);
  const bodyDigest = canonicalDigest('registry', 1, {
    tenantId: input.tenantId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    revision,
    schemaName,
    body: wire,
  });
  const registryRevisionId = newDataId('registryRevision');
  await client.query(
    `INSERT INTO registry_revisions (tenant_id, id, entity_kind, entity_id, revision, schema_name, body, body_digest, actor_kind, actor_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.tenantId,
      registryRevisionId,
      input.entityKind,
      input.entityId,
      revision,
      schemaName,
      JSON.stringify(wire),
      bodyDigest,
      input.actor.kind,
      input.actor.id,
      input.source,
    ],
  );
  return { registryRevisionId, revision, bodyDigest };
}
