# UptimeBuyer State Machines

Status: `SPECIFICATION_ONLY`

State transitions are persisted through version-checked domain commands. Jobs may request a transition; only the domain layer validates and commits it. Unknown external outcomes remain explicit.

## 1. Incident

```text
DETECTED -> TRIAGING -> AWAITING_EVIDENCE -> PLANNING
    |           |              |                 |
    |           +--------------+-----------------+----> ESCALATED | PAUSED
    |                                                
    +-----------------------------------------------> ESCALATED

PLANNING -> AWAITING_APPROVAL -> EXECUTING -> VERIFYING -> RECOVERED
                 |                 |             |             |
                 +-----------------+-------------+-> ESCALATED  +-> REOPENED -> TRIAGING

AWAITING_APPROVAL -> PLANNING   (pre-egress invalidation only; otherwise ESCALATED)

ESCALATED -> TRIAGING | AWAITING_EVIDENCE | PLANNING
PAUSED -> TRIAGING | AWAITING_EVIDENCE | PLANNING | AWAITING_APPROVAL | EXECUTING | VERIFYING
```

| From | To | Guard |
|---|---|---|
| `DETECTED` | `TRIAGING` | incident and source telemetry persisted |
| `TRIAGING` | `AWAITING_EVIDENCE` | required identity/evidence is not yet sufficient |
| `TRIAGING/AWAITING_EVIDENCE` | `PLANNING` | current evidence revision is sufficient to evaluate candidates |
| `PLANNING` | `AWAITING_APPROVAL` | at least one allowable action and valid current pricing |
| `AWAITING_APPROVAL` | `EXECUTING` | signed approval covers exact plan hash and budget |
| `AWAITING_APPROVAL` | `PLANNING` | the plan or an unexecuted approval is invalidated by a revision, price, expiry or policy change before any reserve-plus-`SEND_STARTED` linearization; no possible in-flight effect exists |
| `EXECUTING` | `VERIFYING` | intended work/fulfillment reports completion; payment may still reconcile |
| `VERIFYING` | `RECOVERED` | stable sensor window and configured sign-off satisfied |
| any active | `ESCALATED` | safety hold, deadline, repeated failure, recovery evaluation `FAILED` or `EXPIRED`, invalidation after possible egress, no allowable action, or manual command |
| `TRIAGING/AWAITING_EVIDENCE/PLANNING/AWAITING_APPROVAL/EXECUTING/VERIFYING` | `PAUSED` | authorized operator pauses execution without discarding state and records the resumable prior state |
| `ESCALATED` | `TRIAGING/AWAITING_EVIDENCE/PLANNING` | the tenant-scoped current assignment is accepted through compare-and-set and a revision-bound next path exists |
| `PAUSED` | prior legal active state | accepted current owner authorizes resume and revalidates evidence, policy, approval, expiry, deadline status, and every in-flight effect before work continues |
| `RECOVERED` | `REOPENED` | recurrence, invalid recovery evidence, or approved investigation |
| `REOPENED` | `TRIAGING` | new evidence revision created |

An unsuccessful provider, purchase, diagnosis, or intervention does not terminate a live refrigeration risk as `FAILED`; it moves the incident to `ESCALATED` or `PAUSED` (or, only before possible egress, `AWAITING_APPROVAL → PLANNING`) while preserving the failed child action. A stable-window regression during `VERIFYING` resets the recovery evaluation; it never reopens an incident that has not reached `RECOVERED`. `RECOVERED` cannot be reached from provider self-report, model output, or stale telemetry (INV-01, INV-11, INV-14). Recovery is the canonical successful terminal state; records are retained rather than moved to a separate `CLOSED` state.

Incident opening pins the immutable tenant procedure revision, timezone/basis digest, original SOP response/containment deadline, and initial assignment. Deadline pause/resume/shorten/extension events and assignment/handoff/acceptance events are append-only and serialize through the incident version; procedure publication or concurrent reassignment cannot silently move the deadline or owner.

## 2. Evidence revision

```text
DRAFT -> VALIDATING -> COMMITTED
   |          |
   +-------> REJECTED

COMMITTED --new input--> a new DRAFT revision
```

