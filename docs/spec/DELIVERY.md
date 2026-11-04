# Delivery, Git, and Release Plan

## Delivery principle

Build UptimeBuyer as a sequence of reviewable, reversible modules. A green unit-test suite is necessary but does not prove real sensor ingestion, paid provider fulfillment, refrigeration recovery, deployment readiness, or hackathon submission.

## Repository intake

Before changing code, the coding agent must:

1. Read `START-HERE.md`, `MASTER-PROMPT.md`, `CORE-CONTRACT.md`, `requirements.json`, `TDD.md`, `SECURITY.md`, and the active module prompt.
2. Run read-only inspection: current directory, repository root, remotes, branch, status, recent log, toolchain files, lockfiles, test commands, CI definitions, and secret-bearing file patterns.
3. Record the exact starting commit and working-tree state in `templates/BUILD-STATUS.json` format.
4. Preserve all unrelated user changes. Never discard, reset, stash, rebase, amend, or overwrite them without explicit authorization.
5. If the directory is not a repository, prepare a local repository plan but do not create a GitHub repository or push externally without explicit authorization.

## F0 feasibility gate

After M00 and before the full M01–M14 build, execute `prompts/00a-feasibility-spike.md`. F0 is a bounded evidence exercise, not a canonical module: it owns no FR, NFR, INV, or T identifiers and cannot turn product status from `NOT_RUN` to implemented.

The spike must answer the event-killing questions early: can the selected sensor path produce authenticated normal, fault, and restored-condition observations; can one exact manual/MPN fact be reproduced; can an isolated Kite broker complete and reconcile one low-value paid action; can the general worker be denied broker credentials and paid egress; can provider completion remain separate from restored-condition sensor evidence without claiming the product recovery verifier exists; can a real SERV Reasoning run return a cited proposal without Kite access; and do three relevant operators independently confirm the target pain from concrete recent incidents?

Read-only discovery and local harness work may proceed under the active implementation request. Before a real operator interview/outreach, call, email, payment, purchase, provider mutation, or physical intervention, stop and obtain explicit user authorization for the exact account, person or provider, action, amount/currency where relevant, hard cap, environment, and evidence/privacy handling. Existing user-provided interview records may be evaluated without new outreach. No authorization means the external gate remains `BLOCKED` or `NOT_RUN`; it is not silently replaced by a mock.

Record F0 as `PASS`, `FAIL`, `UNKNOWN`, `UNSUPPORTED`, or `BLOCKED` per sub-gate. Start the full build only after the user decides on an F0 `PROCEED` recommendation or explicitly accepts a `NARROW` claim based on its preserved evidence. A passing spike qualifies only the tested capability and does not substitute for M09, the canonical tests, deployment isolation, or end-to-end product proof.

## Branch and commit discipline

- Default local branch pattern: `feat/mNN-short-scope`, where `NN` matches the module number. The noncanonical gate uses `spike/f0-feasibility`.
- One coherent behavioral change per commit; tests and implementation for the same behavior stay together.
- Suggested commit pattern: `feat(mNN): description`, `test(mNN): description`, `docs(mNN): description`, or `fix(mNN): description` (lowercase module scope, matching `REPOSITORY-PLAN.md`).
- Include stable requirement and test IDs in the commit body where useful.
- Do not rewrite shared history.
- Do not push, create a pull request, enable workflows, publish packages, merge, tag, release, deploy, or change repository visibility without explicit authorization.

## Module lifecycle

After F0 disposition, every canonical module follows the same finite sequence:

1. **Intake:** inspect the current repository and dependency handoffs.
2. **Red evidence:** add or run a test/probe that fails for the missing behavior.
3. **Implementation:** make the smallest complete change that satisfies owned requirements and invariants.
4. **Focused verification:** run the module tests and adversarial cases.
5. **Integrated verification:** run affected upstream/downstream suites and contract checks.
6. **Truth audit:** mark real external evidence `PASS`, `FAIL`, `NOT_RUN`, or `UNKNOWN`.
7. **Handoff:** produce `MODULE-HANDOFF.json`, a concise diff summary, commands, evidence paths, residual risks, and next-module inputs.
8. **Local commit:** commit only files in the reviewed scope when the user has authorized implementation work.

## Pull-request workflow

When the user authorizes a pull request:

1. Re-read the target branch and remote; fetch without mutating local work.
2. Rebase or merge only with explicit approval if shared history would change.
3. Run the required clean-checkout, test, lint, typecheck, build, security, migration, and documentation gates.
4. Fill `templates/PR-BODY.md` with exact IDs, evidence, and limitations.
5. Create the PR; never merge it in the same step unless the user explicitly authorizes merge after reviewing current checks.
6. Before merge, refresh the PR head, required checks, review state, unresolved comments, and merge base.
7. After an authorized merge, verify the resulting commit and deployment separately.

## Release gates

### Gate A — Specification

- Requirements, invariants, modules, and tests remain traceable.
- Core invariant text matches the canonical registry.
- No placeholder markers, broken local links, or invalid JSON.

### Gate B — Software

- Clean install, lint, typecheck, unit/integration tests, migration dry run, and production build pass.
- Retry, timeout, duplicate, concurrency, and restart paths pass.
- Tenant boundaries and credential isolation pass.

### Gate C — External systems

- One authenticated signal path opens the incident, and only the canonical post-intervention recovery evaluation over the full configured fresh stable window plus every required identity/signoff closes it; a single reading cannot close it.
- One real OpenServ run returns provenance-bound output.
- One real Kite paid action completes and reconciles under a bounded session.
- The paid action executes only in the separately deployed broker; negative egress tests prove API, browser, model and general workers cannot reach the paid endpoint or credential.
- Provider result and payment receipt are independently captured.
- A failed/unknown transaction remains unresolved until reconciliation.

F0 evidence may inform this gate but cannot satisfy it by itself; Gate C runs against the implemented, source-SHA-bound product.

### Gate D — Safety

- Ambiguous compatibility fails closed.
- Substitute parts require exact policy evidence or named human approval.
- Provider self-report cannot close an incident or release outcome-dependent payment.
- Raw credentials are inaccessible to the agent, model, browser, and untrusted adapters.

### Gate E — Product and accessibility

- Primary flow works at 320, 375, 768, 1024, and 1440 px widths and at 400% zoom reflow.
- Keyboard, screen-reader labels, focus, contrast, reduced motion, error recovery, and non-color status cues pass.
- Loading, empty, partial, degraded, unknown, and failure states are honest.

### Gate F — Deployment and submission

- Deployment is tested from a clean environment with production-like configuration.
- Backup, restore, rollback, and alerting evidence exists.
- Demo artifact matches the running build.
- Publishing and submission remain explicit user-authorized actions.

## Completion rule

The project is not complete because files were generated or tests were mocked. Completion requires all owned IDs to pass, the mandatory real-evidence gates to be satisfied, residual limitations to be disclosed, and the user to authorize any external publication, deployment, payment, or submission.

