# UptimeBuyer: hackathon write-up (DRAFT, not submitted)

> DRAFT for SERV Hackathon 02, Track 02 (Kite). Not submitted: the submission needs its own explicit authorization
> (`RELEASE-GATES.md`, `GATE-REQUESTS.md`). Every claim carries its ledger id (`claims.json`). The console walk-through
> in the demo is SIMULATED; the evidence segments show committed records of real runs; what is not yet proven is NOT_RUN.

## What it does

UptimeBuyer coordinates commercial-refrigeration recovery for multi-site restaurants, grocers and dark stores. A cooler's
temperature signal opens one incident; SERV Reasoning reads the equipment manual and proposes cited facts and candidate
actions; deterministic code decides compatibility, safety, authority and budget; an operator approves a bounded spend; an
isolated broker makes the paid call; and the incident closes only on independent recovery evidence (a stable sensor
window plus an authoritative sign-off), never on a provider's say-so <!-- C-002 C-004 C-005 C-008 -->.

## How it uses SERV Reasoning

- SERV Reasoning is the evidence and proposal layer. It receives the exact manual revision and the incident packet,
  calls two product tools (asset snapshot, candidate schema) and returns fault hypotheses, extracted fields with
  citations, candidate actions with evidence for and against, and its uncertainty.
- The answer is a MODEL PROPOSAL with authority NONE. The product re-opens every citation against the stored document
  and rejects the whole proposal on any mismatch; injected document instructions are isolated <!-- C-003 -->.
- Decisions stay deterministic code over recorded evidence: compatibility ALLOW, HOLD or REJECT, safety, budget and
  closure <!-- C-004 C-008 -->.
- Recorded run (the full journey stays NOT_RUN): journey `j-2026-11-12-serv-document-2`, one serv-mini call over the published Dixell XR60CX manual from Copeland, run `rsn_49008919…` COMPLETED, $0.024365, 7 of 7 citations re-opened and verified; journey gate document PASS and reasoning PASS <!-- C-021 -->.
- The run before it, `j-2026-11-12-serv-document`, was REJECTED by the citation validator (PDF font decoding, since fixed) and is recorded as such, not counted (NOT_RUN) <!-- C-021 -->.

## Kite track (Track 02)

Agents with verifiable identity and spending limits you control:

- Exclusive broker: only `kite-broker` holds the paid credential and the paid egress; the API and worker reach it through
  signed, single-use references <!-- C-006 -->.
- Signed bounded authority: amount, merchant, purpose and expiry, with hard caps in code (1 cent per call, 5 cents per
  session) <!-- C-005 -->. Any payment outside local tests also needs the owner's single-use, Ed25519-signed PAYMENT gate
  record <!-- C-013 C-018 -->.
- Recorded payment (the full journey stays NOT_RUN): journey `j-2026-11-13-kite-payment-2`, a passkey-approved Kite Passport session of one cent, one x402 payment of 0.01 USDC to lionx402.com (OpenStreetMap business search), debited from the broker wallet's Base USDC <!-- C-022 -->.
- Recorded fulfillment and duplicate (the full journey stays NOT_RUN): the merchant answered HTTP 200 with 7 refrigeration-repair businesses; a duplicate request returned the same intent with no second charge <!-- C-022 -->.
- Honest UNKNOWN (recorded; the full journey stays NOT_RUN): kpass reported settlement chain id 2366, not Base (8453), so the broker recorded UNKNOWN, kept the reservation and retried nothing <!-- C-007 C-022 -->.
- Manual resolution (recorded; the full journey stays NOT_RUN): the owner, as finance approver, resolved it CAPTURED through the product's manual resolution from out-of-band evidence (wallet 1.10 to 1.09 USDC, Kite activity, session spent 0.01) <!-- C-022 -->.
- Open question, NOT_RUN as verified: what chain id 2366 denotes; the adapter still refuses to confirm any chain but Base automatically <!-- C-022 -->.
- The first attempt, `j-2026-11-13-kite-payment`, made no payment (the session was never approved) and is recorded as such (NOT_RUN) <!-- C-022 -->.

## What was built during the hackathon

Everything in this repository, from the build pack imported on 2026-11-04 to 2026-11-13 <!-- C-015 -->: the workspace and
secret scan (M00), contracts and domain (M01), storage, auth, RBAC and tenancy (M02), sensor gateway (M03), incident
engine (M04), evidence and bounded SERV reasoning (M05), compatibility and safety policy (M06), provider discovery (M07),
cost-to-recovery planning (M08), the Kite broker and ledger (M09), orders and reconciliation (M10), recovery verification
and CMMS closeout (M11), the operator console (M12), security and observability (M13), deployment definitions, release
gates and claim checks (M14), the real-input journey runners and records (T-058), and this submission's video, drafts
and authorization tooling <!-- C-017 C-018 -->.

## Evidence ladder

| Level | What                                        | Status                                                                                                                       |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1    | Unit and contract tests                     | PASS locally <!-- C-016 -->                                                                                                  |
| E2    | Integrated and browser tests, compose smoke | PASS locally; backup, restore and rollback exercised locally <!-- C-011 C-012 -->                                            |
| E3    | Live sponsor response                       | recorded: one SERV run accepted, reasoning PASS; the full journey is NOT_RUN <!-- C-021 -->                                  |
| E4    | Real bounded payment plus fulfilled action  | recorded once: payment, fulfillment and duplicate PASS after a manual resolution; the full journey is NOT_RUN <!-- C-022 --> |
| E5    | Independent physical recovery evidence      | NOT_RUN <!-- C-023 -->                                                                                                       |

Local suites in `pnpm verify` on this branch: 1,327 unit tests, 626 integration tests and 10
browser tests <!-- C-016 -->.

## Not yet proven (NOT_RUN)

- A real authenticated physical sensor: NOT_RUN <!-- C-020 -->.
- Independent physical recovery evidence: NOT_RUN <!-- C-023 -->.
- The timeout case after a real payment: NOT_RUN (Kite has no lookup by client key) <!-- C-022 -->.
- A hosted deployment: NOT_RUN <!-- C-024 -->.
- One complete real-input journey with every part in a single run (T-058): NOT_RUN <!-- C-021 C-022 -->.
- Release v1.0.0 with the video: done under signed gate records; X post (https://x.com/0xweeky/status/2121434814087938457) and form submission: done by the owner outside the tooling, so their gate records are NOT_RUN <!-- C-025 -->.
- Production load, SLOs, edge/WAF and enforced network policy: NOT_RUN <!-- C-026 -->.

## Demo

The video (`docs/release/video/`, 2 min 56 s) has a SIMULATED console walk-through (SIMULATOR sensors, a recorded-contract
broker, contract-fake reasoning and CMMS, synthetic data) and REAL evidence segments rendered from the committed
journey records <!-- C-017 -->. Code: [github.com/gnanam1990/uptimebuyer](https://github.com/gnanam1990/uptimebuyer).
Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md). Event: [SERV Hackathon](https://www.openserv.ai/hackathon-2).
