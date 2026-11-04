# UptimeBuyer Data Model

Status: `SPECIFICATION_ONLY`

## 1. Conventions

- UUIDv7-style IDs or another monotonic opaque identifier chosen at implementation intake.
- `tenant_id` on every tenant-owned table and every tenant-scoped primary, foreign-key, and unique constraint. Only global identity/catalog tables and the `tenants` root omit it.
- Every tenant child uses a composite foreign key such as `(tenant_id, parent_id)` to a composite candidate key on its parent; an opaque globally unique ID is not accepted as tenant isolation by itself.
- `created_at`, `updated_at`, and integer `version` on mutable aggregates.
- money as `{amount_minor, currency}`; measurements as integers with explicit units.
- mutable JSON is not a substitute for constrained domain columns. JSON is limited to versioned adapter payload envelopes and redacted evidence metadata.
- soft deletion is allowed only for user-facing configuration; ledgers, decisions, attempts, and evidence manifests are append-only.

## 2. Identity and configuration

| Table | Key fields | Constraints |
|---|---|---|
| `tenants` | `id`, `name`, `status` | status constrained |
| `users` | `id`, `external_subject`, `display_name` | external subject unique |
| `tenant_memberships` | `tenant_id`, `user_id`, `role` | composite unique; role enum |
| `tenant_policies` | `id`, `tenant_id`, `revision`, `body_digest`, `effective_at` | revision unique per tenant; immutable |
| `operating_procedure_revisions` | `id`, `tenant_id`, `procedure_key`, `revision`, `body_digest`, typed deadline start/pause/shorten/expiry rules, timezone basis, `effective_at`, `superseded_at` | immutable; unique tenant/procedure/revision; deadline rules are typed and unit-safe |
| `sites` | `id`, `tenant_id`, `name`, `timezone`, `location` | timezone validated |
| `site_contacts` | `id`, `tenant_id`, `site_id`, `type`, `encrypted_value_ref` | composite tenant/site FK; no plaintext secret/contact in logs |

## 3. Assets and telemetry

| Table | Key fields | Constraints |
|---|---|---|
| `assets` | `id`, `tenant_id`, `site_id`, `current_revision_id`, `status` | stable identity; composite tenant/site FK; current revision must belong to this asset |
| `asset_revisions` | `id`, `tenant_id`, `asset_id`, `revision`, `manufacturer`, `model`, `serial`, `safety_class`, `bom_revision`, `valid_from`, `superseded_at`, `identity_digest` | immutable; unique `(tenant_id, asset_id, revision)`; partial current-identity uniqueness on `(tenant_id, manufacturer, model, serial)` when serial is known |
| `asset_components` | `id`, `tenant_id`, `asset_revision_id`, `oem_mpn`, `component_type`, `effective_from/to` | composite tenant/revision FK; ranges cannot overlap for the same revision slot |
| `devices` | `id`, `tenant_id`, `credential_ref`, `status` | stable provisioned device identity; credential is opaque reference |
| `device_asset_assignments` | `id`, `tenant_id`, `device_id`, `asset_id`, `asset_revision_id`, `revision`, `valid_from`, `valid_to`, `assignment_digest` | immutable/effective-dated; composite tenant/device/asset/revision FKs; no overlapping interval for one device; unique revision per tenant/device |
| `sensor_channels` | `id`, `tenant_id`, `device_id`, `current_revision_id`, `status` | stable channel identity; composite tenant/device FK |
| `sensor_channel_revisions` | `id`, `tenant_id`, `channel_id`, `revision`, `kind`, `unit`, `calibration_revision`, `valid_from`, `valid_to`, `channel_digest` | immutable/effective-dated; composite tenant/channel FK; no overlapping interval; unit allowlist |
| `telemetry_samples` | `tenant_id`, `channel_id`, `channel_revision_id`, `device_assignment_id`, `event_at`, `received_at`, `boot_id`, `sequence`, `value_int`, `quality`, `ingestion_class` | assignment/channel revisions must be effective at event time and tenant-matched; `ingestion_class` is `LIVE`, `LATE`, or `BACKFILL` from versioned lateness policy; unique `(tenant_id, channel_id, boot_id, sequence)`; time partitioned |
| `telemetry_batches` | `id`, `tenant_id`, `device_id`, `received_at`, `min/max_event_at`, `digest` | composite tenant/device FK; digest retained for audit |
| `incident_rules` | `id`, `tenant_id`, `revision`, threshold/window/quorum fields | immutable revision |

