// Human authentication for the operator API (FR-24, INV-16): `Authorization: Bearer <OIDC access token>` verified
// by M02's HumanSessionVerifier and mapped to an active user (authenticateHuman), then the tenant resolved from the
// principal's own memberships (resolveTenantContext; `X-Tenant-ID` may only name one of them). The resulting
// TenantContext is the ONLY authority any route passes to a package function: no route reads a tenant, site, actor or
// role from the request. Bearer only, no cookies, so there is no ambient credential for CSRF to ride on.
import { isIP } from 'node:net';
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
  /** Hard bound on one verification (JWKS + database lookups); the slot is returned when it settles or expires. */
  timeoutMs: number;
}

const authRateLimited = (deps: AuthDeps) =>
  new DomainError('RATE_LIMITED', 'Too many failed authentications; retry later.', {
    reasonCode: 'AUTHENTICATION_RATE_EXCEEDED',
    retryAfterMs: deps.failures.retryAfterSeconds() * 1000,
  });

/**
 * M13 security review S11-S13: bounded pre-authentication work. A per-source cap (sources keyed by IPv4 /32 and IPv6
 * /64, see `sourceKey`) and a global cap sized well above per-source x expected sources; when only the global cap is
 * full a request waits in a short bounded queue instead of being refused at once. `enter` resolves to an idempotent
 * leave function, or null when the source is at its cap or the queue is full / timed out. The caller holds the slot
 * for the verification's whole lifetime and releases it once when the verification settles (never on client close).
 * Residual risk (ADR 0008): a large distributed pool of sources can still saturate any in-process cap; edge/WAF rate
 * limiting at deployment is the real mitigation (M14).
 */
export class PreAuthGate {
  private readonly bySource = new Map<string, number>();
  private total = 0;
  private readonly queue: { source: string; grant: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly cfg: { perSource: number; global: number; queued: number; queueTimeoutMs: number }) {}

  private admit(source: string): () => void {
    this.bySource.set(source, (this.bySource.get(source) ?? 0) + 1);
    this.total++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.total--;
      const m = (this.bySource.get(source) ?? 1) - 1;
      if (m <= 0) this.bySource.delete(source);
      else this.bySource.set(source, m);
      this.drain();
    };
  }

  private drain(): void {
    while (this.total < this.cfg.global && this.queue.length) {
      const i = this.queue.findIndex((q) => (this.bySource.get(q.source) ?? 0) < this.cfg.perSource);
      if (i < 0) return;
      const [next] = this.queue.splice(i, 1);
      clearTimeout(next!.timer);
      next!.grant();
    }
  }

  enter(source: string): Promise<(() => void) | null> {
    const queuedForSource = this.queue.filter((q) => q.source === source).length;
    if ((this.bySource.get(source) ?? 0) + queuedForSource >= this.cfg.perSource) return Promise.resolve(null);
    if (this.total < this.cfg.global) return Promise.resolve(this.admit(source));
    if (this.queue.length >= this.cfg.queued) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = {
        source,
        grant: () => resolve(this.admit(source)),
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          resolve(null);
        }, this.cfg.queueTimeoutMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  inFlight(source?: string): number {
    return source === undefined ? this.total : (this.bySource.get(source) ?? 0);
  }
}

/** The rate/concurrency key of a client address: IPv4 /32, IPv6 /64 (IPv4-mapped IPv6 is treated as IPv4). */
export function sourceKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIP(ip) !== 6) return ip || 'unknown';
  const bare = ip.split('%')[0]!.toLowerCase();
  const [head, tail] = bare.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

const BEARER = /^Bearer [A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,4096}$/;

export async function authenticate(
  deps: AuthDeps,
  req: FastifyRequest,
  correlationId: CorrelationId,
): Promise<TenantContext> {
  const source = sourceKey(req.ip || 'unknown');
  // Every attempt reserves a failure token atomically BEFORE any verification or database work (concurrent attempts
  // cannot all slip past a check); a successful authentication refunds it. An empty budget is refused at once
  // (credential stuffing / token guessing bound).
  if (!deps.failures.take(source)) throw authRateLimited(deps);
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !BEARER.test(header))
    throw new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  // Verification runs under the per-source and global pre-auth caps; excess gets the same 429 body (no oracle). The
  // slot lives exactly as long as the verification: released once when it settles or hits the hard timeout, never
  // on client close (a disconnect must not free capacity while work continues). Work left running past the timeout
  // is bounded by the JWKS fetch timeout and the database statement.
  const leave = await deps.gate.enter(source);
  if (!leave) throw authRateLimited(deps);
  let timer: NodeJS.Timeout | undefined;
  let auth;
  try {
    auth = await Promise.race([
      authenticateHuman(deps.pool, deps.verifier, header),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError('UNAUTHENTICATED', 'Authentication failed.')), deps.timeoutMs);
      }),
    ]);
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  } finally {
    if (timer) clearTimeout(timer);
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
