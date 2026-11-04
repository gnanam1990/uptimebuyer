# UptimeBuyer Architecture

Status: `SPECIFICATION_ONLY`  
Implementation, provider fulfillment, payments, deployment, and production operations: `NOT_RUN`

## 1. Architectural objective

UptimeBuyer turns a real commercial-refrigeration incident into a bounded recovery workflow: ingest authoritative telemetry, bind reasoning to the exact asset and evidence revision, deterministically decide which actions are safe, purchase only within an approved Kite session, track fulfillment, and close only after independent recovery evidence. It is not a generic shopping agent and it does not treat an agent or provider claim as proof of recovery.

## 2. System boundary

```text
ESP32 / BMS / simulator
        | MQTT over TLS
        v
Sensor gateway -> API -> PostgreSQL <-> Outbox -> bounded general workers
                       |                    |      |      |
                       |                    |      |      +-> CMMS / notifications
                       |                    |      +--------> unpaid provider adapters
                       |                    +-> signed opaque intent -> Kite broker -> paid Kite endpoints
                       |
                  Object storage <-> evidence service <-> OpenServ/SERV
                       |
                       +-> deterministic compatibility and policy engine

Next.js operator console <-> Fastify API <-> append-only decision/evidence views
```

Trust boundaries are explicit:

1. Sensors and external integrations are untrusted inputs.
2. Manuals, transcripts, web results, and model output are evidence, never authority.
3. The deterministic policy engine alone returns compatibility `ALLOW`, `HOLD`, or `REJECT`; only an `ALLOW` may let the plan builder produce an approvable action.
4. The Kite broker is the only component with payment credentials and vendor-payment egress.
5. Sensor windows plus an authorized CMMS/operator record are the only recovery authorities.

## 3. Proposed implementation stack

| Layer | Proposed choice | Reason |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | shared contracts and repeatable commands |
| Web | Next.js App Router + TypeScript | server-rendered operations console and route isolation |
| API | Fastify + TypeScript + generated OpenAPI | typed, bounded request handling |
| Canonical store | PostgreSQL | transactions, constraints, row-level tenant enforcement |
| Job coordination | Redis + BullMQ | bounded asynchronous adapters with retry control |
| Telemetry ingress | MQTT over TLS | edge-friendly ordered messages |
| Evidence blobs | S3-compatible object storage | immutable manual, image, and transcript objects |
| Reasoning | OpenServ/SERV behind one adapter | cited extraction and proposal generation only |
| Payments | exclusive server-side Kite broker | enforce budget and credential boundary |
| Observability | OpenTelemetry-compatible traces, metrics, structured logs | cross-workflow correlation |

Implementation intake must select current supported releases, record an ADR, and pin the lockfile and container digests. This document does not invent dependency versions.

## 4. Deployable units

- `apps/web`: read-heavy operator console; no provider or payment secrets.
- `apps/api`: authentication, tenant scoping, commands, queries, approval endpoints.
- `apps/worker`: incident, evidence, unpaid-provider, order, and verification jobs; queues are concurrency- and time-bounded, and the service has neither Kite credentials nor paid-endpoint egress.
- `apps/kite-broker`: separately deployed bounded-session, paid-execution, receipt, and payment-reconciliation service; it has a distinct workload identity, the only Kite credential grant, and the only Kite paid-endpoint egress allowlist.
- `apps/sensor-gateway`: authenticates devices, validates sequencing, and writes telemetry batches.
- `packages/contracts`: schemas, state enums, error taxonomy, money and measurement types.
- `packages/domain`: state-machine transition tables plus pure deterministic compatibility, spending, and recovery functions.
- `packages/data`: database client, repositories and migrations.
- `packages/integrations`: OpenServ, unpaid catalog/provider, phone/email contract, CMMS, and object-store interfaces without credentials or direct paid execution.
- `packages/observability`: logs, traces, metrics and correlation.
- `packages/kite-contracts`: credential-free signed opaque execution-reference (`EXECUTION_AUTHORITY` or `COMMERCIAL_INTENT`) and result schemas shared with the broker; the credential-bearing Kite adapter remains inside `apps/kite-broker` and is not importable by general services.
- `edge/sensor-agent`: minimal ESP32/reference edge client plus signed simulator fixtures.

`REPOSITORY-PLAN.md` holds the canonical directory layout; this list must match it.

## 5. Control plane and data plane

The control plane stores tenant policy, approval rules, immutable execution authorities and append-only lifecycle events, separately reconciled Kite-session activations, budgets, provider allowlists, asset data, evidence revisions, and non-secret credential metadata. Raw Kite credential access is granted only to the broker's workload identity. The data plane ingests measurements, executes jobs, and calls unpaid provider surfaces. General workers receive opaque authority/intent IDs, never a Kite credential reference or raw secret, and network policy denies Kite paid endpoints. The broker reloads the persisted intent, authority, confirmed session outcome, policy, revisions, budget, and correlation data from PostgreSQL before paid egress.

