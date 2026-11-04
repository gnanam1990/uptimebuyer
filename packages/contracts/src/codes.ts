// Constrained code and digest strings shared by every contract.
import { z } from 'zod';

/** Raw content digest: `sha256:<64 lowercase hex>` (blob, request, manifest, payload digests). */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .brand<'Sha256Digest'>();
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

/** Canonical domain digest with a versioned prefix: `<domain>.v<N>:sha256:<hex>` (action digest, plan hash, …). */
export const VersionedDigestSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}\.v[1-9][0-9]{0,5}:sha256:[0-9a-f]{64}$/)
  .brand<'VersionedDigest'>();
export type VersionedDigest = z.infer<typeof VersionedDigestSchema>;

export const PurposeCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
  .brand<'PurposeCode'>();
export type PurposeCode = z.infer<typeof PurposeCodeSchema>;

/** Machine-readable reason (hold, failure, transition). Never free text. */
export const ReasonCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .brand<'ReasonCode'>();
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/** Opaque provider-assigned reference (order, session, job). Evidence only; never an authority identity. */
export const ProviderRefSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,256}$/)
  .brand<'ProviderRef'>();
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/** Versioned payload/contract name such as `compatibility.decision.v1`. */
export const SchemaNameSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.v[1-9][0-9]*$/);

/** Versioned command name such as `incident.pause.v1`. */
export const CommandTypeSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$/);

/** Any canonical state word (used where the machine is named elsewhere, e.g. a command acknowledgement). */
export const StateNameSchema = z.string().regex(/^[A-Z][A-Z_]{0,63}$/);

/** Known compatibility HOLD reasons (STATE-MACHINES §3). Other reason codes remain valid `ReasonCode`s. */
export const COMPATIBILITY_HOLD_REASONS = Object.freeze([
  'ASSET_IDENTITY_UNRESOLVED',
  'MISSING_EXACT_MPN',
  'CONFLICTING_MANUALS',
  'UNSUPPORTED_SUBSTITUTE',
  'SAFETY_CLASSIFICATION',
  'MISSING_CERTIFICATION',
  'STALE_PRICE_OR_STOCK',
  'NAMED_APPROVAL_REQUIRED',
] as const);
