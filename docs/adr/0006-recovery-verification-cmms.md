# ADR 0006 — Recovery evaluation, observation boundary and CMMS replay model (M11)

Status: accepted (M11, 2026-11-05)

## Context

M11 owns FR-14..FR-17, INV-01, INV-02, INV-03 and INV-14 (T-045..T-048). M04 made `RECOVERED` reachable only through
a non-exported hook (`packages/incidents/src/recovery.ts`, `recoverIncidentWithEvaluation`) that requires a PASSED
evaluation from a `RecoveryEvaluator`. M10 emits `purchase_order.state_changed.v1` / `service_job.state_changed.v1`
with null raw evidence (the order view holds it). No real CMMS, physical sensor or recovered asset exists here.

## Decisions

1. **The only path to RECOVERED is `packages/recovery/src/closeout.ts`.** It is the single production importer of
   M04's hook (relative import of a module the `@uptimebuyer/incidents` export map hides; an ESLint
   `no-restricted-imports` pattern forbids it everywhere else, and a structural test scans every workspace source).
   It passes a module-private evaluator; nothing exported from `@uptimebuyer/recovery` accepts an evaluator.
   Inside the hook's transaction (M04 has locked the incident `FOR UPDATE`, honoured its Idempotency-Key and
   compare-and-set the version) the evaluator re-derives the binding, re-runs every gate under lock, pins the exact
   samples and signoffs, moves the evaluation `OBSERVING → PASSED`, writes the one closeout (complete manifest,
   HMAC-signed decision), the `RECOVERY_DECISION` ledger entry, `recovery.assessed.v1` / `incident.recovered.v1` and
   the CMMS closeout update; M04 then commits `VERIFYING → RECOVERED` with the evaluation id as guard reference. A
   deferred constraint trigger refuses to commit a closeout without that transition. Concurrent assessors serialize on
   the incident row; losers re-read and report the one closeout.
