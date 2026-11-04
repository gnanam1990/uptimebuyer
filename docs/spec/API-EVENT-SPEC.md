# UptimeBuyer API and Event Specification

Status: `SPECIFICATION_ONLY`

## 1. Protocol rules

- JSON HTTPS APIs; OpenAPI generated from the same schemas used at runtime.
- OAuth/OIDC bearer identity for users; short-lived service identity for internal calls; mutual TLS or signed device token for sensors.
- `X-Tenant-ID` is a requested context, never authorization by itself. The server resolves the tenant from the authenticated principal's `tenant_memberships`; a header that names a tenant the principal is not a member of is rejected (`403`, audited, no existence leak), and an absent header may default only to the principal's single membership (INV-16).
- Mutating requests require `Idempotency-Key`; aggregate commands also require `If-Match`/expected version.
- Responses include `X-Correlation-ID`; secrets and raw provider authorization are never returned.
- Attempt/session resources expose separate `transportState`, `externalOutcomeState`, `adapterCapability` and economic/authority state fields; no generic combined status is authoritative.
- Cursor pagination only. Payload, batch, time, and concurrency limits are documented and enforced.

## 2. Core endpoints

### Tenant, site, asset

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/sites` | create a tenant-scoped site |
| `POST` | `/v1/assets` | register exact equipment identity |
| `GET` | `/v1/assets/{assetId}` | asset, evidence freshness, active incident summary |
| `POST` | `/v1/assets/{assetId}/documents` | create bounded upload intent and metadata |
| `POST` | `/v1/assets/{assetId}/devices` | bind provisioned sensor device |
| `POST` | `/v1/devices/{deviceId}/asset-assignments` | append an effective-dated immutable device-to-asset-revision assignment |
| `POST` | `/v1/sensor-channels/{channelId}/revisions` | append an effective-dated immutable kind/unit/calibration revision |

### Telemetry and incidents

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/device/telemetry:batch` | authenticated, sequenced telemetry ingest |
| `GET` | `/v1/incidents` | filtered incident list |
| `GET` | `/v1/incidents/{incidentId}` | revisioned incident projection |
| `POST` | `/v1/incidents/{incidentId}:acknowledge` | record operator acknowledgement |
| `POST` | `/v1/incidents/{incidentId}:assign` | append a tenant-scoped owner/team assignment |
| `POST` | `/v1/incidents/{incidentId}/assignments/{assignmentId}:accept` | compare-and-set acceptance by the assigned principal |
| `POST` | `/v1/incidents/{incidentId}:handoff` | supersede current assignment with reason, next owner and deadline |
| `POST` | `/v1/incidents/{incidentId}:adjust-deadline` | append permitted pause/resume/shorten/extend event under the pinned procedure |
| `POST` | `/v1/incidents/{incidentId}:escalate` | explicit escalation with reason |
| `POST` | `/v1/incidents/{incidentId}:pause` | pause only a resumable active state with owner, reason and expected version |
| `POST` | `/v1/incidents/{incidentId}:resume` | restore the recorded legal prior state after full revision/authority/in-flight revalidation |
| `POST` | `/v1/incidents/{incidentId}:reopen` | authorized reopen with evidence |

