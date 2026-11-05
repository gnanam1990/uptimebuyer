// @uptimebuyer/compatibility — M06 compatibility and deterministic safety policy: revision-bound candidate actions,
// fail-closed ALLOW/HOLD/REJECT decisions (one immutable row per evaluated tuple, lifecycle CURRENT/SUPERSEDED),
// HMAC-signed named-engineer and policy-approver authority records, versioned policy administration, and
// invalidation of unexecuted decisions, authority records and approvals on evidence or policy change.
export type { CompatibilityPolicy, RequiredAuthority, ApprovalRoute } from '@uptimebuyer/domain';
export {
  COMPATIBILITY_ID_PREFIXES,
  assertSigning,
  authoritySigningFromEnv,
  type AuthoritySigning,
} from './internal.js';
export * from './events.js';
export {
  getCandidateAction,
  registerCandidateAction,
  type CandidateActionView,
  type CandidateRegistration,
  type RegisterCandidateInput,
  type ResolvedClaim,
} from './candidates.js';
export {
  assertDecisionExecutableInTx,
  checkDecisionExecutable,
  evaluateCandidate,
  getDecision,
  listDecisions,
  reproduceDecision,
  type DecisionView,
  type ExecutableDecision,
} from './decisions.js';
export {
  getAuthorityRecord,
  recordAuthority,
  revokeAuthority,
  type AuthorityRecordView,
  type RecordAuthorityInput,
} from './authority.js';
export {
  approveCompatibilityPolicyProposal,
  publishCompatibilityPolicy,
  listPolicyHistory,
  validatePolicyDraft,
  type PolicyHistoryEntry,
  type PolicyIssue,
} from './policy-admin.js';
export {
  COMPATIBILITY_INVALIDATION_CONSUMER,
  activateEffectivePolicy,
  handleInvalidationEvent,
  type ActivationResult,
} from './invalidation.js';
