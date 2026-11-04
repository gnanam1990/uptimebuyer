# UptimeBuyer Project Brief

Status: `SPECIFICATION_ONLY`

## One sentence

UptimeBuyer turns a real commercial-refrigeration failure into a technically valid, policy-approved recovery plan, executes bounded paid actions through Kite Passport, and closes the incident only after independent sensor and work-order evidence proves recovery.

## The problem

When a refrigerator or freezer fails, a site operator must race across fragmented systems: sensor alerts, paper or PDF manuals, bills of materials, warranty terms, supplier catalogs, local technicians, phone calls, purchase approvals, payment, delivery, work orders, and temperature verification. The common failure is not merely detecting an alarm. It is coordinating the correct action before inventory spoils without buying the wrong part, trusting an unverified provider claim, or losing control of autonomous spend.

The first buyer is a multi-site restaurant, grocery, dark-store, or facilities operator with high-value chilled inventory and an existing mix of sensors, service providers, and work-order tooling.

## What the product does

1. Authenticate and ingest temperature, power, current, door, and heartbeat evidence from a real edge device.
2. Open one incident for the failing asset and load the tenant's response or containment deadline from a versioned operating procedure. Any spoilage-risk estimate is separately versioned, uncertainty-labelled, non-authoritative, and cannot replace the configured deadline.
3. Retrieve the exact asset revision's manual, BOM, warranty, history, and approved-provider records with citations.
4. Let a model extract and explain evidence, while deterministic policy alone returns `ALLOW`, `HOLD`, or `REJECT` for compatibility and safety.
5. Discover suppliers and technicians, request real availability and quotes, and preserve calls, emails, and provider responses as evidence.
6. Rank only eligible plans by expected cost to recovery, not item price alone.
7. Obtain a purpose- and amount-bounded Kite Passport session from an authorized operator.
8. Execute paid calls or purchases through a separately deployed, idempotent Kite broker whose workload identity alone holds credentials and paid-endpoint egress; ambiguous outcomes reconcile before retry.
9. Track the order or service job and reopen policy evaluation for cancellation or substitution.
10. Close only after a stable sensor window plus required installed-part identity and CMMS or authorized-operator evidence.

## Why it is not a generic agent-payment wrapper

Kite supplies identity, service discovery, spending controls, and payment rails. UptimeBuyer owns the vertical domain that remains necessary even if those rails improve: asset identity, manual and BOM lineage, compatibility, tenant-configured response timing, optional non-authoritative risk estimates, recovery economics, provider performance, CMMS integration, and authoritative sensor closeout.

## Defensible wedge

The wedge is the complete control loop:

> real failure → exact technical evidence → safe procurement → bounded spend → fulfillment tracking → telemetry-verified recovery

This is not a claim that no competitor can ever build the loop. The initial moat is accumulated asset mappings, compatibility decisions, recovery outcomes, provider performance by failure type, and integration depth inside the operator's daily workflow.

## Critical safety rule

An LLM never independently approves a substitute part, safety-critical repair, paid action, or incident closure. Exact OEM or manufacturer-part-number evidence is required for automatic compatibility; any permitted exception needs a named engineer approval bound to the exact evidence and action revision.

## Working-demo standard

The credible demo uses one physical monitored cooler or a clearly labeled deployed edge process, a real equipment manual, a real incident, one rejected incompatible option, one real provider response, and at least one real bounded Kite-paid action. A provider's “completed” status is deliberately insufficient. The sensor must return to the configured safe range for the full observation window before closeout.

## Pre-build go/no-go gates

After M00 establishes a safe repository, run `prompts/00a-feasibility-spike.md` before the full M01–M14 build. F0 is a separately authorized, deliberately low-value feasibility experiment, not a canonical module and not evidence that the product has been implemented. A real call, email, payment, purchase, or provider mutation occurs only after the user approves its exact target, amount, recipient and cap.

Continue past F0 into M01 only if the F0 evidence can prove:

1. One authenticated sensor or explicitly labelled deployed edge process produces trustworthy normal, fault, and restored-condition observations through the isolated spike harness without claiming product incident state exists.
2. One real Kite-paid service executes inside the isolated bounded broker spike and returns reconcilable evidence.
3. Reasoning agents cannot access raw Kite credentials or bypass paid egress.
4. One exact asset/manual/MPN fact is reproducible from a manufacturer source, while an ambiguous candidate remains held without claiming the final compatibility engine exists.
5. Provider self-report remains separate from restored-condition sensor evidence and cannot be narrated as product recovery.
6. At least three target operators independently confirm from concrete recent incidents that emergency response delay or wrong-part sourcing is a current operational pain; outreach requires explicit authorization and anonymized evidence.
7. One real SERV Reasoning run returns a schema-valid cited proposal while holding no Kite credential or paid egress; SERV Reasoning is mandatory for the event.

If a gate is `FAIL`, `UNKNOWN`, `UNSUPPORTED`, or `BLOCKED`, preserve the evidence and stop the full build unless the user explicitly accepts a narrower claim. Choose a different demonstrable paid action only after recording why it remains semantically bound to the recovery plan; never simulate the central claim. Passing F0 proves only the selected feasibility surfaces, so M01–M14 must still implement and qualify the product.

## Explicit non-goals for the first production slice

- Generic industrial predictive maintenance across every equipment class.
- Unsupervised safety-critical diagnosis or repair instructions.
- A new payment rail, escrow protocol, CMMS replacement, supplier marketplace, or sensor hardware company.
- Autonomous contract acceptance, warranty waiver, or regulated food-safety certification.
- Treating model confidence, a purchase receipt, or provider completion as recovery proof.

## Truth boundary

This pack specifies a product and delivery process. It does not prove that the application, integrations, paid actions, provider fulfillment, deployment, or recovery loop already work. Those remain `NOT_RUN` until the implementation produces the mapped test evidence.
