# UptimeBuyer User Journeys

## Status and interpretation

These journeys are implementation requirements, not evidence that a workflow has run. Product, provider, payment, sensor, and recovery execution remain **NOT_RUN** until recorded against a running system.

## Journey 1 — Qualify a tenant before autonomy

**Actor:** facilities manager with tenant-administrator support  
**Goal:** create one safely bounded operating site.

1. Create the tenant, site, timezone, currency, escalation contacts and operating hours.
2. Register the refrigeration asset with manufacturer, exact model, serial, compartment, installation date and safety class.
3. Bind an authenticated sensor revision to an immutable asset identity revision and prove current readings, units, sequence handling and freshness.
4. Attach authoritative manual/BOM revisions and identify the pages/sections covering the asset.
5. Configure safe range, incident threshold, stale-signal threshold, recovery stable window and repeat-fault window.
6. Configure approved vendors, compatibility rules, exact-part requirements, approval matrix and incident/action spend caps.
7. Connect CMMS in qualification mode and prove a read and a reversible test work-order write.
8. Connect OpenServ and Kite without exposing raw credentials to the browser, model, or general worker.
9. Run qualification faults: duplicate sample, stale sensor, conflicting manual, ambiguous part, provider timeout, payment outcome unknown and false provider completion.
10. Publish policy only after the system reports which requirements remain unproven.

**Success evidence:** versioned asset identity; sensor identity and sample trail; policy revision; authoritative document checksums; connector qualification report; named approvals.  
**Fail-closed rule:** the site cannot enter autonomous purchasing mode while exact asset identity, telemetry freshness, payment broker isolation, or required approval routes are unproven.

## Journey 2 — Detect and triage an incident

**Actors:** sensor gateway, incident engine, operations dispatcher  
**Goal:** open one canonical incident from trustworthy telemetry.

1. The gateway authenticates and normalizes a temperature, power, current, door or heartbeat sample (FR-02).
2. It rejects an invalid signature/unit, de-duplicates sequence replay, and records original provenance.
3. The incident engine evaluates threshold duration and freshness against the active policy revision.
4. A new incident is created only when no matching active incident exists for the tenant, site, asset and configured fault window (INV-09).
5. Subsequent qualifying samples attach to the incident rather than creating duplicates.
6. The dispatcher sees site, asset, last trustworthy sample, deviation, at-risk inventory, the authoritative current response/containment deadline derived from the incident's pinned procedure plus authorized deadline events, and the next required decision. Any optional safe-time/risk estimate is shown separately with model revision, `as_of`, uncertainty and an explicit non-authoritative label; it cannot move the SOP deadline.
7. The system notifies configured recipients without treating message delivery as incident acknowledgement.

**Success evidence:** canonical incident ID; exact trigger samples; active policy revision; deduplication key; notification outcomes.  
**Alternate path:** if the sensor becomes stale, the incident remains open in a signal-uncertain state and escalates; stale data never proves recovery.

## Journey 3 — Build an evidence-bound diagnosis

**Actors:** OpenServ reasoning worker, dispatcher, refrigeration engineer  
**Goal:** turn fragmented evidence into bounded hypotheses and required checks.

1. Retrieve the incident-bound asset snapshot, service history, installed parts, warranty, manual and BOM revisions.
2. Treat all retrieved content as untrusted data; ignore embedded instructions that attempt to alter the workflow or authorize spending.
3. OpenServ returns structured hypotheses, cited evidence, uncertainty and recommended diagnostic checks.
4. The application validates schema, citations, entity revisions and allowed output types.
5. Deterministic rules classify the proposal as usable, incomplete, conflicting or invalid.
6. The operator can inspect the exact source section and see facts separated from model inference.
7. A named engineer resolves conflicts or safety-critical uncertainty when required.

**Success evidence:** prompt/model/config identity; input evidence hashes; structured output; citation validation; deterministic classification; human decision where applicable.  
**Prohibited shortcut:** model confidence cannot promote an unknown or conflicting part match to `ALLOW`.

## Journey 4 — Select an exact compatible intervention

**Actors:** compatibility engine, engineer, facilities manager  
**Goal:** authorize only a technically supported part or service scope.

