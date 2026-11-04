// The canonical action digest (INV-03, INV-07): binds tenant, incident, immutable asset revision, evidence revision,
// policy revision, proposed action, exact provider-account revision, merchant, amount, currency and purpose.
import {
  ActionDigestInputSchema,
  DomainError,
  decodeWire,
  encodeWire,
  type ActionDigestInput,
  type VersionedDigest,
} from '@uptimebuyer/contracts';
import type { z } from 'zod';
import { canonicalDigest } from './canonical.js';

export const ACTION_DIGEST_DOMAIN = 'action';
export const ACTION_DIGEST_VERSION = 1;
export const ACTION_DIGEST_BOUND_FIELDS = Object.freeze(
  Object.keys(ActionDigestInputSchema.shape),
) as readonly (keyof ActionDigestInput)[];

/** Validate `value` strictly against `schema`, then digest the clean validated value (never extra fields). */
export function computeSchemaDigest<S extends z.ZodType>(
  domain: string,
  version: number,
  schema: S,
  value: z.output<S>,
): VersionedDigest {
  const clean = decodeWire(schema, encodeWire(schema, value));
  return canonicalDigest(domain, version, clean);
}

export function computeActionDigest(input: ActionDigestInput): VersionedDigest {
  return computeSchemaDigest(ACTION_DIGEST_DOMAIN, ACTION_DIGEST_VERSION, ActionDigestInputSchema, input);
}

/**
 * An authority/approval/decision bound to `boundDigest` covers `current` only if recomputing gives the same digest.
 * Any change to a bound value invalidates it (DIGEST_MISMATCH); the historical input still reproduces the old digest.
 */
export function assertActionDigestCurrent(boundDigest: VersionedDigest, current: ActionDigestInput): void {
  if (computeActionDigest(current) !== boundDigest)
    throw new DomainError('DIGEST_MISMATCH', 'The bound action digest no longer matches the current inputs.');
}
