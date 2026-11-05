# UptimeBuyer: hackathon write-up (DRAFT, not submitted)

> DRAFT for SERV Hackathon Edition 02. Not submitted: the hackathon submission is NOT_RUN and needs its own explicit
> authorization (`RELEASE-GATES.md`). Every claim below is tagged with its ledger id (`claims.json`); anything that
> needs a real sensor, provider, payment or deployment is marked NOT_RUN. Screenshots come from a local SIMULATED demo.

## What it does

UptimeBuyer coordinates commercial-refrigeration recovery for multi-site restaurants, grocers and dark stores. A
cooler's temperature signal opens an incident; bounded reasoning gathers cited evidence from manuals and work orders;
deterministic policy blocks incompatible or unsafe actions; an operator approves a bounded spend; an isolated broker
executes the paid action; and the incident closes only on independent recovery evidence (a stable sensor window plus
an authoritative sign-off), never on a provider's say-so.

## How it uses SERV Reasoning

SERV Reasoning (OpenServ) is the evidence and proposal layer: it extracts cited facts from the exact document revision
and proposes recovery candidates. Its output is advisory. Compatibility, safety, authority, budget and closure
decisions are deterministic code over recorded evidence, and every citation is re-checked against the stored document.
In this repository every reasoning run uses a contract-fake adapter with synthetic documents; a real OpenServ run is
NOT_RUN <!-- C-021 -->.

## Track

Kite track (agents with verifiable identity and spending limits) is the proposed track. The Kite integration is a
separate broker workload: an approved, signed execution authority bounds amount, merchant, purpose and expiry, and the
broker alone holds the paid credential and paid egress <!-- C-005 C-006 -->.
A real Kite-paid action is NOT_RUN <!-- C-022 -->: no Kite credential exists here and no PAYMENT authorization was
given; every payment in the demo is RECORDED_CONTRACT.

## What has been shown (local evidence)

- Telemetry ingestion with freshness and deduplication <!-- C-001 C-002 -->.
- Cited evidence with injected-instruction isolation (synthetic documents) <!-- C-003 -->.
- Deterministic compatibility: exact parts allowed, ambiguity held, substitutes need a named engineer <!-- C-004 -->.
- Bounded spending, credential isolation and UNKNOWN-before-retry reconciliation against a recorded-contract broker
  <!-- C-005 C-006 C-007 -->.
- Provider completion cannot close an incident <!-- C-008 -->.
- An accessible console that shows stale, unknown and unsupported states honestly <!-- C-009 -->.
- A worker that schedules every runner with per-runner locks and graceful shutdown <!-- C-010 -->.
- A clean clone built, migrated, started and smoke-tested in a local compose stack, with backup, restore and image
  rollback exercised locally <!-- C-011 C-012 -->.
- Release gates for every external action, all REFUSED; a real-input journey gate that refuses simulated evidence; a
  claim check over these drafts <!-- C-013 C-014 C-015 -->.

## Limits (NOT_RUN)

- Real authenticated physical sensor: NOT_RUN <!-- C-020 -->.
- Real SERV Reasoning run on a real document: NOT_RUN <!-- C-021 -->.
- Real bounded Kite-paid action with downstream fulfillment: NOT_RUN <!-- C-022 -->.
- Independent physical recovery evidence: NOT_RUN <!-- C-023 -->.
- Hosted deployment: NOT_RUN <!-- C-024 -->.
- Public repository, video, X post and submission: NOT_RUN <!-- C-025 -->.
- Production load, SLOs, edge/WAF and enforced network policy: NOT_RUN <!-- C-026 -->.

The demo is SIMULATED end to end: SIMULATOR sensors (SIMULATED_INPUT), a RECORDED_CONTRACT broker, contract-fake
reasoning and CMMS, synthetic data and a local test identity provider. It is not the real-input journey and is never
presented as one.

Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md). Event page: [SERV Hackathon](https://www.openserv.ai/hackathon-2).
