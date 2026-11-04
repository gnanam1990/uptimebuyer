# UptimeBuyer Pack QA

## Scope

This file records quality checks for the specification archive. It does not record product implementation, product tests, real provider fulfillment, payment, physical recovery, deployment, security approval, legal approval, publication or event submission.

## Truth boundary

- Pack artifact: `SPECIFICATION_ONLY`
- Product implementation: `NOT_RUN`
- Product tests: `NOT_RUN`
- Runtime and provider integration tests: `NOT_RUN`
- Real Kite payment and provider fulfillment: `NOT_RUN`
- Physical sensor recovery: `NOT_RUN`
- Deployment, publication and event submission: `NOT_RUN`
- Market validation: `UNPROVEN`

## Quality procedure

The frozen pack must satisfy all of these document/archive checks:

1. parse every JSON document and reject duplicate object keys;
2. validate required files and minimum content sizes;
3. validate portable paths, UTF-8 text and supported extensions;
4. reject symlinks, special files, author-machine paths and unresolved placeholder markers;
5. validate balanced Markdown fences and local links;
6. compare every FR/NFR/INV definition with its canonical core-contract paragraph;
7. require every definition to be owned by at least one module;
8. require every canonical test to be owned by exactly one module;
9. require prompt files to contain their mapped IDs, dependency IDs, `SPECIFICATION_ONLY` and `NOT_RUN`;
10. reject dangling/unknown IDs and cyclic module dependencies;
11. verify metadata counts and non-execution statuses;
12. verify every non-inventory file byte count and SHA-256 digest;
13. run two independent semantic reviews and resolve all high-confidence contradictions;
14. create the ZIP, inspect its listing, extract it into a fresh temporary directory, rerun the trusted checker there, and compare extracted bytes with the source folder.

## Canonical counts

| Registry area | Expected count |
|---|---:|
| Functional requirements | 24 |
| Non-functional requirements | 12 |
| Invariants | 16 |
| Modules | 15 |
| Tests | 60 |
| Tests per module | 4 |

## Structural checker

The pack uses the reusable read-only checker at `scripts/check-build-pack.mjs`, copied byte-for-byte from the `hackathon-idea-researcher` skill during pack creation. The command is:

```bash
node scripts/check-build-pack.mjs --root . --config config/pack-check.json
```

The final result, counts, assertion count, local-link count and errors belong in the frozen validation record below. The checker reports `scope: DOCUMENT_ONLY`, `productTests: NOT_RUN`, and `semanticReview: NOT_PERFORMED` by design; semantic review is recorded separately in this file.

## Semantic review protocol

Two independent reviewers inspect the same frozen candidate without sharing conclusions first. Each reviewer checks:

- whether the PRD, core contract, architecture, state machines, APIs, tests and prompts describe the same product;
- whether a model or UI can bypass compatibility, spending or recovery authority;
- whether unknown external outcomes are safe across retries and restarts;
- whether evidence and approvals are revision-bound;
- whether sensor/provider/CMMS claims distinguish real proof from mocks;
- whether module dependencies are executable and prompts own complete work;
- whether UI and operations expose failure/unknown states;
- whether event, market, competition and provider statements are properly qualified.

The final archive may be labelled `SEMANTIC_CLEAN` only after every accepted finding is repaired and each reviewer performs a convergence check.

## Repair record — 2026-11-04 revision

The first frozen candidate was recorded `SEMANTIC_CLEAN`, but a later five-reviewer semantic audit plus a live re-check of the official event page found defects that contradicted that label. They were repaired in this revision; the earlier label is withdrawn.

Repaired defect classes:

- **Event fit:** SERV Reasoning is mandatory on the official page but had no feasibility gate; added F0-G across START-HERE, PROJECT-BRIEF, PRD, DELIVERY, MASTER-PROMPT and `prompts/00a`. Corrected organizer (OpenServ; Kite is a track partner), write-up contents, track selection and X-post-link requirements in EVENT-NOTES and metadata.
- **Payment integrity:** INV-07 uniqueness could not stop two live intents for one action under two approvals; added a partial unique index on `(tenant_id, action_digest)` excluding `FAILED`. Economic vocabulary now includes `UNKNOWN` and authoritative `SUBMITTED/UNKNOWN → FAILED` with release; `UNKNOWN → REFUNDED/REVERSED` must append the capture first; refunded/reversed amounts and per-intent/per-capture projections split so both conservation equations are checkable; signed budget adjustments got an approval kind and endpoint.
- **State machines:** external action gained `AUTHORIZED → UNKNOWN` (marker crash), `ACCEPTED → UNKNOWN` and synchronous-decline edges; KITE no longer sets `REQUESTED` at `SEND_STARTED`; ARCHITECTURE no longer allows retry after the marker; "legal replanning" defined (`AWAITING_APPROVAL → PLANNING` before egress, otherwise `ESCALATED`); compatibility HOLD resolves by a new immutable decision row; incident dedupe key matches INV-09.
- **Recovery authority:** removed manual closure, human alternate measurements and alternate-evidence paths that could satisfy the stable window; a stable-window regression resets evaluation instead of reopening.
- **Module executability:** M07 tests no longer need the later M09 broker (M01 broker-port contract fake); the policy-revision linearization race moved to M09; single owners named for state tables, migrations, provider accounts and the CMMS adapter; one repository layout, branch set and commit-scope case; F0 exit rule unified.
- **Coverage:** tests now exercise FR-01 provenance, FR-17 CMMS writes, FR-18 export, FR-20 notifications, FR-23 retention/legal hold/erasure, NFR-06 encryption, NFR-08 SLOs, FR-11 bounds display and WCAG 2.2 reflow; M08 maps INV-03/INV-04.
- **Honesty and safety wording:** Kite and StablePhone/StableEmail capabilities qualified as `NOT_RUN` candidates; logs carry no communication content; unknown-outcome reservations cannot be released by policy; demo, GTM outreach and recordings require explicit per-step authorization; replayed faults cannot satisfy the central claim.
- **Checker:** `scripts/check-build-pack.mjs` exited 0 with no output when invoked through a symlinked path (for example macOS `/tmp` or a symlinked skill directory), a silent false pass. The main guard now compares real paths. The patched copy passes the skill's 62-case regression suite.

## Final validation record

Recorded on 2026-11-04 for this repaired revision.

- Structural checker on source folder and on the extracted archive: see the archive verification below; result must be `PASS` with zero errors.
- Canonical registry: 24 FR, 12 NFR, 16 invariants, 15 modules, 60 uniquely owned tests, four tests per module.
- Trusted checker identity: `PASS` — embedded and `hackathon-idea-researcher` skill copies are both the patched checker, SHA-256 `befab469d23feaf4b77abb8554dbecd94a2095ef6470c1d6dc70d4c042caa9dc` (previously `ca5f6934d965e9d9de4e31ee8e90d06093178a92c3db0a0c6ec23393c70cdede`).
- Trusted checker regression suite: `PASS` — 62 behavioral cases on the patched skill copy; invocation through a symlinked skill directory now emits the report instead of exiting silently.
- Semantic review: five independent cluster reviews, all accepted findings repaired, followed by one convergence review of the repair diff whose findings were also repaired. A second convergence pass on the final bytes has not been run, so the disposition is `REPAIRED_PENDING_RECONVERGENCE`, not `SEMANTIC_CLEAN`.

No entry in this record can be interpreted as a product, provider, payment, deployment, safety, legal or market-validation result.
