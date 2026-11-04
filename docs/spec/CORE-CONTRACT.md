# UptimeBuyer Core Contract

Status: `SPECIFICATION_ONLY`  
Registry authority: `requirements.json`  
Change rule: update this file and the registry in the same reviewed change.

This contract defines the non-negotiable safety and integrity boundary. A component that violates an invariant is defective even when its local tests pass or a demo appears successful.

## Functional requirements

### FR-01 — Tenant, site, and asset registry

Authorized users can register tenants, sites, refrigeration assets, sensors, asset model and serial identifiers, warranty data, approved vendors, service history, and food-at-risk values with versioned provenance.

### FR-02 — Telemetry ingestion and freshness

The system ingests authenticated temperature, power, current, door, and heartbeat readings, pins each sample to immutable effective-dated device-to-asset assignment and channel/calibration revisions, preserves device sequence and source time, and derives explicit fresh, stale, offline, or invalid status.

### FR-03 — Incident creation and deduplication

Policy-qualified telemetry or an authorized manual report opens one incident per asset and fault window, links corroborating signals, and prevents duplicate active incidents.

### FR-04 — Evidence-based incident triage

The incident engine classifies urgency, pins the active versioned tenant procedure and computed response or containment deadline at incident opening, records any authorized deadline amendment without rewriting the original, assigns durable ownership, identifies likely fault family, required evidence and allowed next actions, and labels any optional food-risk estimate as non-authoritative with provenance and uncertainty.

### FR-05 — Manual, BOM, and history retrieval

The evidence service retrieves the exact asset revision's manuals, parts lists, warranty terms, prior work orders, and approved-vendor records, returning page- or record-level citations and conflicts.

### FR-06 — Deterministic compatibility decision

A deterministic policy evaluates exact OEM or manufacturer part number, asset revision, electrical and mechanical constraints, certification, warranty, and named-engineer approvals to return ALLOW, HOLD, or REJECT.

### FR-07 — Provider and catalog discovery

The system discovers eligible technicians, suppliers, diagnostic services, temporary-containment products, and catalog offers through auditable adapters without treating search rank as approval.

### FR-08 — Quote and contact orchestration

The system can prepare and track quote, availability, arrival-estimate, and diagnostic-commitment contacts through phone, email, and structured provider APIs with consent, transcript provenance, and idempotency; unpaid execution stays in the provider module, while every paid contact becomes a bounded commercial intent executed and reconciled only by the exclusive broker.

### FR-09 — Cost-to-recovery planning

The planner ranks only policy-eligible recovery plans using repair cost, delay multiplied by downtime cost, a versioned tenant risk estimate multiplied by inventory value, and repeat-failure risk, exposes every input and configured containment deadline, and holds rather than ranks when mandatory inputs are missing.

### FR-10 — Approval and escalation policy

The policy layer determines whether a proposed action is automatically permitted, requires a named human or engineer approval, or must be rejected, based on safety class, substitution, amount, evidence, and site policy.

### FR-11 — Bounded Kite spending session

An authorized operator can create a purpose-, incident-, merchant-, action-, amount-, time-, and currency-bounded Kite Passport spending session whose effective limits are displayed before approval.

### FR-12 — Paid-action broker and reconciliation

A single exclusive broker executes authorized Kite-paid calls and purchases with pre-generated client operation and idempotency keys, immutable intent and attempt records, receipts, UNKNOWN outcome handling, and authoritative lookup or proven same-key replay before retry.

### FR-13 — Order and service-job lifecycle

The system tracks purchase, shipment, cancellation, substitution, appointment, technician arrival, work status, and provider failure as explicit states tied to the approved recovery plan.

### FR-14 — Recovery evidence ingestion

The system ingests post-intervention telemetry, installed-part barcode or serial, technician records, CMMS signatures, and authorized-operator attestations with source identity and time.

### FR-15 — Authoritative recovery verification

An incident closes only when a stable telemetry window beginning after the bound authorized intervention milestone uses fresh non-backfilled samples from the pinned asset and sensor revisions, and required installed-part identity plus CMMS or authorized-operator evidence satisfy deterministic recovery policy.

