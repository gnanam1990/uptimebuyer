# ADR 0008 — Testing, security and observability hardening (M13)

Status: accepted (M13, 2026-11-05)

## Context

M13 owns FR-23, FR-24, NFR-02, NFR-04, NFR-05, NFR-06, NFR-08, NFR-09, NFR-10, NFR-12, INV-06, INV-13 and INV-16
(T-053..T-056). Earlier handoffs deferred to M13: FR-23 retention, legal hold and erasure for raw fulfillment-webhook
bodies (M10) and raw CMMS bodies (M11); separation of duties (M06 engineer exception, M12 dual approval); pruning of the
M02 single-use token table; narrowing the broker worker-context issuer (M09); NFR-08 measurement (M12); an
authenticated operations listener (M03); and the threat corpus, bounds, trace correlation and chaos proofs.

Verified facts at the start (5a4ac2b): no metrics/trace library, readiness was a bare `SELECT 1`, the broker logged no
correlation, the evidence ledger held no APPROVAL, PAYMENT_STATE or EXTERNAL_ACTION entries (FR-18 gap), raw bodies
were stored with no erasure path and fully append-only, any `@uptimebuyer/data` importer could mint a broker context,
IdP URLs accepted metadata/link-local/private literals over https (T-053 red: 19 of 23 corpus cases accepted), and a
verified provider callback was lost forever if the process died between its delivery record and its job (T-056 red).

## Decisions

1. **Three small packages, no new external dependency.** `@uptimebuyer/observability` (pure: redaction, structured
   logger, closed-label metrics with Prometheus exposition, W3C-traceparent tracer, health/readiness, SLO tracker, alert
   rules as JSON), `@uptimebuyer/resilience` (token bucket, bulkhead with explicit `RATE_LIMITED/LOAD_SHED`, deadlines
   that turn an external-effect timeout into `DEPENDENCY_OUTCOME_UNKNOWN`, a retry policy that refuses an external
   effect without a reconciliation key, size and model token/cost budgets) and `@uptimebuyer/operations`
   (database-backed: incident trace, platform gauges, readiness checks, encryption posture).
2. **Metrics cannot carry identifiers.** Every label is declared with its complete value set; label names that look
   like identifiers are refused at registration and undeclared values at use (`METRIC_LABEL_UNBOUNDED`). Alerts read
   aggregate values only and dedupe on their static rule id.
3. **Redaction is two-layer and fail-closed.** Sensitive keys are replaced whatever their value; secret-shaped values
   (bearer, JWT, PEM, `secretref:`, any URL userinfo, contacts, Luhn-valid card numbers, registered secret values) are
   replaced wherever they occur. Matching is bounded (every pattern has a maximum match length; the scan window is the
   kept length plus that bound) and offset-safe (output holds only characters whose original offset is below the kept
   length). Non-primitive log fields are dropped, errors are logged by name and typed code only.
4. **The trace is reconstructed from durable records.** The broker is a separate workload, so `buildIncidentTrace`
   stitches incident, telemetry batches, evidence, decision, plan, approval/authority, intent, attempt, order and
   recovery rows with the correlation id each command wrote (row column, else its outbox event, ledger entry or audit
   entry). The API continues an inbound `traceparent`, returns one, and logs/spans with the response's
   `X-Correlation-ID`; broker log lines now carry the intent's correlation id and identifiers.
5. **FR-18 completeness.** `appendRecordEvidence` (data) appends server-produced record kinds (APPROVAL, PAYMENT_STATE,
   EXTERNAL_ACTION, RECEIPT) inside the record's own transaction whatever principal triggered it; approvals, every
   commercial-intent state change, external attempt events and order/job state changes now write one. Results from the
   recorded contract or the local stand-in are labelled `CONTRACT_FAKE`, never provider-reported truth. The ledger lock
   is taken last, after domain locks, preserving ADR 0006 ordering.
