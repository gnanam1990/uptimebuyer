# Start Here — UptimeBuyer

## Pack status

UptimeBuyer is currently **SPECIFICATION_ONLY**. The files in this pack specify a real product and its proof obligations. They do not establish implementation, provider support, paid fulfillment, sensor behavior, deployment, safety approval, legal approval or production readiness.

| Claim area | Current status |
|---|---|
| Documents and traceability registry | Created; archive QA must be checked in `PACK-QA.md` |
| Application source and tests | NOT_RUN |
| Physical sensor and edge device | NOT_RUN |
| OpenServ/SERV reasoning | NOT_RUN |
| Kite Passport bounded paid action | NOT_RUN |
| StablePhone/StableEmail/StableEnrich/Bitrefill fulfillment | NOT_RUN |
| Catalog or merchant purchase | NOT_RUN |
| CMMS integration | NOT_RUN |
| Telemetry-confirmed recovery | NOT_RUN |
| Security, privacy, legal and licensed-work review | NOT_RUN |
| Deployment and event submission | NOT_RUN |

## Product in one sentence

When a commercial refrigerator fails, UptimeBuyer finds a technically valid recovery action, obtains real provider/part options, spends only within explicit authority, and closes the incident only after independent evidence shows the asset recovered.

## The hard product claim

The central claim is not “an AI agent can shop.” It is:

> A physical fault can be converted into a safe, bounded, commercially executed recovery plan whose outcome is independently verified.

Mocks may exercise presentation and adapter contracts, but they cannot qualify this claim. A credible end-to-end proof needs a real authenticated sensor or controlled physical rig, an exact asset/manual/BOM evidence chain, a deterministic compatibility decision, at least one real bounded provider/payment effect, and a genuine recovery signal.

## Mandatory safety boundary

- The model proposes; deterministic policy and authenticated people authorize.
- Exact OEM/MPN evidence is required unless a named engineer approves a policy-permitted substitute.
- Missing, ambiguous, conflicting or stale compatibility evidence fails closed.
- Raw Kite credentials belong only to the payment broker; general workers and browsers cannot bypass it.
- A timeout becomes `UNKNOWN` and is reconciled before retry.
- Provider self-report, payment receipt or UI action cannot prove recovery.
- Stale or unauthenticated telemetry never appears healthy.
- Tenant isolation and server-side authorization apply to every read, write and export.

## Reading order

1. [PROJECT-BRIEF.md](PROJECT-BRIEF.md) — problem, wedge and product mechanism.
2. [CORE-CONTRACT.md](CORE-CONTRACT.md) — authoritative invariants and completion boundary.
3. [requirements.json](requirements.json) — canonical FR/NFR/INV/module/test registry.
4. [PRD.md](PRD.md) and [USER-JOURNEYS.md](USER-JOURNEYS.md) — product requirements and actor flows.
5. [TDD.md](TDD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DATA-MODEL.md](DATA-MODEL.md), [STATE-MACHINES.md](STATE-MACHINES.md) and [API-EVENT-SPEC.md](API-EVENT-SPEC.md).
6. [AI-SAFETY.md](AI-SAFETY.md), [KITE-OPENSERV-INTEGRATION.md](KITE-OPENSERV-INTEGRATION.md), [HARDWARE-IOT.md](HARDWARE-IOT.md) and [SECURITY.md](SECURITY.md).
7. [UI-SPEC.md](UI-SPEC.md) — complete operator console behavior.
8. [TEST-PLAN.md](TEST-PLAN.md), [OBSERVABILITY-OPERATIONS.md](OBSERVABILITY-OPERATIONS.md), [PRODUCT-OPERATIONS.md](PRODUCT-OPERATIONS.md) and [DEMO-VALIDATION.md](DEMO-VALIDATION.md).
9. [MASTER-PROMPT.md](MASTER-PROMPT.md), [DELIVERY.md](DELIVERY.md), [REPOSITORY-PLAN.md](REPOSITORY-PLAN.md) and [PROMPT-INDEX.md](PROMPT-INDEX.md).
10. [BUSINESS-GTM.md](BUSINESS-GTM.md), [RISKS-DECISIONS.md](RISKS-DECISIONS.md), [EVENT-NOTES.md](EVENT-NOTES.md) and [SOURCES.md](SOURCES.md).
11. [PACK-QA.md](PACK-QA.md) — only document/archive QA, never product qualification.