Tenant-bound `provider_accounts` and immutable capability revisions are the routing source of truth. The stable account identifies provider/environment; its immutable revision declares paid/unpaid capability, owner workload, opaque credential reference, endpoint policy and webhook verifier. Every request, approval, intent, attempt and callback pins the exact revision; supersession invalidates unexecuted work but cannot rewrite an in-flight attempt. M07 owns discovery, contact preparation, unpaid execution, quote/transcript normalization and consent evidence. For StablePhone, StableEmail (candidates; fulfillment `NOT_RUN`) or any other paid contact/API, M07 persists the immutable contact request and asks M09 to create a commercial intent whose subject is that request; only `apps/kite-broker` resolves the paid revision's credential, performs egress and reconciles. M07 consumes the result event and never retries a paid `UNKNOWN` directly.

## 6. Transactional workflow

Every state-changing API command:

1. validates identity, tenant, role, request schema, and expected aggregate version;
2. writes the aggregate change and an outbox event in one PostgreSQL transaction;
3. returns the durable aggregate version, not a claim that external work finished;
4. lets an outbox publisher enqueue the event.

For an authorized paid commercial action only, `apps/kite-broker` additionally:

1. reloads and revalidates the tenant, revision-bound action, approval, immutable execution authority, confirmed Kite-session outcome, exact provider-account revision, and budget;
2. generates the client operation/idempotency key and records attempt transport marker `SEND_STARTED` before network I/O while the economic intent remains `RESERVED`;
3. reconciles ambiguous timeouts by authoritative lookup or provider-guaranteed same-key replay; an adapter with neither capability is `UNSUPPORTED` for autonomous execution;
4. persists payment/provider outcome evidence and emits the next event.

Queue delivery is at-least-once. Business effects must therefore be exactly-once by invariant, using database uniqueness and provider idempotency where supported.

## 7. Agent boundary

SERV may extract candidates, cite evidence, summarize calls, and propose ranked plans. It cannot:

- return or mark compatibility `ALLOW`;
- release or increase a budget;
- access credentials;
- directly call payment or merchant endpoints;
- declare a repair successful;
- override `UNKNOWN`, policy revision mismatch, stale evidence, or a safety hold.

Tool calls use schema-constrained inputs and per-tool allowlists. Retrieved text is untrusted data and cannot add tools or instructions.

## 8. Consistency model

- PostgreSQL is authoritative for workflow state.
- MQTT messages are accepted once per `(device_id, boot_id, sequence)`.
- Redis is acceleration/coordination only; rebuilding it cannot lose business state.
- Object metadata and SHA-256 digests are stored in PostgreSQL; blobs are immutable.
- Client views are eventually current but show `as_of`, freshness, and unresolved state.
- Transport, normalized external action, adapter capability and economic intent are separate persisted axes. External actions use `PROPOSED`, `AUTHORIZED`, `REQUESTED`, `ACCEPTED`, `CONFIRMED`, `UNKNOWN`, `FAILED`, or `CANCELLED`; `UNSUPPORTED` is a pre-egress capability/policy result or a parallel capability status that never resolves a post-egress `UNKNOWN` effect. Economic intents use the exact states in `STATE-MACHINES.md`; no generic `PENDING` alias is permitted.

## 9. Multi-tenancy

Every tenant-owned row includes `tenant_id`; primary and unique keys include it where meaningful. API transaction context sets tenant identity, database row-level security provides defense in depth, object paths are tenant-scoped, and queue payloads contain opaque IDs that workers reauthorize. Cross-tenant joins, caches, logs, traces, and exports are tested as denial cases (FR-24, INV-16, NFR-05).

## 10. Availability and degraded modes

| Failure | Required behavior |
|---|---|
| MQTT unavailable | edge buffers bounded telemetry; UI shows data stale/offline |
| SERV unavailable | retain incident; allow deterministic/manual workflow; no fabricated diagnosis |
| provider timeout | state `UNKNOWN`; reconcile before retry |
| Kite unavailable before `SEND_STARTED` is durably committed | keep the economic intent in its current pre-egress canonical state and retry only under its existing authority/idempotency rules; never bypass the broker |
| Kite outcome ambiguous after possible egress | record `UNKNOWN`, retain the bounded reserve, and reconcile inside the broker before retry |
| Redis loss | rebuild queues from outbox/attempt records |
| object store loss | block evidence-dependent approval; preserve metadata |
| CMMS unavailable | recovery may be sensor-observed but cannot be fully closed if policy requires sign-off |

## 11. Environment boundaries

- Local: simulator and explicit fake adapters; payments disabled by default; all fake output labeled.
- Demo: real sensor/edge process and at least one real provider/payment action, with hard caps; any unexecuted integration visibly labeled.
- Production: separate tenant secrets, verified webhook signatures, network egress policy, backup/restore evidence, incident response, and change approvals.

No local or demo fixture may be silently accepted as production proof (INV-12, NFR-12).

## 12. Architecture acceptance gates

- Clean checkout can reproduce lint, types, unit, integration, and end-to-end commands.
- Model output cannot reach provider/payment egress without deterministic authorization.
- Killing the broker or a general worker before, during, or after request dispatch does not duplicate payment or order and never mislabels a pre-egress intent as submitted.
- Recovery cannot be closed without the configured stable telemetry window and sign-off evidence.
- Cross-tenant access fails at API and database boundaries.
- An ambiguous provider timeout is reconciled, not retried as a definite failure.
- Dirty migrations, unpinned dependencies, missing secrets, or absent real-service credentials fail explicitly.

Related requirements: FR-01 through FR-24, NFR-01 through NFR-12, and INV-01 through INV-16.

