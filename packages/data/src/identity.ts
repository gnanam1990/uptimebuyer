// Identity administration: global users (OIDC subject mapping), platform tenant provisioning, memberships, role
// grants and the separate service/integration principals. Grants are tenant- and optionally site-scoped.
import {
  DomainError,
  ProviderAccountIdSchema,
  ServiceIdentityIdSchema,
  SiteIdSchema,
  UserIdSchema,
  newId,
  type ProviderAccountId,
  type ServiceIdentityId,
  type SiteId,
  type TenantId,
  type UserId,
} from '@uptimebuyer/contracts';
import { z } from 'zod';
import { requireAuthorized } from './authz.js';
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { actorOf, assertTenantContext, humanActor, HUMAN_ROLES, type Role, type TenantContext } from './context.js';
import { assertTenantSecretRef } from './secret-ref.js';
import { UNIQUE_VIOLATION, pgCode, versionConflict, withTransaction, type Db } from './db.js';
import { IntegrationIdentityIdSchema, newDataId, type IntegrationIdentityId, type RoleAssignmentId } from './ids.js';
import { appendRegistryRevision, RegistrySourceSchema, type RegistrySource } from './registry-core.js';

const validation = (reasonCode: string, message = 'Input failed contract validation.') =>
  new DomainError('VALIDATION_FAILED', message, { reasonCode });

export const SecretRefSchema = z.string().regex(/^secretref:[a-z0-9-]{1,32}\/[A-Za-z0-9._/-]{1,200}$/);

/** Create or refresh the global user for an OIDC subject (first sign-in / directory sync). */
export async function upsertUser(
  pool: Db,
  input: { issuer: string; externalSubject: string; displayName: string },
): Promise<{ userId: UserId }> {
  const parsed = z
    .strictObject({
      issuer: z.string().min(1).max(512),
      externalSubject: z.string().min(1).max(255),
      displayName: z.string().min(1).max(200),
    })
    .safeParse(input);
  if (!parsed.success) throw validation('INVALID_USER');
  const { rows } = await pool.query<{ id: UserId; issuer: string }>(
    `INSERT INTO users (id, issuer, external_subject, display_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_subject) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = clock_timestamp()
     RETURNING id, issuer`,
    [newId('user'), input.issuer, input.externalSubject, input.displayName],
  );
  if (rows[0]!.issuer !== input.issuer) throw validation('SUBJECT_BOUND_TO_OTHER_ISSUER');
  return { userId: rows[0]!.id };
}

/**
 * Platform provisioning (operator tooling, not tenant-callable): creates the tenant, its first registry revision
 * and a tenant-wide administrator grant for an existing user, atomically.
 */
export async function provisionTenant(
  pool: Db,
  input: { name: string; adminUserId: UserId; source: RegistrySource },
): Promise<{ tenantId: TenantId }> {
  if (!UserIdSchema.safeParse(input.adminUserId).success || !RegistrySourceSchema.safeParse(input.source).success)
    throw validation('INVALID_PROVISIONING_REQUEST');
  const tenantId = newId('tenant');
  return withTransaction(pool, async (c) => {
    await c.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, input.name]);
    await appendRegistryRevision(c, {
      tenantId,
      entityKind: 'TENANT',
      entityId: tenantId,
      body: { name: input.name, status: 'ACTIVE' },
      actor: { kind: 'PLATFORM', id: null },
      source: input.source,
    });
    await c.query(`INSERT INTO tenant_memberships (tenant_id, id, user_id) VALUES ($1, $2, $3)`, [
      tenantId,
      newDataId('membership'),
      input.adminUserId,
    ]);
    await c.query(
      `INSERT INTO role_assignments (tenant_id, id, principal_kind, user_id, role, site_id, granted_by_user_id)
       VALUES ($1, $2, 'HUMAN', $3, 'admin', NULL, NULL)`,
      [tenantId, newDataId('roleAssignment'), input.adminUserId],
    );
    await c.query(
      `INSERT INTO audit_entries (tenant_id, id, actor_kind, actor_id, action, resource_type, resource_id, result, correlation_id)
       VALUES ($1, $2, 'PLATFORM', NULL, 'tenant.provision', 'tenant', $1, 'SUCCEEDED', $3)`,
      [tenantId, newDataId('audit'), newId('correlation')],
    );
    return { tenantId };
  });
}