6. **Erasure is one tombstoned column change.** Migration 0020 replaces the blanket no-update trigger on
   `fulfillment_observations` and `recovery_evidence` with guards that allow exactly one change — the raw payload column
   to NULL (or `{"erased": true}`) with an erasure stamp referencing a tombstone for that row — and refuse everything
   else with UB001. Digests, HMAC seals (which bind `body_digest`, not the body), ledger entries and decisions are
   untouched, so the hash chain verifies and recovery decisions re-read identically. `ub_legal_hold_covers` (unknown
   level = covered, fail closed) refuses erasure under an active hold in the database (UB132), including the existing
   communication-body erasure. Tombstones gain a retention basis. Retention windows come from the effective RETENTION
   policy (`fulfillmentRawDays`, `cmmsRawDays`, else `communicationDays`). Transient raw-body copies in finished job
   payloads are scrubbed. `executePrivacyRequest` re-checks holds at execution (a hold placed after receipt wins),
   erases in scope (COMMUNICATION: communication bodies; CONTACT: every governed raw payload — there is no per-person
   index of raw payloads, so the scope bounds the erasure; USER: REJECTED, identity erasure belongs to the IdP and
   membership lifecycle) and EXPORT returns a manifest by digest. Erasure transactions take the per-tenant legal-hold
   advisory lock first.
7. **Separation of duties when policy says so, self-approval never.** AUTHORITY policy gains an optional
   `separationOfDuties` section. Spend: an approval at or above a listed currency threshold gets its execution
   authority only from a different human holding finance_approver (a worker cannot), and budget adjustments only from
   a finance approver who neither approved nor issued it; migration 0021's insert guard refuses an issuer equal to the
   approver (UB130). High-risk policy: keys listed in `dualApprovalPolicyKeys` are published only by
   `proposePolicyRevision` + `approvePolicyProposal` by a different administrator (proposer recorded as publisher,
   approver recorded on the revision; database guard UB131; CHECK approver ≠ proposer); an AUTHORITY change that would
   switch dual approval off needs the second administrator too. Unconditionally: the registrant of a compatibility
   candidate cannot record its exception or override. Recovery policies (M11) are outside `dualApprovalPolicyKeys`
   for now (residual).
8. **jti pruning is grace-bounded.** `pruneExpiredTokenUses` deletes only rows whose token expired longer ago than the
   verifier tolerance plus a margin (600 s; anything under tolerance + 60 s is refused), in SKIP LOCKED batches. A
   pruned row's token is already refused by `jwtVerify`, so replay protection is intact.
9. **Broker context subpath.** `issueBrokerWorkerContext` moved to `packages/data/src/broker-context.ts`, exported only
   as `@uptimebuyer/data/broker`; ESLint allows that subpath only in the broker application source and a structural
   test scans the repository.
10. **Bounded API.** Operator requests authenticate first. A source is an IPv4 /32 or an IPv6 /64 (IPv4-mapped IPv6
    counts as IPv4), so rotating addresses inside one /64 does not buy capacity. Each attempt reserves a failure token
    atomically (refunded on success), then waits for a pre-auth verification slot: 8 per source, 256 in total (sized
    well above per-source x the expected number of concurrent legitimate sources), with a short bounded queue (64
    waiters, 2 s) when only the global cap is full; all configurable through `ApiLimits`. The slot is held for the
    verification's whole lifetime and released exactly once when it settles or hits its hard timeout (10 s, answered
    with the uniform 401), never on client close. Only then does the request take a bulkhead slot (64 concurrent, 256
    queued, 10 s queue wait by default), released once on the response's close. Excess is shed with 429 `LOAD_SHED`
    - `Retry-After`; webhooks have their own bulkhead; health and public configuration are never shed.
      Readiness is visible: `degraded` (a missed SLO, a non-critical failure) still answers 200 with the reason, a dead
      critical dependency answers 503, check details never carry error text. A separate operations listener serves
      Prometheus metrics and firing alerts only to the operations token (constant-time compare, token from a 0600 file).
11. **Model budgets.** `runReasoning` charges reported usage per turn against `REASONING_LIMITS.maxRunTokens`
    (120 000) or a caller budget; unreported usage is charged by a 4-characters-per-token estimate; with a cost ceiling
    configured, unreported usage fails closed (`USAGE_UNREPORTED`). The contract fake passes scripted usage through.
12. **IdP URL SSRF.** Configuration refuses IdP endpoints that are non-loopback IP literals (every numeric encoding is
    normalized to a literal by the URL parser), single-label or internal-suffix hosts, userinfo, fragments or non-https
    schemes (plain http only on loopback). A private IdP is addressed by DNS name; resolution-time egress control is the
    deployment's network policy (M14).
