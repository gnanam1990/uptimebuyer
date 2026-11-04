# UptimeBuyer Risks and Decisions

Status: `SPECIFICATION_ONLY`

## 1. Fixed product decisions

| ID | Decision | Reason | Revisit trigger |
|---|---|---|---|
| D-01 | Start with commercial refrigeration | Visible high-cost failure, measurable sensor outcome, repeated equipment families | Three target operators reject the pain or data access is infeasible |
| D-02 | Integrate with CMMS rather than replace it | Work-order replacement is not the differentiating claim | No writable CMMS path exists for target customers |
| D-03 | Models propose; deterministic policy authorizes | Safety, compatibility, and money require reproducibility | Never relaxed for high-risk decisions |
| D-04 | Exact OEM or MPN evidence is the automatic compatibility baseline | Search similarity is unsafe | Named engineer policy creates a scoped exception |
| D-05 | Kite credentials and paid egress belong only to a separately deployed broker workload identity | Prevents gateway bypass and secret leakage by API, browser, agent, or general worker | Never relaxed; provider architecture may change |
| D-06 | External uncertainty is a first-class `UNKNOWN` state | Timeout is not evidence of failure | Never collapsed into success or failure |
| D-07 | Recovery requires independent telemetry plus configured identity and authority evidence | Provider or receipt proof is insufficient | Domain expert changes the policy evidence set |
| D-08 | Optimize expected cost to recovery, not price, while treating the tenant's versioned SOP response deadline as authoritative | Delay and spoilage exposure can dominate cheap-but-slow choices, but an unvalidated prediction cannot become food-safety authority | Formula and optional risk model are calibrated from pilot data |
| D-09 | Real critical-path inputs are required for the winning demo | A mocked purchase or recovery cannot prove the claim | Unsupported provider is replaced, not simulated |
| D-10 | Treat the build pack as specification evidence only | Prevents document completeness from being mistaken for product readiness | Changes only after mapped runtime evidence exists |

## 2. Highest risks

### R-01 — Unsupported real Kite checkout

**Risk:** Catalog discovery or a 402 challenge works, but the intended call, purchase, status lookup, or receipt flow cannot complete in the hackathon environment.

**Control:** Immediately after M00, run F0 from `prompts/00a-feasibility-spike.md` with explicit authorization for the exact low-value external action and a hard cap. Use an isolated broker process/workload identity, record the complete provider state machine, prove the general worker cannot reach paid egress, and select a service with explicit status or reconciliation. StablePhone, StableEmail, StableEnrich, and Bitrefill were catalog candidates in the point-in-time research, not proven fulfillment.

**Stop condition:** No real bounded paid action can complete and reconcile, or the broker boundary is bypassable. Preserve the F0 result and stop the full hackathon build unless the user explicitly accepts a narrowed, truthful claim; F0 is not product implementation evidence even when it passes.

### R-02 — Merchant or part catalog does not cover the demo asset

**Risk:** The exact refrigeration part cannot be bought through a supported merchant.

**Control:** Choose an equipment family and commodity recovery item only after verifying manufacturer evidence, availability, merchant access, shipping or pickup, and provider terms. A real paid diagnostic or contact action may be the Kite transaction while the exact part remains an approved external order, but the demo must describe this boundary honestly.

### R-03 — Sensor signal is not authoritative enough

**Risk:** A single temperature sensor can be misplaced, delayed, spoofed, or remain cold after a compressor failure.

**Control:** Authenticate devices, expose freshness, retain raw and derived values, configure stable duration, use multiple signals where needed, require installed-part and CMMS or operator evidence, and reopen on repeat fault.

### R-04 — Wrong diagnosis or unsafe instruction

**Risk:** A model infers a fault or repair beyond evidence and causes damage or injury.

**Control:** Limit model work to cited extraction and proposals; keep safety classifications, compatibility, tool permissions, and intervention authority deterministic and expert-reviewed. Do not present the product as a substitute for a licensed technician.

### R-05 — Payment or order duplication

**Risk:** Concurrent retries after timeout create multiple charges, orders, or service calls.

