# UptimeBuyer Technical Design Document

Status: `SPECIFICATION_ONLY`  
Code, tests, live providers, payments, and deployment: `NOT_RUN`

## 1. Design mandate

Build a failure-recovery system whose claims can be proved. UptimeBuyer must convert a refrigeration incident into a revision-bound plan, block unsafe or ambiguous procurement, execute only authorized commercial actions, survive retries and restarts, and close only from authoritative recovery evidence.

## 2. Non-negotiable decisions

1. State lives in PostgreSQL, not in the model, browser, queue, or Redis.
2. Every proposal is bound to tenant, incident, asset identity, evidence revision, policy revision, and price snapshot.
3. `UNKNOWN` is a first-class result and fails closed.
4. Compatibility uses exact identifiers and deterministic rules; semantic similarity only finds candidates.
5. Safety-critical or substitute actions require a named authorized approver.
6. Only the Kite broker possesses payment credentials and payment egress.
7. An external timeout is ambiguous until reconciled.
8. A provider's completion flag is not repair proof.
9. Recovery requires a stable sensor window and configured human/CMMS evidence.
10. The UI reports evidence, freshness, and uncertainty without optimistic language.

## 3. Aggregate model

- `TenantPolicy`: roles, thresholds, approvals, budget ceilings, allowed vendors, recovery rules.
- `Site`: location, timezone, emergency contacts, operating windows.
- `Asset`: stable equipment handle and pointer to the current immutable revision.
- `AssetRevision`: immutable manufacturer, model, serial, safety class, BOM/warranty identity, and identity digest referenced by every decision.
- `Incident`: deduplicated fault episode and authoritative state machine.
- `EvidenceRevision`: immutable manifest of manuals, telemetry windows, history, transcripts, and citations.
- `CompatibilityDecision`: `ALLOW`, `HOLD`, or `REJECT` plus machine-readable reason codes.
- `RecoveryPlan`: ranked actions and expected cost-to-recovery at one revision.
- `Approval`: signed decision with actor, scope, expiry, and maximum amount.
- `ExecutionAuthority`: immutable signed, revision-bound commercial scope with append-only suspension/revocation/expiry events and a separately reconciled Kite-session activation.
- `CommercialIntent`: provider/payment action before external I/O.
- `ExternalAttempt`: tenant/provider-account-revision-scoped client operation and idempotent request whose reconciliation identity exists before egress.
- `BudgetLedgerEntry`: append-only reserve, release, capture, refund, or reversal movement used to derive gross exposure and net settlement.
- `PurchaseOrder`: purchase-only fulfillment lifecycle, including partial fill, substitution proposal and material change review.
- `ServiceJob`: service-only lifecycle, including scheduling, en route, technician arrival, scope change, no-show and reported completion.
- `RecoveryAssessment`: stable-window calculation and closure evidence.

## 4. Money and measurements

Money uses integer minor units plus ISO currency. Cross-currency comparison is forbidden without a timestamped rate and explicit policy. Temperatures are stored in milli-degrees Celsius with original unit retained. Durations are integer milliseconds. All timestamps are UTC instants; tenant timezone is presentation only. Binary floating point is forbidden for money, thresholds, and scoring inputs; use integer units or a tested decimal library.

## 5. Command path

```text
Command -> schema validation -> authorization -> expected-version check
        -> pure domain transition -> aggregate + outbox transaction
        -> event publication -> bounded job
        -> intent reserve + SEND_STARTED marker persisted -> network call
        -> acknowledgement/UNKNOWN -> reconcile by pre-egress identity
        -> result + evidence transaction -> next event
```

Each command returns `command_id`, aggregate ID/version, and durable state. A `202` response means accepted, never fulfilled.

## 6. Telemetry and incident detection

The gateway authenticates a device certificate/key, resolves source event time to exactly one immutable effective-dated device-to-asset-revision assignment and channel/unit/calibration revision, checks timestamp skew and `(boot_id, sequence)`, normalizes units, and stores those revision IDs on every accepted sample. Missing or overlapping assignments/revisions are invalid. Device rebinding or asset/channel supersession appends a new interval and cannot reinterpret historical samples. Incident rules operate on event time with bounded lateness and pin the sample's asset revision. A rule must define threshold, duration, sensor quorum, stale-data behavior, dedupe window, SOP procedure revision/deadline basis, and recovery window. Missing/stale telemetry produces freshness status `STALE`, `OFFLINE` or `INVALID` (FR-02), never a healthy projection.

## 7. Evidence construction

Evidence ingestion parses an immutable blob, records source, digest, extraction method, page/section spans, and trust level. Every evidence revision pins the immutable asset revision. SERV outputs typed candidates with citations. The evidence builder rejects citations outside the referenced digest/range. Adding, removing, or replacing evidence—or changing the asset revision—creates a new revision and invalidates dependent compatibility, plan, and unexecuted approval decisions.

## 8. Compatibility algorithm

