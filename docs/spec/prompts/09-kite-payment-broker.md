# M09 — Kite Payment Broker

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

Canonical mappings: Module M09; Requirements FR-10, FR-11, FR-12, FR-21, NFR-02, NFR-03, NFR-04, NFR-05, NFR-06, NFR-11; Invariants INV-02, INV-03, INV-05, INV-06, INV-07, INV-08, INV-12, INV-13, INV-15; Tests T-037, T-038, T-039, T-040; Dependencies M01, M02, M06, M08.

## Role and required outcome

You are the implementation agent responsible only for **M09: Kite Payment Broker** in UptimeBuyer. Create the exclusive credential and paid-egress broker for bounded Kite Passport sessions, economic intents, execution and authoritative reconciliation.

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
- `FR-10`
- `FR-11`
- `FR-12`
- `FR-21`
- `NFR-02`
- `NFR-03`
- `NFR-04`
- `NFR-05`
- `NFR-06`
- `NFR-11`

Invariants:
- `INV-02`
- `INV-03`
- `INV-05`
- `INV-06`
- `INV-07`
- `INV-08`
- `INV-12`
- `INV-13`
- `INV-15`

Tests:
- `T-037`
- `T-038`
- `T-039`
- `T-040`

Dependencies: M01 contracts/digests, M02 identities/policies, M06 authorization and M08 selected eligible plan are required, plus a recorded F0 disposition and user decision (`spikes/f0/F0-REPORT.md`, `BUILD-STATUS.json` `feasibility`).

Shared requirements or invariants remain jointly enforced; this module may not redefine their canonical text. Any discovered contract change must be documented and coordinated with affected modules before implementation.

## Required implementation scope

1. Design operator approval showing exact incident, action digest, subject (`PLAN_ACTION` or paid `PROVIDER_CONTACT_REQUEST`), immutable provider-account/capability revision, merchant/service, purpose, allowed actions, per-action/aggregate amount, currency and expiry. Implement idempotent execution-authority create/read/revoke APIs and events: one immutable signed authority per approval, append-only local lifecycle, separately persisted Kite-session operation/outcome and optional provider reference, restart recovery, and expiry/revocation serialization with new reserves.
2. Persist immutable session and economic-intent records before egress; one stable action digest plus one execution-authority ID maps to at most one intent. A successor authority may create a new intent for that same action digest only after every prior intent is terminal and proven to have had no external economic effect. Generate the client operation/idempotency key before egress and record a durable attempt transport marker `SEND_STARTED` while the intent remains `RESERVED`; do not label the economic intent `SUBMITTED` until provider acceptance is observed.
3. Enforce all effective bounds server-side and deny suspended/revoked/expired authority, unconfirmed/unknown Kite session, or stale evidence, policy, provider-account revision, approval or action digest.
   A `CREATED` intent that fails broker revalidation becomes immutable definite-no-effect `FAILED`; it cannot be rebound to a new approval. The semantic action digest remains stable. Fresh authority may create one successor intent with a new execution-authority/operation identity and supersession link only after every prior intent for that action is terminal definite-no-effect; any possibly effective predecessor blocks it.
4. Keep Kite credentials and paid endpoint network access inside the separately deployable broker identity; prove general workers, API, agent, browser and client cannot read the secret or bypass its egress allowlist. Broker ingress accepts only a signed opaque reference typed as `EXECUTION_AUTHORITY` for session activation/reconciliation or `COMMERCIAL_INTENT` for paid execution/reconciliation, rejects embedded authority fields, and reloads every bound fact from PostgreSQL.
5. Implement broker-owned paid provider-account-revision adapters, including paid phone/email/contact subjects, payment negotiation/execution, receipts and reconciliation by the pre-generated client operation key. Keep transport, normalized external outcome, adapter capability and economic-intent state as separate axes; `ACCEPTED` permits `SUBMITTED`, provider references are optional, and post-egress lack of reconciliation capability leaves the effect `UNKNOWN` while capability is `UNSUPPORTED`. Pin the exact revision through approval, authority/session, intent, attempt, ledger and callback; a superseded revision may reconcile only its historical in-flight work during an explicit retained-verifier window. Emit normalized result events for M07 without exposing credentials.
6. Apply bounded retries, circuit breakers, rate/cost limits, redacted observability and operator-visible states.
7. Record every reserve, capture, release, refund, reversal and signed authority adjustment in an append-only ledger. Enforce account-, intent-, and capture-level gross-cap/net-settlement equations under duplicate and concurrent events; every return references a same-intent capture, cross-intent headroom cannot mask an over-return, and refunds never silently recreate spend authority.
8. Perform real payment only with explicit user authorization and record E4 fulfillment evidence separately from 402 negotiation.

Boundary: No reasoning/model process may possess credentials or authorize payment. Do not treat HTTP 402, a receipt, local success or payment settlement as proof the purchased service or repair was delivered.

## Proof-first execution

1. Map the current code and repository evidence to every owned ID; record missing paths as `NOT_RUN`, not as assumed absence or success.
2. For each owned test, create or run a focused failing test/probe that demonstrates the missing behavior. If the behavior already exists, capture the existing failing regression boundary or exact passing evidence before modifying it.
3. Implement the smallest complete behavior across every entry point, retry path and lifecycle transition; avoid UI-only or adapter-only facades.
4. Run focused tests, then affected shared-contract, integration, security and clean-build suites.
5. Exercise duplicate, concurrent, timeout, restart, stale, invalid, unauthorized and cross-tenant paths relevant to this module.
6. Classify external results only as `PASS`, `FAIL`, `NOT_RUN`, `UNKNOWN`, or `UNSUPPORTED`. Mocks, fixtures and local 402 negotiation do not prove paid fulfillment or physical recovery.
7. Update documentation, migrations, API/event schemas, generated artifacts and rollback/runbook material in the same change.

### Owned test gates

- `T-037`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-038`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-039`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.
- `T-040`: implement the registry-named test in `TEST-PLAN.md`; first capture a failing or missing-behavior result, then make it pass without weakening the assertion.

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

Use a local branch such as `feat/m09-kite-payment-broker` when branch creation is authorized and safe. Keep commits coherent, include owned IDs in the commit body, and avoid rewriting history. You may prepare a PR body using `templates/PR-BODY.md`.

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