export async function updateTenantProfile(
  pool: Db,
  ctx: TenantContext,
  patch: { name: string },
  opts: { expectedVersion: number; source: RegistrySource },
): Promise<{ version: number }> {
  const meta = { action: 'tenant.update', resourceType: 'tenant', resourceId: ctx.tenantId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'registry.write', siteId: null }, undefined, { type: 'tenant', id: ctx.tenantId });
    const { rows } = await c.query(`SELECT name, status, version FROM tenants WHERE id = $1 FOR UPDATE`, [
      ctx.tenantId,
    ]);
    const t = rows[0]!;
    if (t.version !== opts.expectedVersion) throw versionConflict();
    await c.query(`UPDATE tenants SET name = $2, version = version + 1, updated_at = clock_timestamp() WHERE id = $1`, [
      ctx.tenantId,
      patch.name,
    ]);
    await appendRegistryRevision(c, {
      tenantId: ctx.tenantId,
      entityKind: 'TENANT',
      entityId: ctx.tenantId,
      body: { name: patch.name, status: t.status },
      actor: actorOf(ctx),
      source: opts.source,
    });
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { version: t.version + 1 };
  });
}

export async function addMembership(pool: Db, ctx: TenantContext, userId: UserId): Promise<{ membershipId: string }> {
  const meta = { action: 'membership.add', resourceType: 'user', resourceId: userId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null }, undefined, { type: 'user', id: userId });
    if (!UserIdSchema.safeParse(userId).success) throw unavailable(meta);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tenant_memberships (tenant_id, id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'ACTIVE', updated_at = clock_timestamp()
       RETURNING id`,
      [ctx.tenantId, newDataId('membership'), userId],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { membershipId: rows[0]!.id };
  });
}

export type GrantPrincipal =
  | { kind: 'HUMAN'; userId: UserId }
  | { kind: 'SERVICE'; serviceIdentityId: ServiceIdentityId }
  | { kind: 'INTEGRATION'; integrationIdentityId: IntegrationIdentityId };

const GrantSchema = z.strictObject({
  principal: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('HUMAN'), userId: UserIdSchema }),
    z.strictObject({ kind: z.literal('SERVICE'), serviceIdentityId: ServiceIdentityIdSchema }),
    z.strictObject({ kind: z.literal('INTEGRATION'), integrationIdentityId: IntegrationIdentityIdSchema }),
  ]),
  role: z.string(),
  siteId: SiteIdSchema.nullable(),
});

const roleFits = (kind: GrantPrincipal['kind'], role: string) =>
  kind === 'HUMAN'
    ? (HUMAN_ROLES as readonly string[]).includes(role)
    : kind === 'SERVICE'
      ? role === 'worker'
      : role === 'integration';

/** Grant a role (idempotent while active). Devices hold no roles; role/principal-kind pairs are fixed. */
export async function assignRole(
  pool: Db,
  ctx: TenantContext,
  input: { principal: GrantPrincipal; role: Role; siteId: SiteId | null },
): Promise<{ assignmentId: RoleAssignmentId }> {
  const parsed = GrantSchema.safeParse(input);
  if (!parsed.success || !roleFits(parsed.data.principal.kind, parsed.data.role))
    throw validation('INVALID_ROLE_GRANT');
  const p = parsed.data.principal;
  const principalId =
    p.kind === 'HUMAN' ? p.userId : p.kind === 'SERVICE' ? p.serviceIdentityId : p.integrationIdentityId;
  const meta = { action: 'role.assign', resourceType: 'role_assignment', resourceId: principalId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null }, undefined, {
      type: 'role_assignment',
      id: principalId,
    });
    const grantor = humanActor(ctx);
    const existing = await c.query<{ id: RoleAssignmentId }>(
      `SELECT id FROM role_assignments WHERE tenant_id = $1 AND principal_kind = $2
         AND coalesce(user_id, service_identity_id, integration_identity_id) = $3 AND role = $4
         AND site_id IS NOT DISTINCT FROM $5 AND revoked_at IS NULL`,
      [ctx.tenantId, p.kind, principalId, input.role, input.siteId],
    );
    if (existing.rows[0]) return { assignmentId: existing.rows[0].id };
    const assignmentId = newDataId('roleAssignment') as RoleAssignmentId;
    try {
      await c.query(
        `INSERT INTO role_assignments (tenant_id, id, principal_kind, user_id, service_identity_id, integration_identity_id, role, site_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          ctx.tenantId,
          assignmentId,
          p.kind,
          p.kind === 'HUMAN' ? principalId : null,
          p.kind === 'SERVICE' ? principalId : null,
          p.kind === 'INTEGRATION' ? principalId : null,
          input.role,
          input.siteId,
          grantor,
        ],
      );
    } catch (e) {
      if (pgCode(e) === UNIQUE_VIOLATION) throw versionConflict('CONCURRENT_GRANT');
      throw e;
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { role: input.role } });
    return { assignmentId };
  });
}

