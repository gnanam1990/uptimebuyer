-- M11 recovery verification and CMMS closeout (FR-14, FR-15, FR-16, FR-17, INV-01, INV-02, INV-03, INV-10, INV-14).
--   * recovery_policy_revisions: effective-dated, append-only recovery policy (designated completion milestone, its
--     authorized sources, attestation roles, required signoffs, installed-part rule, skew/backdate bounds and the
--     stable-window parameters). A new revision never rewrites an evaluation that pinned an older one.
--   * cmms_integrations: one CMMS integration identity bound to one site with a record-verifier secret reference.
--   * recovery_evidence (+ disputes): every post-intervention record with source identity, trust label, occurred and
--     observed times and its verified signature digest. Provider, model and free-text evidence is labelled and can never
--     back a milestone or a signoff.
--   * intervention_milestones: immutable, action-bound, policy-designated completion milestone; the database refuses a
--     milestone not backed by authorized, undisputed, in-policy evidence for the incident's approved action.
--   * recovery_evaluations (+ transitions, channel/sample/signoff pins, assessments): the observation boundary is the
--     milestone's normalized occurred time; pinned bindings never change; only exact-revision LIVE flag-free in-range
--     samples strictly after the boundary can be pinned; PASSED needs every policy-required signoff.
--   * recovery_closeouts: one per incident and recovery cycle, only for a PASSED evaluation, and only if the incident's
--     RECOVERED transition naming that evaluation commits in the same transaction; reopen is a one-shot stamp.
--   * cmms_work_order_updates / cmms_write_attempts: the replay-safe CMMS outbox (one row per idempotency key) on the
--     EXTERNAL_ACTION outcome vocabulary, plus append-only attempt records.
-- Conventions: tenant_id + (tenant_id, id) keys, tenant-leading composite FKs, ub_make_append_only, NULL-safe guards
-- (ADR 0004). M11 guard violations raise SQLSTATE UB201 (evaluation binding/qualification), UB202 (closeout), UB203
-- (CMMS outbox), UB204 (milestone).

CREATE TABLE recovery_policy_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rpr')),
  site_id text,
  scope_key text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  completion_milestone_type text NOT NULL
    CHECK (completion_milestone_type IN ('WORK_COMPLETED', 'PART_INSTALLED', 'TECHNICIAN_DEPARTED')),
  milestone_sources text[] NOT NULL
    CHECK (cardinality(milestone_sources) BETWEEN 1 AND 2 AND milestone_sources <@ ARRAY['CMMS', 'AUTHORIZED_OPERATOR']),
  attestation_roles text[] NOT NULL
    CHECK (cardinality(attestation_roles) BETWEEN 1 AND 3
      AND attestation_roles <@ ARRAY['operator', 'maintenance_approver', 'engineer']),
  required_signoffs text[] NOT NULL
    CHECK (cardinality(required_signoffs) BETWEEN 1 AND 2
      AND required_signoffs <@ ARRAY['CMMS_WORK_ORDER', 'OPERATOR_ATTESTATION']),
  installed_part_required boolean NOT NULL,
  max_backdate_ms bigint NOT NULL CHECK (max_backdate_ms BETWEEN 0 AND 604800000),
  max_future_skew_ms bigint NOT NULL CHECK (max_future_skew_ms BETWEEN 0 AND 300000),
  stable_window_ms bigint NOT NULL CHECK (stable_window_ms BETWEEN 60000 AND 604800000),
  max_gap_ms bigint NOT NULL CHECK (max_gap_ms BETWEEN 1000 AND 3600000),
  min_samples integer NOT NULL CHECK (min_samples BETWEEN 2 AND 100000),
  max_tail_age_ms bigint NOT NULL CHECK (max_tail_age_ms BETWEEN 1000 AND 3600000),
  max_observation_ms bigint NOT NULL CHECK (max_observation_ms BETWEEN 60000 AND 2592000000),
  lost_signal_after_ms bigint NOT NULL CHECK (lost_signal_after_ms BETWEEN 1000 AND 86400000),
  allow_simulated_input boolean NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^recovery-policy\.v1:sha256:[0-9a-f]{64}$'),
  effective_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_user_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, scope_key, revision),
  UNIQUE (tenant_id, scope_key, effective_at),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK (scope_key = coalesce(site_id, 'TENANT')),
  CHECK (max_observation_ms >= stable_window_ms),
  -- No retroactive recovery policy (small clock tolerance).
  CHECK (effective_at >= published_at - interval '5 seconds')
);
SELECT ub_make_append_only('recovery_policy_revisions');