13. **Callback crash safety.** A verified fulfillment delivery and its job (or its terminal quarantine) are written in
    one transaction. A delivery left job-less by a crash under the previous release is re-enqueued on the provider's
    identical redelivery; quarantined, enqueued or differing deliveries stay DUPLICATE.

## Security review findings (fixed red-first)

| #   | Finding                                                                                                                                                                      | Fix                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Unauthenticated webhook floods shared the operator bulkhead                                                                                                                  | Separate webhook bulkhead                                                                                                                                                       |
| S2  | A future-dated revision queued before dual approval could switch it off later                                                                                                | Enabling refused while an unreviewed future revision is queued                                                                                                                  |
| S3  | Token-only URL userinfo (`https://TOKEN@host`) was not redacted                                                                                                              | Any userinfo is sensitive                                                                                                                                                       |
| S4  | Redaction work grew with input size (backtracking on huge fields)                                                                                                            | Bounded scan window, bounded repetition                                                                                                                                         |
| S5  | Dual approval decided from the current revision only (self-weakening, superseding a queued control, direct SQL)                                                              | Migration 0022: decided over the current AND every scheduled AUTHORITY revision; any AUTHORITY change under an active section needs two people; guard takes the governance lock |
| S6  | Budget-credit SoD threshold used the original approval amount                                                                                                                | Judged on the credit and the resulting limit; migration 0023 database guard                                                                                                     |
| S7  | Bulkhead slots leaked on early disconnects; anonymous requests held operator capacity                                                                                        | Slots tied to response close, queued waiters abortable, slots taken after authentication                                                                                        |
| S8  | Quarantined deliveries looked like orphans and could be re-opened                                                                                                            | Delivery + job/quarantine in one transaction; quarantine terminal                                                                                                               |
| S9  | Truncation after shortening replacements let characters from beyond the kept length (including a partly matched secret) shift into output; straddling secrets were half kept | Matches located on original offsets; only original offsets below the kept length are emitted; straddling matches replaced whole                                                 |
| S10 | Userinfo stopped at `/ ? #`, leaking such passwords                                                                                                                          | Userinfo runs to the authority's last `@` (a query/fragment after a path ends the authority)                                                                                    |
| S11 | Pre-auth verification unbounded after S7; limiter checked with has()                                                                                                         | Atomic failure-token reservation (refund on success); per-source (8) and global (64) pre-auth caps                                                                              |
| S12 | Pre-auth slot freed on client close while verification kept running; no hard verification bound                                                                              | Slot released once in `finally` when verification settles; 10 s hard timeout (uniform 401)                                                                                      |
| S13 | Global pre-auth cap (64) let a few sources lock everyone out; IPv6 rotation in one /64 multiplied per-source capacity                                                        | Source keyed by IPv4 /32, IPv6 /64; global cap 256 (configurable) with a 64-waiter, 2 s queue                                                                                   |

Residual risk (S11-S13): a large distributed pool of sources (many /32s or /64s) can still saturate any in-process
cap; the caps bound the work one process does, they cannot tell a botnet from a busy customer base. The real
mitigation is edge/WAF rate limiting in front of the API at deployment, an M14 input. The S11 test that asserted a
source could verify again while its aborted verifications were still running encoded the S12 defect; it now asserts
the same recovery after the hard timeout.

Choice for S5 (spec leaves it open): under an active separation-of-duties section (current or scheduled), EVERY
AUTHORITY change needs a second administrator, whether it weakens the section or not and whatever its effective time
(earlier or later than a queued revision). It is stricter than "only weakening changes" and needs no diff semantics.
URL paths containing `@` (`https://host/@user`) are treated as userinfo and redacted (fail safe).

## Security tooling failure policy

All checks run offline inside `pnpm verify` (and therefore in CI through `pnpm bootstrap`); none uploads code,
dependencies or secrets anywhere.

