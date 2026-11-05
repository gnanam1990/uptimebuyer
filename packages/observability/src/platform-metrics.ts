// The platform metric catalog (OBSERVABILITY-OPERATIONS §3) with closed label sets. Alert rules read only these
// names; collectors (packages/operations) set the database-derived gauges and the services increment the counters.
import type { MetricsRegistry } from './metrics.js';

export const ROUTE_CLASSES = ['read', 'command', 'webhook', 'health', 'public', 'static', 'other'] as const;
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export const BOUNDS = [
  'api_requests',
  'gateway_ingest',
  'provider_calls',
  'model_calls',
  'notification',
  'reconciliation',
  'webhook',
] as const;
export const SLO_NAMES = [
  'telemetry_acceptance',
  'incident_opening',
  'operator_read',
  'policy_evaluation',
  'notification_dispatch',
  'outbox_enqueue',
  'reconciliation_entry',
  'api_availability',
] as const;

export function platformMetrics(m: MetricsRegistry) {
  const handles = {
    httpRequests: m.counter('ub_http_requests_total', 'HTTP requests by route class and status class', {
      route_class: ROUTE_CLASSES,
      status_class: STATUS_CLASSES,
    }),
    httpDuration: m.histogram(
      'ub_http_request_duration_ms',
      'HTTP request latency',
      [5, 25, 100, 250, 500, 1000, 2500, 10000],
      {
        route_class: ROUTE_CLASSES,
      },
    ),
    loadShed: m.counter('ub_load_shed_total', 'Work refused by a concurrency bulkhead', { bound: BOUNDS }),
    rateLimited: m.counter('ub_rate_limited_total', 'Work refused by a rate bound', { bound: BOUNDS }),
    webhookRejections: m.counter('ub_webhook_rejections_total', 'Rejected provider callbacks', {
      reason: ['SIGNATURE', 'REPLAY', 'STALE', 'SCHEMA', 'TOO_LARGE', 'UNKNOWN_BINDING', 'OTHER'],
    }),
    brokerInvariantViolations: m.counter(
      'ub_broker_invariant_violations_total',
      'Budget conservation or cap violations',
      {
        invariant: ['GROSS_EQUATION', 'SETTLEMENT_EQUATION', 'INTENT_CAP', 'CAPTURE_RETURNS', 'NEGATIVE_BALANCE'],
      },
    ),
    incidentsClosedWithoutEvidence: m.gauge(
      'ub_incidents_closed_without_evidence',
      'Recovered incidents without a passing evaluation and closeout',
    ),
    isolationSignals: m.counter('ub_isolation_signals_total', 'Cross-tenant or isolation denials worth investigating', {
      surface: ['API', 'DATABASE', 'BROKER', 'WEBHOOK', 'CMMS', 'GATEWAY', 'EXPORT', 'MODEL'],
    }),
    credentialExposureSignals: m.counter(
      'ub_credential_exposure_signals_total',
      'Secret material detected on a guarded surface',
      {
        surface: ['LOG', 'TRACE', 'EXPORT', 'MODEL_INPUT', 'BUNDLE', 'REPOSITORY'],
      },
    ),
    externalUnknownOverdue: m.gauge(
      'ub_external_unknown_overdue',
      'UNKNOWN external outcomes past their reconcile deadline',
    ),
    sensorStaleActiveIncidents: m.gauge(
      'ub_sensor_stale_active_incidents',
      'Active incidents whose asset telemetry is stale',
    ),
    outboxOldestAgeSeconds: m.gauge(
      'ub_outbox_oldest_unpublished_age_seconds',
      'Age of the oldest unpublished outbox event',
    ),
    outboxUnpublished: m.gauge('ub_outbox_unpublished', 'Unpublished outbox events'),
    jobsOldestAgeSeconds: m.gauge('ub_jobs_oldest_runnable_age_seconds', 'Age of the oldest runnable job'),
    jobsDead: m.gauge('ub_jobs_dead', 'Dead-lettered jobs'),
    providerCircuitOpen: m.gauge('ub_provider_circuit_open', 'Open provider circuits', {
      provider_class: ['SEARCH', 'CONTACT', 'FULFILLMENT', 'PAYMENT', 'CMMS', 'MODEL'],
    }),
    modelRuns: m.counter('ub_model_runs_total', 'Reasoning runs by outcome', {
      outcome: ['COMPLETED', 'REJECTED', 'FAILED', 'NOT_RUN'],
    }),
    modelRejections: m.counter('ub_model_rejections_total', 'Rejected reasoning runs by reason class', {
      reason_class: ['SCHEMA', 'CITATION', 'INJECTION', 'BUDGET', 'TOOL', 'OTHER'],
    }),
    backupVerificationFailed: m.gauge('ub_backup_verification_failed', 'Last backup/restore verification failed (1)'),
    sloTargetMissed: m.gauge('ub_slo_target_missed', 'An SLO objective is currently missed (1)', { slo: SLO_NAMES }),
  };
  return { ...handles, names: () => m.names() };
}

export type PlatformMetrics = ReturnType<typeof platformMetrics>;