2. **Evidence model.** Every record keeps source identity, trust label, occurred and observed times. Source and trust
   are fixed by kind in SQL: only a verified CMMS record (`VERIFIED_CMMS`, from an INTEGRATION principal bound to the
   incident's site, HMAC over the exact raw bytes with a 300 s tolerance) or an authorized-operator attestation
   (`OPERATOR_ATTESTED`, attester user id + role stored, role named by the policy and still held) can back a
   milestone or signoff. Provider completion, receipts, model assertions and free text are stored with
   `PROVIDER_REPORTED` / `MODEL_PROPOSED` / `UNATTESTED` and refused by kind. Authority-capable rows carry an HMAC seal
   from the runtime recovery keyring; rows forged in the database never verify.
3. **Intervention milestone and observation boundary.** A milestone is created only from undisputed, sealed,
   authorized evidence of an approved live action (an M10 order/job of the incident's EXECUTING/COMPLETED M08 plan),
   of the policy-designated completion type, for the incident's asset revision and recovery cycle, with
   `occurred_at` within the policy's future-skew and backdate bounds of `observed_at` and not before the cycle entered
   EXECUTING. It pins the recovery-policy revision in force for the incident's scope (site over tenant) at the
   observed time and is signed. `observation_boundary_at` is its millisecond-normalized `occurred_at`; the database
   refuses any other boundary. The binding milestone is the newest one whose signature and source seal verify and
   whose authority (CMMS integration / attester role) is still live.
4. **Evaluation and revision semantics.** One open evaluation per incident, one PASSED per recovery cycle. It pins
   incident, asset revision, cycle, plan/action digest, evidence revision, the milestone's policy revision (its stable
   window and `expires_at = boundary + max observation`), rule revision and the exact open assignment/channel
   revisions. A change of any of these supersedes the open evaluation (`FAILED`, `*_SUPERSEDED`) and opens a new one;
   a revoked binding or disputed evidence fails it and escalates; passing the observation limit EXPIRES it and
   escalates. Decided evaluations and closeouts are never rewritten: a later policy revision only governs later
   milestones.
5. **Stable window.** Per pinned channel, the trailing run of qualifying samples (exact pinned revisions, `LIVE` and
   live-delivered, flag-free, physical unless allowed, in the incident rule's safe range with hysteresis, not linked to
   a sibling incident) strictly after the boundary, no gap above policy, spanning at least
   `max(policy window, rule recovery window)` with enough samples and a tail no older than policy at the evaluation
   instant. Any disqualifying sample resets the run, so backfill followed by a fresh tail cannot pass. The instant is
   the database clock or a later `asOf` at most 1 h ahead (it can only make freshness stricter). The database refuses
   to pin a non-qualifying sample.
6. **Gates.** Policy-required signoffs (`CMMS_WORK_ORDER` from an active site integration, `OPERATOR_ATTESTATION` from
   a live policy role), occurred at/after the boundary; when required, the exact installed part (manufacturer + MPN of
   the approved action's candidate, serial present) from verified CMMS or attested evidence, with conflicting claims
   failing closed unless a CMMS correction links the superseded record; the part's purchase order `VERIFIED`. The
   PASSED database guard re-checks samples, every required signoff, disputes, CMMS revocation and attester
   role/membership under locks.
7. **Reopen/escalate.** Disputes commit first, then their effect (escalate, or reopen through M04's operator command),
   and the receipt only after the effect is durable; replays re-derive the effect. Lost signal inside the pinned watch
   window reopens through M04's new engine command `reopenRecoveredIncident`. M04's own recurrence reopen is linked
   from `incident.reopened.v1`. Closeouts get a one-shot reopen stamp and a CMMS REOPEN update; metrics count a closeout
   whose incident reopened as `reopened`, never `stable`. `getRecoveryGate` is the single answer to "may
   completion-dependent value be released" and fails closed on disputed pinned evidence.
8. **CMMS replay model.** Every work-order update (CLOSEOUT, REOPEN, ORDER_FACT, JOB_FACT) is a row keyed by a
   deterministic idempotency key, written in the same transaction as its fact; order/job facts are consumed once per
   event and read from the M10 order view. Workers claim due rows `FOR UPDATE SKIP LOCKED` under a lease, stamp the
   durable send marker before egress, and record the EXTERNAL_ACTION outcome (guarded by M09's
   `ub_external_outcome_edge_ok`). A row with a marker but no outcome, or UNKNOWN, is resolved by lookup under the same
   key before any resend. An adapter without credentials is `UNSUPPORTED` (pre-egress) and nothing is claimed as sent.
   The contract fake is labelled `CONTRACT_FAKE`; the HTTPS adapter is environment-gated (`UB_CMMS_BASE_URL` https +
   `UB_CMMS_TOKEN`) and has never contacted a CMMS.

## Lock order

Global order: planning advisory lock → execution authority → commercial intent → order/job row (M09/M10) → incident row
(`FOR UPDATE`, M04 commands and the hook) → recovery evaluation (`FOR UPDATE`) → pinned evidence rows (`FOR UPDATE`,
PASSED guard) → CMMS integrations, attester role assignments and memberships (`FOR SHARE`, PASSED guard). Disputes
take incident → open evaluation before inserting the dispute (whose FK key-share on the evidence row conflicts with
the PASSED guard's lock). Revocation of a CMMS integration, a role or a membership updates the share-locked row.
M11 never locks planning, authority, intent or order rows. CMMS writer leases use `SKIP LOCKED` and wait on nothing.

## Consequences

- Recovery cannot be reached by provider completion, receipts, model output, unattested text, transient readings,
  forged rows or stale/backfilled telemetry; T-045..T-048 and the structural test prove it at code and database level.
- The M04 incident table itself has no database trigger requiring a closeout for `RECOVERED` (M04's tests drive the hook
  with a test-only fake evaluator); the guarantee rests on the non-exported hook, the lint boundary, the structural
  test and the closeout commit guard. Raw SQL by the database owner remains out of scope.
- Real CMMS writes, physical sensors and physical recovery are `NOT_RUN`.