Editing manufacturer, model, serial, safety class, or BOM creates a new `asset_revisions` row and atomically advances `assets.current_revision_id`; it never overwrites the revision referenced by historical evidence or decisions. For each still-attached device, the same transaction closes the prior effective assignment and creates a new immutable `device_asset_assignments` revision bound to the new asset revision. Historical samples retain the old assignment and channel revisions. The change emits invalidation work for every non-terminal plan and unexecuted approval bound to the superseded revision.

## 4. Incidents and evidence

| Table | Key fields | Constraints |
|---|---|---|
| `incidents` | `id`, `tenant_id`, `asset_id`, `asset_revision_id`, `rule_id`, `policy_revision_id`, `procedure_revision_id`, `state`, `paused_from_state`, `site_id`, `fault_family`, `fault_window_id`, `dedupe_key`, `opened_at`, `deadline_computed_at`, `deadline_basis_digest`, `deadline_timezone_basis`, `original_response_deadline_at`, `current_response_deadline_at`, `deadline_status`, `current_assignment_id`, `recovered_at`, `version` | composite tenant/asset/revision/rule/procedure FKs; `dedupe_key = digest(tenant_id, site_id, asset_id, fault_window_id)` (INV-09; fault family is triage data, not a dedupe dimension) with partial unique `(tenant_id, dedupe_key) WHERE state <> 'RECOVERED'`; a qualifying trigger for a `RECOVERED` incident inside its configured watch window appends to it through `REOPENED` instead of inserting a second row; `paused_from_state` is non-null exactly when `state = 'PAUSED'`; original deadline and basis immutable |
| `incident_deadline_events` | `id`, `tenant_id`, `incident_id`, `event_type`, `prior_deadline_at`, `new_deadline_at`, `effective_at`, `procedure_revision_id`, `basis_digest`, `reason_code`, `authorized_by`, `approved_at`, `created_at` | append-only `SET/PAUSE/RESUME/SHORTEN/EXTEND/EXPIRE`; composite tenant parents; extension/pause requires explicit procedure support, policy role and reason; cannot mutate original deadline |
| `incident_assignments` | `id`, `tenant_id`, `incident_id`, `assignee_principal_type`, `assignee_principal_id`, `assigned_by`, `assigned_at`, `accepted_at`, `next_action_due_at`, `reason_code`, `handoff_digest`, `superseded_at`, `version` | append-only/superseding; composite tenant principal/incident FKs; one current assignment; acceptance uses compare-and-set |
| `incident_transitions` | `id`, `tenant_id`, `incident_id`, `from_state`, `to_state`, `actor_type/id`, `reason`, `created_at` | composite tenant/incident FK; append-only |
| `evidence_blobs` | `id`, `tenant_id`, `object_key`, `sha256`, `media_type`, `size_bytes`, `trust_level` | `(tenant_id, sha256)` reusable; object immutable |
| `evidence_revisions` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `revision`, `manifest_sha256`, `created_by` | composite tenant/incident/asset-revision FKs; unique revision per tenant/incident; append-only |
| `evidence_revision_items` | `tenant_id`, `revision_id`, `blob_id`, `role`, `locator`, `source_at` | both parents tenant-matched; composite unique |
| `citations` | `id`, `tenant_id`, `revision_id`, `blob_id`, `locator`, `quoted_digest`, `extraction_method` | referenced blob belongs to the same tenant and revision |
| `reasoning_runs` | `id`, `tenant_id`, `incident_id`, `revision_id`, `model_adapter`, `schema_version`, `input_digest`, `output_digest`, `status` | composite tenant parents; no secret/raw credential fields |

Incident creation snapshots the effective procedure revision, timezone basis and typed inputs into `deadline_basis_digest`, computes `original_response_deadline_at` once, and appends `SET`. A later procedure publication never moves an existing incident's deadline. Pause, resume, shorten, extension and expiry follow the pinned procedure's explicit rules and append the old/new values, effective time, authority and reason; replay derives the same current deadline/status. An extension cannot be inferred from an optional risk estimate or provider ETA. The projection updates only `current_response_deadline_at` and `deadline_status` under an aggregate-version lock and cannot erase the original. Assignment and handoff create a new immutable assignment record; an accepted current owner is required for escalation re-entry, and concurrent acceptance/reassignment resolves by versioned compare-and-set rather than last-write-wins.