### Evidence, plan, approval

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/incidents/{incidentId}/evidence-revisions` | commit an immutable evidence manifest |
| `POST` | `/v1/incidents/{incidentId}/reasoning-runs` | request bounded cited proposal generation |
| `POST` | `/v1/incidents/{incidentId}/plans` | deterministically evaluate candidates and create plan |
| `GET` | `/v1/plans/{planId}` | plan, compatibility reasons, provenance, freshness |
| `POST` | `/v1/plans/{planId}:approve` | signed, scoped, expiring approval |
| `POST` | `/v1/plans/{planId}:reject` | record rejection and reason |
| `POST` | `/v1/approvals/{approvalId}/execution-authorities` | idempotently issue immutable bounded authority and request its Kite session; `202` is not session confirmation |
| `GET` | `/v1/execution-authorities/{authorityId}` | exact signed scope, local status, Kite-session outcome, budget projection and unresolved attempts |
| `POST` | `/v1/execution-authorities/{authorityId}/adjustments` | record a signed `BUDGET_ADJUSTMENT` approval and append `AUTHORITY_CREDIT`/`AUTHORITY_DEBIT`; never issues a new authority and never inferred from a refund |
| `POST` | `/v1/execution-authorities/{authorityId}:revoke` | append revocation; block new intents while preserving reconciliation of possible in-flight effects |

### Provider discovery, contacts, and quotes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/incidents/{incidentId}/provider-searches` | create bounded discovery request with evidence revision |
| `GET` | `/v1/incidents/{incidentId}/provider-searches/{searchId}` | source-labelled results with discovery and vendor-approval status separated |
| `POST` | `/v1/incidents/{incidentId}/provider-contact-requests` | prepare immutable consent/purpose/channel-bound quote or availability contact |
| `POST` | `/v1/provider-contact-requests/{requestId}:execute` | unpaid account queues M07 attempt; paid account creates bounded commercial intent for M09 broker |
| `GET` | `/v1/provider-contact-requests/{requestId}` | request, attempts, canonical outcome, transcript and quote evidence refs |
| `POST` | `/v1/provider-contact-requests/{requestId}/quotes` | append normalized immutable quote evidence |
| `POST` | `/v1/provider-accounts` | privileged tenant/provider/environment capability binding; secrets remain opaque |
| `POST` | `/v1/provider-accounts/{accountId}/revisions` | append immutable capability, paid-owner and webhook-verifier revision |

### Execution and recovery

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/plan-actions/{actionId}:execute` | create commercial intent; never means fulfilled |
| `GET` | `/v1/intents/{intentId}` | attempt, receipt, and reconciliation state |
| `GET` | `/v1/purchase-orders/{id}` | constrained purchase lifecycle, change history and raw evidence |
| `GET` | `/v1/service-jobs/{id}` | constrained service lifecycle, technician arrival/scope history and raw evidence |
| `POST` | `/v1/incidents/{incidentId}/intervention-milestones` | append authorized action-bound intervention evidence; provider self-report alone is rejected |
| `POST` | `/v1/incidents/{incidentId}/signoffs` | authorized work/installed-part evidence |
| `POST` | `/v1/incidents/{incidentId}:assess-recovery` | run deterministic stable-window assessment |
| `GET` | `/v1/incidents/{incidentId}/evidence-export` | redacted audit bundle |

### Administrative

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/policies` | publish immutable policy revision |
| `POST` | `/v1/provider-webhooks/{opaqueAccountBinding}` | signed, replay-protected webhook resolved to one configured provider-account revision; body cannot select tenant |
| `GET` | `/v1/audit` | authorized, paginated audit query |
| `GET` | `/health/live` | process liveness only |
| `GET` | `/health/ready` | dependency readiness without secrets |

## 3. Example execution request

```json
{
  "planId": "pln_opaque",
  "planHash": "sha256:hex",
  "evidenceRevision": 4,
  "policyRevision": 9,
  "approvalId": "apr_opaque",
  "expectedMax": {"amountMinor": 48200, "currency": "USD"}
}
```

Success is `202 Accepted` with `intentId`, canonical economic-intent `state: "CREATED"`, and aggregate version. It means the durable intent exists; it is neither a reservation, network submission, nor purchase receipt. The broker later moves it through `RESERVED`, `SUBMITTED`, `UNKNOWN`, or another canonical outcome.

## 4. Typed hold response

```json
{
  "error": {
    "code": "POLICY_HOLD",
    "reasonCode": "SUBSTITUTE_REQUIRES_NAMED_APPROVAL",
    "message": "This action cannot execute under the current approval.",
    "correlationId": "corr_opaque",
    "currentRevision": 5
  }
}
```

## 5. Domain event envelope

