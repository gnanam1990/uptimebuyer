# UptimeBuyer Product Requirements Document

Version: 1.0  
Status: `SPECIFICATION_ONLY`  
Canonical requirement definitions: `requirements.json`  
Safety authority: `CORE-CONTRACT.md`

## 1. Product thesis

Commercial-refrigeration outages create a time-critical coordination problem. Monitoring products can raise an alarm; CMMS products can store a work order; marketplaces can list providers; payment products can fund a purchase. The operator still has to determine what is technically safe for the exact asset, find an available recovery path, obtain authority, buy or book it, and prove the asset recovered before inventory spoils.

UptimeBuyer is the recovery orchestration layer. Its central promise is not “an AI found a part.” Its central promise is:

> Every autonomous action is bound to exact asset evidence, deterministic safety policy, bounded commercial authority, durable external-state reconciliation, and independent recovery proof.

## 2. Target customer and initial wedge

### 2.1 Economic buyer

The economic buyer is the head of facilities, operations, maintenance, or loss prevention at a business operating multiple chilled or frozen sites. The initial target has at least 10 locations, existing temperature monitoring or a willingness to deploy a gateway, an emergency-service budget, and measurable spoilage or downtime exposure.

### 2.2 Primary users

| Persona | Current responsibility | Product job |
|---|---|---|
| Site operator | Protect food, report failure, admit technician | See the exact next action and attest only what they observed |
| Facilities dispatcher | Triage alarms, call providers, authorize work | Compare technically valid plans and recover the site faster |
| Refrigeration engineer | Validate compatibility and risky substitutions | Review a citation-complete exception instead of reconstructing context |
| Finance or procurement approver | Control merchant and incident spend | Grant a narrow session and audit every economic intent |
| Regional operations lead | Reduce loss and repeat failures | See fleet risk, time to recovery, cost, and provider performance |
| Security or platform administrator | Protect tenants, credentials, and integrations | Enforce identity, egress, retention, and evidence policy |

### 2.3 Jobs to be done

- When a cold asset drifts out of range, tell me whether the signal is real, how long I have, and what evidence is missing.
- When a part or technician is proposed, prove it is valid for the exact asset revision and distinguish fact from model inference.
- When time matters, compare total expected loss and arrival time, not just quoted price.
- When an agent spends, keep the authority narrow and make duplicate, timeout, and retry behavior economically safe.
- When a provider claims completion, verify recovery independently before closing the work order.

## 3. User journey

### 3.1 Detect and triage

An authenticated edge device sends readings with source timestamps and sequence identifiers. Freshness policy distinguishes a healthy reading from stale or missing data. Threshold and duration rules open a single incident per asset fault window. The incident shows temperature trajectory, food-at-risk value, signal quality, required evidence, and a response or containment deadline loaded from a versioned tenant operating procedure. An optional spoilage-risk estimate is separately versioned, source- and uncertainty-labelled, and non-authoritative; it cannot extend, replace, or weaken the configured deadline. See `FR-01`–`FR-04`, `INV-09`, and `INV-11`.

### 3.2 Build an evidence-bound diagnosis

The system retrieves the exact model and serial record, manufacturer manual and BOM, warranty, prior work orders, and site policies. A model may extract likely fault families and candidate parts with citations. Conflicts and missing fields remain visible. Every proposal is bound to evidence and policy revisions. See `FR-05`, `NFR-10`, `INV-02`, `INV-03`, and `INV-10`.

### 3.3 Qualify safe recovery options

Deterministic policy checks exact OEM or manufacturer part number, asset revision, electrical and mechanical constraints, certification, warranty, approved vendor, and substitution rules. It returns `ALLOW`, `HOLD`, or `REJECT`. Search rank and semantic similarity are never sufficient. A safety-critical or substitute path requires a named engineer. See `FR-06`, `FR-10`, `INV-04`, and `INV-15`.

### 3.4 Source and compare

