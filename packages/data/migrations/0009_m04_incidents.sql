-- M04 incident engine (FR-03, FR-04, FR-16, INV-09, NFR-03, NFR-08). Immutable incident rules and operating
-- procedures; one incident aggregate per tenant/site/asset/fault window whose dedupe key is computed by the database
-- and guarded by a partial unique index (INV-09: convergence is enforced here, never by queue order); append-only
-- transitions, corroborating signals (device samples linked by foreign key and LIVE-only), manual reports with
-- attachments, superseding assignments with one current owner, replayable deadline events under the pinned procedure,
-- non-authoritative risk estimates and idempotent command receipts. Finally the M02 incident_id columns gain their
-- composite tenant foreign keys.

-- Typed, immutable SOP revisions. The deadline rule, its basis, the permitted adjustments and the initial owner are
-- columns, not free JSON; a later revision never changes an incident that already pinned an earlier one.
CREATE TABLE operating_procedure_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'opr')),
  procedure_key text NOT NULL CHECK (procedure_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  revision integer NOT NULL CHECK (revision >= 1),
  deadline_kind text NOT NULL CHECK (deadline_kind IN ('RESPONSE', 'CONTAINMENT')),
  deadline_basis text NOT NULL CHECK (deadline_basis IN ('TRIGGER_EVENT_AT', 'OPENED_AT')),
  response_deadline_ms bigint NOT NULL CHECK (response_deadline_ms BETWEEN 60000 AND 604800000),
  pause_allowed boolean NOT NULL,
  max_extension_ms bigint NOT NULL CHECK (max_extension_ms BETWEEN 0 AND 604800000),
  adjust_role text NOT NULL CHECK (adjust_role IN ('operator', 'maintenance_approver', 'engineer', 'admin')),
  initial_assignee_user_id text NOT NULL,
  timezone_basis text NOT NULL CHECK (timezone_basis IN ('SITE_LOCAL', 'UTC')),
  body_digest text NOT NULL CHECK (body_digest ~ '^incident-procedure\.v1:sha256:[0-9a-f]{64}$'),
  effective_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_user_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, procedure_key, revision),
  UNIQUE (tenant_id, procedure_key, effective_at),
  FOREIGN KEY (tenant_id, initial_assignee_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK (effective_at >= published_at - interval '5 seconds')
);
SELECT ub_make_append_only('operating_procedure_revisions');