CREATE TABLE cmms_integrations (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cmi')),
  site_id text NOT NULL,
  integration_identity_id text NOT NULL,
  system_key text NOT NULL CHECK (system_key ~ '^[a-z][a-z0-9-]{0,62}$'),
  environment text NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  verifier_ref text NOT NULL CHECK (ub_secret_ref_ok(verifier_ref)),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR revoked_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_identity_id) REFERENCES integration_identities (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX cmms_integrations_one_active_ux ON cmms_integrations (tenant_id, integration_identity_id)
  WHERE revoked_at IS NULL;
SELECT ub_make_append_only('cmms_integrations', 'revoked_at', 'revoked_reason');

CREATE TABLE recovery_evidence (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rce')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CMMS_SIGNOFF', 'TECHNICIAN_RECORD', 'INSTALLED_PART', 'OPERATOR_ATTESTATION',
    'OPERATOR_NOTE', 'PROVIDER_COMPLETION', 'MODEL_ASSERTION', 'RECEIPT')),
  source_kind text NOT NULL CHECK (source_kind IN ('CMMS', 'AUTHORIZED_OPERATOR', 'OPERATOR', 'PROVIDER', 'MODEL')),
  trust text NOT NULL
    CHECK (trust IN ('VERIFIED_CMMS', 'OPERATOR_ATTESTED', 'UNATTESTED', 'PROVIDER_REPORTED', 'MODEL_PROPOSED')),
  cmms_integration_id text,
  external_record_id text CHECK (external_record_id IS NULL OR external_record_id ~ '^[\x21-\x7E]{1,128}$'),
  supersedes_record_id text CHECK (supersedes_record_id IS NULL OR supersedes_record_id ~ '^[\x21-\x7E]{1,128}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER', 'INTEGRATION')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  -- The authorized attester and the role they held at attestation time (authorized-operator evidence only).
  attester_user_id text,
  attester_role text CHECK (attester_role IS NULL OR attester_role IN ('operator', 'maintenance_approver', 'engineer')),
  claimed_asset_id text,
  claimed_asset_revision_id text,
  plan_id text CHECK (plan_id IS NULL OR ub_id_ok(plan_id, 'pln')),
  action_digest text CHECK (action_digest IS NULL OR action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  milestone_type text CHECK (milestone_type IS NULL
    OR milestone_type IN ('WORK_COMPLETED', 'PART_INSTALLED', 'TECHNICIAN_DEPARTED', 'PART_RECEIVED', 'TECHNICIAN_ARRIVED')),
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  work_order_ref text CHECK (work_order_ref IS NULL OR work_order_ref ~ '^[\x21-\x7E]{1,128}$'),
  technician_ref text CHECK (technician_ref IS NULL OR technician_ref ~ '^[\x21-\x7E]{1,128}$'),
  signer_ref text CHECK (signer_ref IS NULL OR signer_ref ~ '^[\x21-\x7E]{1,128}$'),
  part_manufacturer text CHECK (part_manufacturer IS NULL OR length(part_manufacturer) BETWEEN 1 AND 200),
  part_number text CHECK (part_number IS NULL OR length(part_number) BETWEEN 1 AND 80),
  part_serial text CHECK (part_serial IS NULL OR length(part_serial) BETWEEN 1 AND 128),
  part_barcode text CHECK (part_barcode IS NULL OR length(part_barcode) BETWEEN 1 AND 128),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  source_ref text CHECK (source_ref IS NULL OR source_ref ~ '^[\x21-\x7E]{1,128}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Authority-capable rows (CMMS, authorized operator) carry an HMAC seal from the recovery keyring; other rows carry a
  -- plain integrity digest and can never verify as a seal.
  signature_digest text NOT NULL CHECK (signature_digest ~ '^(hmac-sha256|sha256):[0-9a-f]{64}$'),
  signature_key_id text NOT NULL CHECK (length(signature_key_id) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, incident_id),
  UNIQUE (tenant_id, cmms_integration_id, external_record_id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  -- A CMMS record is only ever accepted from an integration bound to the incident's own site.
  FOREIGN KEY (tenant_id, cmms_integration_id, site_id) REFERENCES cmms_integrations (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, claimed_asset_id, claimed_asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, attester_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK ((source_kind = 'AUTHORIZED_OPERATOR') = (attester_user_id IS NOT NULL)
     AND (attester_user_id IS NULL) = (attester_role IS NULL)
     AND (attester_user_id IS NULL OR attester_user_id = actor_id)),
  CHECK ((part_number IS NULL) = (part_manufacturer IS NULL) AND (part_number IS NULL) = (part_serial IS NULL)),
  CHECK (part_barcode IS NULL OR part_number IS NOT NULL),
  CHECK ((plan_id IS NULL) = (action_digest IS NULL)),
  -- Source and trust are fixed by kind: nothing but a verified CMMS record or an authorized human attestation can
  -- ever carry milestone/signoff trust.
  CHECK ((source_kind = 'CMMS') = (trust = 'VERIFIED_CMMS')
     AND (source_kind = 'CMMS') = (cmms_integration_id IS NOT NULL)
     AND (source_kind = 'CMMS') = (external_record_id IS NOT NULL)
     AND (source_kind = 'CMMS') = (actor_kind = 'INTEGRATION')
     AND (source_kind = 'CMMS') = (claimed_asset_revision_id IS NOT NULL)),
  CHECK (source_kind <> 'CMMS' OR (kind IN ('CMMS_SIGNOFF', 'TECHNICIAN_RECORD', 'INSTALLED_PART') AND plan_id IS NOT NULL)),
  CHECK (kind <> 'CMMS_SIGNOFF' OR source_kind = 'CMMS'),
  CHECK (supersedes_record_id IS NULL OR (source_kind = 'CMMS' AND kind = 'INSTALLED_PART')),
  CHECK (kind <> 'OPERATOR_ATTESTATION' OR (source_kind = 'AUTHORIZED_OPERATOR' AND trust = 'OPERATOR_ATTESTED'
    AND actor_kind = 'HUMAN' AND plan_id IS NOT NULL)),
  CHECK (source_kind <> 'AUTHORIZED_OPERATOR' OR (trust = 'OPERATOR_ATTESTED' AND actor_kind = 'HUMAN'
    AND kind IN ('OPERATOR_ATTESTATION', 'INSTALLED_PART'))),
  CHECK (source_kind <> 'OPERATOR' OR (trust = 'UNATTESTED' AND actor_kind = 'HUMAN'
    AND kind IN ('OPERATOR_NOTE', 'TECHNICIAN_RECORD'))),
  CHECK (source_kind <> 'PROVIDER' OR (trust = 'PROVIDER_REPORTED' AND actor_kind IN ('SERVICE', 'WORKER')
    AND kind IN ('PROVIDER_COMPLETION', 'RECEIPT'))),
  CHECK (source_kind <> 'MODEL' OR (trust = 'MODEL_PROPOSED' AND actor_kind IN ('SERVICE', 'WORKER')
    AND kind = 'MODEL_ASSERTION')),
  CHECK (kind NOT IN ('PROVIDER_COMPLETION', 'RECEIPT') OR source_kind = 'PROVIDER'),
  CHECK (kind <> 'MODEL_ASSERTION' OR source_kind = 'MODEL'),
  CHECK (kind <> 'OPERATOR_NOTE' OR source_kind = 'OPERATOR'),
  CHECK ((source_kind IN ('CMMS', 'AUTHORIZED_OPERATOR')) = (signature_digest LIKE 'hmac-sha256:%')),
  CHECK ((signature_digest LIKE 'sha256:%') = (signature_key_id = 'unsealed'))
);
CREATE INDEX recovery_evidence_incident_ix ON recovery_evidence (tenant_id, incident_id, kind, occurred_at);
SELECT ub_make_append_only('recovery_evidence');

CREATE TABLE recovery_evidence_disputes (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rcd')),
  evidence_id text NOT NULL,
  incident_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER', 'INTEGRATION')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_id),
  FOREIGN KEY (tenant_id, evidence_id, incident_id) REFERENCES recovery_evidence (tenant_id, id, incident_id)
);
SELECT ub_make_append_only('recovery_evidence_disputes');

CREATE TABLE intervention_milestones (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'iml')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  recovery_cycle integer NOT NULL CHECK (recovery_cycle >= 0),
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  milestone_type text NOT NULL CHECK (milestone_type IN ('WORK_COMPLETED', 'PART_INSTALLED', 'TECHNICIAN_DEPARTED')),
  source_evidence_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('CMMS', 'AUTHORIZED_OPERATOR')),
  recovery_policy_revision_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signature text NOT NULL CHECK (signature ~ '^hmac-sha256:[0-9a-f]{64}$'),
  signature_key_id text NOT NULL CHECK (length(signature_key_id) BETWEEN 1 AND 128),
  milestone_digest text NOT NULL CHECK (milestone_digest ~ '^intervention-milestone\.v1:sha256:[0-9a-f]{64}$'),
  verified_by_kind text NOT NULL CHECK (verified_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  verified_by_id text NOT NULL CHECK (length(verified_by_id) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_evidence_id),
  UNIQUE (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, source_evidence_id, incident_id) REFERENCES recovery_evidence (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, plan_id, incident_id) REFERENCES recovery_plans (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id),
  FOREIGN KEY (tenant_id, recovery_policy_revision_id) REFERENCES recovery_policy_revisions (tenant_id, id),
  -- The boundary is a normalized UTC instant (millisecond precision).
  CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  CHECK (occurred_at <= observed_at + interval '5 minutes')
);
CREATE INDEX intervention_milestones_incident_ix ON intervention_milestones (tenant_id, incident_id, recovery_cycle);
SELECT ub_make_append_only('intervention_milestones');

-- The database re-derives the milestone from its evidence: authorized, undisputed, verified evidence of the incident's
-- approved action, of the policy-designated type, from a policy-permitted source, for the incident's current asset
-- revision and recovery cycle, with the occurred time inside the policy's skew/backdate bounds.
CREATE FUNCTION ub_intervention_milestone_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_evidence e
      JOIN incidents i ON i.tenant_id = e.tenant_id AND i.id = e.incident_id
      JOIN plan_actions pa ON pa.tenant_id = NEW.tenant_id AND pa.plan_id = NEW.plan_id AND pa.id = NEW.plan_action_id
      JOIN recovery_policy_revisions p ON p.tenant_id = NEW.tenant_id AND p.id = NEW.recovery_policy_revision_id
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.source_evidence_id AND e.incident_id = NEW.incident_id
       -- The policy is the revision in force for the incident's scope at the observed time: site over tenant, latest.
       AND p.scope_key IN (i.site_id, 'TENANT') AND p.effective_at <= NEW.observed_at
       AND NOT EXISTS (
         SELECT 1 FROM recovery_policy_revisions q
          WHERE q.tenant_id = NEW.tenant_id AND q.scope_key IN (i.site_id, 'TENANT') AND q.effective_at <= NEW.observed_at
            AND ((q.scope_key = i.site_id AND p.scope_key = 'TENANT')
              OR (q.scope_key = p.scope_key AND q.effective_at > p.effective_at)))
       -- An attestation backs a milestone only from a policy-named role the attester still holds at the site.
       AND (e.source_kind <> 'AUTHORIZED_OPERATOR' OR (e.attester_role = ANY (p.attestation_roles) AND EXISTS (
         SELECT 1 FROM role_assignments ra
           JOIN tenant_memberships tm ON tm.tenant_id = ra.tenant_id AND tm.user_id = ra.user_id AND tm.status = 'ACTIVE'
          WHERE ra.tenant_id = e.tenant_id AND ra.user_id = e.attester_user_id AND ra.role = e.attester_role
            AND ra.revoked_at IS NULL AND (ra.site_id IS NULL OR ra.site_id = NEW.site_id))))
       AND e.kind IN ('CMMS_SIGNOFF', 'OPERATOR_ATTESTATION')
       AND e.trust IN ('VERIFIED_CMMS', 'OPERATOR_ATTESTED')
       AND e.source_kind = NEW.source_kind AND NEW.source_kind = ANY (p.milestone_sources)
       AND e.plan_id = NEW.plan_id AND e.action_digest = NEW.action_digest AND pa.action_digest = NEW.action_digest
       AND e.milestone_type = NEW.milestone_type AND p.completion_milestone_type = NEW.milestone_type
       AND date_trunc('milliseconds', e.occurred_at) = NEW.occurred_at AND e.observed_at = NEW.observed_at
       AND i.asset_revision_id = NEW.asset_revision_id AND i.reopen_count = NEW.recovery_cycle
       AND (e.claimed_asset_revision_id IS NULL OR e.claimed_asset_revision_id = NEW.asset_revision_id)
       AND NEW.occurred_at <= NEW.observed_at + p.max_future_skew_ms * interval '1 millisecond'
       AND NEW.occurred_at >= NEW.observed_at - p.max_backdate_ms * interval '1 millisecond'
       AND (e.cmms_integration_id IS NULL OR EXISTS (
         SELECT 1 FROM cmms_integrations ci
          WHERE ci.tenant_id = e.tenant_id AND ci.id = e.cmms_integration_id AND ci.site_id = NEW.site_id
            AND ci.revoked_at IS NULL))
       AND NOT EXISTS (
         SELECT 1 FROM recovery_evidence_disputes d WHERE d.tenant_id = e.tenant_id AND d.evidence_id = e.id)
  ) THEN
    RAISE EXCEPTION 'intervention milestone is not backed by authorized, action-bound, in-policy evidence'
      USING ERRCODE = 'UB204';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER intervention_milestones_guard BEFORE INSERT ON intervention_milestones
  FOR EACH ROW EXECUTE FUNCTION ub_intervention_milestone_guard();

-- Recovery evaluation machine (STATE-MACHINES §10); T-006 compares this with the domain machine.
CREATE FUNCTION ub_recovery_evaluation_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (('PENDING', 'OBSERVING'), ('OBSERVING', 'PASSED'), ('OBSERVING', 'FAILED'),
    ('OBSERVING', 'EXPIRED')) $$;

CREATE TABLE recovery_evaluations (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rev')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  recovery_cycle integer NOT NULL CHECK (recovery_cycle >= 0),
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  evidence_revision_id text NOT NULL,
  recovery_policy_revision_id text NOT NULL,
  rule_revision_id text NOT NULL,
  milestone_id text NOT NULL,
  observation_boundary_at timestamptz NOT NULL,
  stable_window_ms bigint NOT NULL CHECK (stable_window_ms BETWEEN 60000 AND 604800000),
  expires_at timestamptz NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^recovery-binding\.v1:sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('PENDING', 'OBSERVING', 'PASSED', 'FAILED', 'EXPIRED')),
  state_reason text CHECK (state_reason IS NULL OR state_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, milestone_id, incident_id) REFERENCES intervention_milestones (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, plan_id, incident_id) REFERENCES recovery_plans (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, recovery_policy_revision_id) REFERENCES recovery_policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_revision_id) REFERENCES incident_rule_revisions (tenant_id, id),
  CHECK ((state IN ('PASSED', 'FAILED', 'EXPIRED')) = (decided_at IS NOT NULL)),
  CHECK ((state IN ('FAILED', 'EXPIRED')) = (state_reason IS NOT NULL)),
  CHECK (expires_at > observation_boundary_at)
);
-- One open evaluation per incident; one PASSED evaluation per incident recovery cycle.
CREATE UNIQUE INDEX recovery_evaluations_one_open_ux ON recovery_evaluations (tenant_id, incident_id)
  WHERE state IN ('PENDING', 'OBSERVING');
