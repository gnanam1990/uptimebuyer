# UptimeBuyer Product Operations

## Status

This is the operating model to implement and qualify. No tenant, provider, payment, production incident, or recovery runbook has been proven merely because it is specified here. Operational readiness is **NOT_RUN**.

## 1. Operating boundary

UptimeBuyer coordinates commercial-refrigeration recovery. It does not replace licensed refrigeration judgment, food-safety obligations, manufacturer requirements, CMMS ownership, procurement controls, insurance, or emergency services.

Autonomous effects are permitted only when all required facts are current and the active tenant policy explicitly allows the action. Unsupported provider capabilities, safety uncertainty, unknown commercial outcome, stale telemetry and conflicting evidence route to a hold or human escalation.

## 2. Service ownership

| Capability | Operational owner | Primary evidence |
|---|---|---|
| Sensor ingestion and freshness | Platform operations | authenticated samples, lag and sequence metrics |
| Asset/manual/BOM authority | Facilities data steward | versioned asset/evidence records and approvals |
| Diagnosis proposals | AI operations | model/config identity, input/output and citation validation |
| Compatibility and safety policy | Refrigeration engineering | rule version, exact decision and named approvals |
| Provider/contact adapters | Vendor operations | request/response, price, transcript and health |
| Budget and paid actions | Finance/platform security | bounded authority, idempotency and reconciliation evidence |
| Orders and work orders | Facilities operations | external IDs, lifecycle events and CMMS state |
| Recovery verification | Site/facilities operations | fresh telemetry, stable window and authorized closeout evidence |
| Tenant access and privacy | Security/privacy owner | role grants, access logs, retention and deletion evidence |

Named people and escalation contacts are configured per deployment; the product must not ship fictitious defaults.

## 3. Environment model

### Local development

Uses local database, broker, object storage and MQTT-compatible service. Synthetic fixtures are permitted and visibly labelled. Local success does not qualify external providers or production behavior.

### Integration qualification

Uses provider sandboxes where available, dedicated low-value accounts, allowlisted recipients/sites and capped budgets. Every adapter records whether evidence came from a sandbox, stub, read-only request, unpaid `402` challenge, or paid fulfillment.

### Pilot

Uses one real site or controlled physical rig, a real authenticated sensor, a real asset/manual pair, real provider actions where safely permitted, a capped Kite session, and an authorized operator. Pilot evidence is not silently generalized to other assets, providers or sites.

### Production

Requires completed security, privacy, legal, provider, operational and physical-safety gates; credential rotation; backups/restores; on-call; support ownership; tenant isolation tests; and deployment rollback. Hackathon acceptance is not production approval.

Environment data, credentials, queues, webhooks, budgets and evidence are partitioned. A sandbox callback cannot mutate a production incident.

## 4. Tenant onboarding runbook

1. Verify contract/customer authority and identify tenant administrators.
2. Create tenant and site boundaries; configure timezone, currency and contacts.
3. Import assets through a reviewed schema; reject ambiguous model/serial identity.
4. Attach authoritative manuals/BOM and record source, revision, checksum and coverage.
5. Bind sensors and run signal authenticity, unit, sequence, stale and backfill tests.
6. Configure incident, food-risk, compatibility, provider, spend, approval and recovery policy.
7. Connect CMMS with least-privilege credentials and prove scoped operations.
8. Configure provider adapters using dedicated credentials and allowlists.
9. Configure Kite through the exclusive broker and a deliberately low qualification cap.
10. Execute the qualification matrix and record actual results.
11. Resolve every critical failure or keep the corresponding capability disabled.
12. Obtain named operational and security approval before pilot activation.

## 5. Incident severity and service objectives

Severity is tenant-configurable but must have deterministic definitions.

| Severity | Example meaning | Response objective | Autonomy default |
|---|---|---|---|
| SEV-1 | active food-safety or high-value loss risk with short deadline | immediate page and continuous ownership | containment within explicit policy; safety/substitute decisions remain gated |
| SEV-2 | confirmed equipment degradation with material downtime risk | rapid acknowledgement and plan | bounded contacts and approved exact-part actions |
| SEV-3 | noncritical fault or repeat-warning investigation | business-hours queue | diagnosis and quote collection only unless policy expands scope |
| SEV-4 | data-quality, maintenance or advisory issue | planned handling | no commercial action by default |

Objectives are operational targets, not guarantees. The product measures detection-to-acknowledge, acknowledge-to-safe-plan, plan-to-authority, authority-to-provider, provider-to-intervention, intervention-to-stable recovery, and total time/cost-to-recovery.

## 6. Incident command

Every active incident has a current owner and next deadline. For SEV-1/2, the timeline records acknowledgement, plan selection, spend authority, provider commitment, onsite start and verification start.

The dispatcher may change owner, escalate, pause an unsafe plan or select another already-authorized plan. They cannot override tenant isolation, forge recovery, expand budget, approve a safety-critical substitute without the required role, or edit historical evidence.