-- Immutable threshold/window rules evaluated on event time over LIVE samples only. A rule names its fault window
-- (the dedupe dimension), the procedure whose active revision an opening pins, and the post-recovery watch window.
CREATE TABLE incident_rule_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'irl')),
  rule_key text NOT NULL CHECK (rule_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  site_id text,
  asset_id text,
  channel_kind text NOT NULL CHECK (channel_kind IN ('TEMPERATURE', 'CURRENT', 'POWER', 'DOOR')),
  comparator text NOT NULL CHECK (comparator IN ('ABOVE', 'BELOW')),
  threshold_int bigint NOT NULL CHECK (threshold_int BETWEEN -1000000000 AND 1000000000),
  hysteresis_int bigint NOT NULL CHECK (hysteresis_int BETWEEN 0 AND 1000000000),
  duration_ms bigint NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
  min_samples integer NOT NULL CHECK (min_samples BETWEEN 1 AND 1000),
  quorum_channels integer NOT NULL CHECK (quorum_channels BETWEEN 1 AND 16),
  max_gap_ms bigint NOT NULL CHECK (max_gap_ms BETWEEN 1000 AND 3600000),
  max_evaluation_lag_ms bigint NOT NULL CHECK (max_evaluation_lag_ms BETWEEN 1000 AND 3600000),
  stale_behavior text NOT NULL CHECK (stale_behavior IN ('HOLD', 'ESCALATE_ACTIVE')),
  fault_window_key text NOT NULL CHECK (fault_window_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  fault_family text NOT NULL CHECK (fault_family ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  urgency text NOT NULL CHECK (urgency IN ('CRITICAL', 'HIGH', 'NORMAL')),
  watch_window_ms bigint NOT NULL CHECK (watch_window_ms BETWEEN 0 AND 2592000000),
  recovery_window_ms bigint NOT NULL CHECK (recovery_window_ms BETWEEN 60000 AND 604800000),
  procedure_key text NOT NULL CHECK (procedure_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  body_digest text NOT NULL CHECK (body_digest ~ '^incident-rule\.v1:sha256:[0-9a-f]{64}$'),
  effective_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_user_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, rule_key, revision),
  UNIQUE (tenant_id, rule_key, effective_at),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES assets (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK (asset_id IS NULL OR site_id IS NOT NULL),
  CHECK (effective_at >= published_at - interval '5 seconds')
);
SELECT ub_make_append_only('incident_rule_revisions');

-- INV-09 dedupe key = digest(tenant_id, site_id, asset_id, fault_window_id), computed by the database so no writer
-- can choose it. Identifier and window-key grammars exclude '|', so the preimage is unambiguous.
CREATE FUNCTION ub_incident_dedupe_key(tenant_id text, site_id text, asset_id text, fault_window_key text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT 'incident-dedupe.v1:sha256:' || encode(sha256(convert_to(
    'incident-dedupe.v1|' || tenant_id || '|' || site_id || '|' || asset_id || '|' || fault_window_key, 'UTF8')), 'hex') $$;

CREATE TABLE incidents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'inc')),
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  rule_revision_id text NOT NULL,
  procedure_revision_id text NOT NULL,
  policy_revision_id text,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('TELEMETRY_RULE', 'MANUAL_REPORT')),
  trigger_input_origin text NOT NULL CHECK (trigger_input_origin IN ('PHYSICAL_SENSOR', 'SIMULATED_INPUT', 'OPERATOR_REPORT')),
  state text NOT NULL CHECK (state IN ('DETECTED', 'TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING', 'AWAITING_APPROVAL',
    'EXECUTING', 'VERIFYING', 'RECOVERED', 'ESCALATED', 'PAUSED', 'REOPENED')),
  paused_from_state text CHECK (paused_from_state IN ('TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING',
    'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING')),
  fault_family text NOT NULL CHECK (fault_family ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  fault_window_key text NOT NULL CHECK (fault_window_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  dedupe_key text GENERATED ALWAYS AS (ub_incident_dedupe_key(tenant_id, site_id, asset_id, fault_window_key)) STORED,
  urgency text NOT NULL CHECK (urgency IN ('CRITICAL', 'HIGH', 'NORMAL')),
  signal_state text NOT NULL DEFAULT 'LIVE' CHECK (signal_state IN ('LIVE', 'UNCERTAIN')),
  trigger_event_at timestamptz NOT NULL,
  trigger_received_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL,
  open_latency_ms bigint NOT NULL CHECK (open_latency_ms >= 0),
  deadline_kind text NOT NULL CHECK (deadline_kind IN ('RESPONSE', 'CONTAINMENT')),
  deadline_basis text NOT NULL CHECK (deadline_basis IN ('TRIGGER_EVENT_AT', 'OPENED_AT')),
  deadline_basis_at timestamptz NOT NULL,
  deadline_computed_at timestamptz NOT NULL,
  deadline_basis_digest text NOT NULL CHECK (deadline_basis_digest ~ '^incident-deadline-basis\.v1:sha256:[0-9a-f]{64}$'),
  deadline_timezone_basis text NOT NULL CHECK (deadline_timezone_basis ~ '^(UTC|SITE_LOCAL:[A-Za-z_]+(/[A-Za-z0-9_+-]+)*)$'),
  original_response_deadline_at timestamptz NOT NULL,
  current_response_deadline_at timestamptz NOT NULL,
  deadline_status text NOT NULL CHECK (deadline_status IN ('RUNNING', 'PAUSED', 'EXPIRED')),
  deadline_paused_at timestamptz,
  deadline_extended_ms bigint NOT NULL DEFAULT 0 CHECK (deadline_extended_ms >= 0),
  current_assignment_id text,
  acknowledged_at timestamptz,
  acknowledged_by_user_id text,
  recovered_at timestamptz,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr')),
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, site_id),
  UNIQUE (tenant_id, id, site_id, asset_id),
  UNIQUE (tenant_id, id, procedure_revision_id, deadline_basis_digest),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES assets (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, rule_revision_id) REFERENCES incident_rule_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, procedure_revision_id) REFERENCES operating_procedure_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, acknowledged_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK ((state = 'PAUSED') = (paused_from_state IS NOT NULL)),
  CHECK ((state = 'RECOVERED') = (recovered_at IS NOT NULL)),
  CHECK ((deadline_status = 'PAUSED') = (deadline_paused_at IS NOT NULL)),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL))
);
-- INV-09: at most one non-recovered incident per tenant and dedupe key, whatever the writers' arrival order.
CREATE UNIQUE INDEX incidents_one_active_ux ON incidents (tenant_id, dedupe_key) WHERE state <> 'RECOVERED';
CREATE INDEX incidents_state_ix ON incidents (tenant_id, state, updated_at);
CREATE INDEX incidents_asset_ix ON incidents (tenant_id, asset_id, opened_at);
CREATE INDEX incidents_deadline_ix ON incidents (current_response_deadline_at) WHERE deadline_status = 'RUNNING';