CREATE UNIQUE INDEX recovery_evaluations_one_passed_ux ON recovery_evaluations (tenant_id, incident_id, recovery_cycle)
  WHERE state = 'PASSED';

CREATE TABLE recovery_evaluation_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rvt')),
  evaluation_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text CHECK (from_state IN ('PENDING', 'OBSERVING')),
  to_state text NOT NULL CHECK (to_state IN ('PENDING', 'OBSERVING', 'PASSED', 'FAILED', 'EXPIRED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('SERVICE', 'WORKER', 'HUMAN')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evaluation_id, sequence),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES recovery_evaluations (tenant_id, id),
  CHECK ((from_state IS NULL) = (sequence = 1 AND to_state = 'PENDING')),
  CHECK (from_state IS NULL OR coalesce(ub_recovery_evaluation_edge_ok(from_state, to_state), false))
);
SELECT ub_make_append_only('recovery_evaluation_transitions');

CREATE TABLE recovery_evaluation_channels (
  tenant_id text NOT NULL REFERENCES tenants (id),
  evaluation_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 16),
  device_id text NOT NULL,
  device_assignment_id text NOT NULL,
  channel_id text NOT NULL,
  channel_revision_id text NOT NULL,
  calibration_revision integer NOT NULL CHECK (calibration_revision >= 1),
  asset_revision_id text NOT NULL,
  PRIMARY KEY (tenant_id, evaluation_id, ordinal),
  UNIQUE (tenant_id, evaluation_id, channel_id),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES recovery_evaluations (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id, device_assignment_id) REFERENCES device_asset_assignments (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, device_id, channel_id) REFERENCES sensor_channels (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, channel_id, channel_revision_id) REFERENCES sensor_channel_revisions (tenant_id, channel_id, id)
);
SELECT ub_make_append_only('recovery_evaluation_channels');