1. Candidate part/service records include manufacturer, exact MPN, specifications, certifications, availability, seller and evidence source.
2. The engine compares them with exact asset identity, BOM/manual, installed configuration and policy revision.
3. It returns `ALLOW`, `HOLD`, or `REJECT` plus machine-readable reasons.
4. An OEM exact match may proceed when all policy checks pass.
5. A proposed substitute enters `HOLD`; a named engineer must approve the exact candidate and conditions.
6. Any change to asset identity, evidence revision, candidate SKU/MPN, quantity, seller or intervention scope invalidates the prior decision.
7. Rejected candidates remain visible so later stages cannot silently reintroduce them.

**Success evidence:** compatibility decision digest; candidate identity; source citations; policy revision; approver identity and scope.  
**Failure path:** no compatible candidate triggers escalation to a diagnostic technician or manual sourcing; it never triggers a best-effort purchase.

## Journey 5 — Discover and contact providers

**Actors:** sourcing worker, dispatcher  
**Goal:** obtain real availability and response options without inventing supplier facts.

1. Search approved catalogs and local providers for the exact permitted requirement.
2. Keep discovery source separate from approved-vendor status.
3. Send a constrained availability/quote request via supported email or phone service.
4. Bind every paid contact attempt to incident, provider, request digest, idempotency key and budget authority.
5. Store provider reply/transcript with source identity and redaction policy.
6. Normalize quote, currency, tax, service scope, ETA and validity window.
7. Classify missing, ambiguous and expired fields explicitly rather than filling them with estimates.

**Success evidence:** query and candidate results; communication request; payment outcome; response/transcript; normalized quote; provider identity.  
**Failure path:** a timeout or `UNKNOWN` is reconciled before another paid attempt can duplicate the same effect.

## Journey 6 — Compare recovery plans

**Actors:** cost-to-recovery engine, dispatcher  
**Goal:** rank safe options by likely total loss, not sticker price.

1. Build plans only from compatible interventions and valid provider/availability evidence.
2. Calculate service and part cost, expected downtime cost, spoilage risk and repeat-failure risk using versioned inputs.
3. Display each input, source, unit, currency and uncertainty.
4. Reject arithmetic with mixed currency/unit or missing mandatory values.
5. Apply deterministic tie-breaking and deadline feasibility.
6. Present alternatives and the reason each was rejected, held or ranked lower.
7. Operator selects a plan within their authority or routes it to the correct approver.

**Success evidence:** formula version; inputs; plan digest; ranking; selection and actor.  
**Honesty rule:** incomplete cost data is labelled incomplete; the system does not claim an optimal plan.

## Journey 7 — Approve bounded commercial authority

**Actors:** finance/facilities approver, Kite broker  
**Goal:** authorize an exact incident scope without exposing credentials.

1. Review the plan digest, compatibility revision, providers, permitted action classes, per-action cap, aggregate cap, currency and expiry.
2. Step up authentication on the trusted UptimeBuyer surface.
3. Idempotently issue one immutable execution authority for the exact approval and request its Kite session through the exclusive credential broker.
4. Persist local authority status, signed terms, exact provider-account revision, remaining gross authority, session operation/outcome and optional provider session reference server-side; restart cannot lose them.
5. The general agent and browser receive only opaque references and scoped results.
6. A changed part, seller, provider-account revision, quantity, service scope, amount, policy or incident state suspends or invalidates the authority as defined by policy. Expiry/revocation blocks new intents but preserves reconciliation of a possible in-flight effect.

**Success evidence:** approval record; execution-authority ID and signed scope; Kite-session operation/outcome and optional provider reference; effect digest; cap and expiry; no secret exposure.  
**Failure path:** provider rejection or integration failure leaves the incident operable but not financially authorized; no fallback credential is injected into the agent.

## Journey 8 — Pay, order and reconcile

**Actors:** purchase worker, Kite broker, provider adapter, reconciliation worker  
**Goal:** create at most one intended commercial effect and learn its authoritative outcome.

1. Prepare the purchase or paid service from the current authorized plan.
2. Compute the client operation/idempotency identity from tenant, incident, action class, immutable effect digest and execution authority.
3. In one linearization transaction, revalidate and lock authority/budget, append the reservation, and durably persist that operation identity plus the `SEND_STARTED` attempt marker while the economic intent remains `RESERVED`.
4. Only after that transaction commits, submit through the broker; use economic state `SUBMITTED` only after provider acceptance is observed and store external references without secrets.
5. Classify a timeout as `UNKNOWN`, not failure.
6. Reconcile by the pre-existing operation key using authoritative lookup or proven same-key replay before retrying; otherwise hold for manual resolution.
7. Confirm, fail, cancel, refund or reverse the action through idempotent append-only ledger movements that preserve gross-cap and net-settlement conservation.
8. Create/update the CMMS work order with receipt, order and compatibility references.