-- Pinned identity, revision, trigger and original-deadline columns are immutable; every change advances the
-- aggregate version by exactly one (compare-and-set happens in the domain command under a row lock).
CREATE FUNCTION ub_incident_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'incident version must advance by exactly one' USING ERRCODE = 'UB041';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.site_id, NEW.asset_id, NEW.asset_revision_id, NEW.rule_revision_id,
      NEW.procedure_revision_id, NEW.policy_revision_id, NEW.trigger_kind, NEW.trigger_input_origin,
      NEW.fault_window_key, NEW.trigger_event_at, NEW.trigger_received_at, NEW.opened_at, NEW.open_latency_ms,
      NEW.deadline_kind, NEW.deadline_basis, NEW.deadline_basis_at, NEW.deadline_computed_at,
      NEW.deadline_basis_digest, NEW.deadline_timezone_basis, NEW.original_response_deadline_at,
      NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.site_id, OLD.asset_id, OLD.asset_revision_id, OLD.rule_revision_id,
      OLD.procedure_revision_id, OLD.policy_revision_id, OLD.trigger_kind, OLD.trigger_input_origin,
      OLD.fault_window_key, OLD.trigger_event_at, OLD.trigger_received_at, OLD.opened_at, OLD.open_latency_ms,
      OLD.deadline_kind, OLD.deadline_basis, OLD.deadline_basis_at, OLD.deadline_computed_at,
      OLD.deadline_basis_digest, OLD.deadline_timezone_basis, OLD.original_response_deadline_at,
      OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'incident pinned references and original deadline are immutable' USING ERRCODE = 'UB042';
  END IF;
  IF OLD.deadline_status = 'EXPIRED' AND NEW.deadline_status <> 'EXPIRED' THEN
    RAISE EXCEPTION 'an expired incident deadline cannot be revived' USING ERRCODE = 'UB042';
  END IF;
  IF NEW.deadline_extended_ms < OLD.deadline_extended_ms THEN
    RAISE EXCEPTION 'incident deadline extension total cannot decrease' USING ERRCODE = 'UB042';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER incidents_update_guard BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION ub_incident_update_guard();
CREATE TRIGGER incidents_no_delete BEFORE DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER incidents_no_truncate BEFORE TRUNCATE ON incidents FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE incident_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'itr')),
  incident_id text NOT NULL,
  incident_version integer NOT NULL CHECK (incident_version >= 1),
  from_state text,
  to_state text NOT NULL,
  paused_from_state text,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  guard_ref text CHECK (guard_ref IS NULL OR guard_ref ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, incident_version),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  CHECK ((from_state IS NULL) = (incident_version = 1 AND to_state = 'DETECTED'))
);
SELECT ub_make_append_only('incident_transitions');

