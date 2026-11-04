# M06 — Compatibility and Safety Policy

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

Canonical mappings: Module M06; Requirements FR-06, FR-10, FR-21, NFR-05, NFR-10; Invariants INV-02, INV-03, INV-04, INV-15; Tests T-025, T-026, T-027, T-028; Dependencies M01, M02, M05.

## Role and required outcome

You are the implementation agent responsible only for **M06: Compatibility and Safety Policy** in UptimeBuyer. Implement a deterministic fail-closed engine that returns ALLOW, HOLD or REJECT for exact parts and recovery actions.

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
- `FR-06`
- `FR-10`
- `FR-21`
- `NFR-05`
- `NFR-10`

Invariants:
- `INV-02`
- `INV-03`
- `INV-04`
- `INV-15`

Tests:
- `T-025`
- `T-026`
- `T-027`
- `T-028`

Dependencies: M01 contracts, M02 policy/RBAC and M05 revision-bound evidence proposals are required.

Shared requirements or invariants remain jointly enforced; this module may not redefine their canonical text. Any discovered contract change must be documented and coordinated with affected modules before implementation.

## Required implementation scope

1. Model exact OEM/manufacturer part number, asset revision, electrical, mechanical, certification, warranty, approved-vendor and action-safety constraints.
2. Evaluate only structured cited evidence under an immutable policy revision and emit machine-readable reasons and missing/conflicting fields.
3. Make semantic similarity, marketplace copy, search rank and model confidence insufficient for ALLOW.
4. Implement named engineer approval for substitutes, non-exact matches and safety-critical action, and policy-role approval (the approver role named by the active policy revision) for policy overrides and out-of-bounds approvals, each with scope, expiry, signature and action digest (INV-15).
5. Invalidate unexecuted decisions when governing evidence/policy/action changes while preserving historical reproducibility.
6. Expose deterministic decision fixtures and a policy-authoring validation path.

Boundary: Do not contact providers or execute payment. No default or catch-all rule may convert unknown evidence into ALLOW.

## Proof-first execution

1. Map the current code and repository evidence to every owned ID; record missing paths as `NOT_RUN`, not as assumed absence or success.
2. For each owned test, create or run a focused failing test/probe that demonstrates the missing behavior. If the behavior already exists, capture the existing failing regression boundary or exact passing evidence before modifying it.
3. Implement the smallest complete behavior across every entry point, retry path and lifecycle transition; avoid UI-only or adapter-only facades.
4. Run focused tests, then affected shared-contract, integration, security and clean-build suites.
5. Exercise duplicate, concurrent, timeout, restart, stale, invalid, unauthorized and cross-tenant paths relevant to this module.
6. Classify external results only as `PASS`, `FAIL`, `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED`. Mocks, fixtures and local 402 negotiation do not prove paid fulfillment or physical recovery.
7. Update documentation, migrations, API/event schemas, generated artifacts and rollback/runbook material in the same change.

### Owned test gates

- `T-025`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-026`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-027`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-028`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.

A test may be expanded into multiple cases, but its ID and module ownership cannot change. Never delete, skip, loosen or replace an assertion merely to obtain green output.

## Security and authority rules

- Model output can propose but cannot approve compatibility, substitution, safety-critical work, spending or closure.
- Missing, conflicting, stale or non-exact compatibility evidence fails closed.
- The exclusive broker owns Kite credentials and paid egress; no model, UI, browser or general worker receives raw credentials.
- Timeout or ambiguous external state is `UNKNOWN` until authoritative reconciliation.
- Provider completion, receipt or transient telemetry alone cannot prove recovery.
- Tenant, site, identity, purpose, amount, merchant/service, currency, expiry and revision bounds are server-enforced.
- Never expose secrets, private communications or payment authorization material in prompts, client code, logs, traces, fixtures, commits or handoff artifacts.

## Git, pull request, and external actions

Use a local branch such as `feat/m06-compatibility-safety-policy` when branch creation is authorized and safe. Keep commits coherent, include owned IDs in the commit body, and avoid rewriting history. You may prepare a PR body using `templates/PR-BODY.md`.

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