**Control:** Canonical action digest, durable uniqueness, atomic reservation, idempotency keys, `UNKNOWN` state, provider reconciliation, and chaos tests across restart and multi-worker execution.

### R-06 — Gateway bypass

**Risk:** An agent reaches a paid endpoint directly using another credential or unrestricted shell/network access.

**Control:** Deploy `apps/kite-broker` under a distinct workload identity, keep the credential-bearing adapter inside that service, grant only it the Kite secret and paid-destination allowlist, deny those destinations to API/web/general workers, and test bypass attempts at the network and runtime layer.

### R-07 — Prompt injection through manuals or provider content

**Risk:** A manual, web page, transcript, or email contains instructions that try to reveal secrets, call tools, or change policy.

**Control:** Treat retrieved content as data, use structured schemas, isolate tools, exclude secrets from model context, validate citations, constrain egress, and run an adversarial corpus.

### R-08 — False savings or recovery claims

**Risk:** The product presents a modelled spoilage deadline or estimated avoided spoilage, a paid request, or a provider status as an observed business outcome or food-safety authority.

**Control:** At incident opening pin the effective tenant SOP and derive the immutable original deadline; thereafter planning reads only the incident's current deadline projection from authorized append-only events. Later SOP publication affects new incidents, not the open one. Keep any spoilage probability or deadline estimate separately versioned, source-labelled, uncertainty-labelled and non-authoritative; missing mandatory inputs hold the plan. Separate estimates from observations, show the formula and source values, use explicit external states, and require recovery evidence for closeout.

### R-09 — Provider communication consent and privacy

**Risk:** Calls or transcripts violate recording, retention, or disclosure rules.

**Control:** Determine jurisdiction and purpose, configure announcements and consent, minimize transcripts, restrict access, support retention and deletion, and obtain legal review before production.

### R-10 — Tenant or role escape

**Risk:** Shared queues, caches, exports, logs, or adapters cross tenant boundaries or permit an unauthorized approval.

**Control:** Server-derived tenant identity, row-level and object-level enforcement, scoped jobs and cache keys, negative tests, redacted observability, and explicit authority checks at the execution boundary.

### R-11 — Competition absorbs surface features

**Risk:** A monitoring, CMMS, marketplace, or Kite platform adds agentic sourcing or payment.

**Control:** Own the evidence graph, compatibility policy, recovery outcomes, integration reliability, and operator workflow. Do not compete on a generic chat or payment wrapper.

### R-12 — Hackathon scope overwhelms delivery

**Risk:** Hardware, models, payments, commerce, CMMS, and UI all remain shallow.

**Control:** Run F0 before the full build, then freeze one equipment family, one controlled failure, one versioned response SOP, one manual, one rejected option, one real paid service, one intervention, and one recovery window. Implement the failure path and evidence honestly before adding breadth. Deadline cut line: the submission deadline is 2026-11-15T23:59Z. If F0 has not produced a user decision on `PROCEED` or an accepted `NARROW` claim with enough room left to build, record and test the chosen slice, the build is submitted under the narrowed claim (for example, real sensor + real SERV run + real paid contact, with physical recovery `NOT_RUN`) rather than expanding scope; no gate is skipped or simulated to meet the date.

## 3. Legal and operational review topics

- Authority to buy, book, cancel, contact, and accept provider terms.
- Warranty, equipment certification, licensed-technician, and food-safety boundaries.
- Call, email, transcript, and location privacy.
- Payment disputes, refunds, chargebacks, and merchant substitution.
- Cross-border currency, tax, and procurement policy.
- Retention, deletion, legal hold, and incident evidence.
- Contract language for estimated savings and system availability.

No section of this pack constitutes legal, food-safety, refrigeration-engineering, or financial advice.

## 4. Decision log procedure

Implementation decisions use `templates/ADR.md`. A decision that changes an `INV-*` invariant, weakens a release gate, broadens a model's authority, changes the economic state machine, or changes the source of recovery truth requires explicit domain, security, and product review. Preserve rejected alternatives and migration or rollback consequences.
