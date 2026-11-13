# ADR 0003 — Exclusive Kite payment broker (M09)

Status: accepted (M09, 2026-11-05)

## Context

M09 owns FR-10/11/12/21 and INV-05..INV-08, INV-12, INV-13, INV-15: bounded execution authorities, a separately
deployable broker that alone holds the Kite credential and paid egress, economic intents with both conservation
equations, and honest UNKNOWN reconciliation. No Kite account, credential or authorization exists here (ADR 0001
decision 9). F0 (`spikes/f0/F0-REPORT.md`) proved a local process-level boundary: credential on an fd pipe, mTLS-pinned
LOCAL_STAND_IN, 0600 unix socket, signed credential-free envelopes.

## Decisions

1. **Two units.** `@uptimebuyer/commerce` (credential-free, importable): plan-action approval binding, idempotent
   authority issuance, lifecycle, budget adjustments, intent creation, views, execution references and the
   `KiteBrokerPort` client. `apps/kite-broker` (`@uptimebuyer/kite-broker`, exports only its manifest): the socket
   server, linearization, reconciliation, the secret loader and every credential-bearing adapter. ESLint
   `no-restricted-imports` plus a T-039 test forbid importing it anywhere else.
2. **Isolation mechanism (reuses F0).** The broker process receives one JSON secret document on an inherited fd (or a
   0600 file owned by its uid): database URL, reference HMAC keyring, authority Ed25519 public keys, compatibility
   keyring and the adapter credential. Never env, argv or logs (a scrubbing logger registers every secret). Ingress is
   node:http on a unix socket created 0600 inside a 0700 directory; the body is exactly one strict
   `SignedExecutionReference` (EXECUTION_AUTHORITY or COMMERCIAL_INTENT), ≤ 4 KiB. Any extra field is refused before
   any lookup. The LOCAL_STAND_IN adapter pins the server certificate fingerprint, presents the broker client
   certificate and a bearer capability, uses `agent: false`, ignores proxies and follows no redirects; its base URL
   must be loopback HTTPS. Same-uid limits from F0 still apply; production network policy and a distinct workload
   identity remain `NOT_RUN`.
3. **Signatures.** Authority scopes are canonicalized and signed with **Ed25519** by the issuing workload; the broker
   holds only public keys and re-verifies at session activation and at every linearization. Execution references are
   the M01 HMAC-SHA256 references (shared key between reference issuers and the broker), 5-minute TTL, and every nonce
   is recorded in `broker_reference_uses`: a replayed reference acts at most once per operation.
