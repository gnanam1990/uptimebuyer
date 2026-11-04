# M07 — Provider Discovery and Communications

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

Canonical mappings: Module M07; Requirements FR-07, FR-08, FR-20, NFR-03, NFR-04, NFR-06, NFR-11; Invariants INV-08, INV-12; Tests T-029, T-030, T-031, T-032; Dependencies M01, M02, M04, M06.

## Role and required outcome

You are the implementation agent responsible only for **M07: Provider Discovery and Communications** in UptimeBuyer. Discover and contact eligible technicians, suppliers and services through bounded auditable adapters without confusing search/contact with fulfillment.

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
- `FR-07`
- `FR-08`
- `FR-20`
- `NFR-03`
- `NFR-04`
- `NFR-06`
- `NFR-11`

Invariants:
- `INV-08`
- `INV-12`

Tests:
- `T-029`
- `T-030`
- `T-031`
- `T-032`

Dependencies: M01 contracts, M02 tenancy/privacy, M04 incident and M06 eligibility decisions are required.

Shared requirements or invariants remain jointly enforced; this module may not redefine their canonical text. Any discovered contract change must be documented and coordinated with affected modules before implementation.

## Required implementation scope

1. Using the M02-owned provider-account tables and migrations, implement provider-account behavior (stable tenant-bound accounts, immutable capability/owner/credential/verifier revisions) and durable provider searches, service-provider candidates, contact requests/attempts, communications and quote records. Pin the exact account revision on every request/attempt; supersession invalidates unexecuted work without rewriting in-flight history. Discovery source and approved-vendor status remain separate.
2. Normalize provider identity, service area, availability, price, ETA, consent, recording disclosure, transcript provenance and raw response references.
3. Split execution by provider-account owner: M07 may execute only explicitly unpaid accounts; a StablePhone-, StableEmail-, or other paid contact is prepared as an immutable contact request and submitted through the M01 commercial-intent broker port. M09 is built later, so M07 tests this handoff against a contract fake; the real-broker path is qualified by T-039/T-040/T-042. M07 never resolves the paid credential or calls paid egress.
4. Use canonical contact/action digests, immutable execution-authority identity, client operation/idempotency keys and explicit timeout/rate/cost bounds. Duplicate paid contacts under the same authority submit one idempotent broker-port request; a successor is permitted only under INV-07's definite-no-effect rule.
5. Persist transport, normalized external outcome, adapter capability and raw provider status separately. M07 consumes `commercial_intent.state_changed.v1` broker result events (contract-faked until M09 lands) and never retries a paid `UNKNOWN`. Pre-egress unsupported capability blocks send; if absent reconciliation is discovered only after possible egress, capability becomes `UNSUPPORTED` while the effect remains `UNKNOWN` and manual rather than being relabelled unsupported or failed.
6. Redact/minimize communication data. Deliver the notification channel, role routing and deduplication; each emitting module (M09 spend exceptions, M11 recovery/reopen) owns its trigger, and M12's T-051 owns the end-to-end check.
7. Run sandbox/recorded contract tests and one separately labelled real connectivity probe only when authorized; a paid probe routes through M09 and the broker.

Boundary: Search rank and provider claims do not approve compatibility or close an incident. M07 cannot hold a paid credential or reach a paid endpoint. Do not spend funds or place real calls/emails without the required user/incident authorization.

## Proof-first execution

1. Map the current code and repository evidence to every owned ID; record missing paths as `NOT_RUN`, not as assumed absence or success.
2. For each owned test, create or run a focused failing test/probe that demonstrates the missing behavior. If the behavior already exists, capture the existing failing regression boundary or exact passing evidence before modifying it.
3. Implement the smallest complete behavior across every entry point, retry path and lifecycle transition; avoid UI-only or adapter-only facades.
4. Run focused tests, then affected shared-contract, integration, security and clean-build suites.
5. Exercise duplicate, concurrent, timeout, restart, stale, invalid, unauthorized and cross-tenant paths relevant to this module.
6. Classify external results only as `PASS`, `FAIL`, `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED`. Mocks, fixtures and local 402 negotiation do not prove paid fulfillment or physical recovery.
7. Update documentation, migrations, API/event schemas, generated artifacts and rollback/runbook material in the same change.

### Owned test gates

- `T-029`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-030`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-031`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-032`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.

A test may be expanded into multiple cases, but its ID and module ownership cannot change. Never delete, skip, loosen or replace an assertion merely to obtain green output.

## Security and authority rules

- Model output can propose but cannot approve compatibility, substitution, safety-critical work, spending or closure.
- Missing, conflicting, stale or non-exact compatibility evidence fails closed.
- The exclusive broker owns Kite credentials and paid egress; no model, UI, browser or general worker receives raw credentials.
- Timeout or ambiguous external state is `UNKNOWN` until authoritative reconciliation.
- Provider completion, receipt or transient telemetry alone cannot prove recovery.
- Tenant, site, identity, purpose, amount, merchant/service, currency, expiry and revision bounds are server-enforced.
- Never expose secrets, payment authorization material, or raw/unapproved private communications in prompts, client code, logs, traces, fixtures, commits or handoff artifacts. Communication excerpts require tenant policy, purpose, role, consent where required, minimization and redaction before an approved model run.

## Git, pull request, and external actions

Use a local branch such as `feat/m07-provider-discovery-comms` when branch creation is authorized and safe. Keep commits coherent, include owned IDs in the commit body, and avoid rewriting history. You may prepare a PR body using `templates/PR-BODY.md`.

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

