// Named-engineer and policy-approver authority records (INV-02, INV-15). The signature digest binds the complete
// immutable scope, actor, role, reason and validity window; verification is pure and fails closed, naming the first
// failed check. Free text never becomes authority: only a record whose every bound field equals the evaluated tuple,
// whose role is the one the invariant (engineer) or the governing policy (approver) requires, and whose window covers
// the evaluation instant is applied.
import type { VersionedDigest } from '@uptimebuyer/contracts';
import { canonicalDigest } from '../canonical.js';
import type { AuthorityRecord, CompatibilityInput } from './input.js';
import { NAMED_ENGINEER_ROLE, policyApproverRoles, type GoverningPolicy } from './policy.js';

export const AUTHORITY_SIGNATURE_DOMAIN = 'compatibility-authority';

/** Digest over every signed field (everything except the digest itself and the event-derived status). */
export function authoritySignatureDigest(r: AuthorityRecord): VersionedDigest {
  return canonicalDigest(AUTHORITY_SIGNATURE_DOMAIN, 1, {
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
  });
}

/** The authority evidence of a tuple: identity, signature and lifecycle state of every bound record at `at`. */
export function authoritySetDigest(records: readonly AuthorityRecord[], at: string): VersionedDigest {
  const t = Date.parse(at);
  return canonicalDigest(
    'compatibility-authority-set',
    1,
    [...records]
      .sort((a, b) =>
        a.authorityRecordId < b.authorityRecordId ? -1 : a.authorityRecordId > b.authorityRecordId ? 1 : 0,
      )
      .map((r) => ({
        authorityRecordId: r.authorityRecordId,
        signatureDigest: r.signatureDigest,
        status: r.status,
        expired: Date.parse(r.expiresAt) <= t,
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
  r: AuthorityRecord,
  input: CompatibilityInput,
  policy: GoverningPolicy,
): AuthorityVerification {
  const fail = (reasonCode: string): AuthorityVerification => ({ valid: false, reasonCode });
  if (r.signatureDigest !== authoritySignatureDigest(r)) return fail('AUTHORITY_SIGNATURE_INVALID');
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
  const at = Date.parse(input.evaluatedAt);
  const issued = Date.parse(r.issuedAt);
  const expires = Date.parse(r.expiresAt);
  if (issued > at) return fail('AUTHORITY_NOT_YET_VALID');
  if (expires <= at) return fail('AUTHORITY_EXPIRED');
  if (!policy.compatibility) return fail('AUTHORITY_POLICY_MISSING');
  if (expires - issued > policy.compatibility.authorityMaxTtlMs) return fail('AUTHORITY_TTL_EXCEEDED');
  return { valid: true };
}