4. **Database is the authority (migration 0016).** Guards UB091–UB099 bind an authority to its paid PLAN_ACTION
   approval, an intent to its active authority, an attempt to its reserving intent; one attempt per intent ever; one
   RESERVE per intent; the partial unique index `(tenant_id, action_digest) WHERE state <> 'FAILED'`. The ledger
   AFTER-INSERT trigger is the only writer of account, intent and capture projections (direct updates are refused) and
   enforces gross-cap, net-settlement and per-capture equations; a deferred constraint trigger requires reserve and
   SEND_STARTED to commit together. Row locks use `FOR NO KEY UPDATE` so foreign-key share locks from child inserts
   cannot deadlock with the lifecycle locks (found by T-038's concurrency test).
5. **Linearization.** Planning advisory lock (serializes with M08 invalidation) → authority → intent; reverify
   signature, lifecycle/expiry, session `CONFIRMED`, approval executable, subject digest recomputed from stored facts,
   merchant/purpose/amount/kind, asset/evidence/policy currency, current broker-owned provider revision, the M06
   `assertDecisionExecutableInTx` gate, adapter capability and available gross authority; then RESERVE + RESERVED +
   SEND_STARTED (+ plan APPROVED→EXECUTING) in one commit. Transient holds (suspended, session not confirmed,
   insufficient authority) leave the intent CREATED; permanent invalidity makes it definite-no-effect FAILED.
6. **Approval binding.** An M09 plan-action approval is the M02 `recordApproval` of exactly the M08-prepared scope,
   bound to its request under the planning lock. Approvals are not `CONSUMED` at issuance, so M06/M08 invalidation still
   blocks new reserves; in-flight effects keep reconciling.
7. **Budget model.** One account per authority (one action digest per authority, so per-action = subject amount and
   aggregate = approval maximum). A `BUDGET_ADJUSTMENT` approval signs `budget-adjustment.v1` over authority, direction
   and amount in its `action_digest` and is applied once as AUTHORITY_CREDIT/DEBIT. Refunds never raise availability.
8. **Reconciliation.** `REQUESTED` is written only from an observed handoff (`finish` of the request / CLI spawn).
   A crash after SEND_STARTED is reconstructed `UNKNOWN` after the send lease lapses (`sendLeaseMs ≥ adapter timeout +
1 s` in production). UNKNOWN resolves only by lookup by the pre-egress key or provider-guaranteed same-key replay
   (request digest re-proved); otherwise capability becomes UNSUPPORTED, the reservation stays, and only a finance
   approver's `resolveUnknownIntentManually` (citing an evidence digest) may release or capture.
9. **Adapter outcome type.** The broker uses its own normalized `AdapterOutcome` (raw status + raw-response digest)
   rather than `ExternalOutcomeResultSchema`, whose `EvidenceRef` requires an M05 blob id that payment observations do
   not have yet; receipts store digests in `external_receipts`, kept separate from fulfillment.

## Kite Passport: what the real adapter does and what is unverified

Public sources read 2026-11-05: `docs.gokite.ai` (`llms/api-reference.txt`, `llms/changelog.txt`, CLI and service
provider guides) and `github.com/gokite-ai/passport-skills` (README, `docs/reference.md`, skill `SKILL.md` and
`references/commands.md`). `gokite-ai/passport-web` is not public; `gokite-ai/developer-docs` is marked deprecated.

- **Verified from source:** Kite publishes **no public HTTP API reference**; agents use the `kpass` CLI. Sessions:
  `kpass session create --delegation '<json>' --separate --output json` → `human_action_required` + `request_id`;
  `kpass session status --request-id … --wait` → `session.status: active`. Delegation fields
  `payment_policy.max_amount_per_tx`, `max_total_amount`, `ttl_seconds`, `currency`. Payment:
  `kpass session execute --url --method --body --idempotency-key --output json` (x402 negotiated by Kite; the key is
  forwarded as `Idempotency-Key`); `payment_outcome_pending` (exit 7) asks for a same-key retry. Kite enforces
  per-transaction, total and TTL limits and a merchant allowlist. No client webhooks; no x402 refund.
- **The adapter (`apps/kite-broker/src/adapters/kite-passport.ts`)** runs exactly those commands with an argument
  vector (no shell), a broker-only `HOME` state root (where `kpass` keeps its JWT/agent token/session key), a minimal
  environment, timeout and output cap. It is constructed only from explicit `KITE_PASSPORT` secret configuration;
  otherwise the broker uses `UnconfiguredAdapter` (UNSUPPORTED, no I/O). Every payment is bound to the authority's
  own session: the adapter resolves the stored approval request id with `kpass session status --request-id`, refuses
  (nothing sent) unless that session is active, and passes `--session-id` (without it kpass pays from its "current"
  session or the account allowance). The delegation `ttl_seconds` is the authority's remaining lifetime computed from
  the PostgreSQL clock; under 60 s the activation is refused before egress.
- **Replay and refusals (review fixes):** same-key replay runs the same `assertExecutionPreconditionsInTx` gate as
  linearization under the authority lock and is refused (UNKNOWN, reserved, manual) when anything is no longer current;
  a not-sent adapter refusal counts as no-effect proof only on a first send that was never handed off.
- **Unverified / assumed (as of M09; see "Live wiring" below for what kpass 6.13.2 settled):** the wire auth header and token format; the default production API host; whether a lost
  `session create` response can be found again (no client key is accepted, so it is reconciled only by `request_id`,
  else manual); whether same-key retry of `session execute` is a provider guarantee for every outcome (the docs say
  `wallet send` keys are "accepted but not yet de-duplicated") — therefore `sameKeyReplayVerified` defaults to `false`
  and autonomous paid execution is **UNSUPPORTED**; there is **no documented payment lookup by client key**
  (`lookup` always returns RECONCILIATION_UNSUPPORTED); reading `payment_requirement.amount` as minor units of the
  session currency; settlement asset/decimals (USDC 6 decimals vs USD cents); whether exit 6 policy refusals are
  definite no-effect (treated as UNKNOWN); treating CLI spawn as the handoff point. Live catalog, a real capped payment,
  a forced timeout and its reconciliation, receipts, refunds and insufficient-funds behaviour are all `NOT_RUN`.

## Live wiring: kpass 6.13.2 and the first bounded payment (T-058, 2026-11-13)

Sources read 2026-11-13 (Kite's installed skills, kpass 6.13.2): `request-session` (SKILL.md, `references/commands.md`,
`examples.md`), `x402-execute` (SKILL.md, `references/commands.md`, `examples.md`), `form-session-delegation`
(SKILL.md, `references/delegation-schema.md`), `kite-passport` SKILL.md, and `kpass --help`, `session create --help`,
`session execute --help`, `session status --help`. Contract tests use **documented-example** fixtures copied from those
docs (`apps/kite-broker/test/fixtures/kpass-6.13.2-documented.ts`), never real responses.

- **Session create** (verified): `kpass session create --delegation <json> --separate --no-reuse --no-browser
--no-interactive --output json`. The delegation is the inner object only: `task.summary` (one reviewable sentence,
  at most 80 characters; here `UptimeBuyer: <purpose> via <host>`), `payment_policy.max_amount_per_tx`,
  `max_total_amount` (decimal strings of the budget currency), `ttl_seconds` (the authority's remaining lifetime from the
  database clock), `currency`; `execution_constraints.x402` scoped to the endpoint (recorded by Kite, not enforced on
  paid calls, so the broker binds the URL itself); `routing_enabled: false` (same-chain only, no bridge or swap cost).
  `--no-reuse` stops the `reuse_available` answer; `--no-browser` keeps the approval page out of the broker. Answer:
  `status: human_action_required`, `request_id` (`req_...`), `approval_url`, `expires_at`. The approval link reaches only
  an operator callback (and only when it is https on `agentpassport.ai`); it is never stored, logged or exported.
- **Session status** (verified): `kpass session status --request-id <req> --no-interactive --output json`.
  `status: pending` (exit 0) -> ACCEPTED; `status: success` with `session.status: active` -> CONFIRMED (`session.id`,
  `session.expires_at`, `session.delegation.payment_policy`, `session.usage.spent_total`); exit 3 "rejected by the user"
  / "expired before approval" -> FAILED (no session exists); an answer naming another `request_id` is never taken for
  the bound one; anything else UNKNOWN.
- **Session execute** (verified): `kpass session execute --session-id <the authority's own session> --url <exact
allowlisted URL> --method GET --idempotency-key <pre-egress key> --no-browser --no-interactive --output json`. GET query
  parameters are in the bound URL; no `--body`, `--headers` or internal identifier reaches the merchant (the previous
  adapter sent a JSON body with the client operation id). Never `--use-allowance`. Before the paid command the bound
  session is re-read and must be active, unexpired and capped inside the hard caps. Success is exit 0, `status:
success`, `session_id` equal to the bound session, no `source: allowance`, `x402.status_code` 2xx,
  `payment_requirement.asset` USDC, `x402.chain_id` 8453 when present, and `payment_requirement.amount` a decimal of the
  budget currency (`"0.01"`), converted exactly to minor units (the previous adapter read it as minor units: fixed); the
  settlement reference is `payment.payment_response.reference`. Anything else after the spawn is UNKNOWN, except the
  documented pre-spend codes with their documented exit codes (`idempotency_key_required`, `no_payment_requirement`,
  `merchant_unsupported` and the routing rejections (2), `provider_unavailable` (1), `allowance_unavailable` (4),
  `wallet_empty` and `separate_session_used_up` (6)), which are not-sent refusals for that invocation only. Exit 7
  (`payment_outcome_pending`, `merchant_failed_held`), `payment_settled_unfulfilled`, policy refusals and every
  undocumented exit (the previous adapter treated an undocumented exit 8 as no-effect: fixed) stay UNKNOWN.
- **Same-key replay:** the docs say to reuse the same key and identical request for a transport retry and that a
  pending outcome retried with the same key charges nothing new, but they describe that for the account allowance and
  recurring payments and never promise the original result for a same-key replay of a separate-session payment
  (`x402-execute` SKILL.md "Recurring and shared allowance payments"; `--idempotency-key` help: "reuse with identical
  input when retrying a recurring payment"). So `sameKeyReplayVerified` stays **false**, and the journey's duplicate is
  the product's own protection: the identical intent request returns the existing intent and the broker sends nothing.
- **Attended execution without autonomous reconciliation:** Kite has no payment lookup by client key and no verified
  replay, so autonomous reconciliation stays UNSUPPORTED. Paid execution is allowed only when the adapter file sets
  `manualReconciliationAccepted: true`: an ambiguous outcome is UNKNOWN, the attempt's capability becomes UNSUPPORTED,
  the reservation stays for a finance approver's manual resolution, and nothing is retried (not by a duplicate, not by
  reconciliation, not by the sweep).
- **Hard caps in code:** `KITE_HARD_CAPS` = 1 cent per call and 5 cents per session (USD), whatever an authority or the
  configuration says; activation, assessment, execution and the re-read session caps all enforce them. The journey's
  authority has a per-action limit of 1 cent and a base limit of 1 cent (the base limit is the approval maximum, which
  is the action amount; decision 7), so the Kite session is capped at 0.01 per call and 0.01 in total, stricter than
  the approved 0.05 total.
- **State isolation:** kpass keeps its login, agent token and session keys in `.kite-passport/`. kpass 6.13.2 looks for
  a project-level `.kite-passport` by walking up from its working directory before falling back to `$HOME` (observed
  2026-11-13); a state root without its own directory under the user's home therefore resolved to the user's
  interactive login. The adapter runs kpass with cwd and HOME at the state root and only when
  `<stateRoot>/.kite-passport` is a private directory of this user (security review S4). The adapter file
  (`uptimebuyer-kite-broker-adapter.v1`, example in `apps/kite-broker/config/`) is a 0600 file outside the repository
  holding paths and policy only, never a credential.
- **Timeouts:** execute uses the configured timeout (300 s; kpass documents a 5-minute execution timeout and the broker's
  send lease is longer); session create/status and the readiness reads use 30 s. A timed-out or killed kpass is UNKNOWN.
- **The journey** (`apps/kite-broker/test/support/journey-kite-payment.ts`, library `kite-payment-journey.ts`): hard
  stops before any egress, the M08/M09 world, the PAYMENT release gate, the bounded passkey wait, one paid call, the
  duplicate, reconciliation, redacted evidence, the manifest and the journey gate. The paid lookup is modelled as a
  DIAGNOSTIC_SERVICE candidate priced by an operator-entered DIAGNOSTIC_VISIT quote carrying the merchant's 402 price:
  the cost-to-recovery planner cannot price a PAID_CONTACT candidate (no quote scope), so such a plan is always
  INCOMPLETE. The incident is opened by a labelled SIMULATOR device (the sensor part stays NOT_RUN).
- **The timeout part stays NOT_RUN:** Kite documents no lookup by client key, so an injected timeout after egress could
  only be resolved manually; it is not attempted.
- **Still unverified:** whether Kite ever settles above the session caps; whether a lost `session create` answer can be
  found again (it is reconciled only by `request_id`, else manual); the exact refund behaviour (x402 has none); the
  backend's behaviour when kpass is killed mid-payment. The real payment itself is NOT_RUN until the operator's live run.

## Consequences

All M09 tests use the LOCAL_STAND_IN HTTPS endpoint (separate process) or the in-memory RECORDED_CONTRACT adapter, both
labelled in `external_attempts.result_origin`; neither is Kite. `issueBrokerWorkerContext` (M02 data, additive) lets the
broker act in the signed reference's tenant with worker-only permissions; any importer of `@uptimebuyer/data` could
call it (same strength as the outbox/job worker contexts). `provider_contact_attempts.commercial_intent_id` has no
foreign key to `commercial_intents` because M07's contract-fake tests insert fake intent ids.