A committed revision is immutable. Its manifest contains source digests and citation locators. Any material change creates a higher revision and invalidates prior plans whose inputs are no longer current (INV-03, INV-10).

## 3. Compatibility decision

```text
decision (immutable row per evaluated tuple): ALLOW | HOLD | REJECT
lifecycle (separate column): CURRENT -> SUPERSEDED

HOLD --new evidence revision (e.g. recorded named-engineer approval)--> new decision row: ALLOW | HOLD | REJECT
```

A decision row is never edited. Resolving a `HOLD` records the missing evidence or named-engineer approval as a new evidence revision and evaluates a new tuple; the prior row becomes `SUPERSEDED` in the lifecycle column. `UNEVALUATED` is the absence of a row, not a decision value.

`HOLD` reasons include unresolved asset identity, missing exact MPN, conflicting manuals, unsupported substitute, safety classification, missing certification, stale price/stock, or named approval required. Model confidence never changes `HOLD` to `ALLOW` (INV-02, INV-04, INV-15).

## 4. Recovery plan

```text
DRAFT -> EVALUATED -> APPROVABLE -> APPROVED -> EXECUTING -> COMPLETED
                   \-> HELD       \-> REJECTED
DRAFT/EVALUATED/APPROVABLE/APPROVED --revision/expiry/policy change--> INVALIDATED
EXECUTING --revision/expiry/policy change--> INVALIDATED + IN_FLIGHT_RECONCILIATION
```

Approval covers the plan hash, asset/evidence/policy revisions, action digest, actor, scope, maximum, currency, and expiry. It cannot float to a regenerated plan.

The linearization point is the transaction that reloads and locks the existing immutable `CREATED` intent, validates current authority, reserves budget, and commits the attempt's pre-egress `SEND_STARTED` marker. An invalidation that wins before this transaction moves the intent to definite-no-effect `FAILED` and blocks egress. An invalidation that commits after it prevents additional actions but cannot erase or blindly retry an external effect that may already exist: the intent remains reserved and reconciles to authoritative outcome, cancellation is attempted only when the adapter proves it safe, and the incident moves to `ESCALATED`, which re-enters planning after revalidation around the observed result. Approval revocation, policy/evidence revision, and price/stock change commands serialize against this transaction.

## 5. Execution authority and Kite session

Local bounded authority and external Kite-session activation are separate axes.

```text
Authority: ACTIVE -> SUSPENDED -> ACTIVE
           ACTIVE/SUSPENDED -> REVOKED | EXPIRED

Kite session: PROPOSED -> AUTHORIZED -> REQUESTED -> ACCEPTED -> CONFIRMED
                              |             |            |
                              |             |            +-> FAILED | CANCELLED
                              |             +-> FAILED | CANCELLED (definitive synchronous decline)
                              +-------------+------------+-> UNKNOWN -> ACCEPTED | CONFIRMED | FAILED | CANCELLED
Capability: ELIGIBLE | UNSUPPORTED (separate pre-egress/diagnostic axis)
```

Idempotent issuance creates one immutable authority per approval with signed incident, asset/evidence/policy/plan/action revisions, exact provider-account revision, merchant/service, purpose, allowed actions, per-action/aggregate limits, currency and expiry. `ACTIVE` means the local authority has not been suspended, revoked or expired; it does not imply that Kite created a session. A paid intent may reserve only when the local state is `ACTIVE` and the separate Kite-session outcome is `CONFIRMED`.

The session operation has its own pre-egress operation/idempotency identity and the same transport/outcome/capability separation as every external attempt. An optional provider session reference is evidence, not the authority identity. A session timeout remains `UNKNOWN` until authoritative lookup or provider-guaranteed same-key replay resolves it. If that recovery capability is absent, the session effect stays `UNKNOWN` for manual resolution while adapter capability becomes `UNSUPPORTED`; it is never converted to failure merely because automation cannot continue.

Revocation, suspension or expiry serializes with intent reservation. A local-state change that wins first blocks new reserves. It never erases, releases or relabels an already possible in-flight effect; that effect and the provider session continue through reconciliation under their pinned historical authority/account revisions.

## 6. Economic intent