CREATE TABLE recovery_evaluation_samples (
  tenant_id text NOT NULL REFERENCES tenants (id),
  evaluation_id text NOT NULL,
  sample_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100000),
  PRIMARY KEY (tenant_id, evaluation_id, sample_id),
  UNIQUE (tenant_id, evaluation_id, ordinal),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES recovery_evaluations (tenant_id, id),
  FOREIGN KEY (tenant_id, sample_id) REFERENCES telemetry_samples (tenant_id, id)
);
SELECT ub_make_append_only('recovery_evaluation_samples');

CREATE TABLE recovery_evaluation_signoffs (
  tenant_id text NOT NULL REFERENCES tenants (id),
  evaluation_id text NOT NULL,
  requirement text NOT NULL CHECK (requirement IN ('CMMS_WORK_ORDER', 'OPERATOR_ATTESTATION', 'INSTALLED_PART')),
  evidence_id text NOT NULL,
  PRIMARY KEY (tenant_id, evaluation_id, requirement, evidence_id),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES recovery_evaluations (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES recovery_evidence (tenant_id, id)
);
SELECT ub_make_append_only('recovery_evaluation_signoffs');

CREATE TABLE recovery_assessments (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ras')),
  evaluation_id text NOT NULL,
  incident_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  outcome text NOT NULL CHECK (outcome IN ('OBSERVING', 'PASSED', 'FAILED', 'EXPIRED')),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) <= 32),
  evaluated_at timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  window_first_at timestamptz,
  window_last_at timestamptz,
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  stable_ms bigint NOT NULL CHECK (stable_ms >= 0),
  assessment_digest text NOT NULL CHECK (assessment_digest ~ '^recovery-assessment\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('SERVICE', 'WORKER', 'HUMAN')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evaluation_id, sequence),
  FOREIGN KEY (tenant_id, evaluation_id, incident_id) REFERENCES recovery_evaluations (tenant_id, id, incident_id),
  CHECK ((window_first_at IS NULL) = (window_last_at IS NULL)),
  CHECK (outcome <> 'PASSED' OR (window_first_at IS NOT NULL AND sample_count >= 2 AND cardinality(reason_codes) = 0))
);
SELECT ub_make_append_only('recovery_assessments');