```json
{
  "eventId": "evt_opaque",
  "eventType": "incident.opened.v1",
  "occurredAt": "RFC3339 UTC",
  "tenantId": "ten_opaque",
  "aggregateType": "incident",
  "aggregateId": "inc_opaque",
  "aggregateVersion": 1,
  "correlationId": "corr_opaque",
  "causationId": "cmd_or_evt_opaque",
  "schemaVersion": 1,
  "payload": {}
}
```

Consumers reject unknown major schema versions to a quarantine queue; they ignore duplicate `eventId` and verify monotonically legal aggregate versions.

## 6. Event catalog

| Event | Meaning |
|---|---|
| `telemetry.accepted.v1` | authenticated samples persisted |
| `device.asset_assignment_changed.v1` | immutable effective-dated device binding appended |
| `sensor_channel.revision_changed.v1` | immutable unit/calibration revision appended |
| `telemetry.stale.v1` | configured freshness expired |
| `incident.opened.v1` | deduplicated incident created |
| `incident.state_changed.v1` | legal transition persisted |
| `incident.assignment_changed.v1` | owner/team assignment or handoff appended |
| `incident.assignment_accepted.v1` | current assignment accepted by the assigned principal |
| `incident.deadline_changed.v1` | authorized deadline event appended without rewriting its original basis |
| `evidence.revision_committed.v1` | immutable evidence manifest available |
| `reasoning.completed.v1` | cited typed proposal produced; not approved |
| `compatibility.evaluated.v1` | deterministic `ALLOW/HOLD/REJECT` persisted |
| `plan.created.v1` | revision-bound ranked plan available |
| `plan.invalidated.v1` | evidence/policy/price changed |
| `approval.recorded.v1` | scoped authorization persisted |
| `execution_authority.issued.v1` | immutable signed bounds and local authority identity persisted |
| `execution_authority.state_changed.v1` | authority suspended, reactivated, revoked, or expired without erasing in-flight work |
| `execution_authority.session_changed.v1` | Kite-session transport/external outcome or opaque provider-session reference changed |
| `provider.search_completed.v1` | bounded source-labelled provider candidates persisted |
| `provider.contact_requested.v1` | immutable contact purpose, consent and action digest prepared |
| `provider.contact_attempted.v1` | unpaid M07 attempt or paid broker-linked attempt state changed |
| `provider.communication_recorded.v1` | consent/redaction-bound message or transcript evidence appended |
| `provider.quote_recorded.v1` | normalized immutable quote, ETA and scope evidence appended |
| `commercial_intent.created.v1` | durable external-action intent exists |
| `commercial_intent.state_changed.v1` | economic intent moved between `RESERVED`, `SUBMITTED`, `UNKNOWN`, `CONFIRMED`, `FAILED`, `REFUNDED` or `REVERSED`; M07 and M10 consume this broker outcome |
| `external_attempt.send_started.v1` | pre-egress client operation/idempotency reference is durable; this is not external `REQUESTED`, and outcome may still be unknown |
| `external_attempt.accepted.v1` | provider acknowledgement permits the linked economic intent to become `SUBMITTED` |
| `external_attempt.capability_changed.v1` | adapter eligibility/reconciliation capability changed without relabelling the effect |
| `external_attempt.unknown.v1` | network result requires reconciliation |
| `external_attempt.reconciled.v1` | authoritative provider result observed |
| `budget.movement_recorded.v1` | append-only signed-authority adjustment or reserve/release/capture/refund/reversal movement changed projections |
| `purchase_order.state_changed.v1` | constrained purchase transition, partial fill, substitution or material change observed |
| `service_job.state_changed.v1` | constrained schedule, arrival, work, scope, cancellation or failure transition observed |
| `intervention.milestone_recorded.v1` | immutable authorized incident/asset/plan/action-bound milestone verified |
| `recovery.assessed.v1` | deterministic stable-window result persisted |
| `incident.recovered.v1` | all configured recovery evidence satisfied |
| `incident.reopened.v1` | recurrence or invalidation returned incident to work |

## 7. Webhooks