## 5. Decisions and plans

| Table | Key fields | Constraints |
|---|---|---|
| `candidate_actions` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `evidence_revision_id`, `kind`, `candidate_mpn`, `provider_ref`, snapshot fields, `action_digest` | immutable; every parent tenant-matched; digest includes all revision-bound inputs |
| `compatibility_decisions` | `id`, `tenant_id`, `candidate_id`, `asset_revision_id`, `evidence_revision_id`, `policy_revision_id`, `action_digest`, `decision`, `lifecycle`, `reason_codes`, `input_digest`, `rule_version` | `decision` is `ALLOW`, `HOLD` or `REJECT` only; one immutable result per exact evaluated tuple; `lifecycle` (`CURRENT`/`SUPERSEDED`) is the only mutable projection and supersession is append-only |
| `recovery_plans` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `evidence_revision_id`, `policy_revision_id`, `plan_hash`, `state` | plan hash unique per tenant/incident revision tuple |
| `plan_actions` | `id`, `tenant_id`, `plan_id`, `ordinal`, `action_digest`, cost/risk/ETA integers, `candidate_id` | tenant-matched parents; ordinal and action digest unique within plan |
| `approvals` | `id`, `tenant_id`, `approval_kind` (`PLAN_ACTION` or `BUDGET_ADJUSTMENT`), nullable `target_execution_authority_id`, `incident_id`, `asset_revision_id`, `evidence_revision_id`, `policy_revision_id`, `plan_hash`, `action_digest`, nullable `provider_account_revision_id`, `actor_id`, scope fields, `max_amount_minor`, `currency`, `expires_at`, `signature_digest`, `revoked_at` | all applicable revision fields mandatory; every paid scope pins the exact provider-account revision; expiry and maximum required |

## 6. Provider discovery, contact, and quote records

| Table | Key fields | Constraints |
|---|---|---|
| `provider_accounts` | `id`, `tenant_id`, `provider_key`, `environment`, `current_revision_id`, `status` | stable identity; tenant/provider/environment unique; current revision belongs to this account |
| `provider_account_revisions` | `id`, `tenant_id`, `provider_account_id`, `revision`, capability set, `paid`, `owner_service`, `credential_ref`, `endpoint_policy_digest`, `webhook_verifier_ref`, `effective_at`, `superseded_at` | immutable; composite tenant/account FK; owner is `M07_UNPAID` or `KITE_BROKER_PAID`; credential remains opaque and resolvable only by that revision's owner workload |
| `service_providers` | `id`, `tenant_id`, normalized identity/location fields, `approved_vendor_status`, source/evidence refs, `version` | discovery source is separate from approval; tenant-scoped dedupe key |
| `provider_searches` | `id`, `tenant_id`, `incident_id`, `evidence_revision_id`, `query_digest`, bounds, `state`, `created_by` | immutable request; bounded result count/time/cost |
| `provider_search_results` | `id`, `tenant_id`, `search_id`, `service_provider_id`, rank/source fields, `raw_evidence_ref` | search rank has no approval authority; tenant-matched parents |
| `provider_contact_requests` | `id`, `tenant_id`, `incident_id`, `service_provider_id`, `provider_account_id`, `provider_account_revision_id`, `evidence_revision_id`, `channel`, `purpose_code`, `request_digest`, consent/recording policy refs, `paid`, `action_digest`, `state`, `created_by` | immutable intended contact; one logical request per tenant/incident/provider/channel/purpose/request digest; account revision is pinned and current capability is revalidated before execution; paid request cannot execute outside broker |
| `provider_contact_attempts` | `id`, `tenant_id`, `contact_request_id`, `provider_account_id`, `provider_account_revision_id`, nullable `commercial_intent_id`, `client_operation_id`, `idempotency_key`, `transport_state`, `external_outcome_state`, `adapter_capability`, nullable `provider_ref`, `next_reconcile_at` | tenant/account/revision matched; paid attempt requires matching commercial intent and broker-owned revision; unpaid attempt requires M07-owned revision; transport/outcome/capability axes remain separate; unique operation/idempotency tuple |
| `provider_communications` | `id`, `tenant_id`, `contact_attempt_id`, direction/type, `evidence_blob_id`, consent/disclosure refs, redaction manifest, `observed_at` | append-only; role/retention scoped; transcript text has no decision authority |
| `provider_quotes` | `id`, `tenant_id`, `incident_id`, `service_provider_id`, `contact_request_id`, scope/part digest, amount/currency/tax integers, ETA/validity fields, `source_evidence_ref`, `state` | immutable revisions; expired/missing fields explicit; quote cannot approve compatibility |