export async function revokeRole(pool: Db, ctx: TenantContext, assignmentId: RoleAssignmentId): Promise<void> {
  const meta = { action: 'role.revoke', resourceType: 'role_assignment', resourceId: assignmentId };
  await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null }, undefined, {
      type: 'role_assignment',
      id: assignmentId,
    });
    const r = await c.query(
      `UPDATE role_assignments SET revoked_at = clock_timestamp(), revoked_by_user_id = $3
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [ctx.tenantId, assignmentId, humanActor(ctx)],
    );
    if (r.rowCount !== 1) throw unavailable(meta);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
  });
}

const WORKLOADS = ['api', 'general-worker', 'kite-broker', 'sensor-gateway', 'serv-agent'] as const;

/**
 * Suspend, reactivate or remove a tenant membership (tenant-wide administrators). This UPDATEs the membership row, so
 * it serializes with any decision that share-locked that membership (M11 recovery PASSED re-checks its attesters).
 */
export async function setMembershipStatus(
  pool: Db,
  ctx: TenantContext,
  userId: UserId | string,
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED',
): Promise<void> {
  if (!['ACTIVE', 'SUSPENDED', 'REMOVED'].includes(status)) throw validation('INVALID_MEMBERSHIP_STATUS');
  const meta = { action: 'membership.status', resourceType: 'tenant_membership', resourceId: String(userId) };
  await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null });
    const { rowCount } = await c.query(
      `UPDATE tenant_memberships SET status = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2`,
      [ctx.tenantId, userId, status],
    );
    if (rowCount !== 1) throw unavailable(meta);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { status } });
  });
}

export async function registerServiceIdentity(
  pool: Db,
  ctx: TenantContext,
  input: { workload: (typeof WORKLOADS)[number]; credentialRef: string },
): Promise<{ serviceIdentityId: ServiceIdentityId }> {
  if (
    !(WORKLOADS as readonly string[]).includes(input.workload) ||
    !SecretRefSchema.safeParse(input.credentialRef).success
  )
    throw validation('INVALID_SERVICE_IDENTITY');
  assertTenantContext(ctx);
  assertTenantSecretRef(ctx.tenantId, input.credentialRef, 'credentialRef');
  const serviceIdentityId = newId('serviceIdentity');
  const meta = { action: 'service_identity.register', resourceType: 'service_identity', resourceId: serviceIdentityId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null });
    await c.query(`INSERT INTO service_identities (tenant_id, id, workload, credential_ref) VALUES ($1, $2, $3, $4)`, [
      ctx.tenantId,
      serviceIdentityId,
      input.workload,
      input.credentialRef,
    ]);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { serviceIdentityId };
  });
}

export async function registerIntegrationIdentity(
  pool: Db,
  ctx: TenantContext,
  input: { providerAccountId: ProviderAccountId | null; credentialRef: string },
): Promise<{ integrationIdentityId: IntegrationIdentityId }> {
  if (
    !SecretRefSchema.safeParse(input.credentialRef).success ||
    (input.providerAccountId !== null && !ProviderAccountIdSchema.safeParse(input.providerAccountId).success)
  )
    throw validation('INVALID_INTEGRATION_IDENTITY');
  assertTenantContext(ctx);
  assertTenantSecretRef(ctx.tenantId, input.credentialRef, 'credentialRef');
  const integrationIdentityId = newDataId('integrationIdentity') as IntegrationIdentityId;
  const meta = {
    action: 'integration_identity.register',
    resourceType: 'integration_identity',
    resourceId: integrationIdentityId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'role.assign', siteId: null });
    await c.query(
      `INSERT INTO integration_identities (tenant_id, id, provider_account_id, credential_ref) VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, integrationIdentityId, input.providerAccountId, input.credentialRef],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { integrationIdentityId };
  });
}