### FR-16 — Escalation and reopening

Provider timeout, failed intervention, incompatible substitution, repeated fault, disputed evidence, or lost recovery signal reopens or escalates the incident without discarding prior evidence.

### FR-17 — CMMS and work-order integration

The system reads and writes work-order status, evidence references, approved plan, costs, receipts, installed-part identity, and closeout decision through isolated, replay-safe CMMS adapters.

### FR-18 — Evidence ledger and export

Every material input, model proposal, policy decision, approval, external action, payment state, receipt, and recovery decision is recorded in an append-only, exportable evidence ledger with correlation identifiers.

### FR-19 — Operations user interface

The web application provides accessible, responsive views for fleet health, incident timeline, evidence, compatibility, plan comparison, approvals, spend, fulfillment, recovery proof, audit, and administration.

### FR-20 — Actionable notifications

The system sends role-appropriate notifications for critical incidents, evidence gaps, approvals, spend exceptions, provider changes, recovery, and reopen events with direct context and recovery paths.

### FR-21 — Policy administration

Authorized administrators can version safety classes, thresholds, recovery windows, approved vendors, amount limits, escalation routes, retention, and integration settings with effective dates and audit history.

### FR-22 — Real-input pilot and demo mode

A pilot can use an authenticated physical sensor or explicitly labeled deployed edge simulator, real manuals, real provider responses, and at least one real bounded Kite-paid action while clearly labeling any unavailable external outcome.

### FR-23 — Privacy and data lifecycle

The system supports data minimization, purpose limitation, configurable retention, legal hold, export, redaction, deletion workflows, and tenant-scoped handling for operational and communication data.

### FR-24 — Authentication, RBAC, and tenant isolation

Human, device, service, and integration identities authenticate separately; permissions enforce tenant, site, role, action, approval, and credential boundaries on every read and write.

## Non-functional requirements

### NFR-01 — Reproducible build

A clean supported environment can install, validate, test, build, migrate, seed, and start the product through documented pinned commands and a committed lockfile.

### NFR-02 — Restart-safe reliability

Durable state, jobs, outbox records, and reconciliation allow safe restart without losing incidents, approvals, payment outcomes, orders, or recovery evidence.

### NFR-03 — Idempotency and concurrency

All external commands and state transitions are idempotent, concurrency-controlled, and safe under duplicate delivery, timeout, retry, and multi-worker execution.

### NFR-04 — Bounded resource use

Ingestion, retrieval, model, provider, notification, and reconciliation work has explicit concurrency, size, rate, retry, timeout, and cost bounds with backpressure.

### NFR-05 — Least-privilege security

Services, users, devices, adapters, and agents receive only required capabilities; sensitive actions require explicit policy and credential isolation; secure defaults fail closed.

### NFR-06 — Privacy by design

Sensitive operational, personal, transcript, and payment data is minimized, encrypted in transit and at rest where supported, redacted from logs, and governed by retention policy.

### NFR-07 — Accessible interaction

The user interface targets WCAG 2.2 AA, full keyboard operation, visible focus, semantic labels, non-color-only status, reduced motion, and screen-reader-readable critical decisions.

### NFR-08 — Operational performance

The product defines and measures latency and availability objectives for telemetry freshness, incident opening, policy evaluation, UI response, notification, and reconciliation without hiding degraded state.

### NFR-09 — Observability and auditability

Structured logs, metrics, traces, audit events, health checks, and correlation identifiers expose every critical path while preventing secrets and unnecessary personal data from entering telemetry.

### NFR-10 — Bounded AI with provenance

Model inputs, outputs, citations, versions, confidence, and policy disposition are recorded; structured validation, tool limits, and deterministic gates prevent model text from directly causing unsafe or paid actions.

### NFR-11 — Adapter portability

Sensor, model, Kite, provider, merchant, messaging, and CMMS integrations sit behind contract-tested adapters so unavailable vendors degrade explicitly rather than corrupting the core domain.

### NFR-12 — Traceable delivery

Each implementation change maps to requirement, invariant, module, and test identifiers and produces reviewable commands, results, evidence, migration notes, and rollback notes.

## Invariants

### INV-01 — Authoritative recovery proof