M07 owns discovery, request preparation, unpaid provider-account execution, normalized responses, quotes, consent and transcript provenance. Contact attempts keep transport state, normalized external outcome, adapter capability and raw provider state as separate fields. A paid phone/email/API request is persisted by M07 but executed only after an authorized commercial intent is created and handed to the separately deployed M09 broker. M07 consumes broker outcome events and never receives the paid credential or retries an `UNKNOWN` effect directly. Superseding an account revision never rewrites a request or attempt: unexecuted work is revalidated and replaced when required, while in-flight work reconciles against its pinned historical revision.

## 7. Commercial execution

| Table | Key fields | Constraints |
|---|---|---|
| `execution_authorities` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `evidence_revision_id`, `policy_revision_id`, `plan_hash`, `action_digest`, `approval_id`, `provider_account_revision_id`, allowed merchant/service/action/purpose fields, `per_action_limit_minor`, `base_limit_minor`, `currency`, `issued_at`, `expires_at`, `status`, `signature_digest`, `version` | immutable signed scope; unique `(tenant_id, approval_id)` for idempotent issuance and only a `PLAN_ACTION` approval may issue an authority; status projection is `ACTIVE`, `SUSPENDED`, `REVOKED`, or `EXPIRED`; every parent/revision tenant-matched |
| `execution_authority_events` | `id`, `tenant_id`, `execution_authority_id`, `event_type`, `prior_status`, `new_status`, `reason_code`, `actor_id`, `effective_at`, `created_at` | append-only `ISSUED/SUSPENDED/REACTIVATED/REVOKED/EXPIRED`; compare-and-set projection; revocation/expiry never deletes in-flight evidence |
| `execution_authority_sessions` | `id`, `tenant_id`, `execution_authority_id`, `provider_account_revision_id`, `client_operation_id`, `idempotency_key`, `transport_state`, `external_outcome_state`, `adapter_capability`, nullable `provider_session_ref`, `request_digest`, `next_reconcile_at` | one current Kite-session activation per authority; exact signed bounds equal authority; operation identity exists before egress; provider reference optional; same state-axis and reconciliation rules as other external attempts |
| `budget_accounts` | `id`, `tenant_id`, `execution_authority_id`, `base_limit_minor`, `approved_adjustments_minor`, `effective_limit_minor`, `open_reserved_minor`, `gross_captured_minor`, `refunded_minor`, `reversed_minor`, `currency`, `version` | tenant/authority matched; one account per authority; base limit/currency equal the signed authority; effective limit equals base plus signed adjustments; projections nonnegative |
| `budget_ledger_entries` | `id`, `tenant_id`, `budget_account_id`, nullable `intent_id`, `approval_id`, `movement_type`, `amount_minor`, `currency`, nullable `provider_account_id`, nullable `provider_account_revision_id`, `provider_event_key`, nullable `capture_entry_id`, `reverses_entry_id`, `returned_against_minor` (on `CAPTURE` rows; CHECK `0 <= returned_against_minor <= amount_minor`), `created_at` | append-only; intent/provider account revision required for commercial movements, a `BUDGET_ADJUSTMENT` approval targeting this account's authority required for authority adjustment, provider event/reversal targets unique in tenant/provider/account namespace, and every refund/reversal references a same-intent capture |
| `commercial_intents` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `subject_type`, `subject_id`, `approval_id`, `execution_authority_id`, `provider_account_revision_id`, `action_digest`, `intent_key`, `max_amount_minor`, `open_reserved_minor`, `captured_gross_minor`, `refunded_minor`, `reversed_minor`, `net_settled_minor`, `currency`, `state`, nullable `supersedes_intent_id` | subject is tenant-matched `PLAN_ACTION` or `PROVIDER_CONTACT_REQUEST`; provider-account revision matches approval/subject and is immutable; `(tenant_id, action_digest, execution_authority_id)` and `(tenant_id, intent_key)` unique for duplicate-return; partial unique `(tenant_id, action_digest) WHERE state <> 'FAILED'` enforces INV-07 across authorities, because two approvals for one action issue two authorities and row locks cannot block a phantom first insert; per-intent `max_amount_minor = open_reserved_minor + captured_gross_minor + unreserved headroom` and `captured_gross_minor = net_settled_minor + refunded_minor + reversed_minor`; per-intent projections nonnegative; successor insertion locks all intents for the action and requires terminal definite-no-effect predecessors |
| `external_attempts` | `id`, `tenant_id`, `intent_id`, `provider_account_id`, `provider_account_revision_id`, `client_operation_id`, `idempotency_key`, `request_digest`, `transport_state`, `external_outcome_state`, `adapter_capability`, nullable `provider_ref`, `next_reconcile_at` | provider-account revision must match the intent and be broker-owned paid capability; client operation created before egress; transport/outcome/capability axes use canonical enums and never collapse an unknown effect into unsupported; unique tenant/account/client-operation and idempotency tuples |
| `external_receipts` | `id`, `tenant_id`, `attempt_id`, `kind`, `object_blob_id`, `normalized_digest`, `observed_at` | tenant-matched parents; append-only |
| `purchase_orders` | `id`, `tenant_id`, `intent_id`, `provider_account_id`, `provider_account_revision_id`, `provider_ref`, `state`, quantity/price/ETA/tracking fields, `version` | purchase enum from `STATE-MACHINES.md`; account revision matches intent; provider reference unique in tenant/provider-account namespace when present |
| `purchase_order_transitions` | `id`, `tenant_id`, `purchase_order_id`, transition ledger fields, changed field/value digests | append-only; partial fill, substitution and material quantity/price/ETA changes are explicit transitions |
| `service_jobs` | `id`, `tenant_id`, `intent_id`, `provider_account_id`, `provider_account_revision_id`, `provider_ref`, `state`, schedule/ETA/technician/scope fields, `version` | service-job enum from `STATE-MACHINES.md`; account revision matches intent; provider reference unique in tenant/provider-account namespace when present |
| `service_job_transitions` | `id`, `tenant_id`, `service_job_id`, transition ledger fields, changed field/value digests | append-only; reschedule, no-show, arrival, scope change, cancellation and failure remain explicit |