Webhook routing first resolves exactly one configured provider-account revision from the authenticated endpoint/credential; tenant identity is derived from that server-side binding, never from a path, header, body field, provider reference, or model output. A superseded verifier may remain callback-valid only for an explicit bounded reconciliation window. Replay identity is exactly `(tenant_id, provider_account_id, provider_event_id)`. Processing verifies provider selection, signature, timestamp tolerance, event uniqueness, payload limits, and that the resolved revision matches the target intent/attempt/purchase-order/service-job before returning success. The raw body digest is retained; sensitive body content follows retention policy. Receiving a valid webhook does not make its business claim authoritative unless the provider is authoritative for that field. Out-of-order events are folded through legal state transitions and reconciled by lookup.

## 8. Idempotency

The server stores `(tenant, route, idempotency_key, request_digest, result_reference)`. Reusing a key with a different digest returns `409 IDEMPOTENCY_KEY_REUSED`. Same-key repeats return the original durable result. Storage lifetime must exceed the longest provider retry/reconciliation window.

Authority issuance additionally enforces unique `(tenant_id, approval_id)`: a repeated identical command returns the same authority and session-activation operation. The signed scope is immutable and includes incident, asset/evidence/policy/plan/action revisions, exact provider-account revision, merchant/service, purpose, allowed action kinds, per-action and aggregate limits, currency and expiry. A paid intent may reserve only when the authority is `ACTIVE`, unexpired and unrevoked and its Kite-session external outcome is `CONFIRMED`. Session `UNKNOWN` remains non-executable and reconciles by the original operation key. Revocation or expiry blocks new reserve transactions but does not relabel or discard a possible in-flight effect.

## 9. Event and API safety

- URLs from model/retrieved content never become arbitrary fetch targets; adapters use allowlisted origins.
- Browser clients cannot call Kite or provider payment endpoints.
- Provider webhook fields cannot directly authorize or close incidents.
- A callback cannot choose its tenant; unmatched or cross-tenant provider/account references are quarantined and audited without mutating workflow state.
- Every provider callback resolves an exact immutable provider-account revision from the authenticated endpoint/credential before tenant routing and must match the revision pinned to its target. Paid capability revisions are broker-owned; M07 cannot resolve their credentials or egress directly.
- Provider contact execution reloads account capability/owner. Unpaid accounts use M07 idempotent attempts; paid accounts create a bounded commercial intent whose subject is the immutable contact request. M07 consumes broker outcomes and never retries a paid `UNKNOWN` directly.
- Execution-authority create/read/revoke commands are tenant- and role-scoped. Issuance reloads the exact approval and creates one immutable authority plus one pre-egress Kite-session operation; a provider session reference is evidence, never the authority identity itself.
- Device assignment and channel-revision commands are server-tenant-scoped, effective-dated and non-overlapping. Telemetry samples store the exact assignment/channel revisions effective at source event time; rebinding cannot reinterpret history.
- Incident creation pins the effective procedure revision, timezone/basis digest and original computed deadline. Deadline commands name a typed event; the server reloads the pinned procedure, verifies the permitted actor/reason, preserves the original deadline and appends the prior/new projection.
- Assignment, acceptance and handoff use aggregate versions and tenant-scoped principals. Escalation re-entry requires the accepted current assignment; concurrent accept/reassign cannot use last-write-wins.
- Recovery assessment requests name an incident only; the server reloads the current tenant, immutable asset revision, approved action, intervention milestone, policy/evidence revisions, channels, and required signoffs rather than accepting them as client authority.
- Intervention-milestone creation reloads the exact approved plan/action and accepts only policy-authorized onsite or CMMS evidence with actor/source identity, occurred/observed times and verification signature. Provider completion alone, cross-action evidence, future skew and disallowed backdating are rejected.
- API errors use stable machine codes and a safe public message.
- Exports declare cut-off time, evidence revisions, omitted/redacted fields, and unresolved outcomes.

Related requirements: FR-01..FR-24; NFR-02, NFR-03, NFR-05, NFR-09, NFR-10; INV-03, INV-06 through INV-12, INV-16.

