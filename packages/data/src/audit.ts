// Tenant audit queries and exports (NFR-09). Always filtered by the server-derived tenant.
import { isoNN, dbNow, type Db } from './db.js';
import { tenantCommand } from './command.js';
import { requireAuthorized } from './authz.js';
import type { TenantContext } from './context.js';

export interface AuditEntry {
  auditId: string;
  tenantId: string;
  occurredAt: string;
  actor: { kind: string; id: string | null };
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  result: 'SUCCEEDED' | 'DENIED' | 'FAILED';
  reasonCode: string | null;
  correlationId: string;
}

export interface AuditFilter {
  result?: AuditEntry['result'];
  action?: string;
  resourceId?: string;
  limit?: number;
}

const toEntry = (r: Record<string, unknown>): AuditEntry => ({
  auditId: r.id as string,
  tenantId: r.tenant_id as string,
  occurredAt: isoNN(r.occurred_at as Date),
  actor: { kind: r.actor_kind as string, id: (r.actor_id as string | null) ?? null },
  action: r.action as string,
  resourceType: (r.resource_type as string | null) ?? null,
  resourceId: (r.resource_id as string | null) ?? null,
  result: r.result as AuditEntry['result'],
  reasonCode: (r.reason_code as string | null) ?? null,
  correlationId: r.correlation_id as string,
});

const SELECT = `SELECT * FROM audit_entries
  WHERE tenant_id = $1 AND ($2::text IS NULL OR result = $2) AND ($3::text IS NULL OR action = $3)
    AND ($4::text IS NULL OR resource_id = $4)
  ORDER BY occurred_at, id LIMIT $5`;

export async function listAuditEntries(pool: Db, ctx: TenantContext, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  return tenantCommand(pool, ctx, { action: 'audit.read', resourceType: 'audit' }, async (c) => {
    requireAuthorized(ctx, { action: 'audit.read', siteId: null });
    const { rows } = await c.query(SELECT, [
      ctx.tenantId,
      filter.result ?? null,
      filter.action ?? null,
      filter.resourceId ?? null,
      Math.min(filter.limit ?? 1000, 10_000),
    ]);
    return rows.map(toEntry);
  });
}

export async function exportAuditEntries(
  pool: Db,
  ctx: TenantContext,
): Promise<{ tenantId: string; cutoffAt: string; entries: AuditEntry[] }> {
  return tenantCommand(pool, ctx, { action: 'audit.export', resourceType: 'audit' }, async (c) => {
    requireAuthorized(ctx, { action: 'audit.export', siteId: null });
    const cutoffAt = await dbNow(c);
    const { rows } = await c.query(
      `SELECT * FROM audit_entries WHERE tenant_id = $1 AND occurred_at <= $2 ORDER BY occurred_at, id`,
      [ctx.tenantId, cutoffAt],
    );
    return { tenantId: ctx.tenantId, cutoffAt, entries: rows.map(toEntry) };
  });
}