-- Evaluation guard: creation re-derives every binding from the incident and the milestone; pinned columns never change;
-- state changes follow the machine with a version bump; PASSED needs the policy's samples and signoffs pinned first.
CREATE FUNCTION ub_recovery_evaluation_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['state', 'state_reason', 'decided_at', 'version', 'updated_at'];
  p recovery_policy_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM incidents i
        JOIN intervention_milestones m ON m.tenant_id = i.tenant_id AND m.incident_id = i.id
        JOIN evidence_revisions er ON er.tenant_id = i.tenant_id AND er.incident_id = i.id
        JOIN recovery_policy_revisions rp ON rp.tenant_id = i.tenant_id AND rp.id = NEW.recovery_policy_revision_id
       WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.incident_id AND i.state = 'VERIFYING'
         -- The evaluation is governed by exactly the policy its milestone pinned: its window and observation limit.
         AND m.recovery_policy_revision_id = NEW.recovery_policy_revision_id
         AND NEW.stable_window_ms = rp.stable_window_ms
         AND NEW.expires_at = NEW.observation_boundary_at + rp.max_observation_ms * interval '1 millisecond'
         AND m.id = NEW.milestone_id AND er.id = NEW.evidence_revision_id
         AND NEW.state = 'PENDING' AND NEW.version = 1 AND NEW.decided_at IS NULL AND NEW.state_reason IS NULL
         AND NEW.observation_boundary_at = m.occurred_at
         AND m.plan_id = NEW.plan_id AND m.plan_action_id = NEW.plan_action_id AND m.action_digest = NEW.action_digest
         AND m.asset_revision_id = NEW.asset_revision_id AND i.asset_revision_id = NEW.asset_revision_id
         AND m.recovery_cycle = NEW.recovery_cycle AND i.reopen_count = NEW.recovery_cycle
         AND i.rule_revision_id = NEW.rule_revision_id
    ) THEN
      RAISE EXCEPTION 'recovery evaluation bindings do not match the incident and its milestone' USING ERRCODE = 'UB201';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recovery evaluation bindings are immutable' USING ERRCODE = 'UB201';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'recovery evaluation version must advance by one' USING ERRCODE = 'UB201';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND coalesce(ub_recovery_evaluation_edge_ok(OLD.state, NEW.state), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'illegal recovery evaluation transition % -> %', OLD.state, NEW.state USING ERRCODE = 'UB201';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state AND OLD.state IN ('PASSED', 'FAILED', 'EXPIRED') THEN
    RAISE EXCEPTION 'a decided recovery evaluation is immutable' USING ERRCODE = 'UB201';
  END IF;
  IF NEW.state = 'PASSED' AND OLD.state IS DISTINCT FROM 'PASSED' THEN
    -- Serialize with disputes and revocations of the evidence behind the decision: a dispute insert needs a key-share
    -- lock on its evidence row and a revocation updates the integration row, so whichever commits first is seen by the
    -- other (READ COMMITTED re-reads after the lock wait).
    PERFORM 1 FROM recovery_evidence e
     WHERE e.tenant_id = NEW.tenant_id
       AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                      WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
         OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                     WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id))
     ORDER BY e.id FOR UPDATE;
    PERFORM 1 FROM cmms_integrations ci
     WHERE ci.tenant_id = NEW.tenant_id AND ci.id IN (
       SELECT e.cmms_integration_id FROM recovery_evidence e
        WHERE e.tenant_id = NEW.tenant_id AND e.cmms_integration_id IS NOT NULL
          AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                         WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
            OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id)))
     ORDER BY ci.id FOR SHARE;
    -- Attesters behind the decision: share-lock their role assignments and memberships (role revocation and membership
    -- suspension UPDATE exactly these rows, so they serialize with this decision), then require for each
    -- authorized-operator row an unrevoked assignment of the stored role at the site (or tenant-wide), an ACTIVE
    -- membership and a role the pinned policy names.
    PERFORM 1 FROM role_assignments ra
     WHERE ra.tenant_id = NEW.tenant_id AND ra.user_id IN (
       SELECT e.attester_user_id FROM recovery_evidence e
        WHERE e.tenant_id = NEW.tenant_id AND e.source_kind = 'AUTHORIZED_OPERATOR'
          AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                         WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
            OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id)))
     ORDER BY ra.id FOR SHARE;
    PERFORM 1 FROM tenant_memberships tm
     WHERE tm.tenant_id = NEW.tenant_id AND tm.user_id IN (
       SELECT e.attester_user_id FROM recovery_evidence e
        WHERE e.tenant_id = NEW.tenant_id AND e.source_kind = 'AUTHORIZED_OPERATOR'
          AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                         WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
            OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id)))
     ORDER BY tm.id FOR SHARE;
    IF EXISTS (
      SELECT 1 FROM recovery_evidence e
       WHERE e.tenant_id = NEW.tenant_id AND e.source_kind = 'AUTHORIZED_OPERATOR'
         AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                        WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
           OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                       WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id))
         AND coalesce(
               EXISTS (SELECT 1 FROM recovery_policy_revisions rp
                        WHERE rp.tenant_id = NEW.tenant_id AND rp.id = NEW.recovery_policy_revision_id
                          AND e.attester_role = ANY (rp.attestation_roles))
               AND EXISTS (
                 SELECT 1 FROM role_assignments ra
                   JOIN tenant_memberships tm ON tm.tenant_id = ra.tenant_id AND tm.user_id = ra.user_id
                  WHERE ra.tenant_id = e.tenant_id AND ra.user_id = e.attester_user_id AND ra.role = e.attester_role
                    AND ra.revoked_at IS NULL AND (ra.site_id IS NULL OR ra.site_id = NEW.site_id)
                    AND tm.status = 'ACTIVE'),
               false) IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'a PASSED recovery evaluation cannot rest on an attester without the policy role'
        USING ERRCODE = 'UB201';
    END IF;
    IF EXISTS (
      SELECT 1 FROM recovery_evidence e
       WHERE e.tenant_id = NEW.tenant_id
         AND (e.id IN (SELECT g.evidence_id FROM recovery_evaluation_signoffs g
                        WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id)
           OR e.id = (SELECT m.source_evidence_id FROM intervention_milestones m
                       WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.milestone_id))
         AND (EXISTS (SELECT 1 FROM recovery_evidence_disputes d WHERE d.tenant_id = e.tenant_id AND d.evidence_id = e.id)
           OR EXISTS (SELECT 1 FROM cmms_integrations ci WHERE ci.tenant_id = e.tenant_id AND ci.id = e.cmms_integration_id
                        AND ci.revoked_at IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'a PASSED recovery evaluation cannot rest on disputed or revoked evidence' USING ERRCODE = 'UB201';
    END IF;
    SELECT * INTO p FROM recovery_policy_revisions WHERE tenant_id = NEW.tenant_id AND id = NEW.recovery_policy_revision_id;
    IF coalesce((SELECT count(*) FROM recovery_evaluation_samples s
                  WHERE s.tenant_id = NEW.tenant_id AND s.evaluation_id = NEW.id) >= p.min_samples, false) IS NOT TRUE
       OR NOT EXISTS (SELECT 1 FROM recovery_evaluation_channels c
                       WHERE c.tenant_id = NEW.tenant_id AND c.evaluation_id = NEW.id)
       OR EXISTS (SELECT 1 FROM unnest(p.required_signoffs) AS r(requirement)
                   WHERE NOT EXISTS (SELECT 1 FROM recovery_evaluation_signoffs g
                                      WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id
                                        AND g.requirement = r.requirement))
       OR (coalesce(p.installed_part_required, true)
           AND NOT EXISTS (SELECT 1 FROM recovery_evaluation_signoffs g
                            WHERE g.tenant_id = NEW.tenant_id AND g.evaluation_id = NEW.id
                              AND g.requirement = 'INSTALLED_PART')) THEN
      RAISE EXCEPTION 'a PASSED recovery evaluation needs its pinned samples and every required signoff'
        USING ERRCODE = 'UB201';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_evaluations_guard BEFORE INSERT OR UPDATE ON recovery_evaluations
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_evaluation_guard();
CREATE TRIGGER recovery_evaluations_no_delete BEFORE DELETE ON recovery_evaluations
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER recovery_evaluations_no_truncate BEFORE TRUNCATE ON recovery_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- Channel pins are written at creation (PENDING) and must be the asset's open assignment/channel revisions of the
-- incident rule's channel kind on a non-revoked device.
CREATE FUNCTION ub_recovery_channel_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_evaluations ev
      JOIN incident_rule_revisions rr ON rr.tenant_id = ev.tenant_id AND rr.id = ev.rule_revision_id
      JOIN device_asset_assignments a ON a.tenant_id = ev.tenant_id AND a.id = NEW.device_assignment_id
      JOIN sensor_channel_revisions c ON c.tenant_id = ev.tenant_id AND c.id = NEW.channel_revision_id
      JOIN devices d ON d.tenant_id = ev.tenant_id AND d.id = NEW.device_id
     WHERE ev.tenant_id = NEW.tenant_id AND ev.id = NEW.evaluation_id AND ev.state = 'PENDING'
       AND a.device_id = NEW.device_id AND a.asset_id = ev.asset_id AND a.asset_revision_id = ev.asset_revision_id
       AND a.valid_to IS NULL AND NEW.asset_revision_id = ev.asset_revision_id
       AND c.channel_id = NEW.channel_id AND c.valid_to IS NULL AND c.kind = rr.channel_kind
       AND c.calibration_revision = NEW.calibration_revision AND d.status <> 'REVOKED'
  ) THEN
    RAISE EXCEPTION 'recovery channel pin is not an open binding of the evaluated asset' USING ERRCODE = 'UB201';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_evaluation_channels_guard BEFORE INSERT ON recovery_evaluation_channels
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_channel_pin_guard();

-- Only a qualifying sample can be pinned to an observing evaluation: on a pinned channel with the exact pinned
-- assignment/channel/asset revisions, LIVE and live-delivered, flag-free, physical unless the pinned policy allows
-- simulated input, in the incident rule's safe range, from a non-revoked device, strictly after the boundary, and not
-- linked as fault evidence of another incident.
CREATE FUNCTION ub_recovery_sample_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_evaluations ev
      JOIN recovery_evaluation_channels pc ON pc.tenant_id = ev.tenant_id AND pc.evaluation_id = ev.id
      JOIN telemetry_samples s ON s.tenant_id = ev.tenant_id AND s.id = NEW.sample_id
      JOIN incident_rule_revisions rr ON rr.tenant_id = ev.tenant_id AND rr.id = ev.rule_revision_id
      JOIN recovery_policy_revisions p ON p.tenant_id = ev.tenant_id AND p.id = ev.recovery_policy_revision_id
      JOIN devices d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
     WHERE ev.tenant_id = NEW.tenant_id AND ev.id = NEW.evaluation_id AND ev.state = 'OBSERVING'
       AND s.channel_id = pc.channel_id AND s.channel_revision_id = pc.channel_revision_id
       AND s.device_assignment_id = pc.device_assignment_id AND s.asset_revision_id = pc.asset_revision_id
       AND s.asset_id = ev.asset_id AND s.calibration_revision = pc.calibration_revision
       AND s.event_at > ev.observation_boundary_at
       AND s.ingestion_class = 'LIVE' AND s.delivery = 'LIVE' AND cardinality(s.quality_flags) = 0
       AND (s.input_origin = 'PHYSICAL_SENSOR' OR p.allow_simulated_input)
       AND d.status <> 'REVOKED'
       AND ((rr.comparator = 'ABOVE' AND s.value_int <= rr.threshold_int - rr.hysteresis_int)
         OR (rr.comparator = 'BELOW' AND s.value_int >= rr.threshold_int + rr.hysteresis_int))
       AND NOT EXISTS (
         SELECT 1 FROM incident_signal_samples ss
           JOIN incident_signals sg ON sg.tenant_id = ss.tenant_id AND sg.id = ss.signal_id
          WHERE ss.tenant_id = s.tenant_id AND ss.sample_id = s.id AND sg.incident_id <> ev.incident_id)
  ) THEN
    RAISE EXCEPTION 'telemetry sample does not qualify for this recovery evaluation' USING ERRCODE = 'UB201';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_evaluation_samples_guard BEFORE INSERT ON recovery_evaluation_samples
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_sample_pin_guard();

-- Signoff pins: undisputed evidence of the same incident, plan and action; a CMMS work order only from an active
-- integration of the incident's site; an attestation only from an authorized human; an installed part only with the
-- approved action's exact manufacturer and part number and a serial, from verified CMMS or attested evidence.
CREATE FUNCTION ub_recovery_signoff_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_evaluations ev
      JOIN recovery_evidence e ON e.tenant_id = ev.tenant_id AND e.id = NEW.evidence_id
      JOIN plan_actions pa ON pa.tenant_id = ev.tenant_id AND pa.plan_id = ev.plan_id AND pa.id = ev.plan_action_id
      JOIN candidate_actions ca ON ca.tenant_id = pa.tenant_id AND ca.id = pa.candidate_action_id
      JOIN recovery_policy_revisions rp ON rp.tenant_id = ev.tenant_id AND rp.id = ev.recovery_policy_revision_id
     WHERE ev.tenant_id = NEW.tenant_id AND ev.id = NEW.evaluation_id AND ev.state = 'OBSERVING'
       AND (e.source_kind <> 'AUTHORIZED_OPERATOR' OR (e.attester_role = ANY (rp.attestation_roles) AND EXISTS (
         SELECT 1 FROM role_assignments ra
           JOIN tenant_memberships tm ON tm.tenant_id = ra.tenant_id AND tm.user_id = ra.user_id AND tm.status = 'ACTIVE'
          WHERE ra.tenant_id = e.tenant_id AND ra.user_id = e.attester_user_id AND ra.role = e.attester_role
            AND ra.revoked_at IS NULL AND (ra.site_id IS NULL OR ra.site_id = ev.site_id))))
       AND e.incident_id = ev.incident_id AND e.plan_id = ev.plan_id AND e.action_digest = ev.action_digest
       AND NOT EXISTS (SELECT 1 FROM recovery_evidence_disputes d WHERE d.tenant_id = e.tenant_id AND d.evidence_id = e.id)
       AND (e.cmms_integration_id IS NULL OR EXISTS (
         SELECT 1 FROM cmms_integrations ci
          WHERE ci.tenant_id = e.tenant_id AND ci.id = e.cmms_integration_id AND ci.site_id = ev.site_id
            AND ci.revoked_at IS NULL))
       AND (
         (NEW.requirement = 'CMMS_WORK_ORDER' AND e.kind = 'CMMS_SIGNOFF' AND e.trust = 'VERIFIED_CMMS')
         OR (NEW.requirement = 'OPERATOR_ATTESTATION' AND e.kind = 'OPERATOR_ATTESTATION' AND e.trust = 'OPERATOR_ATTESTED')
         OR (NEW.requirement = 'INSTALLED_PART' AND e.trust IN ('VERIFIED_CMMS', 'OPERATOR_ATTESTED')
             AND e.part_serial IS NOT NULL AND e.part_number = ca.part_number
             AND e.part_manufacturer = ca.manufacturer)
       )
  ) THEN
    RAISE EXCEPTION 'recovery signoff evidence does not satisfy the requirement' USING ERRCODE = 'UB201';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_evaluation_signoffs_guard BEFORE INSERT ON recovery_evaluation_signoffs
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_signoff_pin_guard();