-- Superseding owner assignments: exactly one current row per incident; acceptance and supersession are one-shot
-- stamps; the assignee is a member of the same tenant (composite FK), so a foreign principal can never own it.
CREATE TABLE incident_assignments (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ias')),
  incident_id text NOT NULL,
  assignee_user_id text NOT NULL,
  assignment_kind text NOT NULL CHECK (assignment_kind IN ('INITIAL', 'ASSIGN', 'HANDOFF')),
  assigned_by_kind text NOT NULL CHECK (assigned_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  assigned_by_id text NOT NULL CHECK (length(assigned_by_id) BETWEEN 1 AND 128),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  next_action_due_at timestamptz,
  handoff_from_assignment_id text,
  handoff_digest text CHECK (handoff_digest IS NULL OR handoff_digest ~ '^incident-handoff\.v1:sha256:[0-9a-f]{64}$'),
  incident_version integer NOT NULL CHECK (incident_version >= 1),
  accepted_at timestamptz,
  superseded_at timestamptz,
  superseded_by_assignment_id text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, incident_id, handoff_from_assignment_id) REFERENCES incident_assignments (tenant_id, incident_id, id),
  FOREIGN KEY (tenant_id, incident_id, superseded_by_assignment_id)
    REFERENCES incident_assignments (tenant_id, incident_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((superseded_at IS NULL) = (superseded_by_assignment_id IS NULL)),
  CHECK (accepted_at IS NULL OR superseded_at IS NULL OR accepted_at <= superseded_at),
  CHECK ((assignment_kind = 'HANDOFF') = (handoff_from_assignment_id IS NOT NULL AND handoff_digest IS NOT NULL)),
  CHECK (superseded_by_assignment_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX incident_assignments_one_current_ux ON incident_assignments (tenant_id, incident_id)
  WHERE superseded_at IS NULL;
SELECT ub_make_append_only('incident_assignments', 'accepted_at', 'superseded_at', 'superseded_by_assignment_id');
ALTER TABLE incidents ADD CONSTRAINT incidents_current_assignment_fk
  FOREIGN KEY (tenant_id, id, current_assignment_id) REFERENCES incident_assignments (tenant_id, incident_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Append-only deadline ledger. Each row names the incident's own pinned procedure revision and basis digest (the
-- composite FK makes any other procedure impossible); replaying the rows in sequence derives the projection.
CREATE TABLE incident_deadline_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'idl')),
  incident_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL CHECK (event_type IN ('SET', 'PAUSE', 'RESUME', 'SHORTEN', 'EXTEND', 'EXPIRE')),
  prior_deadline_at timestamptz,
  new_deadline_at timestamptz NOT NULL,
  prior_status text CHECK (prior_status IN ('RUNNING', 'PAUSED', 'EXPIRED')),
  new_status text NOT NULL CHECK (new_status IN ('RUNNING', 'PAUSED', 'EXPIRED')),
  effective_at timestamptz NOT NULL,
  procedure_revision_id text NOT NULL,
  basis_digest text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  authorized_by_kind text NOT NULL CHECK (authorized_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  authorized_by_id text NOT NULL CHECK (length(authorized_by_id) BETWEEN 1 AND 128),
  authorized_role text,
  approved_at timestamptz NOT NULL,
  incident_version integer NOT NULL CHECK (incident_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, sequence),
  FOREIGN KEY (tenant_id, incident_id, procedure_revision_id, basis_digest)
    REFERENCES incidents (tenant_id, id, procedure_revision_id, deadline_basis_digest),
  CHECK ((sequence = 1) = (event_type = 'SET')),
  CHECK ((event_type = 'SET') = (prior_deadline_at IS NULL AND prior_status IS NULL)),
  CHECK (event_type <> 'SHORTEN' OR new_deadline_at < prior_deadline_at),
  CHECK (event_type <> 'EXTEND' OR new_deadline_at > prior_deadline_at),
  CHECK (event_type NOT IN ('PAUSE', 'EXPIRE') OR new_deadline_at = prior_deadline_at),
  CHECK (event_type <> 'RESUME' OR new_deadline_at >= prior_deadline_at),
  CHECK (event_type <> 'PAUSE' OR (prior_status = 'RUNNING' AND new_status = 'PAUSED')),
  CHECK (event_type <> 'RESUME' OR (prior_status = 'PAUSED' AND new_status = 'RUNNING')),
  CHECK (event_type <> 'EXPIRE' OR (prior_status = 'RUNNING' AND new_status = 'EXPIRED')),
  CHECK (event_type NOT IN ('SHORTEN', 'EXTEND') OR (prior_status = 'RUNNING' AND new_status = 'RUNNING')),
  CHECK (event_type <> 'SET' OR new_status = 'RUNNING')
);
SELECT ub_make_append_only('incident_deadline_events');

-- An authorized human report. It carries actor, reason and attachments, never device evidence.
CREATE TABLE incident_manual_reports (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'imr')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  report_kind text NOT NULL CHECK (report_kind IN ('FAULT_REPORT', 'REOPEN_EVIDENCE')),
  rule_revision_id text NOT NULL,
  reported_by_user_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  observed_at timestamptz NOT NULL,
  report_digest text NOT NULL CHECK (report_digest ~ '^incident-manual-report\.v1:sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, rule_revision_id) REFERENCES incident_rule_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, reported_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);
SELECT ub_make_append_only('incident_manual_reports');

CREATE TABLE incident_manual_report_attachments (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL DEFAULT ('ima_' || gen_random_uuid()) CHECK (ub_id_ok(id, 'ima')),
  report_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  blob_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('PHOTO', 'DOCUMENT', 'OTHER')),
  PRIMARY KEY (tenant_id, report_id, ordinal),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, report_id, blob_id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES incident_manual_reports (tenant_id, id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES evidence_blobs (tenant_id, id)
);
SELECT ub_make_append_only('incident_manual_report_attachments');

-- Corroborating signals linked to an incident. The kind fixes the trust and actor: device evidence only comes from
-- the server-side rule evaluator and links real LIVE samples; a human report is operator-attested and sample-free.
CREATE TABLE incident_signals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'isg')),
  incident_id text NOT NULL,
  signal_kind text NOT NULL CHECK (signal_kind IN ('TELEMETRY_TRIGGER', 'MANUAL_REPORT', 'STALE_SIGNAL')),
  trust text NOT NULL CHECK (trust IN ('DEVICE_AUTHENTICATED', 'OPERATOR_ATTESTED', 'SYSTEM_DERIVED')),
  outcome text NOT NULL CHECK (outcome IN ('OPENED', 'ATTACHED', 'REOPENED')),
  input_origin text NOT NULL CHECK (input_origin IN ('PHYSICAL_SENSOR', 'SIMULATED_INPUT', 'OPERATOR_REPORT', 'SYSTEM')),
  rule_revision_id text,
  manual_report_id text,
  window_start_at timestamptz,
  window_end_at timestamptz,
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count BETWEEN 0 AND 500),
  window_sample_total integer NOT NULL DEFAULT 0 CHECK (window_sample_total >= sample_count),
  channel_count integer NOT NULL DEFAULT 0 CHECK (channel_count BETWEEN 0 AND 64),
  peak_value_int bigint,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  signal_digest text NOT NULL CHECK (signal_digest ~ '^incident-signal\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, signal_digest),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_revision_id) REFERENCES incident_rule_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id, manual_report_id) REFERENCES incident_manual_reports (tenant_id, incident_id, id),
  CHECK (window_start_at IS NULL OR window_end_at >= window_start_at),
  CHECK (signal_kind <> 'TELEMETRY_TRIGGER' OR (trust = 'DEVICE_AUTHENTICATED' AND actor_kind IN ('SERVICE', 'WORKER')
    AND sample_count >= 1 AND rule_revision_id IS NOT NULL AND manual_report_id IS NULL
    AND input_origin IN ('PHYSICAL_SENSOR', 'SIMULATED_INPUT') AND window_start_at IS NOT NULL)),
  CHECK (signal_kind <> 'MANUAL_REPORT' OR (trust = 'OPERATOR_ATTESTED' AND actor_kind = 'HUMAN'
    AND sample_count = 0 AND window_sample_total = 0 AND manual_report_id IS NOT NULL
    AND input_origin = 'OPERATOR_REPORT')),
  CHECK (signal_kind <> 'STALE_SIGNAL' OR (trust = 'SYSTEM_DERIVED' AND actor_kind IN ('SERVICE', 'WORKER')
    AND sample_count = 0 AND manual_report_id IS NULL AND input_origin = 'SYSTEM'))
);
CREATE INDEX incident_signals_incident_ix ON incident_signals (tenant_id, incident_id, recorded_at);
SELECT ub_make_append_only('incident_signals');