1. Resolve exact asset identity; otherwise `HOLD:ASSET_IDENTITY_UNRESOLVED`.
2. Identify OEM part number/approved service action from revision-bound evidence.
3. Normalize candidate manufacturer and part number; never fuzzy-match as approval.
4. Evaluate deterministic fit, voltage, refrigerant, dimensions, certification, warranty, provider, and policy rules.
5. Exact approved match may become `ALLOW` if all required fields are known.
6. Substitute, conflict, missing field, or safety classification becomes `HOLD` until named approval.
7. Known incompatibility becomes `REJECT`.
8. Persist evaluated inputs, rule version, reasons, and decision hash.

## 9. Cost-to-recovery ranking

For an allowable action:

```text
expected_cost = purchase_or_service_minor
              + expected_delay_ms * downtime_cost_minor_per_hour / 3_600_000
              + versioned_tenant_risk_ppm * inventory_value_minor / 1_000_000
              + repeat_failure_probability_ppm * repeat_failure_cost_minor / 1_000_000
```

All inputs need provenance, revision, units, uncertainty where applicable, and `as_of`. For an open incident, the operational response/containment deadline comes only from its `current_response_deadline_at` projection, derived from the procedure revision pinned at opening plus authorized append-only deadline events. Publishing a later procedure does not change that incident. Any food-risk estimate is optional, non-authoritative, and cannot extend the projected deadline; when enabled its calibration scope is evidence. Compute with exact rational or decimal intermediates and round the final sum half-up once to the minor unit, so a small per-millisecond rate never truncates to zero. Missing mandatory inputs cause `HOLD` rather than an invented zero/default. Evidence sufficiency is an eligibility gate, not a model-confidence price adjustment. Sorting is deterministic: expected cost, recovery ETA, provider score, then stable candidate ID.

## 10. Approval and payment

A plan becomes executable only when current deterministic policy returns allowable and an approval covers action kind, exact provider-account revision, maximum amount, currency, incident, immutable asset revision, evidence/policy revisions, action digest, plan hash and expiry. Idempotent authority issuance creates one immutable `ExecutionAuthority` per approval, persists the exact signed scope, and activates its Kite session through a separate pre-egress operation whose optional provider-session reference and external outcome are durable. Paid reservation requires local authority `ACTIVE`, unexpired and unrevoked, plus Kite-session `CONFIRMED`; an activation timeout is `UNKNOWN` and non-executable until reconciled. The API then creates an opaque `CREATED` commercial intent. If broker revalidation proves it stale before reserve, it becomes terminal no-effect `FAILED`; it is never rebound to a new approval. The semantic action digest remains stable, and later fresh authority may create a successor intent with a new execution-authority/operation identity only after every prior intent for that action has definite-no-effect terminal proof. Under one linearization transaction, the broker rechecks authority, locks the authority/budget, reserves the maximum, creates the client operation/idempotency key, and persists a `SEND_STARTED` attempt marker before calling Kite. The economic intent remains `RESERVED` until the provider acknowledges submission; a lost response becomes `UNKNOWN`. Append-only ledger entries derive approved adjustments, effective limit, open reserve, gross capture, returned value, net settlement, and gross-cap availability. Refunds never recreate authority without a separate signed adjustment.

Approval/authority revocation, authority expiry or asset/evidence/policy/account-revision/price invalidation uses the same serialization boundary. If it commits before reserve-plus-`SEND_STARTED`, egress is denied. If it commits after that point, no new action may start, but the possible in-flight effect remains reserved and must reconcile or safely cancel under its pinned historical authority/account revision; invalidation never deletes or reissues it.

## 11. External calls and reconciliation

Immutable tenant-bound provider-account revisions declare capability, environment, paid/unpaid flag, owner workload, opaque credential reference, endpoint policy and webhook verifier. Every request, approval, intent, attempt and callback pins the exact revision. Supersession invalidates unexecuted work; an in-flight effect remains bound to the historical revision and may use its retained verifier only for a configured reconciliation window. M07 owns provider search, contact request preparation, unpaid execution, quote/transcript normalization and consent evidence. A paid phone/email/API contact becomes a commercial intent whose subject is the immutable contact request; only M09/broker resolves its revision-bound credential and egresses, then M07 consumes the normalized outcome event.

Adapters implement capability assessment, `prepare`, `execute`, `lookup`, and optionally `cancel`. The client operation ID, idempotency key, request digest, and exact provider-account-revision namespace exist before egress. Persist transport (`PREPARED/SEND_STARTED/ACKNOWLEDGED/UNKNOWN/DEFINITE_NO_EFFECT`), normalized external outcome (`REQUESTED/ACCEPTED/CONFIRMED/FAILED/CANCELLED/UNKNOWN`), adapter capability (`ELIGIBLE/UNSUPPORTED`), raw provider status and economic intent as separate axes. `SEND_STARTED` is purely a durable pre-egress marker and does not set external `REQUESTED`; only actual adapter/network handoff sets `REQUESTED`, while economic state remains `RESERVED`. A crash after the marker but before observed handoff reconstructs external/economic `UNKNOWN` with reserve held and never fabricates `REQUESTED`. Only `ACCEPTED` justifies economic `SUBMITTED`. `CONFIRMED` may have no provider reference when authoritative evidence is recovered by the pre-egress client identity. Pre-egress `UNSUPPORTED` blocks send. If recovery capability is absent only after possible egress, capability becomes `UNSUPPORTED` while the effect stays `UNKNOWN`, reserved and manual. Retry is legal only for a proven non-effect or the same provider idempotency key. M07 never directly retries a paid `UNKNOWN`. Reconciliation jobs use capped exponential backoff, absolute deadlines, and a terminal manual-review queue; they never convert timeout alone to failure.

