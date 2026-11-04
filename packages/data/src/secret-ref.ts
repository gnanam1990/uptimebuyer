// Tenant-bound opaque secret references (INV-06, INV-16): `secretref:<namespace>/tenants/<tenantId>/<path>`.
// A reference that names another tenant, has no tenant segment, or contains `.`/`..` segments is rejected, so a
// tenant can never make a principal or provider account resolve another tenant's secret. Mirrors the SQL
// `ub_tenant_secret_ref_ok` CHECK added in migration 0007.
import { DomainError, type TenantId } from '@uptimebuyer/contracts';

const SHAPE = /^secretref:[a-z0-9-]{1,32}\/tenants\/([^/]+)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const DOT_SEGMENT = /\/\.{1,2}(\/|$)/;

export function isTenantSecretRef(tenantId: TenantId, ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length > 300 || DOT_SEGMENT.test(ref)) return false;
  const m = SHAPE.exec(ref);
  return m !== null && m[1] === tenantId;
}

export function assertTenantSecretRef(tenantId: TenantId, ref: unknown, field: string): void {
  if (!isTenantSecretRef(tenantId, ref))
    throw new DomainError('VALIDATION_FAILED', 'Secret reference must belong to the caller tenant.', {
      reasonCode: 'SECRET_REF_NOT_TENANT_BOUND',
      fieldErrors: [{ path: field, issue: 'tenant_bound_secret_ref' }],
    });
}