Budget movements are `AUTHORITY_CREDIT`, `AUTHORITY_DEBIT`, `RESERVE`, `RELEASE`, `CAPTURE`, `REFUND`, or `REVERSAL`. Authority movements require a new signed `BUDGET_ADJUSTMENT` approval through `POST /v1/execution-authorities/{authorityId}/adjustments` and cannot be inferred from a refund. For one currency and authority:

```text
approved_adjustments = sum(AUTHORITY_CREDIT) - sum(AUTHORITY_DEBIT)
effective_limit = base_limit + approved_adjustments
open_reserved = sum(RESERVE) - sum(RELEASE) - sum(CAPTURE)
gross_captured = sum(CAPTURE)
refunded = sum(REFUND)
reversed = sum(REVERSAL)
returned = refunded + reversed
net_settled = gross_captured - returned
gross_exposure = open_reserved + gross_captured
available_to_authorize = effective_limit - gross_exposure
```

Database checks require base/effective limits, open reserve, capture, returned, net settlement and availability to be nonnegative, `returned <= gross_captured`, and `gross_exposure <= effective_limit`. For every intent and every referenced capture entry, cumulative refunds plus reversals cannot exceed that intent/capture amount; a capture from another intent cannot mask over-return. Refunds reduce net settlement but do not silently replenish the original gross spending authority; a new signed `AUTHORITY_CREDIT` is required to spend returned value again. A capture consumes reservation atomically, a release can consume only open reservation, and each refund/reversal references an earlier same-intent captured movement. Ledger insertion, per-capture/per-intent projection update, account projection update and intent transition occur in one transaction under ordered row locks. Duplicate or concurrent provider events reuse the same namespaced event key and create no second movement.

## 8. Recovery and audit

