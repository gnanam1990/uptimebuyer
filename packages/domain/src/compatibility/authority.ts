// Named-engineer and policy-approver authority records (INV-02, INV-15). A record is signed with HMAC-SHA256 under a
// server-held master key, derived per tenant (so a signature can never be transplanted to another tenant's record),
// over a versioned canonical preimage of the complete immutable scope, actor, role, reason and validity window.
// Verification needs the server keyring: without it nothing is applied. The record's claimed role is checked twice:
// against what the invariant (engineer) or the governing policy (approver) requires, and against the roles the tenant
// role registry says the actor holds at the site at evaluation time (`heldRoles`, server-resolved), so a revoked or
// never-held role cannot authorize. Free text never becomes authority.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, type VersionedDigest } from '@uptimebuyer/contracts';
import { canonicalDigest, canonicalize } from '../canonical.js';
import type { AuthorityEvidence, AuthorityRecord, CompatibilityInput, UnsignedAuthorityRecord } from './input.js';
import { NAMED_ENGINEER_ROLE, policyApproverRoles, type GoverningPolicy } from './policy.js';

export const AUTHORITY_SIGNATURE_DOMAIN = 'compatibility-authority';
export const AUTHORITY_SIGNATURE_ALGORITHM = 'HMAC-SHA256';
/** Master keys by key id. Supplied by the authority service's runtime configuration; never by a client. */
export type AuthorityKeyring = Readonly<Record<string, Uint8Array>>;

const KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Versioned canonical preimage of every signed field (everything except the signature and the event status). */
export function authoritySigningInput(r: UnsignedAuthorityRecord): string {
  return `${AUTHORITY_SIGNATURE_DOMAIN}.v1\n${canonicalize({
    authorityRecordId: r.authorityRecordId,
    kind: r.kind,
    tenantId: r.tenantId,
    siteId: r.siteId,
    incidentId: r.incidentId,
    candidateActionId: r.candidateActionId,
    assetRevisionId: r.assetRevisionId,
    evidenceRevisionId: r.evidenceRevisionId,
    policyRevisionId: r.policyRevisionId,
    actionDigest: r.actionDigest,
    heldDecisionId: r.heldDecisionId,
    exceptionClasses: [...r.exceptionClasses],
    overriddenReasons: [...r.overriddenReasons],
    actorUserId: r.actorUserId,
    actorRole: r.actorRole,
    reasonCode: r.reasonCode,
    reasonText: r.reasonText,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
  })}`;
}

function tenantKey(master: Uint8Array, tenantId: string): Buffer {
  if (!(master instanceof Uint8Array) || master.byteLength < 32)
    throw new DomainError('VALIDATION_FAILED', 'Authority signing key must be at least 32 bytes.');
  return createHmac('sha256', master).update(`${AUTHORITY_SIGNATURE_DOMAIN}-key.v1\n${tenantId}`, 'utf8').digest();
}

const mac = (master: Uint8Array, r: UnsignedAuthorityRecord) =>
  createHmac('sha256', tenantKey(master, r.tenantId)).update(authoritySigningInput(r), 'utf8').digest('base64url');

/** Sign a record with the server's master key (authority service only). */
export function signAuthorityRecord(r: UnsignedAuthorityRecord, masterKey: Uint8Array, keyId: string): AuthorityRecord {
  if (!KEY_ID_RE.test(keyId)) throw new DomainError('VALIDATION_FAILED', 'Invalid authority signing key id.');
  const { signature: _ignored, ...unsigned } = r as AuthorityRecord;
  return {
    ...unsigned,
    signature: { algorithm: AUTHORITY_SIGNATURE_ALGORITHM, keyId, value: mac(masterKey, unsigned) },
  };
}

export function verifyAuthoritySignature(r: AuthorityRecord, keyring: AuthorityKeyring): boolean {
  const sig = r.signature;
  if (!sig || sig.algorithm !== AUTHORITY_SIGNATURE_ALGORITHM || !Object.hasOwn(keyring, sig.keyId)) return false;
  const key = keyring[sig.keyId]!;
  const { signature: _s, ...unsigned } = r;
  let expected: Buffer;
  try {
    expected = Buffer.from(mac(key, unsigned), 'utf8');
  } catch {
    return false;
  }
  const actual = Buffer.from(String(sig.value), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The authority evidence of a tuple: identity, signature, registry roles and lifecycle state of every record at `at`. */
export function authoritySetDigest(entries: readonly AuthorityEvidence[], at: string): VersionedDigest {
  const t = Date.parse(at);
  return canonicalDigest(
    'compatibility-authority-set',
    1,
    [...entries]
      .sort((a, b) =>
        a.record.authorityRecordId < b.record.authorityRecordId
          ? -1
          : a.record.authorityRecordId > b.record.authorityRecordId
            ? 1
            : 0,
      )
      .map(({ record: r, heldRoles }) => ({
        authorityRecordId: r.authorityRecordId,
        signature: r.signature.value,
        status: r.status,
        expired: Date.parse(r.expiresAt) <= t,
        heldRoles: [...heldRoles].sort(),
      })),
  );
}

const SCOPE_FIELDS = [
  'tenantId',
  'siteId',
  'incidentId',
  'candidateActionId',
  'assetRevisionId',
  'evidenceRevisionId',
  'policyRevisionId',
  'actionDigest',
] as const;

export type AuthorityVerification = { valid: true } | { valid: false; reasonCode: string };

export function verifyAuthorityRecord(
  e: AuthorityEvidence,
  input: CompatibilityInput,
  policy: GoverningPolicy,
  keyring: AuthorityKeyring | null | undefined,
): AuthorityVerification {
  const fail = (reasonCode: string): AuthorityVerification => ({ valid: false, reasonCode });
  const r = e.record;
  if (!keyring) return fail('AUTHORITY_SIGNATURE_UNVERIFIABLE');
  if (!verifyAuthoritySignature(r, keyring)) return fail('AUTHORITY_SIGNATURE_INVALID');
  if (r.status !== 'ACTIVE') return fail('AUTHORITY_INACTIVE');
  for (const f of SCOPE_FIELDS) if (r[f] !== input.binding[f]) return fail('AUTHORITY_SCOPE_MISMATCH');
  if (r.kind === 'ENGINEER_EXCEPTION') {
    if (r.actorRole !== NAMED_ENGINEER_ROLE || r.exceptionClasses.length === 0 || r.overriddenReasons.length > 0)
      return fail('AUTHORITY_ROLE_MISMATCH');
  } else {
    const roles = policyApproverRoles(policy, 'POLICY_OVERRIDE', input.binding.siteId, input.candidate.amount);
    if (!roles.includes(r.actorRole) || r.overriddenReasons.length === 0 || r.exceptionClasses.length > 0)
      return fail('AUTHORITY_ROLE_MISMATCH');
  }
  if (!e.heldRoles.includes(r.actorRole)) return fail('AUTHORITY_ROLE_NOT_HELD');
  const at = Date.parse(input.evaluatedAt);
  const issued = Date.parse(r.issuedAt);
  const expires = Date.parse(r.expiresAt);
  if (issued > at) return fail('AUTHORITY_NOT_YET_VALID');
  if (expires <= at) return fail('AUTHORITY_EXPIRED');
  if (!policy.compatibility) return fail('AUTHORITY_POLICY_MISSING');
  if (expires - issued > policy.compatibility.authorityMaxTtlMs) return fail('AUTHORITY_TTL_EXCEEDED');
  return { valid: true };
}
