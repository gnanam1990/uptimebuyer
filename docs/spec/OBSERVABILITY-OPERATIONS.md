# UptimeBuyer Observability and Operations

Status: `SPECIFICATION_ONLY`  
Dashboards, alerts, load tests, backup/restore, and production drills: `NOT_RUN`

## 1. Operational principle

Observe the business state and proof chain, not only process uptime. Operators must distinguish an open incident, an unavailable model, a held decision, an ambiguous payment, a delayed job, stale sensors, and a verified recovery.

## 2. Correlation model

Every command, event, queue job, model run, provider call, webhook, and recovery assessment carries:

- `correlation_id` for the end-to-end incident/workflow;
- `causation_id` for the direct command/event;
- tenant, site, incident, aggregate, and attempt IDs where applicable;
- schema/config/rule revision;
- redacted outcome and latency.

Logs never contain raw secrets, authorization headers, contact values, payment details, or any transcript/communication content (partial or redacted); they reference such evidence by digest only.

## 3. Signals

### Business and safety metrics

- active incidents by state, site, severity, and age;
- detection-to-triage, triage-to-plan, plan-to-approval, approval-to-action, and action-to-recovery durations;
- compatibility `ALLOW/HOLD/REJECT` counts and reason codes;
- stale evidence/policy invalidations;
- proposed, reserved, captured, refunded, and unresolved amounts by currency;
- orders/jobs delayed, substituted, cancelled, and disputed;
- recovery evaluations by `PENDING/OBSERVING/PASSED/FAILED/EXPIRED` and typed reason;
- recurrence within watch window;
- false/duplicate incident rate and manual escalation rate.

### Platform metrics

- API latency/error/rate by route class;
- MQTT accept/reject/late/duplicate/skew and device freshness;
- outbox age and unpublished count;
- queue age, depth, active, retry, dead-letter, and per-provider circuit state;
- database connection/lock/transaction/replication/backup signals;
- Redis and object-store errors;
- model run latency/schema rejection/citation failure/token bounds;
- provider latency, definite failure, unknown outcome, reconcile age;
- webhook signature/replay/out-of-order counts.

Metrics must not use unbounded tenant/site/incident/provider-reference labels. IDs belong in traces/logs under access controls.

## 4. Traces

Representative spans:

```text
incident.detect
  evidence.build
    evidence.retrieve
    serv.reason
    citation.validate
  compatibility.evaluate
  plan.rank
  approval.record
  commercial.reserve
  provider.execute
  provider.reconcile
  recovery.assess
  incident.close
```

Span status differentiates rejection/hold from system error. Model and provider raw payloads are referenced by protected evidence digest, not copied into traces.

## 5. Structured log event

```json
{
  "timestamp": "RFC3339 UTC",
  "level": "info",
  "service": "worker",
  "event": "external_attempt_outcome_unknown",
  "correlationId": "corr_opaque",
  "tenantId": "ten_opaque",
  "incidentId": "inc_opaque",
  "attemptId": "att_opaque",
  "provider": "adapter_name",
  "reasonCode": "CLIENT_TIMEOUT",
  "nextReconcileAt": "RFC3339 UTC"
}
```

## 6. Initial SLO candidates

These are proposed targets requiring pilot measurement, not achieved claims:

- 99.9% monthly availability for operator command/read API excluding declared maintenance;
- telemetry acceptance p95 under 1 second of receipt;
- incident opening p95 under 30 seconds after rule maturity;
- operator reads p95 under 500 ms excluding external providers;
- deterministic policy evaluation p95 under 1 second per candidate set;
- critical notification dispatch p95 under 60 seconds after the triggering event;
- 99% of published outbox events enqueued within 10 seconds;
- 99% of external unknown outcomes enter reconciliation within 60 seconds;
- zero incidents closed without all configured authoritative evidence;
- zero spend beyond a current reservation/approval.

The last two are correctness invariants, not error-budget tradeoffs.

