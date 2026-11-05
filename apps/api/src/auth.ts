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
}

const BEARER = /^Bearer [A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,4096}$/;

export async function authenticate(
  deps: AuthDeps,
  req: FastifyRequest,
  correlationId: CorrelationId,
): Promise<TenantContext> {
  const source = req.ip || 'unknown';
  // Unauthenticated failures spend a per-source budget; once it is empty the request is refused before any
  // verification or database work (credential stuffing / token guessing bound).
  if (!deps.failures.has(source))
    throw new DomainError('RATE_LIMITED', 'Too many failed authentications; retry later.', {
      reasonCode: 'AUTHENTICATION_RATE_EXCEEDED',
      retryAfterMs: deps.failures.retryAfterSeconds() * 1000,
    });
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !BEARER.test(header)) {
    deps.failures.take(source);
    throw new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  }
  let auth;
  try {
    auth = await authenticateHuman(deps.pool, deps.verifier, header);
  } catch (e) {
    deps.failures.take(source);
    throw e instanceof DomainError ? e : new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  }
  const tenantHeader = req.headers[TENANT_HEADER];
  if (Array.isArray(tenantHeader))
    throw new DomainError('VALIDATION_FAILED', 'The request is malformed.', { reasonCode: 'DUPLICATE_HEADER' });
  return resolveTenantContext(deps.pool, auth, typeof tenantHeader === 'string' ? tenantHeader : undefined, {
    correlationId,
  });
}
