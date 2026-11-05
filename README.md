# UptimeBuyer

From refrigeration failure to verified recovery, with bounded spending.

UptimeBuyer turns a commercial-refrigeration fault into an evidence-bound recovery plan, lets deterministic policy (not
a model) decide what is compatible and safe, spends only inside an explicitly approved, bounded authority through an
exclusive payment broker, and closes the incident only after independent telemetry plus CMMS or authorized-operator
evidence shows recovery.

## What is and is not proven

All evidence in this repository is local: unit and integration tests against a throwaway PostgreSQL database, browser
tests, and a production-like compose bring-up on one machine. Every local run uses SIMULATOR sensors (SIMULATED_INPUT),
a recorded-contract broker, contract-fake reasoning and CMMS, synthetic data and a local test identity provider.

| Claim                                                                                                                | Status                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Incident engine, evidence, compatibility, planning, bounded spending, reconciliation, recovery verification, console | local tests PASS <!-- C-001 C-004 C-005 C-007 C-008 C-009 -->  |
| Worker schedules every runner; clean clone builds, migrates, starts and passes smoke checks in local compose         | local layer PASS <!-- C-010 C-011 -->                          |
| Backup, restore and image rollback exercised locally                                                                 | local layer PASS <!-- C-012 -->                                |
| Real authenticated physical sensor                                                                                   | **NOT_RUN** <!-- C-020 -->                                     |
| Real SERV Reasoning (OpenServ) run on a real document                                                                | **NOT_RUN** <!-- C-021 -->                                     |
| Real bounded Kite-paid action with downstream fulfillment                                                            | **NOT_RUN** <!-- C-022 -->                                     |
| Independent physical recovery evidence                                                                               | **NOT_RUN** <!-- C-023 -->                                     |
| Hosted deployment                                                                                                    | **NOT_RUN** <!-- C-024 -->                                     |
| Public repository, video, X post, hackathon submission                                                               | **NOT_RUN** (each needs explicit authorization) <!-- C-025 --> |
| Production load, SLOs, edge/WAF, enforced network policy, penetration test, SBOM                                     | **NOT_RUN** <!-- C-026 -->                                     |

The full status of every requirement, invariant and test is in [docs/coverage/COVERAGE.md](docs/coverage/COVERAGE.md);
`status` there is the canonical result (external proof required for T-057..T-060), `localStatus` the local layer.

## Architecture

```text
apps/web            operator console (React SPA, served by apps/api)
apps/api            authenticated HTTP API: OIDC, server-derived tenant context, strict contracts
apps/worker         outbox consumers, jobs and sweeps with per-runner advisory locks (no paid egress)
apps/kite-broker    the only holder of the paid credential and the only paid egress (unix socket, signed references)
apps/sensor-gateway signed telemetry ingestion and freshness sweeps
packages/*          contracts, domain, data (migrations, tenancy, outbox), incidents, evidence, compatibility,
                    providers, planning, commerce, orders, recovery, observability, resilience, operations
infra/              Dockerfile, compose definition, reference network policies, runbooks
```

Diagrams: [docs/release/ARCHITECTURE.md](docs/release/ARCHITECTURE.md). Decisions: [docs/adr](docs/adr). Specification:
[docs/spec/START-HERE.md](docs/spec/START-HERE.md) (its invariants in `CORE-CONTRACT.md` are binding).

## Quick start (local)

Requirements: Node 22 (`.node-version`), pnpm 11 (corepack), Docker for the local PostgreSQL.

```sh
corepack enable
pnpm install --frozen-lockfile
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.example | cut -d= -f2-)"
pnpm db:migrate
pnpm db:seed
pnpm verify
```

Production-like local stack (fresh clone, fresh compose project and ports, throwaway secrets, torn down afterwards):

```sh
pnpm release:smoke
```

## Test and release commands

| Command                                                 | What it runs                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                           | lint, security checks, format, typecheck, unit, integration, build, browser tests, pack check, release draft check, secret scan |
| `pnpm test` / `pnpm test:integration` / `pnpm test:e2e` | the individual suites (integration and browser tests need `DATABASE_URL`)                                                       |
| `pnpm release:smoke`                                    | T-057 local clean-environment bring-up; result in `docs/release/evidence/t057-release-smoke.json`                               |
| `pnpm demo:local`                                       | the SIMULATED demo walk-through and its screenshots (`docs/release/screenshots`)                                                |
| `pnpm release:check`                                    | claim, link and secret checks over the release drafts                                                                           |
| `pnpm release:gates`                                    | status of the seven release gates (all REFUSED: nothing is authorized)                                                          |
| `pnpm release:journey`                                  | the real-input journey gate (NOT_RUN: no real journey exists)                                                                   |
| `pnpm coverage:report`                                  | regenerate `docs/coverage` from test result files                                                                               |

## Deployment

Definitions only: [infra/deploy/DEPLOYMENT.md](infra/deploy/DEPLOYMENT.md). Deploying anywhere requires the `DEPLOY`
release gate ([docs/release/RELEASE-GATES.md](docs/release/RELEASE-GATES.md)); no hosted deployment exists (NOT_RUN).

## License

MIT, see [LICENSE](LICENSE).
