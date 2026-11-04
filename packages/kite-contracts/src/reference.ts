// Signed opaque execution reference (KITE-OPENSERV-INTEGRATION §2). It names ONLY an ExecutionAuthority (session
// activation/reconciliation) or a CommercialIntent (paid execution/reconciliation). Strict schemas reject any
// embedded authority field; the broker reloads every bound value itself. The signing key is supplied by the caller
// (the broker's isolated secret store in production); this module holds no credential.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CommercialIntentIdSchema,
  DomainError,
  ExecutionAuthorityIdSchema,
  TenantIdSchema,
  UtcInstantSchema,
  decodeWire,
  encodeWire,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import { z } from 'zod';

export const EXECUTION_REFERENCE_VERSION = 1;
export const EXECUTION_REFERENCE_SIGNATURE_ALGORITHM = 'HMAC-SHA256';

export const ExecutionReferenceTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EXECUTION_AUTHORITY'), executionAuthorityId: ExecutionAuthorityIdSchema }),
  z.strictObject({ kind: z.literal('COMMERCIAL_INTENT'), commercialIntentId: CommercialIntentIdSchema }),
]);
export type ExecutionReferenceTarget = z.output<typeof ExecutionReferenceTargetSchema>;

const unsignedFields = {
  referenceVersion: z.literal(EXECUTION_REFERENCE_VERSION),
  tenantId: TenantIdSchema,
  target: ExecutionReferenceTargetSchema,
  issuedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
};
const validWindow = (r: { issuedAt: string; expiresAt: string }) => Date.parse(r.expiresAt) > Date.parse(r.issuedAt);

export const UnsignedExecutionReferenceSchema = z
  .strictObject(unsignedFields)
  .refine(validWindow, { path: ['expiresAt'], message: 'Reference must expire after issue.' });
export type UnsignedExecutionReference = z.output<typeof UnsignedExecutionReferenceSchema>;

export const SignedExecutionReferenceSchema = z
  .strictObject({
    ...unsignedFields,
    signature: z.strictObject({
      algorithm: z.literal(EXECUTION_REFERENCE_SIGNATURE_ALGORITHM),
      keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
  })
  .refine(validWindow, { path: ['expiresAt'], message: 'Reference must expire after issue.' });
export type SignedExecutionReference = z.output<typeof SignedExecutionReferenceSchema>;

/** Exact bytes that are signed: a versioned tag plus the canonical unsigned reference. */
export function executionReferenceSigningInput(unsigned: UnsignedExecutionReference): string {
  const clean = decodeWire(UnsignedExecutionReferenceSchema, encodeWire(UnsignedExecutionReferenceSchema, unsigned));
  return `execution-reference.v${EXECUTION_REFERENCE_VERSION}\n${canonicalize(clean)}`;
}

function mac(key: Uint8Array, input: string): string {
  if (!(key instanceof Uint8Array) || key.byteLength < 32)
    throw new DomainError('VALIDATION_FAILED', 'Signing key must be at least 32 bytes.');
  return createHmac('sha256', key).update(input, 'utf8').digest('base64url');
}

export function signExecutionReference(
  unsigned: UnsignedExecutionReference,
  key: Uint8Array,
  keyId: string,
): SignedExecutionReference {
  const value = mac(key, executionReferenceSigningInput(unsigned));
  const signed = { ...unsigned, signature: { algorithm: EXECUTION_REFERENCE_SIGNATURE_ALGORITHM, keyId, value } };
  return decodeWire(SignedExecutionReferenceSchema, encodeWire(SignedExecutionReferenceSchema, signed as never));
}

const invalid = (reason: string) =>
  new DomainError('EXECUTION_REFERENCE_INVALID', 'Execution reference rejected.', { reason });

/** Verify shape, key, signature and validity window. Any failure is one opaque EXECUTION_REFERENCE_INVALID. */
export function verifyExecutionReference(
  reference: unknown,
  keyring: Readonly<Record<string, Uint8Array>>,
  now: UtcInstant,
): SignedExecutionReference {
  const parsed = SignedExecutionReferenceSchema.safeParse(reference);
  if (!parsed.success) throw invalid('MALFORMED');
  const ref = parsed.data;
  const key = Object.hasOwn(keyring, ref.signature.keyId) ? keyring[ref.signature.keyId] : undefined;
  if (!key) throw invalid('UNKNOWN_KEY');
  const { signature, ...unsigned } = ref;
  const expected = Buffer.from(mac(key, executionReferenceSigningInput(unsigned)), 'utf8');
  const actual = Buffer.from(signature.value, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid('BAD_SIGNATURE');
  const t = Date.parse(now);
  if (t < Date.parse(ref.issuedAt)) throw invalid('NOT_YET_VALID');
  if (t >= Date.parse(ref.expiresAt)) throw invalid('EXPIRED');
  return ref;
}
