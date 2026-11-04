# Kite Passport and OpenServ Integration

Status: `SPECIFICATION_ONLY`  
Live payment, fulfillment, and OpenServ execution: `NOT_RUN`

## 1. Division of responsibility

| Layer | Owns | Must not own |
|---|---|---|
| OpenServ/SERV | evidence extraction, cited proposal, missing/conflict identification | compatibility approval, budget, payment, recovery closure |
| UptimeBuyer policy | exact-fit rules, approvals, cost-to-recovery, state machines | payment credentials or provider truth fabrication |
| Kite Passport | candidate bounded commercial identity/session/payment execution (capability `NOT_RUN`; which bound dimensions Kite enforces is unverified, and the local `ExecutionAuthority` enforces every bound Kite does not) | refrigeration compatibility or recovery proof |
| Provider adapters | normalized contact/search/order/job operations | policy override or incident closure |
| Sensor/CMMS verifier | authoritative recovery observations | shopping/payment authorization |

## 2. Exclusive broker architecture

Only `kite-broker` can read a Kite credential reference or reach Kite payment endpoints. It runs in a separate service identity and network policy. API, web, OpenServ agent, general workers, and browser are denied that secret and egress. The broker accepts only a signed opaque internal execution reference naming either an `ExecutionAuthority` ID for Kite-session activation/reconciliation or a `CommercialIntent` ID for paid execution/reconciliation. It rejects any embedded authority fields, reloads the named aggregate plus all bound approval/policy/revision/budget state from PostgreSQL, and then acts.

This prevents a shell, model, or alternate HTTP path from bypassing policy merely because the application recommends using a gateway (INV-06).

The canonical immutable `provider_accounts` revision declares whether a capability is unpaid and M07-owned or paid and broker-owned. Requests, approvals, intents, attempts, ledger movements and callbacks pin that exact revision; supersession invalidates unexecuted work without retargeting an in-flight effect. A StablePhone-, StableEmail- (candidates; fulfillment `NOT_RUN`) or any other paid contact is first an immutable M07 contact request, then a commercial intent whose subject references that request. M07 never resolves the paid credential, sends the call/email, or retries its `UNKNOWN`; the broker executes/reconciles and returns a normalized result event.

## 3. Bounded session and budget

An approval supplies incident, immutable asset revision, evidence/policy revisions, plan hash, action digest, exact provider-account revision, allowed action kinds/providers, per-action/aggregate maximum, currency, expiry, and actor. Idempotent issuance persists one immutable signed execution authority per approval. Its local `ACTIVE/SUSPENDED/REVOKED/EXPIRED` lifecycle is append-only and separate from Kite-session activation, which has a pre-egress operation key, transport/outcome/capability state, optional provider session reference and reconciliation. A paid reserve requires local `ACTIVE`, unexpired authority and session `CONFIRMED`; session `UNKNOWN` cannot execute. Broker reservation is transactional:

```text
approved_adjustments = authority_credit - authority_debit
effective_limit = base_limit + approved_adjustments
open_reserved = reserve - release - capture
gross_captured = capture
returned = refund + reversal
net_settled = gross_captured - returned
gross_exposure = open_reserved + gross_captured
available = effective_limit - gross_exposure
require requested_max <= approval_max
require authority_local_state == ACTIVE
require authority_not_expired_or_revoked
require kite_session_outcome == CONFIRMED
require requested_max <= available
reserve requested_max
```

Capture cannot exceed open reservation; release cannot exceed open reservation; every refund/reversal references one same-intent capture, and cumulative returns cannot exceed that capture or intent even when other captures leave account-global headroom. Every movement is append-only and idempotent in the tenant/provider/account event namespace. The original authority is a gross cap, so a refund reduces net settlement but does not silently replenish authority for another purchase. Increasing the amount, re-spending returned value, or changing provider/action requires a new signed authority adjustment or new plan/approval; a refund callback can never create that authority itself.

## 4. Adapter contract

Each paid service adapter implements:

