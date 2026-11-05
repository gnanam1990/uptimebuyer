// @uptimebuyer/recovery — M11 recovery verification and CMMS closeout: authorized intervention evidence and milestones,
// revision-pinned recovery evaluations over a continuous LIVE window strictly after the frozen observation boundary,
// installed-part and work-order signoff gates, the one transactional closeout that is the ONLY path to RECOVERED
// (through M04's non-exported hook, see closeout.ts — deliberately not exported here), reopen/escalation on repeat
// fault, disputed evidence or lost signal, and replay-safe CMMS writes fed by closeouts and M10 order/job facts.
// Provider completion, receipts, model output and unattested text are recorded with labels and never close anything.
export {
  evaluateStableWindow,
  type ChannelWindow,
  type WindowPin,
  type WindowResult,
  type WindowSample,
  type WindowSpec,
} from './window.js';
export {
  CMMS_RECORD_LIMITS,
  ContractFakeCmmsAdapter,
  HttpsCmmsAdapter,
  signCmmsRecord,
  verifyCmmsSignature,
  type CmmsAdapter,
  type CmmsLookupOutcome,
  type CmmsSignatureCheck,
  type CmmsWorkOrderUpdate,
  type CmmsWriteOutcome,
} from './cmms-adapter.js';
export { RECOVERY_ID_PREFIXES, recoverySigningFromEnv, type RecoverySigning } from './internal.js';
export {
  MILESTONE_TYPES,
  RecoveryPolicySchema,
  publishRecoveryPolicy,
  type MilestoneType,
  type RecoveryPolicyBody,
} from './policy.js';
export {
  ingestCmmsRecord,
  recordRecoveryEvidence,
  registerCmmsIntegration,
  revokeCmmsIntegration,
  type CmmsIngestResult,
  type CmmsRecord,
  type RecoveryEvidenceInput,
  type RecoveryEvidenceResult,
} from './evidence.js';
export { recordInterventionMilestone, type MilestoneResult } from './milestones.js';
export { assessRecovery, type AssessmentOutcome, type RecoveryAssessmentResult } from './assess.js';
export type { CloseoutFaults } from './closeout.js';
export {
  RECOVERY_REOPEN_CONSUMER,
  disputeRecoveryEvidence,
  handleIncidentReopenedEvent,
  monitorRecoveredIncidents,
  type DisputeResult,
} from './reopen.js';
export {
  RECOVERY_FACT_CONSUMER,
  handleOrderFactEvent,
  runCmmsWrites,
  type CmmsWriteFaults,
  type CmmsWriteRunResult,
} from './cmms.js';
export { getCloseout, getRecoveryGate, getRecoveryStatus, recoveryMetrics, type RecoveryGate } from './read.js';