A provider, model, purchase receipt, or human assertion alone can never prove recovery; closure requires the incident's configured independent telemetry window plus every mandatory identity and authorization signal.

The recovery evaluator pins the tenant, incident, asset and sensor revisions, approved action digest, intervention milestone, evidence and policy revisions, required signoffs, and a post-intervention observation boundary. Pre-work, late backfill, stale, sibling-incident, or wrong-asset samples cannot satisfy the stable window. A later loss of the recovery signal follows the reopen policy instead of rewriting the original closeout.

### INV-02 — No model authorization

An LLM may extract, summarize, rank, and propose, but it can never independently approve compatibility, substitution, safety-critical work, spending, or incident closure.

Only deterministic policy and an authenticated authority record may create an executable approval. Free text cannot be parsed as authority.

### INV-03 — Revision-bound decisions

Every compatibility, approval, purchase, installation, and recovery decision is bound to an immutable tenant and incident, asset identity revision including model and serial, evidence revision, policy revision, and proposed-action digest.

Changing any bound value creates a new proposal and invalidates approvals for the prior digest.

### INV-04 — Compatibility fails closed

Missing, ambiguous, conflicting, stale, or non-exact compatibility evidence produces HOLD or REJECT; semantic similarity, seller text, and search rank never produce ALLOW.

`ALLOW` requires all mandatory fields from an authoritative source or a named engineer approval where policy explicitly permits an exception.

### INV-05 — Hard spending bounds

No paid action may exceed the effective incident, action, merchant, amount, currency, purpose, or expiry bounds approved by an authorized operator, and every reservation, capture, release, refund, reversal, or explicit authority adjustment must preserve the append-only gross-cap and net-settlement conservation equations.

The broker evaluates the limit immediately before execution and atomically reserves budget so concurrent requests cannot overspend. The gross authority equation is `base_limit + approved_adjustments = available + reserved + captured_gross`; the settlement equation is `captured_gross = paid_net + refunded + reversed`. The same equation holds per intent and per referenced capture, so one capture cannot hide an over-refund of another. Refunds do not silently recreate spending authority; a re-credit is a separate signed adjustment.

### INV-06 — Exclusive credential and egress broker

Only the payment broker may hold Kite credentials or reach paid Kite endpoints; reasoning agents, browsers, UI clients, and other workers receive neither raw credentials nor bypass egress.

Network policy and runtime identity enforce the boundary; an application convention or prompt is insufficient.

### INV-07 — Payment intent idempotency

One canonical action digest plus immutable execution-authority identity maps to at most one economic intent; duplicates return it, and a successor under fresh authority is allowed only after every prior intent for that action is terminal with definite proof of no effect.

The uniqueness constraint is durable and authoritative across workers, retries, crashes, and deployments. The semantic action digest remains stable. A new approval cannot create a successor while any prior intent is `RESERVED` (reserve and `SEND_STARTED` commit together), `SUBMITTED`, `UNKNOWN`, `CONFIRMED`, partially or fully `REFUNDED`/`REVERSED`, or otherwise may have had an effect. Because one approval issues one execution authority, the durable constraint is per action digest across authorities: at most one non-`FAILED` intent may exist for a tenant and action digest.

### INV-08 — Unknown is not failure

A timeout, disconnect, or ambiguous external response becomes UNKNOWN and must be reconciled through a pre-existing client operation key against authoritative provider state or proven same-key replay before retry, refund, replacement, or failure is declared; an adapter without that capability cannot retry autonomously.

Operators see the uncertainty and its next reconciliation time; the system does not manufacture a terminal result. If neither authoritative lookup nor provider-guaranteed same-key replay exists, the action remains reserved for manual resolution and the adapter is `UNSUPPORTED` for autonomous retry.

### INV-09 — Single active incident window

For a tenant, site, asset, and configured fault window, concurrent triggers converge on one active incident and append evidence rather than opening independent recovery spend paths.

Database uniqueness and transactional transition logic, not queue ordering, enforce convergence.

### INV-10 — Append-only evidence lineage

Material evidence and decision records are immutable; corrections create linked revisions, and historical decisions remain reproducible from the revisions that governed them.

