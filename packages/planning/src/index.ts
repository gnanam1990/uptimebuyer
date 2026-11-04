// @uptimebuyer/planning — M08 cost-to-recovery planning: versioned tenant risk estimates, immutable revision-bound
// recovery plans that rank only policy-eligible ALLOW candidates by transparent expected cost (pure computation in
// @uptimebuyer/domain), the STATE-MACHINES §4 plan lifecycle with invalidation on evidence/asset/policy/price/deadline
// change, and approval-request preparation. Advisory only: it never approves, reserves, spends or executes.
export {
  PLAN_TIE_BREAK_RULE,
  PLANNING_RULE_VERSION,
  type CostResult,
  type RecoveryPlanEvaluation,
} from '@uptimebuyer/domain';
export { PLANNING_ID_PREFIXES } from './internal.js';
export * from './events.js';
export { publishTenantRiskEstimate, type PublishRiskEstimateInput, type PublishedRiskEstimate } from './risk.js';
export type { CandidateRef } from './assemble.js';
export {
  createRecoveryPlan,
  getRecoveryPlan,
  listIncidentPlans,
  type CreatePlanInput,
  type OptionalRiskEstimateView,
  type PlanActionView,
  type RecoveryPlanView,
} from './plans.js';
export { STALE_INPUTS, type InvalidationResult, type StaleInput } from './lifecycle.js';
export {
  MAX_APPROVAL_REQUEST_TTL_MS,
  getApprovalRequest,
  prepareApprovalRequest,
  type ApprovalRequestView,
  type PrepareApprovalRequestInput,
} from './approval-requests.js';
export {
  PLANNING_CONSUMER,
  PLANNING_EVENT_TYPES,
  PLAN_REVALIDATION_JOB,
  handlePlanRevalidationJob,
  handlePlanningEvent,
  runPlanRevalidationJobs,
} from './consumer.js';