CREATE TABLE recovery_closeouts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rco')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  evaluation_id text NOT NULL,
  recovery_cycle integer NOT NULL CHECK (recovery_cycle >= 0),
  plan_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  milestone_id text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^recovery-closeout\.v1:sha256:[0-9a-f]{64}$'),
  decision_signature text NOT NULL CHECK (decision_signature ~ '^hmac-sha256:[0-9a-f]{64}$'),
  signature_key_id text NOT NULL CHECK (length(signature_key_id) BETWEEN 1 AND 128),
  decided_at timestamptz NOT NULL,
  reopened_at timestamptz,
  reopen_reason_code text CHECK (reopen_reason_code IS NULL OR reopen_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  reopen_ref text CHECK (reopen_ref IS NULL OR reopen_ref ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evaluation_id),
  UNIQUE (tenant_id, incident_id, recovery_cycle),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, evaluation_id, incident_id) REFERENCES recovery_evaluations (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, milestone_id, incident_id) REFERENCES intervention_milestones (tenant_id, id, incident_id),
  CHECK ((reopened_at IS NULL) = (reopen_reason_code IS NULL) AND (reopened_at IS NULL) = (reopen_ref IS NULL))
);
SELECT ub_make_append_only('recovery_closeouts', 'reopened_at', 'reopen_reason_code', 'reopen_ref');

