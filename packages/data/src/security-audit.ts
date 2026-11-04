// Platform security log (no tenant attribution): rejected tenant resolution, unknown webhook bindings and failed
// authentication. Requested values are stored only as SHA-256 digests so the log itself cannot leak them.
import { newId, type CorrelationId } from '@uptimebuyer/contracts';
import { sha256Digest, type Queryable } from './db.js';
import { newDataId } from './ids.js';

export type SecurityPrincipalKind = 'HUMAN' | 'DEVICE' | 'SERVICE' | 'INTEGRATION' | 'ANONYMOUS';

export interface SecurityAuditInput {
  principal: { kind: SecurityPrincipalKind; id: string | null };
  action: string;
  requested?: string | null;
  result: 'SUCCEEDED' | 'DENIED';
  reasonCode: string;
  correlationId?: CorrelationId;
}

export async function recordSecurityAudit(q: Queryable, input: SecurityAuditInput): Promise<void> {
  await q.query(
    `INSERT INTO security_audit_entries (id, principal_kind, principal_id, action, requested_digest, result, reason_code, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newDataId('securityAudit'),
      input.principal.kind,
      input.principal.id,
      input.action,
      input.requested === undefined || input.requested === null ? null : sha256Digest(input.requested),
      input.result,
      input.reasonCode,
      input.correlationId ?? newId('correlation'),
    ],
  );
}

export interface SecurityAuditEntry {
  securityAuditId: string;
  occurredAt: string;
  principal: { kind: SecurityPrincipalKind; id: string | null };
  action: string;
  requestedTenantDigest: string | null;
  result: 'SUCCEEDED' | 'DENIED';
  reasonCode: string;
  correlationId: string;
}

/** Platform-operator read of the security log (not tenant-callable; no tenant context exists for these rows). */
export async function listSecurityAuditEntries(
  q: Queryable,
  filter: { action?: string; limit?: number } = {},
): Promise<SecurityAuditEntry[]> {
  const { rows } = await q.query(
    `SELECT * FROM security_audit_entries WHERE ($1::text IS NULL OR action = $1)
      ORDER BY occurred_at, id LIMIT $2`,
    [filter.action ?? null, Math.min(filter.limit ?? 1000, 10_000)],
  );
  return rows.map((r) => ({
    securityAuditId: r.id,
    occurredAt: (r.occurred_at as Date).toISOString(),
    principal: { kind: r.principal_kind, id: r.principal_id },
    action: r.action,
    requestedTenantDigest: r.requested_digest,
    result: r.result,
    reasonCode: r.reason_code,
    correlationId: r.correlation_id,
  }));
}