Deletion and privacy workflows may cryptographically erase or redact governed payloads while retaining a non-sensitive tombstone and legal audit record.

### INV-11 — Stale data never appears healthy

Stale, missing, delayed, invalid, or unauthenticated telemetry can never render a green healthy or recovered state and must expose its freshness condition.

Every health projection includes source time, receipt time, freshness threshold, and status reason.

### INV-12 — External outcome honesty

The product separately distinguishes REQUESTED, ACCEPTED, CONFIRMED, UNKNOWN, FAILED, and CANCELLED external outcomes from ELIGIBLE or UNSUPPORTED adapter capability, and never presents a request, local simulation, or payment receipt as fulfilled work.

Adapters map vendor-specific states into this vocabulary while retaining the original provider status and payload reference.

### INV-13 — Secret non-disclosure

Secrets, raw Kite credentials, payment authorization material, and access tokens never enter model prompts, client bundles, logs, traces, exports, or repository history. Private communication content may enter an approved model run only as a purpose-limited, minimum redacted excerpt under tenant policy with consent where required, and may be displayed or exported only to authorized roles with retention and redaction controls.

Secret-scanning, consent/purpose checks, transcript minimization and redaction tests, isolated credential storage, outbound prompt schemas, role-scoped display/export and retention enforcement implement this rule. Raw or unapproved private content is never a model input.

### INV-14 — No premature completion or release

An order, provider-completed flag, receipt, installed-part claim, or transient safe reading cannot close the incident or release completion-dependent value before the full recovery policy passes.

Completion-dependent action remains pending until the recovery evaluator creates a signed passing decision for the current action digest.

### INV-15 — Human approval for high-risk change

Every substitute part, non-exact match, safety-critical intervention, policy override, or approval outside pre-authorized bounds requires a named authorized human or engineer and creates a signed audit record.

The authority service verifies role, tenant, site, scope, expiry, evidence revision, and proposed-action digest. Role mapping: a substitute part, non-exact match, or safety-critical intervention requires a named engineer; a policy override or an approval outside pre-authorized bounds requires the approver role named by the active policy revision for that amount, site and action class.

### INV-16 — Tenant isolation

No identity, query, cache, job, object, event, export, adapter, or observability path may read, infer, mutate, or act on another tenant's data or authority.

Tenant context is derived from authenticated server-side identity and must never be trusted from an unverified client field.

## Canonical state vocabulary

### Incident

`DETECTED → TRIAGING → AWAITING_EVIDENCE → PLANNING → AWAITING_APPROVAL → EXECUTING → VERIFYING → RECOVERED`

Permitted side paths are `ESCALATED`, `PAUSED`, and `REOPENED`. A failed provider, purchase, diagnosis, or intervention remains a child-action result and cannot terminate ownership of a live refrigeration risk; the incident escalates or pauses; the only direct replanning edge is `AWAITING_APPROVAL → PLANNING` when the plan or approval is invalidated before any reserve-plus-`SEND_STARTED` linearization. Any replanning after possible egress goes through `ESCALATED`. `ESCALATED` and `PAUSED` re-enter only after revision-bound revalidation. `RECOVERED` may transition only to `REOPENED`; historical evidence is not erased.

### Compatibility decision

`ALLOW | HOLD | REJECT`

Only `ALLOW` for the current action digest may enter execution. `HOLD` must identify missing or conflicting evidence and an authorized recovery path.

### External action

`PROPOSED → AUTHORIZED → REQUESTED → ACCEPTED → CONFIRMED`

At any non-terminal provider boundary, `UNKNOWN` is valid. `FAILED` and `CANCELLED` are explicit external outcomes requiring authoritative provider evidence; `UNSUPPORTED` belongs to the separate adapter-capability/policy axis and requires deterministic capability evidence.

`UNSUPPORTED` is a pre-egress adapter-capability/policy disposition; it can block `PROPOSED` or `AUTHORIZED` work. After possible egress, loss of autonomous lookup makes the separate adapter-capability axis `UNSUPPORTED`, but the external action and economic effect remain `UNKNOWN` and reserved until authoritative/manual resolution. Transport, external outcome, adapter capability, and economic intent are never stored as one overloaded state.

