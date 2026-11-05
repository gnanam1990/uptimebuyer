# ADR 0005 — Order, service-job and external-outcome reconciliation (M10)

Status: accepted (M10, 2026-11-05)

## Context

M10 owns FR-13, FR-17 (the order/job half: facts for the M11 CMMS adapter), NFR-02, NFR-03, NFR-11 and INV-07, INV-08,
INV-12, INV-14 at the order/job layer. M01 already defines the separate PURCHASE_ORDER and SERVICE_JOB machines and the
`purchase_order.state_changed.v1` / `service_job.state_changed.v1` contract events; M09 owns commercial intents, the
single external attempt per intent, the exclusive broker (`execute` / `reconcile`) and the partial unique index
`commercial_intents_one_live_per_digest_ux`. No real merchant, technician dispatch system, webhook sender or payment
exists here.

## Decisions

1. **An order/job is the fulfillment projection of exactly one M09 commercial intent.** `requestOrder` calls M09's own
   `createCommercialIntentInTx` and inserts the one `purchase_orders` (semantic operation PURCHASE) or `service_jobs`
   (SERVICE_BOOKING) row in the same transaction. Other semantic operations are not orders. The row copies the intent's
   pre-egress client operation id, idempotency key and pinned provider-account revision. Order `REQUESTED` means
   "requested by UptimeBuyer"; whether anything was sent is the intent/attempt axes' business (never fabricated).
2. **Dedupe composes with INV-07, never replaces it.** `UNIQUE (tenant, action_digest, execution_authority_id)`,
   `UNIQUE (tenant, commercial_intent_id)` and a partial unique `(tenant, action_digest) WHERE no_effect_proven_at IS
NULL`; the no-effect stamp is set once and only while the intent is `FAILED` (guard UB104). A successor links the
   latest predecessor (UB102). M09's commercial-intent index remains the authority across authorities.
3. **Separate tables, separate SQL edge functions** (`ub_purchase_order_edge_ok`, `ub_service_job_edge_ok`, T-006
   parity); raw provider words are mapped per kind, so the same word cannot cross kinds; providers can never report
   `VERIFIED`/`DISPUTED` (operator receiving inspection / work verification only) or `REQUESTED`/`UNKNOWN`.
4. **Every state change is backed by an immutable observation** (`fulfillment_observations`, append-only, raw status,
   raw body bytes ≤ 64 KiB and digest, details, provider sequence, disposition). Event identity is namespaced by
   `(tenant, provider_account_id, provider_event_key)` with source prefixes `wh:`, `poll:`, `broker:`, `operator:`.
   The observation's composite foreign key carries the order's pinned revision, so an observation verified under any
   other revision cannot attach (database-level refusal of stale-revision retargeting). Leaving `UNKNOWN` requires a
   BROKER/POLL/WEBHOOK observation (UB103). Stale/out-of-order (observed-at or sequence) and regressing observations are
   kept as evidence with disposition STALE/ILLEGAL and never applied.
5. **Webhook verifier model.** Fulfillment webhooks for broker-paid order accounts arrive at
   `/v1/fulfillment-webhooks/{binding}`; the tenant comes only from the binding. The body is size-checked first, then
   HMAC-SHA256 over `<timestamp>.<raw body bytes>` is compared with `timingSafeEqual` against the verifiers of the
   current revision and of superseded revisions within 30 days (only `webhook_verifier_ref` is resolved, never the paid
   `credential_ref`, which stays with the broker), with a 300 s timestamp tolerance and ≥ 32-byte keys. The strict body
   schema has no URL, tenant or revision field. The target is resolved inside the binding's tenant/account by client
   operation id in the table of the event's kind and must be pinned to the revision whose verifier matched; otherwise
   it is quarantined (audited). A verified webhook is a provider statement about fulfillment only: it never changes
   payment state, and a statement about an order whose intent has no attempt is refused (`NOTHING_SENT`). (M07's
   unpaid contact webhooks are unchanged and still refuse broker-owned bindings.)
6. **Polling** claims due rows with `FOR NO KEY UPDATE SKIP LOCKED`, leases them forward (capped exponential backoff,
   48-poll budget) and stops at terminal states. The target is built only from the pinned revision (provider key,
   environment, endpoint-policy digest) plus provider reference or client operation id. The LIVE-shaped
   `HttpsFulfillmentStatusAdapter` reuses M07's guarded HTTPS transport (endpoint policy bound by digest, DNS pre-check
   and guarded connect, no redirects, bounded body) and is `UNSUPPORTED` without its own separately provisioned status
   credential. A lookup "not found" is evidence, never proof of no effect.
7. **UNKNOWN reconciliation is M09's.** `dispatchOrder` calls the broker port `execute` only for a `CREATED` intent;
   `reconcileOrder` calls `reconcile` only for an `UNKNOWN` one; both then mirror the durable intent (SUBMITTED/
   CONFIRMED/REFUNDED/REVERSED → order `ACCEPTED`; UNKNOWN → `UNKNOWN`; FAILED → `CANCELLED`/`REJECTED`/`FAILED` with
   the no-effect stamp). An `UNSUPPORTED` reconciliation capability leaves the order `UNKNOWN` with reconciliation
   `MANUAL_REVIEW`; nothing in M10 retries autonomously.
8. **Material change** (partial fill, substitution, quantity/price/ETA/stock change, cancellation, provider failure,
   rejection, reschedule, no-show, scope change, dispute; also a routine update whose quantity, price, currency or ETA
   is materially worse than the approved terms) enters the explicit state, sets a set-once block, records a
   `fulfillment_change_proposals` row (`auto_accepted` is constrained false; re-entry EVIDENCE/COMPATIBILITY/APPROVAL),
   and invalidates the bound plan through M08 (`EXECUTING → INVALIDATED` + in-flight reconciliation; new stale input
   `EXECUTION`). A changed candidate is a new M06 candidate with a new action digest; the old order/job is not mutated.
9. **Egress linearization point.** `revokeOrder` takes the broker's lock order (planning lock → authority → intent →
   order) and revokes the execution authority. Before linearization the broker then fails the intent (definite no
   effect), the order becomes `CANCELLED` with the no-effect stamp and the plan stays `APPROVED` (a fresh authority may
   create the linked successor). After linearization the effect is preserved and reconciled; the order is blocked
   (`REVOKED_AFTER_EGRESS`) and the executing plan invalidated with in-flight reconciliation. Provider-side cancellation
   is never attempted.
10. **Incident and plan consequences** go through M04's `advanceIncident` (engine path) recomputed from durable state:
    `AWAITING_APPROVAL → EXECUTING` once an attempt exists, `ESCALATED` when blocked after possible egress, `VERIFYING`
    when every live order/job of the plan reports completion; plan `EXECUTING → COMPLETED` when all are operator-
    `VERIFIED` and their payments terminal-reconciled. `RECOVERED` is unreachable from M10 (M11), and no value is
    released (`provesRecovery`/`releasesValue` are constant false).
11. **Lock order** everywhere: planning advisory lock → authority → intent → order row (`FOR NO KEY UPDATE`), the M09
    linearization order; polling claims skip locked rows and wait on nothing.

## Consequences

- The M11 CMMS adapter consumes `purchase_order.state_changed.v1` / `service_job.state_changed.v1` (aggregate version
  = order version, consumer receipts by event id) and reads the order view; `rawEvidence` is null because raw bodies are
  kept in `fulfillment_observations`, not as M05 blobs.
- Real webhook senders, real status endpoints, real orders and real payments are `NOT_RUN`.
- A leaked superseded verifier remains usable for orders pinned to that revision for up to 30 days.
