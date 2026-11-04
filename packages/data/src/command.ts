// Tenant-scoped command/query execution with uniform, audited denial (INV-16, NFR-09).
// Anything outside the caller's tenant — another tenant's row or a row that does not exist — produces the same
// RESOURCE_UNAVAILABLE error, so existence never leaks. Denials are audited in the caller's own tenant on a separate
// connection after the failed transaction rolls back; successes are audited inside the same transaction.
import { DomainError } from '@uptimebuyer/contracts';
import { FK_VIOLATION, pgCode, sha256Digest, type Db, type Queryable, type Tx } from './db.js';
import { actorOf, assertTenantContext, withTenantTransaction, type TenantContext } from './context.js';
import { newDataId } from './ids.js';

export interface AuditInput {
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: 'SUCCEEDED' | 'DENIED' | 'FAILED';
  reasonCode?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function recordAudit(q: Queryable, ctx: TenantContext, input: AuditInput): Promise<void> {
  const actor = actorOf(ctx);
  // A denied lookup records only a digest of the requested identifier: the caller's audit trail must not carry
  // identifiers that may belong to another tenant (and nothing reveals whether they do).
  const unresolved = input.result === 'DENIED' && input.reasonCode === 'RESOURCE_UNAVAILABLE';
  const raw = typeof input.resourceId === 'string' ? input.resourceId : null;
  const resourceId = unresolved || raw === null ? null : raw.slice(0, 128);
  const metadata =
    unresolved && raw !== null ? { ...input.metadata, requestedResourceDigest: sha256Digest(raw) } : input.metadata;
  await q.query(
    `INSERT INTO audit_entries (tenant_id, id, actor_kind, actor_id, action, resource_type, resource_id, result, reason_code, correlation_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.tenantId,
      newDataId('audit'),
      actor.kind,
      actor.id.slice(0, 128),
      input.action,
      input.resourceType ?? null,
      resourceId,
      input.result,
      input.reasonCode ?? null,
      ctx.correlationId,
      JSON.stringify(metadata ?? {}),
    ],
  );
}

export const resourceUnavailable = () =>
  new DomainError('FORBIDDEN', 'The requested resource is not available.', { reasonCode: 'RESOURCE_UNAVAILABLE' });

export const notPermitted = (reasonCode: string) =>
  new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', { reasonCode });

/** Thrown inside a tenant transaction; the wrapper audits it after rollback and rethrows `error`. */
export class Denial extends Error {
  constructor(
    readonly error: DomainError,
    readonly audit: Omit<AuditInput, 'result'>,
  ) {
    super(error.message);
    this.name = 'Denial';
  }
}

export interface CommandMeta {
  action: string;
  resourceType: string;
  resourceId?: string | null;
}

export const unavailable = (meta: CommandMeta, resourceId?: string | null, resourceType?: string) =>
  new Denial(resourceUnavailable(), {
    action: meta.action,
    resourceType: resourceType ?? meta.resourceType,
    resourceId: resourceId === undefined ? (meta.resourceId ?? null) : resourceId,
    reasonCode: 'RESOURCE_UNAVAILABLE',
  });

/**
 * Execute `fn` in a tenant transaction. A `Denial` or a composite-FK violation (a referenced row is absent from
 * this tenant) becomes an audited, uniform FORBIDDEN error.
 */
export async function tenantCommand<T>(
  pool: Db,
  ctx: TenantContext,
  meta: CommandMeta,
  fn: (client: Tx) => Promise<T>,
): Promise<T> {
  assertTenantContext(ctx);
  try {
    return await withTenantTransaction(pool, ctx, fn);
  } catch (error) {
    if (error instanceof Denial) {
      await recordAudit(pool, ctx, { ...error.audit, result: 'DENIED' });
      throw error.error;
    }
    if (pgCode(error) === FK_VIOLATION) {
      await recordAudit(pool, ctx, {
        action: meta.action,
        resourceType: meta.resourceType,
        resourceId: meta.resourceId ?? null,
        result: 'DENIED',
        reasonCode: 'RESOURCE_UNAVAILABLE',
      });
      throw resourceUnavailable();
    }
    throw error;
  }
}
