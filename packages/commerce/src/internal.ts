// Shared persistence helpers for M09's credential-free side: identifiers, typed errors, actor fields, lock keys and
// SQLSTATE mapping for the broker guards (UB091..UB099).
import { randomUUID } from 'node:crypto';
import { DomainError, type UtcInstant } from '@uptimebuyer/contracts';
import { actorOf, pgCode, type TenantContext } from '@uptimebuyer/data';

export const COMMERCE_ID_PREFIXES = Object.freeze({
  planApprovalBinding: 'pab',
  authorityEvent: 'xae',
  budgetAccount: 'bac',
  ledgerEntry: 'ble',
  intentTransition: 'cit',
  receipt: 'rcp',
} as const);
export const newCommerceId = (kind: keyof typeof COMMERCE_ID_PREFIXES) =>
  `${COMMERCE_ID_PREFIXES[kind]}_${randomUUID()}`;

export const hold = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('POLICY_HOLD', 'This commercial action cannot proceed under the current authority.', {
    reasonCode,
    ...details,
  });
export const invalid = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode, ...details });
export const digestMismatch = (reasonCode: string) =>
  new DomainError('DIGEST_MISMATCH', 'The bound action digest no longer matches the current inputs.', { reasonCode });
export const successorBlocked = () =>
  new DomainError('INTENT_SUCCESSOR_BLOCKED', 'A prior intent for this action may have had an effect.', {
    reasonCode: 'PRIOR_INTENT_POSSIBLY_EFFECTIVE',
  });

export const isoOf = (d: Date | string | null | undefined): UtcInstant | null =>
  d === null || d === undefined ? null : (new Date(d).toISOString() as UtcInstant);
export const isoNN = (d: Date | string): UtcInstant => new Date(d).toISOString() as UtcInstant;

export function actorFields(ctx: TenantContext): { kind: 'HUMAN' | 'SERVICE' | 'WORKER'; id: string } {
  const a = actorOf(ctx);
  const kind = ctx.principal.kind === 'WORKER' ? 'WORKER' : ctx.principal.kind === 'HUMAN' ? 'HUMAN' : 'SERVICE';
  return { kind, id: String(a.id).slice(0, 128) };
}

export const refOk = (prefix: string, v: unknown): v is string =>
  typeof v === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$`).test(v);

/** Serializes plan approval, invalidation and the broker linearization of a plan action (shared with M08). */
export const planningLock = (tenantId: string, incidentId: string) => `planning:${tenantId}:${incidentId}`;
/** Serializes intent creation for one stable action digest (phantom first insert, successor checks). */
export const actionDigestLock = (tenantId: string, actionDigest: string) => `intent-digest:${tenantId}:${actionDigest}`;

/** Broker guard SQLSTATEs surface as typed holds instead of raw database errors. */
export function mapGuardError(error: unknown): never {
  const code = pgCode(error);
  if (code && /^UB09[1-9]$/.test(code)) throw hold(`DB_GUARD_${code}`);
  if (code === '23514') throw hold('DB_CONSERVATION_CHECK');
  throw error;
}

export const semanticOperationFor = (actionKind: string) =>
  actionKind === 'PAID_CONTACT'
    ? 'PAID_CONTACT'
    : actionKind === 'SERVICE_JOB' || actionKind === 'DIAGNOSTIC_SERVICE'
      ? 'SERVICE_BOOKING'
      : 'PURCHASE';