Shift handoff includes:

- incident and asset identity;
- last trustworthy sensor observation;
- current state and blocker;
- selected plan/evidence revision;
- authority remaining and expiry;
- unresolved provider/payment/order outcomes;
- onsite contact and next deadline;
- explicit actions that are unsafe to retry.

## 7. Manual fallback

The system always supports an auditable manual escalation path. A human may contact a provider or arrange a purchase outside UptimeBuyer under the tenant's ordinary controls. The product can record the event as externally performed, with source and evidence, but must not invent an in-product payment or claim it executed the action.

No manual action closes an incident: only the canonical recovery evaluator can transition it to `RECOVERED`. Emergency overrides are append-only, name the authorizing actor/reason/scope/expiry, never erase failed or rejected decisions, and can never transition an incident to `RECOVERED`.

## 8. Provider operations

### Qualification

Each adapter is qualified separately for identity, pricing, request schema, authentication, timeout behavior, idempotency, delivery evidence, reconciliation, rate limits, refunds/cancellation, data handling and failure semantics.

An HTTP `402`, catalog listing, provider documentation or read-only response proves discoverability only. It does not prove paid fulfillment, item compatibility, geographic availability, delivery time, refund behavior or support quality.

### Health

Monitor success/failure, latency, rate limiting, unknown outcomes, reconciliation lag and schema drift. A provider health issue may disable only its dependent plan/actions while preserving incident visibility and manual alternatives.

### Change management

Provider API/schema/terms changes trigger requalification. High-risk changes suspend affected paid actions until reviewed. Hard-coded scraping of a consumer site is not treated as a durable production integration.

## 9. Paid-action operations

The payment broker is the sole component holding Kite credentials and allowed provider egress for Kite-paid actions. General agents, OpenServ workers, browsers and untrusted documents receive no raw credential. One immutable execution authority is issued idempotently per exact approval; local authority lifecycle and external Kite-session activation/reconciliation are separate durable records. A session provider reference is evidence rather than authority identity, and no paid reserve begins until local authority is active/unexpired/unrevoked and session outcome is confirmed.

Before submission, it verifies tenant, incident, active plan, immutable asset/evidence/policy revisions, compatibility digest, authority scope, provider/action allowlist, currency, cap, expiry and idempotency. In one linearization transaction it locks authority/budget, reserves the bounded maximum, and persists the client operation key plus pre-egress `SEND_STARTED` attempt marker before network I/O. A timeout or connection loss produces `UNKNOWN`; reconciliation uses that pre-existing key for authoritative lookup or proven same-key replay before any retry. Pre-egress lack of either capability blocks execution as `UNSUPPORTED`. If discovered after possible egress, only adapter capability becomes `UNSUPPORTED`; the external/economic effect remains `UNKNOWN`, the reservation stays held, and manual resolution cannot relabel it without authoritative evidence.

The append-only budget ledger enforces `base_limit + approved_adjustments = available + reserved + captured_gross` and `captured_gross = paid_net + refunded + reversed`. Duplicate or concurrent provider events cannot apply a movement twice. A refund does not silently recreate authority; re-credit requires a new signed adjustment.

Daily operations reconcile:

- reserved amounts with in-flight actions;
- confirmed payments with provider effects;
- refunds/cancellations with authority balances;
- orders/communications with intended effect digest;
- orphaned callbacks or unmatched provider references;
- stuck unknown outcomes beyond the escalation objective.

No operator resolves a money discrepancy by directly editing canonical tables. Recovery uses a controlled administrative command that validates state, records actor/reason/evidence and preserves the prior record.

## 10. Sensor and recovery operations

Monitor sample lag, invalid signature, duplicate/out-of-order sequences, unit mismatch, device clock drift, offline rate and unexplained value jumps. Backfilled data is labelled and does not retroactively manufacture a live response-time claim.

Recovery verification pins the tenant, incident, immutable asset and sensor revisions, approved action/plan digest, evidence/policy revisions, exact signoffs and policy-designated authorized intervention-completion milestone. It deterministically freezes `observation_boundary_at` and accepts only authenticated samples classified `LIVE` whose source event time is strictly greater than that boundary, remain in the configured safe range for a continuous stable window and end in a currently fresh tail. Boundary-equal, pre-work, stale, late, backfilled, mixed-backfill-plus-fresh-tail, wrong-asset and sibling-incident samples are rejected. The evaluator records every reset reason. If the sensor is offline, the incident is not green; an alternate measurement may count toward the stable window only when it is an authenticated `LIVE` device channel whose identity, calibration and approval the active policy defines; human-read or non-device measurements support diagnosis only (INV-01).

The repeat-fault window continues after initial recovery. Reopen events retain the previous plan, provider, part and evidence so repeat performance is measurable.

## 11. AI operations

Model changes are versioned and evaluated on a frozen corpus containing valid manuals, conflicting evidence, irrelevant documents, malicious embedded instructions, ambiguous MPNs, unit traps and missing data.

