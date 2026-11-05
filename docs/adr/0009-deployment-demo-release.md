# ADR 0009 — Deployment, demo and release (M14)

Status: accepted (M14, 2026-11-05)

## Context

M14 owns FR-22, NFR-01, NFR-12 and INV-12 (T-057..T-060). M13 left every runner unscheduled (retention, token-use
pruning, outbox consumers, job runners, tenant sweeps, platform signals), M12 deferred the API's secret channel (authority
signer, webhook verifiers, broker session activation), and no image, compose definition, network policy, runbook,
release gate or claim check existed. Workspace packages export TypeScript sources, so no compiled entry point could run.

The boundaries for this module: no external action of any kind (no deploy, push, publish, post, upload, submit, spend
or real provider/Kite/OpenServ/IdP/CMMS/sensor contact). "Deployment" means production-like definitions plus a clean
local bring-up. The real-input journey has no real inputs and stays NOT_RUN.

## Decisions

1. **A worker process schedules every runner.** `apps/worker` runs 14 runners on bounded intervals (1 s to 24 h) with
   symmetric jitter. Each tick first takes a PostgreSQL session advisory lock `worker-runner:<name>` with
   `pg_try_advisory_lock` (the M07 hand-off pattern), so two replicas never run the same runner at once; the loser
   records `SKIPPED_LOCKED`. All of a replica's runner locks live on ONE dedicated session: lock holders never occupy
   pool connections their runners wait for (an earlier one-connection-per-lock design deadlocked under concurrent
   ticks), and if that session dies every holder's tick is aborted (exclusivity lost) and the client error no longer
   crashes the process. The runner lock is outermost and non-blocking, outside the ADR 0006 global order, so it cannot
   join a deadlock. Failures, timeouts and overlaps are isolated per runner; shutdown is one root AbortController:
   stop scheduling, abort in-flight ticks' signals, drain up to a bound, release the lock session, close the pool.
2. **Per-tenant sweeps run under a worker context issued per ACTIVE tenant row** through `@uptimebuyer/data/worker`
   (`forEachActiveTenant`), restricted by ESLint to `apps/worker/src` like the M13 broker subpath; a failing tenant
   does not stop the others. The outbox sink routes each event to every consumer (the broker-result mirror only gets
   its own event type, because it validates strictly); a consumer failure fails the delivery so the event is retried
   in order and never dropped (a poison event holds the queue and raises the outbox-age alert).
3. **Adapters are explicit.** Without provider adapters, contact dispatch records `UNSUPPORTED/ADAPTER_NOT_CONFIGURED`;
   without status credentials, fulfillment polling is `UNSUPPORTED`; without a CMMS token file, CMMS writes are
   `UNSUPPORTED` pre-egress. The worker never reads a token from the environment (`HttpsCmmsAdapter.fromToken`).
4. **Secrets are files; the environment holds references.** `readSecretFile` refuses non-regular, group/other-readable,
   empty or oversized files; `FileSecretStore` maps a tenant-bound `secretref:` to one file under a root and refuses
   traversal, foreign shapes, open modes and symlinks leaving the root. The API requires the authority signer and the
   webhook verifier root (and, with a broker socket, the execution-reference signer); a missing or unusable reference
   exits 78 naming the variable, never the value. Database passwords come from a 0600 pgpass file. The broker reads its
   secret document on fd 3 (secret volumes are root-owned, which its `--secret-file` owner check refuses).
5. **Built images run compiled code** through `scripts/runtime/register-dist.mjs`, a resolve hook mapping a workspace
   `src/*.ts` (by export or by a relative cross-package specifier) to its `dist/*.js` and failing loudly otherwise.
   Package exports stay unchanged (the M13 subpath test pins them).
6. **One multi-stage Dockerfile** with a runtime target per deployable, digest-pinned bases, frozen lockfile, numeric
   user 10001, no secret in any layer; only the broker target contains the broker. **Compose** runs hardened read-only
   containers; the broker alone joins `paid-egress`; worker, database and migrate job sit on an internal network; ingress
   is published on loopback only; operations listeners stay on 127.0.0.1 inside containers. A **reference Kubernetes
   policy** encodes default deny with internet egress for the broker only. A Docker bridge cannot separate ingress from
   egress for the published services, and a local network is not production isolation (NOT_RUN).
7. **T-057 local layer** is `pnpm release:smoke`: committed HEAD cloned fresh, throwaway secrets, build, identify (SHA
   and image IDs), migrate, provision a synthetic tenant, fresh compose project and loopback ports, health, readiness,
   an authenticated call with a locally minted ES256 token (and refusal without or with a forged one), the web page,
   every runner ticked OK, broker socket liveness from the API container, a pg_dump/pg_restore drill verified by table
   digests and migration checksums with a migrate no-op on the restore, an image rollback to a previous ref and
   forward again, and unconditional teardown. It is not part of `pnpm verify` (it needs Docker and several minutes).
   The bring-up found a real defect: the API registered platform metrics twice when its operations listener was on.
8. **T-058 gate** classifies each journey part PASS/FAIL/NOT_RUN/UNKNOWN/UNSUPPORTED and refuses non-real origins,
   replays, registered simulated artifacts, other-run or out-of-window evidence and unauthorized payments; a database
   cross-check refuses what the database labels non-real but never proves realness alone.
9. **T-059 claim check** (in `pnpm verify`): ledger ids, coverage agreement, real-world assertion qualifiers, link and
   secret/personal-data checks over the drafts and README. The coverage report gains `localStatus`; tests whose proof
   is external (T-057..T-060) read `status` = worse of local and NOT_RUN.
10. **T-060 release authority**: seven separate gates; an authorization is an Ed25519-signed record of exactly one gate
    by a registered authorizer, valid, unused, with an exactly matching scope and passing preflight. No authorizer is
    registered, so every gate is REFUSED. The tooling performs no external action.
11. **No migration** was needed (locks are advisory, gate records are files). LICENSE stays MIT as committed in M00.

## Consequences

- Retention, pruning, sweeps and consumers now run in a deployable process; until something runs the stack, nothing
  happens in practice (no hosted deployment).
- The broker's unix socket cannot cross pods: a cluster needs a node-local socket or an mTLS transport for the same
  protocol (not implemented).
- pgpass support in `pg` is deprecated for pg@9; moving to a password callback is a follow-up.
- Real-input, deployment and publication evidence stays NOT_RUN until a person authorizes each action through its gate.