**Success evidence:** idempotency key; authority; reservation; provider/payment reference; reconciliation observations; final commercial state.  
**Failure path:** conflicting observations quarantine the action for human review; manual database edits are not an accepted recovery mechanism.

## Journey 9 — Execute onsite work

**Actors:** technician, site operator, dispatcher  
**Goal:** perform the authorized intervention and preserve physical-world evidence.

1. Technician receives only the assigned site, equipment, approved scope and safety instructions.
2. Site operator/technician verifies asset identity before work.
3. When required, scan the installed part barcode/serial and compare it with the approved intervention.
4. Record start/end, observations, photos/documents and deviations.
5. A deviation that changes part, scope or risk pauses completion and moves the incident to `ESCALATED`, which re-enters compatibility/approval after revalidation.
6. Technician may report work complete, but that report alone does not close the incident or release a conditional final action.
7. CMMS records authorized sign-off with actor and timestamp.

**Success evidence:** assignment; asset match; installed-part identity; work evidence; CMMS signature.  
**Safety path:** unsafe condition or inability to verify asset identity stops the workflow and escalates.

## Journey 10 — Verify recovery

**Actors:** sensor gateway, recovery verifier, site operator  
**Goal:** prove that the asset returned to policy-defined operation.

1. After the policy-designated authorized intervention-completion milestone deterministically freezes immutable `observation_boundary_at`, start a stable-window evaluator pinned to tenant, incident, immutable asset/sensor revisions, approved action/plan digest, evidence/policy revisions and exact signoffs.
2. Verify every qualifying sample is classified `LIVE`, has source `event_at > observation_boundary_at`, remains within the safe range and meets calibration/quality rules; require a currently fresh tail and reject boundary-equal, pre-work, any late/backfilled or mixed-backfill-plus-fresh-tail, wrong-asset and sibling-incident data.
3. Reset or pause the window according to policy on violation, gap or stale sensor.
4. Require the configured CMMS/authorized-operator evidence and installed-part match.
5. Only the canonical verifier can transition the incident to `RECOVERED`.
6. Continue the repeat-fault observation window.
7. If the fault recurs, reopen/escalate with the full prior trail and do not claim durable recovery.

**Success evidence:** sample series; stable-window calculation; freshness; work-order signature; installed part; transition record.  
**Prohibited shortcut:** a provider’s “completed” callback, paid receipt or manual UI click is not recovery proof.

## Journey 11 — Reconcile after restart or outage

**Actors:** operations engineer, workers, reconciliation engine  
**Goal:** recover durable work without duplicate effects.

1. Restart application/worker during a provider call, payment submission, order or verification window.
2. Reload canonical workflow state and unprocessed outbox jobs.
3. Claim jobs with bounded leases and concurrency controls.
4. Query authoritative external state before repeating any non-idempotent action.
5. Resume stable-window evaluation from trustworthy persisted samples/cursor.
6. Surface any unresolved external outcome in the action queue.
7. Record recovery actions and correlation IDs.

**Success evidence:** before/after state; restart logs; no duplicate charge/order/contact; resolved leases/outbox; reconciliation result.

## Journey 12 — Audit and learn

**Actors:** auditor, operations leader, product analyst  
**Goal:** explain the complete incident and improve policy without rewriting history.

1. Open the evidence ledger for an incident or selected time/site range.
2. Traverse sensor trigger, evidence revision, reasoning output, deterministic decision, approval, paid actions, provider response, work and recovery proof.
3. Export a tenant-scoped, redacted evidence package.
4. Compare provider response time, first-time recovery, repeat fault, wrong-part block rate and cost-to-recovery.
5. Draft policy changes from aggregate outcomes.
6. Review and publish changes prospectively; historical incidents retain their original policy/evidence revisions.

**Success evidence:** complete causal trail; export checksum; access record; prospective policy revision.  
**Privacy rule:** analytics and exports follow tenant isolation, minimization, retention and redaction policy.

## Cross-journey acceptance

- Every external effect has one incident, one immutable intended effect, one bounded authority and one reconciliation trail.
- Every technical `ALLOW` is bound to exact asset, evidence, candidate and policy revisions.
- Every `RECOVERED` state is backed by authoritative telemetry plus configured completion evidence.
- Unknown, stale, conflicting and unsupported states remain visible and fail closed.
- No model output, provider self-report or UI-local state can independently authorize a safety-critical or financial effect.

