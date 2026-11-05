// @uptimebuyer/incidents — the M04 incident engine: event-time rule evaluation over LIVE telemetry, database-enforced
// convergence on one active incident per tenant/site/asset/fault window, revision-pinned opening (procedure,
// deadline basis, original deadline, initial owner), versioned lifecycle, assignment and deadline commands under the
// M01 transition table, authorized manual reports, non-authoritative risk estimates and outbox notification triggers.
export * from './rules.js';
export * from './deadline.js';
export * from './events.js';
export {
  PublishIncidentRuleInputSchema,
  PublishProcedureInputSchema,
  publishIncidentRule,
  publishOperatingProcedure,
  type ProcedureRevisionRecord,
  type PublishIncidentRuleInput,
  type PublishProcedureInput,
  type RuleRevisionRecord,
} from './config.js';
export {
  INCIDENT_ENGINE_CONSUMER,
  applyTelemetryStale,
  evaluateIncidentRules,
  handleTelemetryEvent,
  submitManualReport,
  type EvaluateInput,
  type ManualReportInput,
  type RuleEvaluation,
  type TriggerOutcome,
  type TriggerResult,
} from './engine.js';
export {
  acceptAssignment,
  acknowledgeIncident,
  adjustIncidentDeadline,
  advanceIncident,
  assignIncident,
  escalateIncident,
  expireIncidentDeadlines,
  handoffIncident,
  pauseIncident,
  recordRiskEstimate,
  reopenIncident,
  reopenRecoveredIncident,
  resumeIncident,
  returnFromEscalation,
  type ResumeRevalidator,
} from './commands.js';
export {
  getIncident,
  getIncidentTimeline,
  listIncidents,
  type AssignmentView,
  type IncidentTimeline,
  type IncidentView,
  type SignalView,
} from './read.js';
export { INCIDENT_ID_PREFIXES, type IncidentCommandResult } from './internal.js';
export type { IncidentState } from '@uptimebuyer/contracts';
