// Signatures (INV-02, INV-03, INV-06). An execution authority's scope is canonicalized and signed with Ed25519 by the
// issuing workload; the broker holds only the public verification keys, so neither a database writer nor the broker
// can mint a scope. Execution references are the M01 HMAC references, issued here and verified by the broker.
import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { DomainError, type ExecutionAuthorityId, type TenantId, type UtcInstant } from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import {
  signExecutionReference,
  type ExecutionReferenceTarget,
  type SignedExecutionReference,
} from '@uptimebuyer/kite-contracts';

export const AUTHORITY_SCOPE_DOMAIN = 'execution-authority-scope.v1';

export interface AuthorityScope {
  tenantId: string;
  executionAuthorityId: string;
  approvalId: string;
  incidentId: string;
  siteId: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string;
  planHash: string;
  actionDigest: string;
  subject: { type: string; id: string };
  semanticOperation: string;
  providerAccountId: string;
  providerAccountRevisionId: string;
  merchantId: string;
  purpose: string;
  allowedActionKinds: string[];
  perActionLimit: { amountMinor: bigint; currency: string };
  baseLimit: { amountMinor: bigint; currency: string };
  issuedAt: string;
  expiresAt: string;
}

/** Issuing side: Ed25519 private key held only by the authority-issuing workload. */
export interface AuthoritySigner {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}
/** Verifying side (the broker): public keys by key id. */
export type AuthorityVerifyKeys = Readonly<Record<string, KeyObject>>;

export const scopeSigningInput = (scope: AuthorityScope) => `${AUTHORITY_SCOPE_DOMAIN}\n${canonicalize(scope)}`;
export const scopeDigest = (scope: AuthorityScope) =>
  `sha256:${createHash('sha256').update(scopeSigningInput(scope), 'utf8').digest('hex')}`;

export function signAuthorityScope(scope: AuthorityScope, signer: AuthoritySigner) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(signer.keyId) || signer.privateKey.asymmetricKeyType !== 'ed25519')
    throw new DomainError('INTERNAL', 'Authority signing is not configured.');
  const value = sign(null, Buffer.from(scopeSigningInput(scope), 'utf8'), signer.privateKey).toString('base64url');
  return { algorithm: 'ED25519' as const, keyId: signer.keyId, value, scopeDigest: scopeDigest(scope) };
}

export function verifyAuthorityScope(
  scope: AuthorityScope,
  signature: { algorithm: string; keyId: string; value: string; scopeDigest: string },
  keys: AuthorityVerifyKeys,
): boolean {
  if (signature.algorithm !== 'ED25519' || !Object.hasOwn(keys, signature.keyId)) return false;
  if (scopeDigest(scope) !== signature.scopeDigest) return false;
  try {
    return verify(
      null,
      Buffer.from(scopeSigningInput(scope), 'utf8'),
      keys[signature.keyId]!,
      Buffer.from(signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** Public key of a signer, for handing to the broker's verification ring (DER SPKI, base64url). */
export const exportAuthorityPublicKey = (signer: AuthoritySigner) =>
  createPublicKey(signer.privateKey).export({ format: 'der', type: 'spki' }).toString('base64url');
export const importAuthorityPublicKey = (spkiBase64Url: string) =>
  createPublicKey({ key: Buffer.from(spkiBase64Url, 'base64url'), format: 'der', type: 'spki' });

/** Issues M01 signed opaque execution references (HMAC). The key is shared only with the broker's verifier. */
export interface ReferenceSigner {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly ttlMs?: number;
}

export function issueReference(
  signer: ReferenceSigner,
  tenantId: TenantId | string,
  target: ExecutionReferenceTarget,
  now: Date = new Date(),
): SignedExecutionReference {
  const issuedAt = new Date(Math.floor(now.getTime())).toISOString() as UtcInstant;
  const expiresAt = new Date(now.getTime() + (signer.ttlMs ?? 5 * 60_000)).toISOString() as UtcInstant;
  return signExecutionReference(
    {
      referenceVersion: 1,
      tenantId: tenantId as TenantId,
      target,
      issuedAt,
      expiresAt,
      nonce: randomBytes(18).toString('base64url'),
    },
    signer.key,
    signer.keyId,
  );
}

export const authorityReference = (
  signer: ReferenceSigner,
  tenantId: TenantId | string,
  executionAuthorityId: ExecutionAuthorityId | string,
) =>
  issueReference(signer, tenantId, { kind: 'EXECUTION_AUTHORITY', executionAuthorityId } as ExecutionReferenceTarget);
