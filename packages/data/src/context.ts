// Server-derived tenant context (INV-16, API-EVENT-SPEC §1). A TenantContext exists only when this module issues
// it from an authenticated principal plus its active membership/binding; repositories reject anything else, so a
// tenant can never be selected by an unverified client field. X-Tenant-ID is only a request for one of the
// principal's own tenants: a non-member, nonexistent or malformed value is refused identically and audited.
import {
  DomainError,
  TenantIdSchema,
  newId,
  type CorrelationId,
  type DeviceId,
  type ServiceIdentityId,
  type SiteId,
  type TenantId,
  type UserId,
  type UtcInstant,
  type ProviderAccountId,
} from '@uptimebuyer/contracts';
import { isoNN, type Db, type Queryable, type Tx } from './db.js';
import type { IntegrationIdentityId, RoleAssignmentId } from './ids.js';
import { recordSecurityAudit } from './security-audit.js';

export const HUMAN_ROLES = Object.freeze([
  'viewer',
  'operator',
  'maintenance_approver',
  'finance_approver',
  'engineer',
  'admin',
  'auditor',
] as const);
export type HumanRole = (typeof HUMAN_ROLES)[number];
/** `worker` is the only service role, `integration` the only integration role; device authority is implied. */
export const ROLES = Object.freeze([...HUMAN_ROLES, 'worker', 'integration', 'device'] as const);
export type Role = (typeof ROLES)[number];

export type PrincipalKind = 'HUMAN' | 'DEVICE' | 'SERVICE' | 'INTEGRATION';
export type Principal =
  | { readonly kind: 'HUMAN'; readonly id: UserId; readonly issuer: string; readonly subject: string }
  | { readonly kind: 'DEVICE'; readonly id: DeviceId; readonly tenantId: TenantId; readonly siteId: SiteId }
  | { readonly kind: 'SERVICE'; readonly id: ServiceIdentityId; readonly tenantId: TenantId; readonly workload: string }
  | {
      readonly kind: 'INTEGRATION';
      readonly id: IntegrationIdentityId;
      readonly tenantId: TenantId;
      readonly providerAccountId: ProviderAccountId | null;
    };
/** Internal principal for outbox consumers and job handlers; derived from the durable row, never authenticated. */
export type WorkerPrincipal = {
  readonly kind: 'WORKER';
  readonly id: string;
  readonly source: 'JOB' | 'OUTBOX';
  readonly sourceId: string;
};
export type ContextPrincipal = Principal | WorkerPrincipal;

export interface AuthenticatedPrincipal {
  readonly principal: Principal;
  readonly method: 'OIDC' | 'DEVICE_TOKEN' | 'SERVICE_TOKEN' | 'INTEGRATION_TOKEN';
  readonly authenticatedAt: UtcInstant;
}

export interface RoleGrant {
  readonly role: Role;
  /** null = tenant-wide grant. */
  readonly siteId: SiteId | null;
  /** null for implied grants (devices). */
  readonly assignmentId: RoleAssignmentId | null;
}

export interface TenantContext {
  readonly tenantId: TenantId;
  readonly principal: ContextPrincipal;
  readonly grants: readonly RoleGrant[];
  readonly correlationId: CorrelationId;
  readonly resolvedAt: UtcInstant;
}

const issuedPrincipals = new WeakSet<object>();
const issuedContexts = new WeakSet<object>();

const unauthenticated = () =>
  new DomainError('UNAUTHENTICATED', 'A server-issued authenticated context is required.', {
    reasonCode: 'CONTEXT_NOT_ISSUED',
  });

/** @internal Used only by the authentication adapters in this package. */
export function issuePrincipal(principal: Principal, method: AuthenticatedPrincipal['method']): AuthenticatedPrincipal {
  const auth = Object.freeze({
    principal: Object.freeze({ ...principal }),
    method,
    authenticatedAt: isoNN(new Date()),
  });
  issuedPrincipals.add(auth);
  return auth;
}

export function assertAuthenticated(auth: unknown): asserts auth is AuthenticatedPrincipal {
  if (typeof auth !== 'object' || auth === null || !issuedPrincipals.has(auth)) throw unauthenticated();
}

export function assertTenantContext(ctx: unknown): asserts ctx is TenantContext {
  if (typeof ctx !== 'object' || ctx === null || !issuedContexts.has(ctx)) throw unauthenticated();
}

function issueContext(
  tenantId: TenantId,
  principal: ContextPrincipal,
  grants: RoleGrant[],
  correlationId: CorrelationId,
): TenantContext {
  const ctx: TenantContext = Object.freeze({
    tenantId,
    principal: Object.freeze({ ...principal }),
    grants: Object.freeze(grants.map((g) => Object.freeze({ ...g }))),
    correlationId,
    resolvedAt: isoNN(new Date()),
  });
  issuedContexts.add(ctx);
  return ctx;
}

