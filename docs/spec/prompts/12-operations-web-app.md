# M12 — Operations Web Application

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

Canonical mappings: Module M12; Requirements FR-01, FR-18, FR-19, FR-20, FR-21, NFR-07, NFR-08; Invariants INV-11, INV-12; Tests T-049, T-050, T-051, T-052; Dependencies M01, M02, M03, M04, M05, M06, M07, M08, M09, M10, M11.

## Role and required outcome

You are the implementation agent responsible only for **M12: Operations Web Application** in UptimeBuyer. Build an accessible, modern operations console that exposes incidents, evidence, deterministic decisions, spend bounds, external truth and recovery proof without visual deception.

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
- `FR-01`
- `FR-18`
- `FR-19`
- `FR-20`
- `FR-21`
- `NFR-07`
- `NFR-08`

Invariants:
- `INV-11`
- `INV-12`

Tests:
- `T-049`
- `T-050`
- `T-051`
- `T-052`

Dependencies: M01 public contracts and completed backend APIs for the displayed flows are required; read UI-SPEC.md before implementation.

Shared requirements or invariants remain jointly enforced; this module may not redefine their canonical text. Any discovered contract change must be documented and coordinated with affected modules before implementation.

## Required implementation scope

1. Implement fleet health, incident command view, evidence/citations, compatibility result, plan comparison, approvals, execution-authority/Kite-session status, payment, distinct purchase/service fulfillment, recovery proof, ledger and policy administration. Incident command includes RBAC-controlled assign, accept, reassign and handoff controls/history with reason, next-action deadline and version-conflict recovery, plus pinned SOP procedure/original/current deadline and authorized deadline-event history.
2. Use the UI design tokens and responsive layouts in UI-SPEC.md; target 320, 375, 768, 1024 and 1440 px plus 200% zoom and 400% zoom reflow at 320 CSS px.
3. Render fresh/stale/offline/invalid plus local authority, Kite-session, transport, external-outcome, adapter-capability and economic-intent axes separately with text, icon/shape and accessible announcement, never color alone. A post-egress `UNKNOWN` remains unknown even when adapter capability is `UNSUPPORTED`; purchase and service states use distinct labels.
4. Add telemetry charts with accessible table/current-value fallback, pause/resume and reduced motion.
5. Implement keyboard operation, visible focus, semantic labels, error summary, recovery actions and safe confirmation for bounded approval/authority issuance/revocation; `202` or provider-session reference never renders as session confirmation.
6. Use typed API clients; keep secrets and raw authorization material out of bundles, browser storage, analytics and error reports.

Boundary: Do not fabricate live data, external success, paid fulfillment or recovery. Every simulator/replay is persistently labeled and every disabled action explains the blocking evidence.

## Proof-first execution

1. Map the current code and repository evidence to every owned ID; record missing paths as `NOT_RUN`, not as assumed absence or success.
2. For each owned test, create or run a focused failing test/probe that demonstrates the missing behavior. If the behavior already exists, capture the existing failing regression boundary or exact passing evidence before modifying it.
3. Implement the smallest complete behavior across every entry point, retry path and lifecycle transition; avoid UI-only or adapter-only facades.
4. Run focused tests, then affected shared-contract, integration, security and clean-build suites.
5. Exercise duplicate, concurrent, timeout, restart, stale, invalid, unauthorized and cross-tenant paths relevant to this module.
6. Classify external results only as `PASS`, `FAIL`, `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED`. Mocks, fixtures and local 402 negotiation do not prove paid fulfillment or physical recovery.
7. Update documentation, migrations, API/event schemas, generated artifacts and rollback/runbook material in the same change.

### Owned test gates

- `T-049`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-050`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-051`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-052`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.

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

Use a local branch such as `feat/m12-operations-web-app` when branch creation is authorized and safe. Keep commits coherent, include owned IDs in the commit body, and avoid rewriting history. You may prepare a PR body using `templates/PR-BODY.md`.

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

