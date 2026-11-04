# Module Prompt Index

## How to use these prompts

Give the coding agent the entire extracted pack, not an isolated prompt. Start with `00-intake-foundation.md`. Then run `00a-feasibility-spike.md` before the full build; its local harness work runs under the active implementation request, and each external sub-gate waits for explicit user authorization. F0 is an evidence gate, not a canonical module and not product implementation. After each canonical module, inspect its diff, tests, and `MODULE-HANDOFF.json` before starting a dependent module. The prompts do not authorize remote repository creation, push, pull request, merge, deployment, provider contact, spending, publishing, or submission.

The safe default sequence is:

| Order | Module | Prompt | Primary output |
|---:|---|---|---|
| 1 | M00 | `prompts/00-intake-foundation.md` | Reproducible repository and quality gates |
| 2 | F0 gate | `prompts/00a-feasibility-spike.md` | Honest low-value feasibility evidence; no canonical ID coverage |
| 3 | M01 | `prompts/01-shared-contracts-domain.md` | Typed domain and lifecycle contracts |
| 4 | M02 | `prompts/02-storage-auth-rbac-tenancy.md` | Durable tenant/auth/policy/evidence base |
| 5 | M03 | `prompts/03-sensor-edge-gateway.md` | Authenticated telemetry and freshness |
| 6 | M04 | `prompts/04-incident-engine.md` | Durable incident authority |
| 7 | M05 | `prompts/05-evidence-manual-reasoning.md` | Cited bounded evidence proposals |
| 8 | M06 | `prompts/06-compatibility-safety-policy.md` | Fail-closed deterministic decision |
| 9 | M07 | `prompts/07-provider-discovery-comms.md` | Auditable provider discovery/contact |
| 10 | M08 | `prompts/08-cost-to-recovery-planning.md` | Explainable plan ranking |
| 11 | M09 | `prompts/09-kite-payment-broker.md` | Exclusive separately deployed paid-action broker |
| 12 | M10 | `prompts/10-order-job-reconciliation.md` | Restart-safe fulfillment state |
| 13 | M11 | `prompts/11-recovery-verification-cmms.md` | Authoritative closeout/reopen loop |
| 14 | M12 | `prompts/12-operations-web-app.md` | Accessible operations console |
| 15 | M13 | `prompts/13-testing-security-observability.md` | Integrated hardening and evidence |
| 16 | M14 | `prompts/14-deployment-demo-release.md` | Deployable release and truthful artifacts |

## Controlled parallel work

After M00–M02 are stable and the F0 disposition permits the full build, some work can run in separate worktrees when each agent has a disjoint file ownership plan:

- M03 sensor adapter and the storage/parser substrate of M05 can begin from frozen M01/M02 contracts; incident-bound M05 reasoning still waits for M04.
- M07 provider adapters and M08 pure cost model can proceed after their input contracts are frozen.
- M12 UI can start against validated generated contracts and state fixtures, but integration completion waits for M03-M11.
- M13 test/security infrastructure can grow throughout the build, while final chaos and trace proof waits for the integrated system.

Do not parallelize migrations, shared schemas, state-machine definitions, public events, or the exclusive payment boundary without one coordinating owner. The credential-bearing Kite adapter exists only inside `apps/kite-broker`; general services share credential-free intent/result contracts, not paid execution code. Every parallel branch revalidates its merge base and all affected tests before integration.

## Required handoff between prompts

Each module passes:

- an exact starting/ending commit and working-tree statement;
- changed files and public contract changes;
- owned ID results and commands;
- migration, rollback, secret/configuration and operational notes;
- real evidence separately from fixtures/mocks;
- unresolved failures, unknown outcomes and unsupported capabilities;
- next-module inputs in `templates/MODULE-HANDOFF.json` format.

F0 instead produces a redacted feasibility record containing the exact tested surface, authorization reference, external identifiers, amount/currency when applicable, commands, outcomes, residual uncertainty, and explicit statement that no canonical module or product claim was completed.

If a dependency handoff is missing or contradicts `requirements.json` or `CORE-CONTRACT.md`, stop the dependent implementation and reconcile the contract first.

## Completion meaning

Running every prompt does not itself prove completion. The final outcome requires passing release gates in `DELIVERY.md`, the real-evidence ladder in `DEMO-VALIDATION.md`, current official event revalidation, and explicit user authorization for every external publication or transaction.