| Table | Key fields | Constraints |
|---|---|---|
| `intervention_milestones` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `plan_id`, `action_digest`, nullable `fulfillment_type`, nullable `fulfillment_id`, `milestone_type`, `source_type`, `source_ref`, `occurred_at`, `observed_at`, `verified_at`, `observation_boundary_at`, `boundary_rule_version`, `verified_by`, `evidence_digest`, `signature_digest` | immutable; optional fulfillment target is a tenant-matched purchase order or service job; composite incident/asset/plan/action FKs; policy designates the completion milestone and deterministically derives the immutable boundary from normalized `occurred_at`; only authorized onsite/CMMS evidence can verify; provider self-report alone cannot create it; backdate/future-skew bounds enforced |
| `recovery_assessments` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `plan_id`, `action_digest`, `evidence_revision_id`, `policy_revision_id`, `state` (CHECK `PENDING`/`OBSERVING`/`PASSED`/`FAILED`/`EXPIRED`), `intervention_milestone_id`, `observation_boundary_at`, `verification_started_at`, exact assignment/channel revision IDs, sample range, stable duration, `signoff_manifest_digest`, result, `evidence_digest` | composite tenant parents; boundary exactly equals the milestone's immutable boundary; every assignment resolves to the same pinned asset revision; every qualifying sample has `event_at > observation_boundary_at`, `ingestion_class = LIVE`, and a currently fresh tail; exact sample bounds and mandatory signoff set required |
| `work_order_signoffs` | `id`, `tenant_id`, `incident_id`, `asset_revision_id`, `plan_id`, `action_digest`, `external_ref`, `actor_id`, `role`, `signed_at`, installed identifiers, `signature_digest` | tenant and action bound; authorized actor required; immutable |
| `notifications` | `id`, `tenant_id`, `dedupe_key`, channel, state, provider ref | dedupe key unique |
| `audit_entries` | `id`, `tenant_id`, `occurred_at`, actor, action, resource, result, correlation_id, redacted metadata | append-only, hash-chained optional after threat review |
| `outbox_events` | `id`, `tenant_id`, aggregate fields, event type/version, payload, published_at | unique aggregate version/event type |
| `webhook_deliveries` | `id`, `tenant_id`, `provider_account_id`, `provider_account_revision_id`, `provider_event_id`, signature result, body digest, received/processed timestamps | unique `(tenant_id, provider_account_id, provider_event_id)`; callback resolves the exact retained verifier revision and must match the target attempt/intent revision; it cannot infer tenant from client input |

A recovery assessment may consume only authenticated, non-revoked samples whose immutable effective-dated `device_asset_assignments` and `sensor_channel_revisions` were valid at event time and resolve to the assessment's same tenant and asset revision. Rebinding a device or superseding an asset/channel cannot reinterpret historical samples. The configured completion milestone deterministically freezes `observation_boundary_at`; every qualifying sample must have source `event_at` strictly greater than that boundary, be classified `LIVE` under the pinned lateness policy, remain inside the continuous safe range, and the window must end in a currently fresh sample. Boundary-equal, late, backfilled, pre-intervention, mixed-backfill-plus-fresh-tail, forged, cross-action, future-skewed and policy-disallowed backdated evidence cannot qualify. Such data may explain history but contributes zero duration to recovery. A provider-completed flag cannot manufacture the milestone. The assessment digest includes the boundary rule/time, exact sample IDs, assignment/channel/calibration revisions, approved action digest, policy/evidence revisions, lateness classification, and every required signoff/installed-part record. A new revision, binding, milestone, or action creates a new assessment rather than reusing an earlier pass.

## 9. Retention and privacy

Telemetry retention is tenant-policy-driven with aggregates retained separately. Raw phone/email content and manuals have source-specific retention and access controls. Deletion requests remove or cryptographically erase eligible personal/contact content while preserving legally required redacted transaction/audit facts. Retention workers emit evidence and never silently drop active-incident inputs (FR-23, NFR-06).

## 10. Indexes and partitions

- telemetry by time and tenant/channel;
- incidents by tenant/state/updated time and asset/opened time;
- outbox by unpublished creation time;
- attempts by pending reconciliation time;
- purchase orders and service jobs separately by provider reference and constrained state;
- audit by tenant/time/correlation;
- full-text/vector indexes are candidate-discovery aids only and never compatibility authority.

## 11. Migration gates

Migrations must be forward compatible for rolling deployment, include tenant filters, preserve unknown states, and have restore-tested backups for destructive transformations. Schema rollback is not promised when data shape has irreversibly changed; an explicit forward repair is required. A clean database and an upgrade fixture from the prior release must both pass before release.

Related invariants: INV-03, INV-05, INV-07 through INV-10, INV-13, INV-16.