## 12. Recovery verification

The verifier reloads tenant, incident, immutable asset revision, approved plan/action digest, evidence and recovery-policy revisions, and the verified policy-designated intervention-completion milestone. That milestone deterministically freezes `observation_boundary_at`. The verifier evaluates a continuous window in which every qualifying sample is authenticated, correctly revision-bound, `LIVE` under the pinned lateness policy, and has source `event_at` strictly greater than the boundary; boundary-equal, stale, future, duplicate, revoked, cross-tenant, wrong-asset/action, pre-intervention, late, backfilled, or mixed-backfill-plus-fresh-tail windows fail. The window ends in currently fresh telemetry and records exact sample IDs/range, ingestion classifications and calibration revisions. Depending on tenant policy, closure additionally requires the exact tenant/action-bound work-order signoff and installed-part identifier. Provider self-report can advance fulfillment but cannot close the incident. A repeated fault inside the watch window reopens or links a recurrence.

## 13. Concurrency strategy

- optimistic aggregate version on commands;
- unique incident key for overlapping site/asset/rule window;
- unique commercial-intent key for stable action digest plus immutable execution-authority identity, with successor insertion blocked until all predecessors for the action are terminal definite-no-effect;
- unique tenant/provider/account-revision client-operation and idempotency keys;
- row lock for execution-authority lifecycle/expiry, authority adjustment, budget reserve/capture/release and Kite-session activation;
- append-only movement uniqueness for duplicate/concurrent authority, capture, refund, and reversal events;
- approval/policy/asset revision locks shared by invalidation and reserve-plus-`SEND_STARTED` linearization;
- compare-and-set transitions in jobs;
- advisory lock only as an optimization, never the sole correctness mechanism.

## 14. Error taxonomy

| Class | HTTP/API behavior | Workflow behavior |
|---|---|---|
| `VALIDATION` | 400 with field errors | no mutation |
| `UNAUTHENTICATED` | 401 | no mutation |
| `FORBIDDEN` | 403 | audit denial |
| `CONFLICT` | 409 with current version | client reload/redecide |
| `POLICY_HOLD` | 422 typed reason | human review |
| `RATE_LIMIT` | 429 with retry hint | bounded retry |
| `DEPENDENCY_DEFINITE_FAILURE` | 502/recorded | alternate/escalate |
| `DEPENDENCY_UNKNOWN` | 202/recorded | reconcile, no duplicate |
| `INTERNAL` | opaque 500 + correlation ID | dead-letter/escalate |

No error includes secrets, raw provider authorization headers, or model-private content.

## 15. Performance and bounds

Initial product targets, to be validated by load tests rather than claimed: telemetry accepted p95 under 1 second at the documented pilot load; operator reads p95 under 500 ms excluding external providers; incident opening p95 under 30 seconds after a rule becomes true; policy evaluation p95 under 1 second per candidate set; critical notification dispatch p95 under 60 seconds (same targets as `OBSERVABILITY-OPERATIONS.md` §6); all lists cursor-paginated; manual size/page/token limits; worker concurrency per tenant and provider; explicit timeouts and payload limits.

## 16. Verification strategy

- pure unit tests for transitions, policy, money, measurements, compatibility, scoring, and stable-window logic;
- property tests for conservation, idempotency, legal transitions, and monotonic evidence revisions;
- race tests for invalidation immediately before/after egress linearization and for duplicate/concurrent capture/refund/reversal;
- database integration tests with real PostgreSQL and row-level isolation;
- MQTT, object-store, and queue integration tests using service containers;
- adapter contract tests plus separately gated live smoke tests;
- end-to-end browser tests for operator paths and honest states;
- fault injection at every network boundary and between intent/result writes;
- recovery mutation tests using boundary-equal/wrong-milestone, pre-intervention, any late/backfilled or mixed-backfill-plus-fresh-tail, sibling-incident, wrong-action, superseded-asset, revoked-channel, and cross-tenant evidence;
- security tests for tenant escape, prompt injection, SSRF, secret leakage, webhook replay, and approval bypass.

## 17. Definition of technically complete

Technically complete means all mapped tests pass from a clean checkout, the documented real-service gates have executed with redacted evidence, restore and reconciliation drills pass, UI accessibility checks pass, and no critical-path assertion depends on a mock. Documentation/archive validation alone cannot change implementation or runtime status from `NOT_RUN`.

Traceability: FR-01..FR-24, NFR-01..NFR-12, INV-01..INV-16; module ownership M00..M14.