```text
CREATED -> RESERVED -> SUBMITTED -> CONFIRMED -> REFUNDED | REVERSED
    |         |            |   |
    |         +-> UNKNOWN <-+   +-> FAILED (authoritative decline/cancel before capture + atomic RELEASE)
    |         |      |
    |         |      +-> SUBMITTED | CONFIRMED | FAILED | REVERSED | REFUNDED
    +---------+-> FAILED (only with definite proof that no reserve/egress effect remains)
```

Rules:

- `CREATED -> FAILED` is required when broker revalidation proves approval/revision/price/policy invalid before any reservation or egress; `RESERVED -> FAILED` requires atomic release plus definite proof that no external effect began.
- Before network I/O, persist a separate attempt marker `SEND_STARTED` with the client-generated operation ID, idempotency key, request digest, and reserved intent; the economic intent remains `RESERVED`.
- When the request is actually handed to the adapter/network boundary, normalized external outcome becomes `REQUESTED` while economic state remains `RESERVED`. A crash after durable `SEND_STARTED` but before durable `REQUESTED` reconstructs `UNKNOWN`, not `REQUESTED` or `FAILED`.
- Move the economic intent to `SUBMITTED` only after the provider/Kite boundary authoritatively acknowledges the request. If the process dies or loses the response after `SEND_STARTED` while the intent is still `RESERVED`, it transitions `RESERVED -> UNKNOWN` rather than assuming no send; ambiguity after acknowledgement transitions `SUBMITTED -> UNKNOWN`.
- Timeout/connection loss becomes `UNKNOWN`, never immediate retry with a new key.
- Only authoritative lookup/webhook by provider reference or the pre-egress client operation/idempotency key can resolve ambiguous effect. An accepted-but-not-confirmed observation moves `UNKNOWN -> SUBMITTED`; it does not jump to confirmation.
- Reserved budget remains bounded while unknown; authorized manual review may release it only after evidence that no effect occurred.
- `SUBMITTED -> FAILED` and `UNKNOWN -> FAILED` require authoritative provider evidence that no economic effect exists (for example a decline or a cancellation before capture) and atomically append `RELEASE` for the open reservation.
- A `REFUNDED` or `REVERSED` intent had an economic effect, so it blocks a successor for the same action digest; buying the same item again requires a new evidence or plan revision (and therefore a new action digest).
- `UNKNOWN -> REFUNDED | REVERSED` is legal only when the same reconciliation transaction first appends the proved `CAPTURE` movement and then the `REFUND`/`REVERSAL` that references it, so the per-capture equation is never bypassed.
- A partial refund is an append-only ledger movement while the intent remains `CONFIRMED`; the projection exposes returned and net-settled amounts. Full refund/reversal may move it to `REFUNDED`/`REVERSED`. Duplicate or concurrent refund events are idempotent.
- Confirmation, release, reversal, and refund must satisfy both gross authority and net-settlement conservation; confirmed amount cannot exceed reservation (INV-05, INV-07, INV-08).

Attempt transport states are `PREPARED -> SEND_STARTED -> ACKNOWLEDGED | UNKNOWN | DEFINITE_NO_EFFECT`. They are not aliases for the economic-intent state or normalized external outcome. An adapter without authoritative lookup by a reference available before egress, and without provider-enforced same-key idempotent execution, cannot autonomously resolve `SEND_STARTED`; its adapter capability becomes `UNSUPPORTED` and routes to manual review, while the transport/external/economic effect remains `UNKNOWN` and reserved.

A terminal pre-egress `FAILED` intent and its execution-authority identity are immutable. A later approval cannot rebind or revive it. The semantic action digest stays stable; fresh authority may create a successor intent with a new authority/operation identity only after every prior intent for that action has terminal definite-no-effect proof. The prior intent remains linked as superseded evidence. Any prior reserved, send-started, submitted, unknown, confirmed, refundable, or otherwise possibly effective intent blocks a successor.

## 7. External action

```text
PROPOSED -> AUTHORIZED -> REQUESTED -> ACCEPTED -> CONFIRMED
                 |             |           |
                 |             |           +-> FAILED | CANCELLED
                 |             +-> FAILED | CANCELLED (definitive synchronous decline)
                 +-------------+-----------+-> UNKNOWN -> ACCEPTED | CONFIRMED | FAILED | CANCELLED
Capability: ELIGIBLE | UNSUPPORTED (separate axis)
```