AI output is constrained to typed proposals. It cannot:

- issue a compatibility `ALLOW`;
- expand authority or create a budget;
- access raw credentials;
- mark payment/order/provider success without authoritative evidence;
- close an incident;
- silently change asset, policy or document authority.

Monitor schema rejection, invalid citation, unsupported claim, model/provider latency, prompt-injection detection, human rejection, false recommendation and cost. A model regression disables the affected reasoning path without disabling deterministic incident detection or operator access.

## 12. Security operations

Operational controls include least privilege, strong tenant scoping, step-up authentication, secret rotation, webhook verification, outbound allowlists, dependency and container scanning, audit-log protection, encrypted backups, restore tests and incident response.

Security events include cross-tenant access attempt, abnormal authority creation, repeated denied paid action, credential exposure indicator, forged sensor/provider webhook, evidence tampering, policy publication anomaly and administrative recovery command.

Credential rotation does not require deleting evidence. Compromise response immediately disables affected integration/authority, reconciles in-flight effects, preserves forensics, notifies the named owner and follows applicable disclosure requirements.

## 13. Privacy and retention

Collect only data necessary for asset recovery. Provider transcripts, names, phone/email, location, photos and user identifiers may be personal or commercially sensitive. Tenants configure retention within legal/contractual constraints.

Exports and support access are tenant-scoped and logged. Support impersonation is disallowed; approved support access is time-bound, reason-bound and visible. Deletion/anonymization must preserve required financial/security evidence while removing data that no longer has a valid basis.

## 14. Backup, restore and continuity

Define and validate recovery point and recovery time objectives before production. Back up PostgreSQL and object evidence with encryption and access separation. Redis/queues are not the sole record of canonical work.

Restore qualification proves:

- canonical incidents and revisions return;
- evidence hashes and object references remain valid;
- outbox/jobs can resume without duplicate external effects;
- authority and money states reconcile;
- sensor cursors do not classify stale samples as current;
- audit history is preserved.

## 15. Release management

Every release records source SHA, lockfile, migrations, configuration schema, artifact digests, test evidence, known limitations and rollback procedure. Database migrations are forward/backward safe for the deployment strategy or have an explicit maintenance plan.

Release gates include:

1. registry and invariant traceability;
2. focused, integration, adversarial and end-to-end test results;
3. tenant-isolation and authorization evidence;
4. restart/retry/reconciliation evidence;
5. migration and restore evidence;
6. provider qualification status;
7. browser/accessibility evidence;
8. security review and dependency findings;
9. capped pilot authorization.

A passing document checker, CI build or demo video alone cannot authorize production.

## 16. Product metrics

Primary outcome metrics:

- median and percentile time-to-safe-plan;
- median and percentile time-to-verified-recovery;
- downtime and spoilage value avoided, with model/assumptions disclosed;
- first-intervention recovery rate;
- repeat-fault rate;
- exact wrong/incompatible part blocked;
- provider response and recovery performance;
- autonomous effects completed within policy;
- human escalations caused by genuine uncertainty.

Guardrail metrics:

- duplicate commercial effect count;
- unknown payment/provider outcomes and age;
- stale-sensor recovery attempts;
- false recovery declarations;
- unauthorized or cross-tenant access attempts;
- AI citation/schema rejection;
- budget-policy denial;
- incidents with missing evidence.

Vanity metrics such as agent messages, tokens, searches or total spend do not establish customer value.

## 17. Hackathon/demo operations

The demonstration uses a controlled cooler or credible instrumented rig, real sensor ingestion, a real asset/manual pair, real policy decisions, and at least one real bounded provider/payment action. If that action cannot be qualified, the central claim is not made: the demo follows the narrowed-claim rule in `PROJECT-BRIEF.md` and shows the unavailable capability as `NOT_RUN` rather than faked.

The demo rehearses both success and failure:

1. normal telemetry;
2. introduced failure;
3. incident and evidence-bound diagnosis;
4. incompatible/ambiguous option blocked;
5. approved plan and bounded authority;
6. paid provider action with receipt/status;
7. intervention;
8. fresh stable telemetry;
9. recovery closeout;
10. one timeout/retry/reconciliation or false-completion rejection.

Publishing a repository, demo, write-up, X post or event submission is an external action and requires explicit user authorization. Credentials, private tenant data and unsafe instructions must be redacted from every artifact.

## 18. Go-live blockers

Production remains blocked if any of the following is unresolved:

- asset identity or compatibility authority is ambiguous;
- an LLM can create an `ALLOW`, budget or recovery state;
- a general worker/browser can obtain raw Kite credentials or bypass the broker;
- timeout/restart can duplicate a paid or provider effect;
- provider self-report can close an incident;
- stale telemetry can be treated as healthy;
- tenant isolation or server-side authorization is unproven;
- no tested backup/restore and reconciliation path exists;
- security, legal, privacy, food-safety or licensed-work ownership is absent;
- pilot behavior is presented as broad production proof.