-- Exact samples behind a device signal, with the assignment/channel/calibration/asset revisions they were stored
-- under. The guard refuses anything but an authenticated LIVE flag-free sample of the incident's asset, and any
-- parent signal that is not device evidence.
CREATE TABLE incident_signal_samples (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL DEFAULT ('iss_' || gen_random_uuid()) CHECK (ub_id_ok(id, 'iss')),
  signal_id text NOT NULL,
  sample_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 500),
  channel_id text NOT NULL,
  channel_revision_id text NOT NULL,
  calibration_revision integer NOT NULL,
  device_assignment_id text NOT NULL,
  asset_revision_id text NOT NULL,
  event_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, signal_id, sample_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, signal_id, ordinal),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES incident_signals (tenant_id, id),
  FOREIGN KEY (tenant_id, sample_id) REFERENCES telemetry_samples (tenant_id, id)
);
CREATE FUNCTION ub_incident_signal_sample_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  s telemetry_samples%ROWTYPE;
  sig_kind text;
  inc_asset text;
BEGIN
  SELECT * INTO s FROM telemetry_samples WHERE tenant_id = NEW.tenant_id AND id = NEW.sample_id;
  SELECT g.signal_kind, i.asset_id INTO sig_kind, inc_asset
    FROM incident_signals g JOIN incidents i ON i.tenant_id = g.tenant_id AND i.id = g.incident_id
   WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.signal_id;
  IF sig_kind IS DISTINCT FROM 'TELEMETRY_TRIGGER' THEN
    RAISE EXCEPTION 'only device telemetry signals may link samples' USING ERRCODE = 'UB043';
  END IF;
  IF s.id IS NULL OR s.ingestion_class <> 'LIVE' OR cardinality(s.quality_flags) <> 0 THEN
    RAISE EXCEPTION 'only LIVE flag-free samples can be incident trigger evidence' USING ERRCODE = 'UB043';
  END IF;
  IF s.asset_id IS DISTINCT FROM inc_asset OR (NEW.channel_id, NEW.channel_revision_id, NEW.calibration_revision,
      NEW.device_assignment_id, NEW.asset_revision_id, NEW.event_at) IS DISTINCT FROM
      (s.channel_id, s.channel_revision_id, s.calibration_revision, s.device_assignment_id, s.asset_revision_id, s.event_at) THEN
    RAISE EXCEPTION 'signal sample revisions must equal the stored sample' USING ERRCODE = 'UB043';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER incident_signal_samples_guard BEFORE INSERT ON incident_signal_samples
  FOR EACH ROW EXECUTE FUNCTION ub_incident_signal_sample_guard();