Auditable adapters discover nearby technicians, catalog inventory, temporary containment, and diagnostic services. Phone, email, or provider APIs request availability and quotes. The planner filters out policy-ineligible options and ranks the remainder using:

```text
expected cost to recovery =
  repair cost (service and part)
  + expected delay × downtime cost rate
  + versioned tenant risk estimate × inventory value
  + repeat-failure risk cost
```

The UI exposes inputs, confidence, missing values, and the reason each alternative was allowed, held, or rejected. See `FR-07`–`FR-09`.

For an open incident, the plan uses its `current_response_deadline_at` projection derived from the procedure revision pinned at opening plus authorized append-only deadline events. Publishing a later tenant procedure affects new incidents only and cannot silently re-rank this one. If a tenant enables an optional spoilage probability or deadline model, its model version, input revisions, calibration population, uncertainty and `as_of` time are evidence. The versioned tenant risk estimate is the mandatory input; an optional model may inform it but is not required. Missing mandatory economic or risk inputs produce `HOLD`; model output is never food-safety authority and cannot override the projected SOP deadline.

### 3.5 Authorize and execute

An operator reviews effective provider-account revision, merchant, purpose, action, per-action/aggregate amount, currency and expiry bounds. Idempotent issuance creates one immutable signed execution authority per approval and separately activates/reconciles its Kite Passport session; local authority state, session outcome and optional provider reference survive restart. Paid reserve requires active, unexpired, unrevoked authority plus confirmed session. Only the separately deployed Kite broker workload identity holds Kite credentials and paid-endpoint egress; API, browser, model and general workers receive neither. A canonical action digest plus immutable execution-authority identity maps to at most one economic intent; fresh authority can create a successor only after every predecessor for that action is terminal with definite proof of no effect. Ambiguous session/provider responses become `UNKNOWN` and reconcile before retry. See `FR-11`, `FR-12`, `INV-05`–`INV-08`, and `INV-13`.

### 3.6 Fulfill and verify

Order, shipment, appointment, technician, cancellation, substitution, and failure states remain linked to the approved plan. Substitution returns to compatibility review. After intervention, the system observes the configured stable sensor window and verifies installed-part identity and required CMMS or operator evidence. Provider self-report or a receipt cannot close the incident. See `FR-13`–`FR-17`, `INV-01`, and `INV-14`.

### 3.7 Audit and improve

Every material fact, model proposal, policy result, approval, external action, payment state, receipt, and recovery evaluation appears in a correlated evidence ledger. Fleet views show recovery time, avoided loss estimates with methodology, repeated faults, provider outcomes, and policy exceptions. See `FR-18`–`FR-21`.

## 4. Functional scope

The canonical wording and module mappings live in `requirements.json`; this section explains product intent without replacing that authority.

| ID range | Capability group | Product acceptance summary |
|---|---|---|
| `FR-01`–`FR-03` | Assets, telemetry, incidents | A real tenant-scoped asset produces fresh evidence and one deduplicated incident |
| `FR-04`–`FR-06` | Triage, evidence, compatibility | The system shows cited evidence and fails closed on ambiguity |
| `FR-07`–`FR-10` | Providers, quotes, planning, authority | Only technically eligible options enter a transparent recovery ranking |
| `FR-11`–`FR-12` | Kite session and paid broker | Spend is narrow, credential-isolated, idempotent, and reconciled |
| `FR-13`–`FR-17` | Fulfillment and closeout | External state remains honest and recovery requires independent proof |
| `FR-18`–`FR-21` | Audit, UI, notifications, policy | Operators can understand, control, and export the complete incident |
| `FR-22`–`FR-24` | Real-input mode, privacy, identity | The demo and product preserve truth, lifecycle rights, and tenant boundaries |

## 5. Non-functional requirements

### 5.1 Reliability and economic integrity

