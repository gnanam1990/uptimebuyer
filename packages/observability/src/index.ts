// @uptimebuyer/observability — structured logs, bounded-label metrics, correlation-carrying traces, redaction,
// health/readiness, SLO tracking and alert rules (M13; NFR-08, NFR-09, INV-13, INV-16). Pure library: no database,
// network or credentials. Database-derived signals and the incident trace live in @uptimebuyer/operations.
export { DEPTH_LIMIT, DROPPED, REDACTED, SecretRegistry, isSensitiveKey, redactString, redactValue } from './redact.js';
export type { RedactionOptions } from './redact.js';
export { CORRELATION_FIELDS, MemorySink, StructuredLogger } from './logger.js';
export type { LogFields, LogLevel, LogValue, LoggerOptions } from './logger.js';
export { Counter, Gauge, Histogram, MetricsRegistry } from './metrics.js';
export type { LabelSpec, Labels, MetricSnapshot } from './metrics.js';
export { MemoryExporter, SPAN_NAMES, Span, Tracer, parseTraceparent, statusOf } from './trace.js';
export type { AttributeValue, SpanContext, SpanOptions, SpanRecord, SpanStatus } from './trace.js';
export { HealthRegistry } from './health.js';
export type { CheckResult, CheckStatus, HealthCheck, ReadinessReport } from './health.js';
export { BOUNDS, ROUTE_CLASSES, SLO_NAMES, STATUS_CLASSES, platformMetrics } from './platform-metrics.js';
export type { PlatformMetrics } from './platform-metrics.js';
export { SLO_TARGETS, SloTracker } from './slo.js';
export type { SloEvaluation, SloName, SloTarget } from './slo.js';
export { ALERT_RULES, AlertRuleSchema, evaluateAlerts, validateAlertRules } from './alerts.js';
export type { AlertRule, FiringAlert } from './alerts.js';
