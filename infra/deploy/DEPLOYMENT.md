# Deployment definitions (M14)

Status: production-like **definitions** plus a scripted **local** bring-up (`pnpm release:smoke`). No hosted
deployment exists: deploying anywhere is `NOT_RUN` and needs the `DEPLOY` release gate (`docs/release/RELEASE-GATES.md`).

## Deployables

| Deployable                 | Image target                            | Listens on                                                    | Holds                                                                                                   |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `migrate` (job)            | `migrate`                               | nothing                                                       | database role password (pgpass file)                                                                    |
| `api` (serves the web app) | `api`                                   | 8080 (edge), 9464 operations listener on 127.0.0.1            | authority signer key, execution-reference key, webhook verifier root, operations token                  |
| `worker`                   | `worker`                                | 9465 operations listener on 127.0.0.1                         | operations token; optional CMMS token and unpaid provider credential root                               |
| `kite-broker`              | `kite-broker`                           | unix socket `/run/ub-broker/broker.sock` (0600 in a 0700 dir) | broker secret document: its database URL, verification keyrings, the paid-endpoint credential reference |
| `sensor-gateway`           | `sensor-gateway`                        | 8081 (edge)                                                   | device credential root                                                                                  |
| `postgres`                 | `postgres:17.6-alpine` pinned by digest | 5432 on the internal network                                  | data                                                                                                    |

All images come from `infra/docker/Dockerfile` (multi-stage, base images pinned by digest, `--frozen-lockfile`, numeric
non-root user 10001, no secret in any layer). Only the `kite-broker` target contains the broker application. Compiled
entry points load compiled workspace packages through `scripts/runtime/register-dist.mjs`.

## Secrets

Secrets are files; the environment carries only references (`.env.example` lists every variable with placeholders):

- `UB_AUTHORITY_SIGNER_KEY_FILE` (PKCS#8 Ed25519 PEM) with `UB_AUTHORITY_SIGNER_KEY_ID`;
- `UB_REFERENCE_SIGNER_KEY_FILE` (base64url, at least 32 bytes) with `UB_REFERENCE_SIGNER_KEY_ID`, required when
  `UB_KITE_BROKER_SOCKET` is set;
- `UB_WEBHOOK_VERIFIER_ROOT` and `UB_DEVICE_SECRET_ROOT`: directories laid out as
  `<namespace>/tenants/<tenantId>/<path>`, one base64url key per tenant-bound `secretref:`;
- `UB_OPS_TOKEN_FILE`, `UB_WORKER_OPS_TOKEN_FILE`: at least 32 characters;
- the database password through a 0600 `PGPASSFILE` (DATABASE_URL carries no password);
- the broker's secret document on an inherited file descriptor (mounted into the broker container only).

Every file must be a regular file readable by its owner only (0600/0400); the API, worker and gateway refuse to start
(exit 78, EX_CONFIG) naming the variable, never the value. Kubernetes secret volumes satisfy this with
`defaultMode: 0400`. The broker reads its document on fd 3 because secret volumes are owned by root.

## Network boundaries

- **Paid egress belongs to the kite-broker only.** Compose: only the broker joins `paid-egress`; the worker, migrate
  job and database are on the internal `data` network with no egress at all. Kubernetes reference policy
  (`kubernetes/network-policies.json`): default deny; the broker alone may reach 443 on public ranges, and should
  additionally sit behind an egress gateway that allow-lists the Kite and merchant endpoints by name (resolution-time
  egress control). The API reaches DNS, PostgreSQL and the identity provider only.
- A Docker bridge cannot separate ingress from egress, so in compose the `edge` network that publishes the API and
  gateway on loopback also permits their egress. The local stack is not proof of production isolation
  (REPOSITORY-PLAN §8); the enforced boundary is the cluster policy, which is `NOT_RUN`.
- **Operations listener on a private interface.** The API (9464) and worker (9465) operations listeners bind
  127.0.0.1 inside their containers and are never published; metrics and alerts require the operations bearer token.
  In a cluster, bind them to the pod network and admit only the monitoring namespace (as the reference policy does).
- The broker unix socket cannot cross pods. A cluster deployment needs a node-local socket (broker and clients on the
  same node, separate pods and service accounts) or an mTLS transport for the same reference-only protocol, which does
  not exist yet (residual risk, ADR 0009).

## Edge, WAF and rate limits

The in-process caps (M13: pre-authentication caps per /32 and /64, failure buckets, bulkheads) bound one process; they
cannot tell a large distributed source pool from a busy customer base. A deployment **must** put an edge/WAF in front
of the API and gateway with:

- per-source and global rate limit rules on `/v1/*`, a stricter rate limit on unauthenticated paths
  (`/v1/fulfillment-webhooks/*`, `/v1/device/telemetry:batch`) and a 64 KiB body limit on webhooks;
- TLS termination with HSTS; request header and body size limits matching `ApiLimits` and `GatewayLimits`;
- bot and volumetric protection.

Behind that proxy set `UB_TRUST_PROXY` (to `true` or, better, the proxy address list): otherwise every client shares
the proxy's address and one client's failures throttle everyone.

## Per-replica sizing

All limits are per process, so N replicas multiply capacity. Size them per replica:

- `ApiLimits` (apps/api/src/app.ts): `maxConcurrentRequests` 64, `maxQueuedRequests` 256, `maxConcurrentAuth` 256,
  `maxConcurrentAuthPerSource` 8, `maxQueuedAuth` 64, `authTimeoutMs` 10 000. The API pool has 16 connections.
- Worker: `UB_WORKER_DB_POOL_MAX` (default 10) plus one dedicated advisory-lock session; runners never wait on each
  other's locks. Any number of worker replicas is safe: each runner runs on at most one replica at a time.
- Broker: 8 connections; one replica unless the deployment provides the node-local socket arrangement above.
- PostgreSQL `max_connections` must cover api x 16 + worker x 11 + broker x 8 + gateway x 16 + headroom.

## Health and readiness

`/health/live` and `/health/ready` on the API (public port), gateway and worker operations listener; the broker answers
`/health/live` on its socket. Readiness is `ready`, `degraded` (200, visible) or `unavailable` (503). Compose health
checks probe from inside each container.

## Local production-like bring-up

`pnpm release:smoke` clones the committed HEAD into a fresh temporary directory, generates throwaway secrets there,
builds every image, migrates, starts the stack in a fresh compose project on fresh loopback ports, runs the smoke checks
(health, readiness, an authenticated API call with a locally issued test token, the web page, worker ticks, broker
liveness), exercises backup/restore and an image rollback, records the git SHA and image IDs, and tears everything
down. Results: `docs/release/evidence/t057-release-smoke.json`.