The product must survive process restarts and duplicate delivery without losing or duplicating incidents, approvals, payments, orders, or evidence (`NFR-02`, `NFR-03`). External work is bounded by rate, retry, timeout, size, and cost limits (`NFR-04`).

### 5.2 Security and privacy

Every identity is least privileged, secrets remain isolated, and tenant context is server-derived (`NFR-05`, `INV-06`, `INV-13`, `INV-16`). Data is minimized, encrypted where supported, redacted from telemetry, and governed by configurable retention and deletion (`FR-23`, `NFR-06`).

### 5.3 Accessibility and operational clarity

The web experience targets WCAG 2.2 AA and never depends on color alone (`NFR-07`). It exposes latency, freshness, degradation, and uncertainty rather than creating a false green state (`NFR-08`, `INV-11`, `INV-12`).

### 5.4 AI boundary

Model work is recorded with source citations, version, structured output validation, and deterministic disposition (`NFR-10`). Prompt injection in a manual, email, transcript, or provider payload cannot grant tools, change policy, expose a secret, or authorize action.

### 5.5 Delivery and portability

The repository is reproducible from a clean environment (`NFR-01`). Vendor integrations are isolated behind contract-tested adapters (`NFR-11`). Every change maps to IDs and produces evidence (`NFR-12`).

## 6. Information architecture

1. **Fleet:** site and asset health, signal freshness, active risk, food at risk, and unresolved incidents.
2. **Incident command:** live timeline, sensor chart and table, evidence gaps, versioned SOP response/containment clock, optional non-authoritative risk estimate, and next decision.
3. **Evidence:** manual pages, BOM records, history, provider claims, contradictions, and revisions.
4. **Plans:** compatible options, rejected options, cost-to-recovery breakdown, arrival time, and policy decision.
5. **Approval:** exact action digest, effective Kite bounds, authority, expiry, and residual budget.
6. **Fulfillment:** paid actions, receipts, order or job status, reconciliation, and escalation.
7. **Recovery:** observation window, installed-part identity, CMMS signature, pass or fail reason, and reopen history.
8. **Audit:** append-only event ledger and export.
9. **Administration:** tenants, sites, assets, users, roles, policies, adapters, retention, and secrets references.

## 7. Success measures

### 7.1 Pilot outcome measures

- Median time from qualified signal to incident creation.
- Median time from incident to first policy-eligible plan.
- Median time from incident to confirmed provider or order acceptance.
- Median time to verified recovery.
- Percentage of incidents that require human compatibility exception.
- Wrong-part purchase count and prevented incompatible-option count.
- Duplicate economic intent count; target is zero.
- Percentage of ambiguous external actions reconciled without duplicate execution.
- Repeat fault within the configured reopen window.
- Operator minutes spent per incident compared with the documented baseline.

### 7.2 Guardrail measures

- Cross-tenant authorization failures detected in tests; target is zero released defects.
- Paid actions outside approved bounds; target is zero.
- Incident closures without complete authoritative evidence; target is zero.
- Secrets, raw/unapproved/unconsented/unredacted communication, or content beyond the minimum purpose-approved excerpt observed in prompts, client bundles, logs, traces, or unrestricted exports; target is zero. Separately measure approved-excerpt minimization, consent/purpose checks, redaction and audit coverage.
- Critical decisions without source and policy revision; target is zero.

Avoid presenting “avoided spoilage” as audited savings. Label it as an estimate, disclose the formula and inputs, and keep observed recovery outcomes separate.

## 8. Pilot acceptance journey

The first pilot is accepted only when one continuous run proves all of the following with recorded identifiers and timestamps:

1. An authenticated real sensor or explicitly labeled deployed edge process reports an in-range condition.
2. A controlled failure creates an out-of-range condition and one incident.
3. The system retrieves a real manual or BOM and cites the exact relevant evidence.
4. An incompatible or ambiguous option is held or rejected.
5. A compatible plan is ranked using disclosed economic inputs.
6. An authorized person creates a bounded Kite session.
7. At least one real paid action executes through the credential-isolated broker; a receipt alone remains fulfillment evidence, not recovery proof.
8. A duplicate request returns the existing intent.
9. A timeout injection becomes `UNKNOWN` and reconciles before any retry.
10. Intervention evidence is linked to the work order.
11. The sensor remains in the safe range for the configured observation window.
12. Only then does the deterministic evaluator mark the incident `RECOVERED`.

