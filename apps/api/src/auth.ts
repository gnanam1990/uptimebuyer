// Human authentication for the operator API (FR-24, INV-16): `Authorization: Bearer <OIDC access token>` verified
// by M02's HumanSessionVerifier and mapped to an active user (authenticateHuman), then the tenant resolved from the
// principal's own memberships (resolveTenantContext; `X-Tenant-ID` may only name one of them). The resulting
// TenantContext is the ONLY authority any route passes to a package function: no route reads a tenant, site, actor or
// role from the request. Bearer only, no cookies, so there is no ambient credential for CSRF to ride on.
import { DomainError, type CorrelationId } from '@uptimebuyer/contracts';
import { TENANT_HEADER } from '@uptimebuyer/contracts/api';
import {
  authenticateHuman,
  resolveTenantContext,
  type Db,
  type HumanSessionVerifier,
  type TenantContext,
} from '@uptimebuyer/data';
import type { FastifyRequest } from 'fastify';
import type { TokenBuckets } from './security.js';

export interface AuthDeps {
  pool: Db;
  verifier: HumanSessionVerifier;
  failures: TokenBuckets;
  gate: PreAuthGate;
}

const authRateLimited = (deps: AuthDeps) =>
  new DomainError('RATE_LIMITED', 'Too many failed authentications; retry later.', {
    reasonCode: 'AUTHENTICATION_RATE_EXCEEDED',
    retryAfterMs: deps.failures.retryAfterSeconds() * 1000,
  });

/**
 * M13 security review S11: bounded pre-authentication work. A per-source and a global cap on concurrent verification;
 * `enter` returns an idempotent leave function or null when a cap is reached. Memory is bounded (sources at zero are
 * forgotten).
 */
export class PreAuthGate {
  private readonly bySource = new Map<string, number>();
  private total = 0;
  constructor(private readonly cfg: { perSource: number; global: number }) {}

  enter(source: string): (() => void) | null {
    const n = this.bySource.get(source) ?? 0;
    if (n >= this.cfg.perSource || this.total >= this.cfg.global) return null;
    this.bySource.set(source, n + 1);
    this.total++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.total--;
      const m = (this.bySource.get(source) ?? 1) - 1;
      if (m <= 0) this.bySource.delete(source);
      else this.bySource.set(source, m);
    };
  }

  inFlight(source?: string): number {
    return source === undefined ? this.total : (this.bySource.get(source) ?? 0);
  }
}

const BEARER = /^Bearer [A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,4096}$/;

export async function authenticate(
  deps: AuthDeps,
  req: FastifyRequest,
  correlationId: CorrelationId,
): Promise<TenantContext> {
  const source = req.ip || 'unknown';
  // Every attempt reserves a failure token atomically BEFORE any verification or database work (concurrent attempts
  // cannot all slip past a check); a successful authentication refunds it. An empty budget is refused at once
  // (credential stuffing / token guessing bound).
  if (!deps.failures.take(source)) throw authRateLimited(deps);
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !BEARER.test(header))
    throw new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  // Verification runs under the per-source and global pre-auth caps; excess gets the same 429 body (no oracle).
  const leave = deps.gate.enter(source);
  if (!leave) throw authRateLimited(deps);
  req.raw.once('close', leave);
  let auth;
  try {
    auth = await authenticateHuman(deps.pool, deps.verifier, header);
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  } finally {
    leave();
  }
  deps.failures.refund(source);
  const tenantHeader = req.headers[TENANT_HEADER];
  if (Array.isArray(tenantHeader))
    throw new DomainError('VALIDATION_FAILED', 'The request is malformed.', { reasonCode: 'DUPLICATE_HEADER' });
  return resolveTenantContext(deps.pool, auth, typeof tenantHeader === 'string' ? tenantHeader : undefined, {
    correlationId,
  });
}