CREATE FUNCTION ub_recovery_closeout_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_evaluations ev
     WHERE ev.tenant_id = NEW.tenant_id AND ev.id = NEW.evaluation_id AND ev.incident_id = NEW.incident_id
       AND ev.state = 'PASSED' AND ev.recovery_cycle = NEW.recovery_cycle AND ev.plan_id = NEW.plan_id
       AND ev.action_digest = NEW.action_digest AND ev.milestone_id = NEW.milestone_id AND ev.site_id = NEW.site_id
  ) OR NEW.reopened_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closeout needs the PASSED evaluation of the same incident, cycle and action'
      USING ERRCODE = 'UB202';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_closeouts_guard BEFORE INSERT ON recovery_closeouts
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_closeout_guard();

-- At commit, the incident's RECOVERED transition naming this evaluation must exist (it is written by M04's internal
-- recovery hook in the same transaction): a closeout can never be committed apart from the transition.
CREATE FUNCTION ub_recovery_closeout_commit_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM incident_transitions t
     WHERE t.tenant_id = NEW.tenant_id AND t.incident_id = NEW.incident_id AND t.to_state = 'RECOVERED'
       AND t.guard_ref = NEW.evaluation_id
  ) THEN
    RAISE EXCEPTION 'a closeout commits only with the RECOVERED transition of its evaluation' USING ERRCODE = 'UB202';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER recovery_closeouts_commit_guard AFTER INSERT ON recovery_closeouts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ub_recovery_closeout_commit_guard();