### Execution authority and Kite session

Local authority is `ACTIVE | SUSPENDED | REVOKED | EXPIRED`. It is an immutable signed scope with append-only lifecycle events. External Kite-session activation follows the external-action vocabulary and may independently be `UNKNOWN`; a paid reserve requires local `ACTIVE`, unexpired authority plus session `CONFIRMED`. A provider session reference is optional evidence and never substitutes for the execution-authority identity.

### Economic intent

`CREATED → RESERVED → SUBMITTED → CONFIRMED → REFUNDED | REVERSED`, with `UNKNOWN` entered from `RESERVED` (after `SEND_STARTED`) or `SUBMITTED` on ambiguity. `CREATED` or `RESERVED` may reach `FAILED` only with definitive proof that no reserve/egress effect remains; `SUBMITTED` or `UNKNOWN` may reach `FAILED` only with authoritative proof of no economic effect plus an atomic release of the reservation.

The attempt transport substate `SEND_STARTED` and client operation key are persisted before egress while the economic intent remains `RESERVED`. Actual adapter handoff makes the normalized external outcome `REQUESTED`; a crash after the marker but before that observation is durably recorded reconstructs `UNKNOWN`, not a fabricated request. `SUBMITTED` requires provider acknowledgement. Ambiguity after `SEND_STARTED` or submission becomes `UNKNOWN`; only authoritative reconciliation may move it to `SUBMITTED` when acknowledgement alone is proved, or to `CONFIRMED`, `FAILED`, `REVERSED`, or `REFUNDED` when the corresponding outcome is proved. Partial refunds remain append-only movements on a confirmed intent. A terminal pre-egress no-effect intent cannot be rebound to a new approval; fresh authority creates a successor intent with a new authority/operation identity while preserving the stable semantic action digest.

### Purchase and service fulfillment

Purchase and service jobs use separate constrained vocabularies from `STATE-MACHINES.md`. Purchase explicitly represents partial fill, substitution proposal, material quantity/price/ETA review, shipment, delivery, cancellation and failure. Service explicitly represents scheduling, en route, technician arrival, in progress, scope change, no-show, work reported complete, cancellation and failure. No fulfillment state proves equipment recovery.

### Recovery evaluation

`PENDING → OBSERVING → PASSED | FAILED | EXPIRED`

`PASSED` requires the complete configured evidence set. Every qualifying sample is authenticated, classified `LIVE`, strictly later by source event time than the immutable policy-derived intervention boundary, continuously safe, and part of a currently fresh tail. A new evidence or policy revision creates a new evaluation rather than modifying a completed one.

## Decision authority matrix

| Decision | Model contribution | Deterministic policy | Human authority |
|---|---|---|---|
| Extract manual facts | Propose with citations | Validate schema and source | Resolve disputed source when required |
| Exact part compatibility | Explain and compare | Required ALLOW/HOLD/REJECT | Named engineer for permitted exception |
| Recovery-plan ranking | Propose and summarize | Compute eligible set and score | Approve when policy requires |
| Paid action | No authority | Verify bounds and digest | Operator creates bounded session |
| Substitute part | Explain evidence only | Always HOLD without valid exception | Named engineer required |
| Safety-critical intervention | Explain evidence only | Classify and HOLD until approved | Named engineer required |
| Incident closure | Summarize evidence | Required recovery evaluation | Attestation only when configured; cannot replace telemetry |

## Money and measurement rules

- Store money as integer minor units plus ISO currency; never use binary floating point for authorization or settlement.
- Store temperature in an exact canonical unit with source unit retained; conversions use a tested decimal library.
- Persist timestamps as UTC instants and preserve reported source timezone when operationally relevant.
- Canonical digests use versioned serialization and include tenant, incident, immutable asset identity revision, evidence revision, policy revision, action, exact provider-account revision, merchant, amount, currency, and purpose.

## Truth boundary

This document is design evidence, not runtime evidence. Until the implementation runs the mapped tests against real adapters, all provider fulfillment, Kite payments, deployment, hardware behavior, recovery performance, and security properties remain `NOT_RUN`.
