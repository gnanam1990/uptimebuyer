# UptimeBuyer Repository and Change Plan

## Current truth

- Proposed GitHub owner: `gnanam1990`
- Proposed repository name: `uptimebuyer`
- Proposed visibility: private during implementation
- Remote repository existence: **UNVERIFIED**
- Remote creation, push, pull request and merge: **NOT_AUTHORIZED_BY_THIS_DOCUMENT**

These values are a working target. The implementation agent must inspect the actual workspace and ask before performing an external action.

## 1. Repository shape

Proposed monorepo:

```text
apps/
  web/                 operator web application
  api/                 authenticated HTTP/API and domain commands
  worker/              bounded non-payment jobs, outbox and reconciliation
  kite-broker/         exclusive Kite credentials, paid egress and payment reconciliation
  sensor-gateway/      device authentication, sequencing and telemetry writes
packages/
  contracts/           schemas, IDs, money/units and API/event types
  domain/              state machines and deterministic policies
  data/                database client, repositories and migrations
  integrations/        OpenServ, unpaid-provider, CMMS and object-store adapters
  kite-contracts/      credential-free signed-intent and broker-result schemas
  observability/       logs, traces, metrics and correlation
edge/
  sensor-agent/        MQTT/HTTP edge reference and controlled-rig firmware
infra/                 local stack and reviewed deployment definitions
tests/                 cross-service, adversarial and end-to-end harnesses
docs/                  ADRs, runbooks and evidence index
evidence/              redacted qualification manifests, not secrets/raw customer data
```

Use pnpm workspaces and Turborepo only after verifying current supported versions and actual repository needs. Keep one lockfile. Do not split services into repositories until ownership/deployment evidence justifies it.

`apps/kite-broker` is a separate deployable even inside the monorepo. Its credential-bearing Kite adapter must not be a shared package importable by `web`, `api`, or `worker`. Deployment policy gives only the broker workload identity access to the Kite secret and paid destinations; all other workloads receive an explicit deny. An in-process class, prompt rule, or shared environment variable does not satisfy INV-06.

## 2. Branch model

Default branch proposal: `main`, protected remotely when authorized. Integration work uses short-lived branches:

```text
feat/m00-intake-foundation
spike/f0-feasibility
feat/m01-shared-contracts-domain
feat/m02-storage-auth-rbac-tenancy
...
feat/m14-deployment-demo-release
fix/<bounded-defect>
docs/<bounded-document-change>
```

If the actual repository has an established convention, follow it and record the decision. Never rename a remote/default branch without approval.

## 3. Commit model

Each commit must be reviewable and correspond to one coherent behavior or proof. Preferred sequence per canonical module:

1. `test(mNN): reproduce <behavior>`
2. `feat(mNN): implement <behavior>` or `fix(mNN): enforce <invariant>`
3. `test(mNN): add integration and adversarial coverage`
4. `docs(mNN): record evidence and operations`

A red test may be preserved in the first commit only if the branch/PR remains clearly marked work in progress. The final module branch must pass required gates or record the unresolved failure without merging.

The F0 feasibility spike is not a canonical module and does not satisfy an FR, NFR, INV, or T identifier. If authorized, keep its disposable harness and redacted evidence on `spike/f0-feasibility`; preserve the result even when it fails. Do not merge the spike harness into product code merely to make later tests pass.

Commit messages use imperative, specific scope. Do not use misleading messages such as “production ready” when external qualification is incomplete. Do not commit credentials, `.env` values, private transcripts, customer data or large unredacted recordings.

## 4. Pull request model

One PR may contain one module or a tightly coupled dependency group. Every PR includes:

- problem and owned IDs;
- architecture/state changes;
- red-before-green evidence;
- exact commands, exit codes and test counts;
- security/privacy/tenant/money impact;
- migrations and rollback;
- provider/device evidence and honesty status;
- screenshots/video only when useful;
- explicit remaining risks and follow-up;
- module handoff JSON (see the `Module handoff` section of `templates/PR-BODY.md`).

PR creation is a remote action and requires user authorization. Draft status is preferred until required evidence is present. Independent review is required for money, authorization, tenant isolation, compatibility/safety, migrations and recovery-closeout changes.

## 5. Merge gates

Do not merge because a module “looks done.” Required gates are:

- owned requirement/invariant/test mappings are current;
- focused and regression CI passes from the exact source SHA;
- migrations have forward/rollback or approved roll-forward evidence;
- authorization and tenant-isolation tests pass;
- retry/restart/idempotency tests pass for external effects;
- no high/critical unresolved security finding;
- docs/runbooks/handoffs match behavior;
- reviewer approvals exist under branch policy;
- provider/device limitations are explicitly preserved.

Only the user or an explicitly authorized repository maintainer may approve merge. A request to implement or commit does not authorize merge.

## 6. Suggested module/change sequence

| Module | Main owned paths | Merge dependency |
|---|---|---|
| M00 | root config, workspace, CI, local stack | none |
| F0 feasibility gate | isolated `spikes/f0/` harness and redacted evidence only; not a canonical module | M00 plus explicit authorization for any real contact or spend |
| M01 | `packages/contracts`, `packages/domain` primitives, `packages/kite-contracts` broker-port schemas and contract fake | M00 |
| M02 | `packages/data`, auth/RBAC, migrations | M01 |
| M03 | edge and sensor ingestion | M01–M02 |
| M04 | incident engine/state transition | M02–M03 |
| M05 | evidence pipeline and OpenServ proposal adapter | M01–M04 |
| M06 | deterministic compatibility/policy | M01, M05 |
| M07 | provider discovery/communications adapters | M01–M02, M06 |
| M08 | cost-to-recovery planning | M04, M06–M07 |
| M09 | `apps/kite-broker` implementing the M01-owned `packages/kite-contracts` port, plus bounded authority | M01–M02, M06, M08, and a recorded F0 disposition |
| M10 | purchase/order/job reconciliation | M02, M07, M09 |
| M11 | recovery verification and CMMS | M03–M04, M06, M10 |
| M12 | operator web application | stable contracts from M01–M11 |
| M13 | cross-system hardening and observability | all implementation modules |
| M14 | deployment/demo/release qualification | M00–M13 |

Do not start the full M01–M14 build until the user decides on an F0 `PROCEED` recommendation or explicitly accepts a `NARROW` claim after an honest `FAIL`, `UNKNOWN`, `UNSUPPORTED`, or `BLOCKED` result. Where later parallel work is safe, use separate worktrees or branches and assign non-overlapping paths. Shared database migrations, API contracts and state machines are serialized through their designated owner: M02 owns the migration framework and ordering, and each later module adds only its own numbered files under `packages/data/migrations/` through that owner; M01 owns state-machine transition tables in `packages/domain`, which M04, M10 and M11 consume; M02 owns provider-account tables and M07 owns their behavior; M11 owns the CMMS adapter.

## 7. CI proposal

CI should include:

1. dependency/lockfile integrity and secret scan;
2. format, lint and type checks;
3. unit/property/state-machine tests;
4. database migration and repository integration tests;
5. API/event contract checks;
6. tenant/authorization/adversarial tests;
7. external-effect retry/restart/idempotency tests against controlled fakes plus separately tracked real qualification, including negative proof that only `apps/kite-broker` can reach paid Kite endpoints;
8. web build, accessibility and responsive smoke tests;
9. container/image scan and software bill of materials;
10. pack/traceability checker when specifications change.

CI fakes establish deterministic software behavior only. They do not qualify real Kite/provider/CMMS/device fulfillment.

## 8. Release and deployment

Use immutable artifacts associated with source SHA and lockfile. Promotions reference the same artifact across environments. Database migration and rollback/roll-forward runbooks are reviewed before deployment.

Deployments require separate approval and record environment, source SHA, artifact digest, migration result, health checks and rollback status. Production credentials and network policy must make the Kite broker a separate workload identity and egress boundary. The general worker cannot share its service account, secret mount, paid-destination route, or credential-bearing adapter. A local Docker network is not proof of production isolation.

## 9. Implementation-agent handoff

At each boundary provide:

- exact path/branch/HEAD;
- clean/dirty status and owned changes;
- module and ID coverage;
- tests run and evidence locations;
- migrations/config changes;
- provider/device status (`NOT_RUN`, `PASS`, `FAIL`, `UNKNOWN`, `UNSUPPORTED`, `BLOCKED`);
- known risks and next module prerequisites;
- local commits;
- explicit statement of remote/public actions performed or not performed.

The next agent re-verifies these facts rather than trusting prose alone.

