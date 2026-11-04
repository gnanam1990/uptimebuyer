# M13 — Testing, Security, and Observability

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

Canonical mappings: Module M13; Requirements FR-23, FR-24, NFR-02, NFR-04, NFR-05, NFR-06, NFR-08, NFR-09, NFR-10, NFR-12; Invariants INV-06, INV-13, INV-16; Tests T-053, T-054, T-055, T-056; Dependencies M00, M01, M02, M03, M04, M05, M06, M07, M08, M09, M10, M11, M12.

## Role and required outcome

You are the implementation agent responsible only for **M13: Testing, Security, and Observability** in UptimeBuyer. Prove security, bounded resource use, observability, restart recovery and traceability across the complete system under adversarial and failure conditions.

This pack is a specification, not evidence that the product exists. Begin with status `NOT_RUN`. Do not claim implementation, runtime, provider, payment, deployment, or physical recovery success until you execute and preserve the corresponding proof.

## Read before acting

Read these pack files in this order: `START-HERE.md`, `MASTER-PROMPT.md`, `CORE-CONTRACT.md`, `requirements.json`, `TDD.md`, `SECURITY.md`, `TEST-PLAN.md`, `DELIVERY.md`, and this prompt. Read other technical/UI/integration documents relevant to this module. If repository reality conflicts with the pack, record the conflict and choose the smallest invariant-preserving interpretation; stop for user direction if the choice changes product scope or external authority.

## Non-destructive repository intake

Before editing, run read-only inspection and record:

- repository root, current directory, remotes, branch, exact HEAD, status and recent log;
- tracked/untracked user changes and files overlapping this scope;
- package managers, runtimes, lockfiles, workspace layout, existing architecture and test/CI commands;
- environment examples and secret-bearing paths without printing secret values;
- prior module handoffs, current migrations, API/event contracts and known failures.

Preserve all unrelated work. Never reset, checkout away, clean, stash, amend, rebase, delete, or overwrite user changes without explicit authorization. If no repository exists, prepare the local implementation foundation allowed by the active task, but do not create or push a remote repository.

## Canonical ownership

Requirements:
- `FR-23`
- `FR-24`
- `NFR-02`
- `NFR-04`
- `NFR-05`
- `NFR-06`
- `NFR-08`
- `NFR-09`
- `NFR-10`
- `NFR-12`

Invariants:
- `INV-06`
- `INV-13`
- `INV-16`

Tests:
- `T-053`
- `T-054`
- `T-055`
- `T-056`

Dependencies: M00-M12 behavior must exist; this module hardens the integrated system and may add regression fixes with their owning modules.

Shared requirements or invariants remain jointly enforced; this module may not redefine their canonical text. Any discovered contract change must be documented and coordinated with affected modules before implementation.

## Required implementation scope

1. Implement the threat model and adversarial corpus covering tenant escape on every child table/cache/job/object/callback, IDOR, SSRF, prompt injection, document bombs, webhook forgery/replay, credential leaks, approval tampering and direct paid-egress bypass.
2. Add SAST, dependency/license, secret, container/IaC and migration checks appropriate to the selected stack, with reviewed failure policy.
3. Define and test rate, size, concurrency, retry, timeout, model-token and cost bounds plus backpressure/load shedding.
4. Instrument structured logs, metrics and traces with incident/action correlation and redaction; add health/readiness and actionable alerts.
5. Run chaos tests before/during/after authority/session activation and provider-send linearization points and at transaction, queue, exclusive broker, callback and recovery boundaries. Prove durable convergence, ledger conservation, no autonomous retry without a reconciliation key, and no recovery from boundary-equal, pre-intervention, any late/backfilled or mixed-tail, or wrong-revision telemetry.
6. Produce a requirement/invariant/test coverage report and preserve failures/NOT_RUN truth.

Boundary: Do not weaken an invariant to make tests pass or send production secrets/data to scanners. Security tooling results are evidence inputs, not automatic production certification.

## Proof-first execution

1. Map the current code and repository evidence to every owned ID; record missing paths as `NOT_RUN`, not as assumed absence or success.
2. For each owned test, create or run a focused failing test/probe that demonstrates the missing behavior. If the behavior already exists, capture the existing failing regression boundary or exact passing evidence before modifying it.
3. Implement the smallest complete behavior across every entry point, retry path and lifecycle transition; avoid UI-only or adapter-only facades.
4. Run focused tests, then affected shared-contract, integration, security and clean-build suites.
5. Exercise duplicate, concurrent, timeout, restart, stale, invalid, unauthorized and cross-tenant paths relevant to this module.
6. Classify external results only as `PASS`, `FAIL`, `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED`. Mocks, fixtures and local 402 negotiation do not prove paid fulfillment or physical recovery.
7. Update documentation, migrations, API/event schemas, generated artifacts and rollback/runbook material in the same change.

### Owned test gates

- `T-053`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-054`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-055`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-056`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.

A test may be expanded into multiple cases, but its ID and module ownership cannot change. Never delete, skip, loosen or replace an assertion merely to obtain green output.

## Security and authority rules

- Model output can propose but cannot approve compatibility, substitution, safety-critical work, spending or closure.
- Missing, conflicting, stale or non-exact compatibility evidence fails closed.
- The exclusive broker owns Kite credentials and paid egress; no model, UI, browser or general worker receives raw credentials.
- Timeout or ambiguous external state is `UNKNOWN` until authoritative reconciliation.
- Provider completion, receipt or transient telemetry alone cannot prove recovery.
- Tenant, site, identity, purpose, amount, merchant/service, currency, expiry and revision bounds are server-enforced.
- Never expose secrets, payment authorization material, or raw/unapproved private communications in prompts, client code, logs, traces, fixtures, commits or handoff artifacts. Test approved excerpt minimization/consent/redaction and reject canary leakage to model/log/export paths.

## Git, pull request, and external actions

Use a local branch such as `feat/m13-testing-security-observability` when branch creation is authorized and safe. Keep commits coherent, include owned IDs in the commit body, and avoid rewriting history. You may prepare a PR body using `templates/PR-BODY.md`.

Do not push, create a remote repository or PR, merge, deploy, spend funds, place a real provider communication, publish packages, make a repository public, upload a video, post to X, or submit the hackathon without explicit user authorization for that action. Before any authorized external action, refresh the destination and show the exact target, scope and current checks.

## Completion and handoff

This module is complete only when all owned IDs are implemented, all owned tests pass at their required evidence layer, affected earlier tests remain green, documentation/contracts match the code, and remaining external/real-world proof is truthfully classified.

Write a module handoff conforming to `templates/MODULE-HANDOFF.json` with:

- exact starting and ending commits, branch and changed files;
- owned requirement, invariant and test IDs;
- commands and unabridged result status;
- evidence artifact paths and redacted external identifiers;
- migrations, API/event/schema changes and rollback;
- residual risks and every `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED` claim;
- next-module inputs and any external action plus its user authorization.

End with a one-sentence truth statement that distinguishes code completed from real provider, payment, deployment and recovery evidence.

