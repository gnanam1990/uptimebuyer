// Tenant namespacing for non-SQL boundaries (INV-16): object-store keys and in-process caches. Keys are derived from
// the server-issued context, verified on use, and can never be steered into another tenant's namespace.
import { DomainError, Sha256DigestSchema } from '@uptimebuyer/contracts';
import { resourceUnavailable } from './command.js';
import { assertTenantContext, type TenantContext } from './context.js';

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const KEY = /^tenants\/(ten_[A-Za-z0-9][A-Za-z0-9-]{3,63})\/([a-z][a-z0-9-]{0,31})\/([0-9a-f]{64})$/;

/** `tenants/<tenantId>/<kind>/<sha256 hex>`; content-addressed and immutable. */
export function tenantObjectKey(ctx: TenantContext, kind: string, sha256: string): string {
  assertTenantContext(ctx);
  if (!KIND.test(kind) || !Sha256DigestSchema.safeParse(sha256).success)
    throw new DomainError('VALIDATION_FAILED', 'Object key input failed validation.', {
      reasonCode: 'INVALID_OBJECT_KEY',
    });
  return `tenants/${ctx.tenantId}/${kind}/${sha256.slice('sha256:'.length)}`;
}

/** Accept an object key only when it is well-formed and inside the caller's tenant namespace. */
export function assertObjectKeyInTenant(ctx: TenantContext, key: string): string {
  assertTenantContext(ctx);
  const m = KEY.exec(key);
  if (!m || m[1] !== ctx.tenantId) throw resourceUnavailable();
  return key;
}

/** In-process cache whose keys are always prefixed with the server-derived tenant. */
export class TenantScopedCache<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly maxEntries = 10_000) {}

  private key(ctx: TenantContext, parts: readonly (string | number)[]): string {
    assertTenantContext(ctx);
    return JSON.stringify([ctx.tenantId, ...parts]);
  }
  get(ctx: TenantContext, parts: readonly (string | number)[]): V | undefined {
    return this.entries.get(this.key(ctx, parts));
  }
  set(ctx: TenantContext, parts: readonly (string | number)[], value: V): void {
    const k = this.key(ctx, parts);
    if (!this.entries.has(k) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(k, value);
  }
  delete(ctx: TenantContext, parts: readonly (string | number)[]): void {
    this.entries.delete(this.key(ctx, parts));
  }
}
