# UptimeBuyer Full Build Pack

UptimeBuyer is a specification for an autonomous commercial-refrigeration recovery product for multi-site restaurants, grocery operators, and dark stores.

Its central loop is:

```text
real sensor failure
→ evidence-bound diagnosis
→ deterministic compatibility and safety decision
→ real provider discovery and quote/contact work
→ bounded Kite-paid action
→ order or service execution
→ telemetry + CMMS/authorized-operator recovery proof
```

## Truth status

- Pack and documents: **CREATED**
- Artifact type: **SPECIFICATION_ONLY**
- Product implementation: **NOT_RUN**
- Product tests: **NOT_RUN**
- OpenServ/SERV execution: **NOT_RUN**
- Kite paid fulfillment: **NOT_RUN**
- Sensor/CMMS/provider integrations: **NOT_RUN**
- Deployment, public repository, demo recording, event submission and publishing: **NOT_RUN**
- Market validation: **UNPROVEN**
- Working name and trademark availability: **UNVERIFIED**

This pack does not claim that UptimeBuyer is implemented, deployed, production-ready, globally novel, legally approved, or safe for unsupervised refrigeration work. Documentation evidence and archive QA are not product evidence.

## Start here

Read [START-HERE.md](START-HERE.md), then [CORE-CONTRACT.md](CORE-CONTRACT.md). The canonical machine-readable registry is [requirements.json](requirements.json). Implementation governance lives in [MASTER-PROMPT.md](MASTER-PROMPT.md), [DELIVERY.md](DELIVERY.md), and [REPOSITORY-PLAN.md](REPOSITORY-PLAN.md).

The coding prompts are deliberately modular. Begin with `prompts/00-intake-foundation.md`, then run the separately authorized, noncanonical `prompts/00a-feasibility-spike.md` before committing to the full build. Do not skip dependency evidence or let parallel work invent incompatible contracts.

## Non-negotiable boundary

An LLM may retrieve, extract, summarize, rank and propose. It may not independently create an exact-part `ALLOW`, approve a substitute, authorize safety-critical work, expand spend, determine an unknown payment outcome, or close an incident. Those effects require deterministic policy, bounded authenticated authority, and authoritative external evidence.

Only the exclusive payment broker may hold Kite credentials or reach paid Kite endpoints. A provider's completion message, invoice, receipt, agent assertion or operator button alone cannot prove recovery. Recovery requires the configured fresh telemetry window plus required CMMS/authorized-operator and installed-part evidence.

## Included artifacts

- product: brief, PRD, journeys, business/GTM, risks and source evidence;
- technical: TDD, architecture, data, API/events, state machines, IoT, AI safety and provider integration;
- experience: complete responsive UI specification;
- assurance: core invariants, security, tests, observability, operations and demo validation;
- delivery: repository/branch/commit/PR discipline, module prompts and handoff templates;
- QA: machine-readable traceability, reusable checker and content-addressed inventory.

## Intended use

Give the extracted folder—not only the ZIP—to a coding agent in a clean or existing repository. The agent must first inspect repository instructions, actual source, branch, dirty changes, remotes, toolchains, credentials metadata and provider access. If the environment conflicts with this proposal, record an ADR and preserve the invariants rather than forcing the proposed stack.

Local implementation work is not authorization to create a remote repository, push, open or merge a pull request, deploy, spend money, contact a real person, buy a product, record a site, publish content, or submit to an event. Those actions require explicit user authorization at the relevant step.

## Validate the pack

From the extracted pack root:

```bash
node scripts/check-build-pack.mjs --root . --config config/pack-check.json
```

The checker validates configured document structure, traceability, links and inventory. A passing result proves only those configured checks; semantic consistency is reviewed separately, and neither result means the product works.