```ts
interface CommercialAdapter {
  assess(input: AuthorizedIntent): Promise<AdapterCapability>;
  prepare(input: AuthorizedIntent): Promise<PreparedRequest>;
  execute(input: PreparedRequest & ClientOperation): Promise<ExternalOutcome>;
  lookup(input: ReconciliationLocator): Promise<ExternalOutcome>;
  cancel?(input: ReconciliationLocator): Promise<ExternalOutcome>;
}
type AdapterCapability =
  | { kind: 'ELIGIBLE' }
  | { kind: 'UNSUPPORTED'; reasonCode: string };
type ClientOperation = {
  clientOperationId: string;
  idempotencyKey: string;
  requestDigest: string;
};
type ReconciliationLocator = {
  clientOperationId: string;
  idempotencyKey: string;
  providerRef?: string;
};
type ExternalOutcome =
  | { kind: 'ACCEPTED'; clientOperationId: string; providerRef?: string; evidence: EvidenceRef }
  | { kind: 'CONFIRMED'; clientOperationId: string; providerRef?: string; receipt: EvidenceRef }
  | { kind: 'FAILED'; clientOperationId: string; reasonCode: string; effect: 'NO_EFFECT_PROVED' }
  | { kind: 'CANCELLED'; clientOperationId: string; providerRef?: string; evidence: EvidenceRef }
  | { kind: 'UNKNOWN'; clientOperationId: string; providerRef?: string; reconcileAfter: string };
```

`clientOperationId`, idempotency key, request digest, exact provider-account-revision namespace, and a `SEND_STARTED` attempt record are committed before egress. `SEND_STARTED` alone leaves the normalized external outcome at `AUTHORIZED`; only an observed adapter/network handoff sets `REQUESTED`, and a crash between the marker and that observation reconstructs `UNKNOWN`. Neither implies acknowledgement. Persist transport state, normalized external outcome, adapter capability and economic-intent state in separate fields. The economic intent remains `RESERVED` until `ACCEPTED` permits it to become `SUBMITTED`. `CONFIRMED` may be recovered solely by the pre-egress client identity and evidence, so `providerRef` is optional. Provider-specific payloads remain inside adapters. Normalized results include observed timestamp and raw-response digest.

Autonomous execution is eligible only when preflight capability supports either authoritative lookup by the pre-egress client operation/idempotency key or provider-enforced same-key idempotent execution whose result can be recovered. Pre-egress `UNSUPPORTED` blocks send. If the absence of recovery capability is discovered after possible egress, adapter capability becomes `UNSUPPORTED` but transport/external/economic outcome stays `UNKNOWN`, reserved and in manual review; the system never converts uncertainty to failure or creates a replacement attempt merely to obtain certainty.

## 5. Intended provider capabilities

The integration design may use Kite-accessible services observed as point-in-time catalog candidates (fulfillment `NOT_RUN`) for search/enrichment, phone, email, shopping, mobile top-up/eSIM, or other paid actions. The pack does not assert continued availability, exact price, or successful fulfillment. Implementation intake must re-query the live catalog and capability/payment schemas, record date and identifiers, and run a capped live spike.

Candidate roles include:

- place/provider discovery and enrichment;
- a paid service call with recorded transcript;
- paid email/SMS-style delivery of instructions;
- compatible-part purchasing through a supported merchant flow;
- temporary connectivity or containment purchase when applicable.

No candidate provider is part of the safety authority.

## 6. OpenServ agent workflow

SERV Reasoning is the event's one mandatory technology ("SERV Reasoning must be part of your build", official page, checked 2026-11-04) and requires an OpenServ account and API key held as a non-Kite secret by the SERV workload only (`f0-serv` in the spike). A build in which SERV is unavailable may keep the deterministic/manual workflow running, but it cannot be submitted as the hackathon build until a real SERV run is recorded. F0-G qualifies this before M01.

The SERV workflow receives a read-only incident packet and invokes bounded evidence tools. It returns a schema-constrained proposal. UptimeBuyer validates citations, stores the reasoning run, and invokes deterministic compatibility/policy functions. A second plan builder computes cost-to-recovery. Only then can an operator approve.