CREATE TABLE recovery_command_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  command_type text NOT NULL CHECK (command_type ~ '^recovery\.[a-z_]+\.v[1-9]$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER', 'INTEGRATION')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
SELECT ub_make_append_only('recovery_command_receipts');

-- CMMS outbox: one row per idempotency key, on the EXTERNAL_ACTION outcome vocabulary (INV-12). AUTHORIZED = queued by
-- an authorized closeout/fact; leaving AUTHORIZED requires the durable pre-send marker; capability UNSUPPORTED is a
-- pre-egress disposition only.
CREATE TABLE cmms_work_order_updates (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cwu')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  update_kind text NOT NULL CHECK (update_kind IN ('ORDER_FACT', 'JOB_FACT', 'CLOSEOUT', 'REOPEN')),
  source_type text NOT NULL CHECK (source_type IN ('purchase_order', 'service_job', 'recovery_closeout')),
  source_id text NOT NULL CHECK (source_id ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  source_version integer NOT NULL CHECK (source_version >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^cmms:[A-Za-z0-9._:-]{8,200}$'),
  work_order_key text NOT NULL CHECK (work_order_key ~ '^inc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  external_outcome_state text NOT NULL DEFAULT 'AUTHORIZED' CHECK (external_outcome_state IN ('AUTHORIZED', 'REQUESTED',
    'ACCEPTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED')),
  adapter_capability text NOT NULL DEFAULT 'ELIGIBLE' CHECK (adapter_capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  capability_reason text CHECK (capability_reason IS NULL OR capability_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  send_started_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  lease_expires_at timestamptz,
  external_update_ref text CHECK (external_update_ref IS NULL OR external_update_ref ~ '^[\x21-\x7E]{1,128}$'),
  last_reason_code text CHECK (last_reason_code IS NULL OR last_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, update_kind, source_id, source_version),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (work_order_key = incident_id),
  CHECK (external_outcome_state <> 'CONFIRMED' OR external_update_ref IS NOT NULL)
);
CREATE INDEX cmms_work_order_updates_due_ix ON cmms_work_order_updates (tenant_id, next_attempt_at)
  WHERE external_outcome_state IN ('AUTHORIZED', 'UNKNOWN');

CREATE FUNCTION ub_cmms_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bookkeeping text[] := ARRAY['external_outcome_state', 'adapter_capability', 'capability_reason', 'send_started_at',
    'attempts', 'next_attempt_at', 'lease_owner', 'lease_expires_at', 'external_update_ref', 'last_reason_code',
    'version', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.external_outcome_state IS DISTINCT FROM 'AUTHORIZED' OR NEW.version IS DISTINCT FROM 1
       OR NEW.send_started_at IS NOT NULL OR NEW.attempts IS DISTINCT FROM 0 OR NEW.external_update_ref IS NOT NULL THEN
      RAISE EXCEPTION 'a CMMS update is queued AUTHORIZED at version 1 with nothing sent' USING ERRCODE = 'UB203';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
    RAISE EXCEPTION 'CMMS update identity and payload are immutable' USING ERRCODE = 'UB203';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'CMMS update version must advance by one' USING ERRCODE = 'UB203';
  END IF;
  IF NEW.external_outcome_state IS DISTINCT FROM OLD.external_outcome_state
     AND coalesce(ub_external_outcome_edge_ok(OLD.external_outcome_state, NEW.external_outcome_state), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'illegal CMMS outcome transition % -> %', OLD.external_outcome_state, NEW.external_outcome_state
      USING ERRCODE = 'UB203';
  END IF;
  IF OLD.send_started_at IS NOT NULL AND NEW.send_started_at IS DISTINCT FROM OLD.send_started_at
     OR OLD.external_update_ref IS NOT NULL AND NEW.external_update_ref IS DISTINCT FROM OLD.external_update_ref
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'CMMS send marker, external reference and attempt count are set-once/monotonic'
      USING ERRCODE = 'UB203';
  END IF;
  IF NEW.external_outcome_state IS DISTINCT FROM 'AUTHORIZED' AND NEW.send_started_at IS NULL THEN
    RAISE EXCEPTION 'a CMMS outcome beyond AUTHORIZED needs the durable send marker' USING ERRCODE = 'UB203';
  END IF;
  IF OLD.adapter_capability = 'UNSUPPORTED' AND NEW.adapter_capability = 'ELIGIBLE' AND OLD.send_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'post-send capability loss never relabels the effect' USING ERRCODE = 'UB203';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cmms_work_order_updates_guard BEFORE INSERT OR UPDATE ON cmms_work_order_updates
  FOR EACH ROW EXECUTE FUNCTION ub_cmms_update_guard();
CREATE TRIGGER cmms_work_order_updates_no_delete BEFORE DELETE ON cmms_work_order_updates
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER cmms_work_order_updates_no_truncate BEFORE TRUNCATE ON cmms_work_order_updates
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE cmms_write_attempts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cwa')),
  update_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  mode text NOT NULL CHECK (mode IN ('WRITE', 'LOOKUP')),
  adapter_kind text NOT NULL CHECK (adapter_kind IN ('CONTRACT_FAKE', 'HTTPS_CMMS')),
  adapter_label text NOT NULL CHECK (adapter_label IN ('CONTRACT_FAKE', 'LIVE')),
  outcome text NOT NULL CHECK (outcome IN ('CONFIRMED', 'UNKNOWN', 'FAILED', 'UNSUPPORTED', 'NOT_FOUND')),
  external_update_ref text CHECK (external_update_ref IS NULL OR external_update_ref ~ '^[\x21-\x7E]{1,128}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  worker_id text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, update_id, attempt),
  FOREIGN KEY (tenant_id, update_id) REFERENCES cmms_work_order_updates (tenant_id, id),
  CHECK (outcome <> 'CONFIRMED' OR external_update_ref IS NOT NULL)
);
SELECT ub_make_append_only('cmms_write_attempts');