`AUTHORIZED -> UNKNOWN` is the reconstruction after a crash between the durable `SEND_STARTED` marker and observed handoff; it never fabricates `REQUESTED`. `ACCEPTED -> UNKNOWN` covers ambiguity after acknowledgement. `REQUESTED` proves only that the request was sent. `ACCEPTED` proves only provider acknowledgement and is the prerequisite for economic `SUBMITTED`. `CONFIRMED` requires authoritative evidence for the exact external action and still does not prove equipment recovery (INV-12, INV-14). `UNSUPPORTED` is legal only before possible egress as a capability/policy result. If reconciliation capability is discovered to be absent after possible egress, the adapter-capability axis becomes `UNSUPPORTED` but the action remains `UNKNOWN` and reserved for manual resolution.

## 8. Purchase order

```text
REQUESTED -> ACCEPTED -> ORDERED -> SHIPPED -> DELIVERED -> VERIFIED | DISPUTED
    |           |          |          |            |
    +----------> REJECTED  +---------> PARTIALLY_FILLED
                CANCELLED             SUBSTITUTION_PROPOSED
                FAILED                CHANGE_REVIEW
                UNKNOWN               CANCELLED | FAILED | UNKNOWN
```

`PARTIALLY_FILLED`, `SUBSTITUTION_PROPOSED`, and material quantity/price/ETA `CHANGE_REVIEW` are explicit states, not notes. They block installation/verification, invalidate the affected plan action, and move the incident to `ESCALATED`, which re-enters evaluation after revalidation. A newly approved substitute creates a new action/order lineage; it does not mutate the old order into approved fulfillment. Delivery/verification is fulfillment evidence, not equipment recovery.

| From | Allowed purchase transitions |
|---|---|
| `REQUESTED` | `ACCEPTED`, `REJECTED`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `UNKNOWN` | `ACCEPTED`, `REJECTED`, `ORDERED`, `PARTIALLY_FILLED`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `FAILED` only from reconciliation evidence |
| `ACCEPTED` | `ORDERED`, `SUBSTITUTION_PROPOSED`, `CHANGE_REVIEW`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `ORDERED` | `PARTIALLY_FILLED`, `SHIPPED`, `SUBSTITUTION_PROPOSED`, `CHANGE_REVIEW`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `PARTIALLY_FILLED` | `SHIPPED`, `DELIVERED`, `SUBSTITUTION_PROPOSED`, `CHANGE_REVIEW`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `SHIPPED` | `DELIVERED`, `PARTIALLY_FILLED`, `CHANGE_REVIEW`, `FAILED`, `UNKNOWN` |
| `DELIVERED` | `VERIFIED`, `DISPUTED` |
| `SUBSTITUTION_PROPOSED/CHANGE_REVIEW` | `CANCELLED`; an accepted change creates a new revision/action lineage |

## 9. Service job

```text
REQUESTED -> ACCEPTED -> SCHEDULED -> EN_ROUTE -> ARRIVED -> IN_PROGRESS
    |           |           |            |          |           |
    +----------> REJECTED   +----------> RESCHEDULED            +-> WORK_REPORTED_COMPLETE -> VERIFIED | DISPUTED
                CANCELLED                NO_SHOW                  +-> SCOPE_CHANGE_PROPOSED
                FAILED                  CANCELLED | FAILED       +-> CANCELLED | FAILED | UNKNOWN
                UNKNOWN
```

Technician arrival is the explicit `ARRIVED` state. `RESCHEDULED`, `NO_SHOW`, provider `FAILED`, cancellation, or `SCOPE_CHANGE_PROPOSED` preserves the raw provider event, invalidates any changed scope/ETA assumption as policy requires, and moves the incident to `ESCALATED`, which re-enters planning after revalidation. `WORK_REPORTED_COMPLETE` is not recovery proof.

Purchase and service-job rows use different enum/check constraints; cross-kind transitions are invalid even if a provider uses the same raw status word.