SELECT ub_make_append_only('incident_signal_samples');

CREATE TABLE incident_acknowledgements (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'iak')),
  incident_id text NOT NULL,
  user_id text NOT NULL,
  incident_version integer NOT NULL CHECK (incident_version >= 1),
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, incident_version),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);
SELECT ub_make_append_only('incident_acknowledgements');

-- Optional food-safety estimate: separate, provenance- and uncertainty-labelled, and never authoritative. Nothing
-- reads it to compute, extend or pause a deadline.
CREATE TABLE incident_risk_estimates (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ire')),
  incident_id text NOT NULL,
  estimate_kind text NOT NULL CHECK (estimate_kind IN ('FOOD_SAFE_TIME')),
  estimator_kind text NOT NULL CHECK (estimator_kind IN ('MODEL', 'RULE', 'OPERATOR')),
  source_revision text NOT NULL CHECK (source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  as_of timestamptz NOT NULL,
  safe_time_remaining_ms bigint NOT NULL CHECK (safe_time_remaining_ms >= 0),
  lower_bound_ms bigint NOT NULL CHECK (lower_bound_ms >= 0),
  upper_bound_ms bigint NOT NULL,
  confidence_ppm integer NOT NULL CHECK (confidence_ppm BETWEEN 0 AND 1000000),
  provenance_digest text NOT NULL CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  authority text NOT NULL DEFAULT 'NON_AUTHORITATIVE' CHECK (authority = 'NON_AUTHORITATIVE'),
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  recorded_by_id text NOT NULL CHECK (length(recorded_by_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  CHECK (lower_bound_ms <= safe_time_remaining_ms AND safe_time_remaining_ms <= upper_bound_ms)
);
SELECT ub_make_append_only('incident_risk_estimates');

-- Idempotency-Key receipts for incident commands (API-EVENT-SPEC §8): same key + same request digest (command type,
-- principal and body) returns the original result; any other use of the key in the tenant is IDEMPOTENCY_KEY_REUSED.
CREATE TABLE incident_command_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL DEFAULT ('icr_' || gen_random_uuid()) CHECK (ub_id_ok(id, 'icr')),
  command_type text NOT NULL CHECK (command_type ~ '^incident\.[a-z_]+\.v1$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  incident_id text,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  principal_kind text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id)
);
SELECT ub_make_append_only('incident_command_receipts');

-- M02 asked M04 to bind its incident_id columns. NOT VALID keeps a forward-only upgrade possible over legacy rows
-- written before incidents existed; every new or changed row is checked. A database without such rows can run
-- VALIDATE CONSTRAINT as a later forward step.
ALTER TABLE evidence_revisions ADD CONSTRAINT evidence_revisions_incident_fk
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id) NOT VALID;
ALTER TABLE evidence_ledger_entries ADD CONSTRAINT evidence_ledger_entries_incident_fk
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id) NOT VALID;
ALTER TABLE approvals ADD CONSTRAINT approvals_incident_fk
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id) NOT VALID;
ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_incident_fk
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id) NOT VALID;
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_incident_fk
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id) NOT VALID;