## One-shot instruction for a coding agent

Use this only when implementation has been authorized in the chosen workspace:

> Treat this pack as a specification, not evidence of an existing product. Read `AGENTS.md` and all repository instructions, then read `START-HERE.md`, `CORE-CONTRACT.md`, `requirements.json`, `MASTER-PROMPT.md`, `PRD.md`, `TDD.md`, `SECURITY.md`, `TEST-PLAN.md`, `DELIVERY.md`, `REPOSITORY-PLAN.md`, and every prompt before editing. Inspect the actual branch, HEAD, dirty worktree, remotes, toolchains and existing architecture; preserve user-owned work. Execute M00, then pause for the explicitly authorized noncanonical F0 feasibility spike; proceed to M01 through M14 only after the user decides on an F0 `PROCEED` recommendation or explicitly accepts a `NARROW` claim based on its preserved evidence. For each canonical module, first demonstrate the missing or broken behavior with a failing test/probe, implement the smallest complete change, run focused and required regression checks, record exact commands/exit codes/results, and produce the module handoff. Do not use mocks to claim the central sensor, compatibility, provider, payment or recovery path. Record unavailable capabilities as `NOT_RUN`, `UNKNOWN` or `UNSUPPORTED`. Do not weaken an invariant to make a demo pass. Local implementation and explicitly requested local commits do not authorize remote repository creation, push, PR, merge, deploy, purchase, real provider contact, recording, publishing or event submission; obtain explicit authorization at each external step.

## Module execution order

| Order | Module | Purpose |
|---:|---|---|
| 0 | M00 | repository intake and foundation |
| Gate | F0 | separately authorized feasibility spike; owns no canonical IDs and does not prove implementation |
| 1 | M01 | shared contracts and domain model |
| 2 | M02 | persistence, tenancy, authentication and authorization |
| 3 | M03 | sensor gateway and edge ingestion |
| 4 | M04 | incident engine and deduplication |
| 5 | M05 | evidence ingestion and bounded reasoning |
| 6 | M06 | compatibility and deterministic safety policy |
| 7 | M07 | provider discovery and communications |
| 8 | M08 | cost-to-recovery planning |
| 9 | M09 | exclusive Kite payment broker |
| 10 | M10 | order, job and external-outcome reconciliation |
| 11 | M11 | recovery verification and CMMS closeout |
| 12 | M12 | operator web application |
| 13 | M13 | adversarial testing, security, performance and observability |
| 14 | M14 | deployment qualification, demo evidence and release gates |

Parallel implementation is permitted only after shared schemas and dependencies are committed and each worker owns non-overlapping files. Database migrations, canonical state machines, shared API contracts and security policy have one designated owner at a time.

## First implementation gate

After M00 and before a large build, complete the separately authorized F0 bounded feasibility spike:

1. one real authenticated sensor or explicitly labelled deployed edge process produces trustworthy normal, fault and restored-condition observations in the isolated spike harness;
2. one exact asset/manual/MPN fact is reproducible with citations, while an ambiguous candidate remains held without claiming the final compatibility engine exists;
3. one real Kite-paid service executes through the isolated exclusive-broker boundary under a small cap;
4. an ambiguous response is reconcilable by the pre-existing operation key without a duplicate economic or provider effect;
5. provider completion remains separate from restored-condition sensor evidence;
6. at least three relevant operators independently confirm a current target pain from concrete recent incidents, with anonymized notes separated from founder inference; outreach requires explicit authorization;
7. one real SERV Reasoning run returns a schema-valid cited proposal without Kite credential or paid-egress access (the event requires SERV Reasoning).

If a gate fails, preserve the evidence and change scope deliberately. Do not replace a failed real integration with a mock and call the gate passed.

## Repository target

The proposed target is a private repository named `gnanam1990/uptimebuyer`. It is a proposal inherited from the user's prior repository preference, not proof that the repository exists or authorization to create it. The coding agent must inspect the real environment and ask before any remote action.

## Definition of complete

Product completion requires all mandatory requirements and invariants to be implemented, every mapped test to have actual evidence, critical providers and the physical recovery loop to be qualified, security/privacy/legal/operational gates to be closed, and the intended deployment to be verified. A green pack checker, code build, mocked test suite, attractive UI, demo video or event acceptance alone is insufficient.