The agent cannot directly invoke Kite, phone, email, merchant, CMMS write, or arbitrary web tools. Communications and commercial actions are separate authorized jobs.

## 7. Idempotency and timeout recovery

The intent key derives from tenant, incident, immutable asset revision, evidence/policy revisions, plan hash, stable semantic action digest, immutable execution-authority identity, exact provider-account revision, and semantic operation. That tuple maps to one intent. The broker persists the client operation ID, request digest, idempotency key, and `SEND_STARTED` marker before calling Kite. On timeout, lost response, or worker death after that marker it stores/reconstructs `UNKNOWN`, retains bounded reserve, and calls provider/Kite lookup with the client operation/idempotency key against that pinned revision even when no provider reference was returned. It never starts a second spend because the first response was lost (INV-07, INV-08).

If revalidation fails while an intent is `CREATED`, it becomes terminal `FAILED` with definite no effect. Reservation and the `SEND_STARTED` marker commit in one linearization transaction, so no committed reserved-but-not-send-started state exists; a failure inside that transaction rolls back both and the intent stays `CREATED` for revalidation or terminal `FAILED`. The intent is never rebound to a later approval. Fresh authority may create a successor with a new execution-authority/operation identity and explicit supersession link only when every prior intent for the stable action digest has terminal definite-no-effect proof; any possible or confirmed effect blocks it.

Asset/evidence/policy/approval invalidation serializes with the reserve-plus-`SEND_STARTED` transaction. An invalidation that wins first blocks egress. An invalidation after the marker prevents new actions but does not erase the possible effect: reconciliation continues, safe cancellation is attempted only through the adapter contract, and the observed result is routed back to incident escalation/replanning.

## 8. Receipts and evidence

A payment receipt proves the payment observation it describes; it does not prove delivery, installation, service quality, or recovery. Store separate evidence for:

1. authorization;
2. payment submission/settlement;
3. provider acceptance;
4. delivery/work report;
5. installed-part/sign-off;
6. sensor recovery window.

The UI and export must not collapse these into a single “completed” badge.

## 9. Live-spike gates

Before a hackathon or pilot claims a working flow:

1. discover current services from official/live catalog;
2. inspect exact request, price/payment challenge, and response schema;
3. execute one low-value, user-approved transaction under a hard cap;
4. force a client timeout and reconcile without duplicate charge;
5. retrieve and redact the receipt/fulfillment artifact;
6. prove the OpenServ worker cannot read broker credentials or call its egress;
7. record failure behavior for insufficient funds, expired approval, price change, provider rejection, and unavailable lookup.
8. kill the broker after durable `SEND_STARTED` but before a provider reference is stored and prove lookup by the pre-egress client operation/idempotency key converges;
9. exercise partial/full refund or reversal when the provider supports it and prove duplicate/concurrent callbacks preserve gross-cap and net-settlement equations; otherwise label refund capability `UNSUPPORTED`.

Until run, each result is `NOT_RUN`, not assumed.

## 10. Demo path

The minimum real demo is: physical or deployed edge telemetry opens an incident; SERV cites a real manual; policy blocks an incompatible choice; an operator approves a capped plan; the broker completes at least one real Kite-paid action; timeout/idempotency evidence is visible; a real sensor stable window plus sign-off closes the incident. Amazon/card onboarding and physical delivery may be shown only if actually completed and documented.

## 11. Secrets and data handling

- secrets are injected by workload identity/secret manager and never committed;
- provider receipts and transcripts are encrypted and role-restricted;
- logs contain provider reference and digest only: no token, card data, payment headers, contact values, or any transcript/communication content, partial or redacted;
- webhook signatures and timestamps are verified;
- model prompts receive redacted minimum data;
- key rotation and revocation are runbook operations.

Related requirements: FR-05, FR-07 through FR-13, FR-18, FR-22; NFR-03, NFR-05, NFR-10, NFR-11; INV-02, INV-05 through INV-08, INV-12, INV-13.