## 7. Alerts

| Alert | Severity | Immediate action |
|---|---|---|
| broker budget/invariant violation | critical | stop new commercial intents; preserve state |
| incident closed without evidence link | critical | freeze closure path; reopen/review affected incident |
| credential/tenant isolation signal | critical | revoke/contain and invoke security response |
| pending external outcome past deadline | high | reconcile/manual review; no blind retry |
| sensor stale for active incident | high | contact site; alternate evidence may support diagnosis/containment only and never satisfies the stable window; show unknown |
| outbox/queue age over threshold | high | restore publisher/worker from durable state |
| provider circuit open | medium/high | alternate or escalate under policy |
| model schema/citation rejection spike | medium | disable affected configuration; manual workflow |
| backup/restore verification failed | high | block release and repair protection |

Alerts are deduplicated and routed by tenant/site on-call policy without leaking tenant content.

## 8. Runbooks

### Payment/provider outcome unknown

1. Stop automatic new attempt for the same intent.
2. Inspect persisted request digest, idempotency key, provider reference, and timestamps.
3. Query authoritative lookup/webhook state through the adapter.
4. Capture/release only from authoritative evidence.
5. If the reconciliation deadline expires, place in manual review and retain the reservation until authoritative or manual no-effect resolution; policy cannot release it.

### Outbox or worker backlog

1. Confirm PostgreSQL health and oldest event/job age.
2. Repair publisher/consumer; never delete durable rows to clear a dashboard.
3. Scale within provider/tenant limits.
4. Reprocess idempotently; verify aggregate convergence.

### Sensor outage

1. Mark device/channel stale; do not display health or close recovery.
2. Check broker/connectivity/device identity and last sequence.
3. An alternate authenticated `LIVE` device channel defined by policy may replace the stale channel; human or non-device evidence may support diagnosis/containment only and never satisfies the stable window or closure (INV-01).
4. Backfilled samples retain original time and immutable classification, may trigger a new diagnostic projection, and contribute zero duration to every recovery assessment.

### Model or evidence failure

1. Preserve incident and rejection reason.
2. Disable unhealthy reasoning configuration when systemic.
3. Continue manual deterministic workflow.
4. Re-run only against an explicit evidence/config revision.

### Suspected cross-tenant or secret exposure

Follow `SECURITY.md`: contain, revoke, preserve, scope, notify, reconcile, restore, review. Do not purge evidence before response ownership is established.

## 9. Backup and recovery

PostgreSQL point-in-time recovery, object versioning/immutability, configuration export, and secret-manager recovery are designed and exercised separately. Redis/queues are rebuildable from durable outbox/attempt records. A restore drill must prove tenant, evidence, approval, budget, unknown attempt, and state-machine consistency. Backups are encrypted, access-controlled, and retention-tested.

## 10. Release and change operations

- staged rollout with backward-compatible schemas/events;
- canary by internal tenant/site where permitted;
- broker and policy changes receive separate high-risk review;
- feature flags cannot bypass invariants or authorization;
- rollback plan preserves external attempts and new data;
- migrations and restore fixtures run before promotion;
- post-deploy smoke tests are non-destructive unless explicitly approved.

## 11. Demo operations board

The demo dashboard shows sensor freshness, incident state, evidence revision, deterministic decision, approval/budget, real provider/payment state, reconciliation, and recovery window. It must expose at least one failure path: incompatible part blocked, provider timeout reconciled, duplicate request suppressed, or false completion rejected.

## 12. Operational readiness gate

No production-ready claim until alert delivery, on-call ownership, backup and restore, queue rebuild, payment reconciliation, credential rotation, provider outage, sensor stale, recurrence, and security response have been exercised with timestamped evidence.

Related requirements: FR-02 through FR-04, FR-11 through FR-18, FR-20 through FR-24; NFR-02 through NFR-04, NFR-08, NFR-09, NFR-12; INV-01, INV-05 through INV-14, INV-16.