If the selected provider or Kite surface cannot complete a real paid action, the demo must say `UNSUPPORTED` or `NOT_RUN`; it must not replace the critical path with a mock and retain the claim.

## 9. Release gates

### Gate 0 — Feasibility before the full build

- M00 establishes the reproducible local foundation without external spend.
- The separately authorized F0 spike in `prompts/00a-feasibility-spike.md` records one exact sensor, evidence/MPN, Kite paid-action/reconciliation, broker-isolation, recovery-authority and real SERV Reasoning cited-proposal result plus anonymized concrete-incident confirmation from three relevant operators. New outreach requires explicit authorization.
- F0 owns no canonical requirement or test and cannot be cited as product implementation.
- A non-pass result stops the full build unless the user explicitly accepts a narrower, truthful claim.

### Gate A — Domain validity

- Exact asset, manual, BOM, and candidate part evidence are available.
- A refrigeration engineer reviews the compatibility policy and intervention boundary.
- Three target operators validate the implemented workflow, authority model, and pilot acceptance criteria; this later gate is distinct from F0's early problem confirmation.

### Gate B — Economic safety

- Broker credential isolation is proven by negative tests.
- Concurrency, duplicate, timeout, and restart payment tests pass.
- Real bounded payment and reconciliation evidence exist in the intended environment.

### Gate C — Recovery truth

- Stale telemetry cannot appear healthy.
- Provider completion cannot close an incident.
- Stable-window, installed-part, authorization, and reopen tests pass.

### Gate D — Product readiness

- Accessibility, security, privacy, load, chaos, backup, rollback, and observability gates pass.
- Deployment runbook and on-call ownership are accepted.
- Legal review covers calls, transcripts, data retention, warranty, procurement authority, and regulated claims.

### Gate E — Submission readiness

- Event rules and deadline are freshly reverified.
- Public repository, license decision, demo, video, write-up, X post, and claim-evidence matrix are reviewed.
- No private key, provider token, personal phone number, private transcript, customer data, or unreleased vulnerability is published.

## 10. Non-goals and deferred expansion

- Diagnose every refrigeration failure from telemetry alone.
- Replace licensed refrigeration technicians, food-safety policy, procurement, or CMMS.
- Promise automatic emergency dispatch in jurisdictions or sites without prior consent.
- Release final technician compensation solely from a sensor reading.
- Train models on customer manuals, calls, or incidents without explicit lawful authority.
- Expand to HVAC, manufacturing, logistics, or healthcare before the refrigeration wedge has repeatable outcomes.

## 11. Assumptions requiring implementation-time confirmation

- Target customers can provide lawful access to manuals, BOMs, sensor data, service history, and provider contacts.
- The selected Kite services support the intended environment, currencies, merchants, and reconciliation APIs; F0 checks this early, and M09 plus release qualification must prove it again in the implemented product.
- Provider contact and recording consent can be configured by jurisdiction.
- A writable CMMS sandbox or a production-shaped reference adapter is available.
- Pilot hardware and network conditions can support authenticated telemetry with reliable timestamps.

These assumptions are not silently converted into product facts. M00 records the initial assumption inventory; the separately authorized F0 spike records early external feasibility without claiming implementation, and later modules must requalify each dependency against the actual source SHA and environment.

## 12. Truth boundary

This PRD defines intended behavior. It is not evidence that the product, providers, payments, deployment, hardware, integrations, performance, security, or legal controls exist or have passed. Use `TEST-PLAN.md` and `DELIVERY.md` to produce that evidence.