| Check                     | Command                                                 | Fails the build when                                                                                                                                                                                                                                                                | How a finding is resolved                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAST                      | `pnpm lint` (ESLint security rules over product source) | eval/new Function/implied eval, `child_process`/`vm` imports (the Kite adapter's argv-only `execFile` is the one sanctioned exception), `Math.random`, disabled TLS verification, md5/sha1, raw HTML sinks, broker/broker-context/recovery-hook import boundaries                   | Fix the code. A new exception needs an ESLint block scoped to one file plus a reason, reviewed like code.                                                                                                                                                                        |
| Dependencies and licenses | `node scripts/deps-check.mjs`                           | a non-exact dependency, package.json/lockfile drift, a locked package whose license is not allowed or not declared, a non-platform package not installed, a locked version on the offline advisory list                                                                             | Pin and re-lock; or add a reviewed license exception (package, license, reason) to `config/security/license-policy.json`; advisories are added from a reviewed source to `config/security/advisories.json`.                                                                      |
| Migration lint            | `node scripts/migration-lint.mjs`                       | bad file name or duplicate number, an applied migration edited, a migration missing from the checksum lock, a NULL-unsafe negated guard or `NOT IN (SELECT …)` guard, a RAISE EXCEPTION without ERRCODE, a tenant table without a `(tenant_id, …)` key, DROP TABLE/COLUMN, TRUNCATE | Fix the SQL in a new migration (applied files are immutable); lock a new file with `--update-lock` in the same reviewed change. Only pre-M13 findings already audited (ADR 0004) are listed in `config/security/migration-lint-baseline.json`; new findings are never baselined. |
| Secret scan               | `pnpm secrets:scan` (existing)                          | a secret pattern in tracked, untracked, build or history surfaces                                                                                                                                                                                                                   | Remove and rotate; never allowlist a real secret.                                                                                                                                                                                                                                |
| Coverage report           | `tests/m13/coverage-report.test.ts`                     | a canonical FR/NFR/INV/T id missing from `docs/coverage/`, a status outside PASS/FAIL/NOT_RUN/UNKNOWN/UNSUPPORTED, a claimed real-world result                                                                                                                                      | Regenerate with `node scripts/coverage-report.mjs --results …`.                                                                                                                                                                                                                  |

Severity policy: any finding fails `pnpm verify`; there is no warn-only mode. Tool output is evidence for review, not
production certification (container/IaC scanning, SBOM provenance and an independent penetration test are NOT_RUN and
belong to M14's release gate).

## Consequences

- Earlier modules changed additively: ledger records for approvals/payments/attempts/orders; `publishPolicyRevision`
  refuses dual-approval keys; spend SoD checks in commerce; registrant self-approval refusal in compatibility; the
  broker imports its context from the subpath; the reasoning loop charges tokens; the API is instrumented and bounded;
  fulfillment redelivery recovers orphaned deliveries; T-011's matrix lists the two new actions; T-009 lists 0020-0023.
- RLS is still not enabled (tenant isolation remains composite keys plus server authorization, proven catalog-wide by
  T-053). Rate buckets, pre-auth caps and bulkheads are per process; a distributed source pool can still saturate
  them (edge/WAF rate limiting is an M14 input). SLO numbers measured here are local, not production evidence.
- Runners exist but are unscheduled (M14): `RetentionSweeper.runOnce`, `pruneExpiredTokenUses`,
  `collectPlatformSignals` (wired into the operations listener's scrape), plus the earlier unscheduled runners listed
  in the M13 handoff.

## Verification

T-053 (`apps/kite-broker/test/t053-*.int.test.ts`, `apps/api/test/t053-idp-ssrf.test.ts`,
`packages/providers/test/t053-ssrf-corpus.test.ts`, `packages/providers/test/fr23-communication-erasure.int.test.ts`),
T-054 (`packages/resilience/test/t054-bounds.test.ts`, `apps/kite-broker/test/t054-load-rate-cost-bounds.int.test.ts`,
`apps/api/test/t055-api-observability.test.ts`), T-055 (`packages/observability/test/t055-*.test.ts`,
`apps/kite-broker/test/t055-end-to-end-trace.int.test.ts`), T-056 (`apps/kite-broker/test/t056-*.int.test.ts`),
deferred items (`packages/data/test/m13-*.test.ts`), tooling and coverage (`tests/m13/*.test.ts`). Real IdP, deployed
network policy, storage/backup encryption, production load and SLOs, real providers/payments and physical recovery
remain NOT_RUN.

## Rollback or replacement

Code: revert the M13 commits; the packages are additive. Migrations are forward-only: to relax the erasure guards ship a
new migration restoring `ub_forbid_mutation` triggers (erased rows stay erased — tombstones and audit remain the legal
record); to remove SoD guards ship a migration dropping the two triggers (proposal and revision columns stay, unused).
Ledger records written by M13 are append-only evidence and stay.