| From | Allowed service-job transitions |
|---|---|
| `REQUESTED` | `ACCEPTED`, `REJECTED`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `UNKNOWN` | `ACCEPTED`, `REJECTED`, `SCHEDULED`, `RESCHEDULED`, `NO_SHOW`, `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`, `WORK_REPORTED_COMPLETE`, `CANCELLED`, `FAILED` only from reconciliation evidence |
| `ACCEPTED` | `SCHEDULED`, `RESCHEDULED`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `SCHEDULED/RESCHEDULED` | `SCHEDULED`, `EN_ROUTE`, `RESCHEDULED`, `NO_SHOW`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `EN_ROUTE` | `ARRIVED`, `RESCHEDULED`, `NO_SHOW`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `ARRIVED` | `IN_PROGRESS`, `SCOPE_CHANGE_PROPOSED`, `CANCELLED`, `FAILED` |
| `IN_PROGRESS` | `WORK_REPORTED_COMPLETE`, `SCOPE_CHANGE_PROPOSED`, `CANCELLED`, `FAILED`, `UNKNOWN` |
| `WORK_REPORTED_COMPLETE` | `VERIFIED`, `DISPUTED` |
| `SCOPE_CHANGE_PROPOSED` | `CANCELLED`; an accepted scope creates a new revision/action lineage |

## 10. Recovery evaluation

```text
PENDING -> OBSERVING -> PASSED | FAILED | EXPIRED
```

Each evaluation pins tenant, incident, immutable asset revision, approved plan/action digest, evidence and recovery-policy revisions, an immutable policy-designated intervention-completion milestone verified from authorized onsite/CMMS evidence, its deterministically derived `observation_boundary_at`, assignment/channel/calibration revisions, exact sample IDs/range, required signoff/installed-part records, quorum, exclusions, and continuous duration. Provider self-report alone cannot create the milestone; forged, wrong-action, wrong-timestamp, future-skewed or policy-disallowed backdated milestones are rejected. Every qualifying sample must have source event time strictly greater than the boundary, be classified `LIVE` under the pinned lateness policy, remain continuously safe and end in a currently fresh tail. Boundary-equal, pre-work, sibling-incident/action, superseded-asset/assignment, revoked-channel, late, backfilled, or mixed-backfill-plus-fresh-tail windows fail. Stale data, an interrupted stable window, or missing sign-off is a reason for remaining `OBSERVING` or reaching `FAILED/EXPIRED`; it is never a hidden healthy state. Recalculation creates a new evaluation and does not mutate evidence. A recurrence after `PASSED` reopens the incident and creates a new evaluation rather than altering the prior one.

## 11. Device health

```text
PROVISIONED -> ONLINE -> STALE -> OFFLINE
                  ^        |         |
                  +--------+---------+
Any state -> REVOKED
```

Reconnection does not backdate freshness. Buffered samples keep original event time and are marked late. Revoked devices cannot contribute to recovery proof.

## 12. Invalid transition behavior

An invalid transition returns a stable `409 STATE_TRANSITION_INVALID`, current state/version, and correlation ID; it writes a redacted denial audit entry and causes no side effect. Workers treat it as a stale command, reload, and do not loop.

## 13. State-machine proof obligations

- Exhaustively test allowed/denied transitions.
- Property-test that no path closes without authoritative recovery proof.
- Kill workers before/after each network boundary and verify idempotent convergence.
- Replay duplicate/out-of-order telemetry, events, and webhooks.
- Mutate evidence/policy/price while awaiting approval and prove invalidation.
- Race asset/evidence/policy/approval invalidation immediately before and after the reserve-plus-`SEND_STARTED` linearization point; prove pre-egress work is blocked and in-flight work remains reconcilable without duplicate effect.
- Attempt recovery with boundary-equal/wrong-milestone, pre-intervention, any late/backfilled or mixed-backfill-plus-fresh-tail, other-tenant, sibling-incident, wrong-action, superseded-asset, and revoked-channel samples; prove each is rejected.
- Exercise partial/full refund and reversal after confirmed capture, including duplicate and concurrent callbacks, and prove gross-cap plus net-settlement conservation.
- Recur a fault inside watch window and prove reopening.