/** @internal Worker context for a durable outbox/job row. Grants nothing beyond worker-permitted reads. */
export function issueWorkerContext(
  tenantId: TenantId,
  worker: WorkerPrincipal,
  correlationId: CorrelationId = newId('correlation'),
): TenantContext {
  return issueContext(tenantId, worker, [], correlationId);
}

const TENANT_UNAVAILABLE = 'Tenant context is not available for this principal.';

/**
 * Resolve the tenant for an authenticated principal. `requestedTenant` is the raw X-Tenant-ID header value (or
 * undefined when absent). Humans may name only an active membership; an absent header defaults only to a single
 * membership. Device, service and integration principals are bound to the tenant of their own row.
 */
export async function resolveTenantContext(
  pool: Db,
  auth: AuthenticatedPrincipal,
  requestedTenant: string | undefined,
  opts: { correlationId?: CorrelationId } = {},
): Promise<TenantContext> {
  assertAuthenticated(auth);
  const p = auth.principal;
  const correlationId = opts.correlationId ?? newId('correlation');
  const deny = async (reasonCode: string): Promise<never> => {
    await recordSecurityAudit(pool, {
      principal: { kind: p.kind, id: p.id },
      action: 'tenant.resolve',
      requested: requestedTenant ?? null,
      result: 'DENIED',
      reasonCode,
      correlationId,
    });
    throw new DomainError('FORBIDDEN', TENANT_UNAVAILABLE);
  };
  const requested = requestedTenant === undefined ? undefined : TenantIdSchema.safeParse(requestedTenant);
  if (requested && !requested.success) return deny('MALFORMED_TENANT_HEADER');

  let tenantId: TenantId;
  if (p.kind === 'HUMAN') {
    const { rows } = await pool.query<{ tenant_id: TenantId }>(
      `SELECT m.tenant_id FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND t.status = 'ACTIVE' AND u.status = 'ACTIVE'
        ORDER BY m.tenant_id`,
      [p.id],
    );
    const tenants = rows.map((r) => r.tenant_id);
    if (requested) {
      if (!tenants.includes(requested.data)) return deny('NOT_A_MEMBER');
      tenantId = requested.data;
    } else if (tenants.length === 1) tenantId = tenants[0]!;
    else if (tenants.length === 0) return deny('NO_ACTIVE_MEMBERSHIP');
    else
      throw new DomainError('VALIDATION_FAILED', 'X-Tenant-ID is required for a principal with several tenants.', {
        reasonCode: 'TENANT_CONTEXT_REQUIRED',
      });
  } else {
    if (requested && requested.data !== p.tenantId) return deny('PRINCIPAL_BOUND_TO_OTHER_TENANT');
    const active = await pool.query(`SELECT 1 FROM tenants WHERE id = $1 AND status = 'ACTIVE'`, [p.tenantId]);
    if (active.rowCount !== 1) return deny('TENANT_INACTIVE');
    tenantId = p.tenantId;
  }
  return issueContext(tenantId, p, await loadGrants(pool, tenantId, p), correlationId);
}

async function loadGrants(q: Queryable, tenantId: TenantId, p: Principal): Promise<RoleGrant[]> {
  if (p.kind === 'DEVICE') return [{ role: 'device', siteId: p.siteId, assignmentId: null }];
  const column =
    p.kind === 'HUMAN' ? 'user_id' : p.kind === 'SERVICE' ? 'service_identity_id' : 'integration_identity_id';
  const { rows } = await q.query<{ id: RoleAssignmentId; role: Role; site_id: SiteId | null }>(
    `SELECT id, role, site_id FROM role_assignments
      WHERE tenant_id = $1 AND ${column} = $2 AND revoked_at IS NULL ORDER BY granted_at, id`,
    [tenantId, p.id],
  );
  return rows.map((r) => ({ role: r.role, siteId: r.site_id, assignmentId: r.id }));
}

/** Run `fn` in a transaction tagged with the server-derived tenant (`app.tenant_id`, for RLS defence in depth). */
export async function withTenantTransaction<T>(
  pool: Db,
  ctx: TenantContext,
  fn: (client: Tx) => Promise<T>,
): Promise<T> {
  assertTenantContext(ctx);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type ActorKind = ContextPrincipal['kind'] | 'PLATFORM';
export const actorOf = (ctx: TenantContext): { kind: ActorKind; id: string } => ({
  kind: ctx.principal.kind,
  id: ctx.principal.id,
});

export function humanActor(ctx: TenantContext): UserId {
  if (ctx.principal.kind !== 'HUMAN')
    throw new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
      reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
    });
  return ctx.principal.id;
}
