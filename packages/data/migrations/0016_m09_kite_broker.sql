-- M09 exclusive Kite payment broker (FR-10, FR-11, FR-12, INV-05, INV-06, INV-07, INV-08, INV-12, INV-13).
-- Immutable signed execution authorities (one per PLAN_ACTION approval) with an append-only local lifecycle, a
-- separately persisted Kite-session activation operation, one budget account per authority whose projection is
-- maintained ONLY by the append-only ledger trigger, economic intents with the cross-authority partial unique index,
-- one external attempt per intent, receipts and replay records. Every state axis is a separate constrained column
-- and every guard below holds even for a caller that bypasses the service layer. SQLSTATEs UB091..UB099.

-- Legal edges, transcribed from @uptimebuyer/domain MACHINES (a unit test compares them exhaustively).
CREATE FUNCTION ub_external_outcome_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (('PROPOSED', 'AUTHORIZED'), ('AUTHORIZED', 'REQUESTED'), ('REQUESTED', 'ACCEPTED'),
    ('ACCEPTED', 'CONFIRMED'), ('REQUESTED', 'FAILED'), ('REQUESTED', 'CANCELLED'), ('ACCEPTED', 'FAILED'),
    ('ACCEPTED', 'CANCELLED'), ('AUTHORIZED', 'UNKNOWN'), ('REQUESTED', 'UNKNOWN'), ('ACCEPTED', 'UNKNOWN'),
    ('UNKNOWN', 'ACCEPTED'), ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED'), ('UNKNOWN', 'CANCELLED')) $$;

CREATE FUNCTION ub_attempt_transport_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (('PREPARED', 'SEND_STARTED'), ('SEND_STARTED', 'ACKNOWLEDGED'), ('SEND_STARTED', 'UNKNOWN'),
    ('SEND_STARTED', 'DEFINITE_NO_EFFECT')) $$;

CREATE FUNCTION ub_economic_intent_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (('CREATED', 'RESERVED'), ('CREATED', 'FAILED'), ('RESERVED', 'SUBMITTED'),
    ('RESERVED', 'UNKNOWN'), ('RESERVED', 'FAILED'), ('SUBMITTED', 'CONFIRMED'), ('SUBMITTED', 'UNKNOWN'),
    ('SUBMITTED', 'FAILED'), ('UNKNOWN', 'SUBMITTED'), ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED'),
    ('UNKNOWN', 'REFUNDED'), ('UNKNOWN', 'REVERSED'), ('CONFIRMED', 'REFUNDED'), ('CONFIRMED', 'REVERSED')) $$;

CREATE FUNCTION ub_execution_authority_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (('ACTIVE', 'SUSPENDED'), ('SUSPENDED', 'ACTIVE'), ('ACTIVE', 'REVOKED'),
    ('SUSPENDED', 'REVOKED'), ('ACTIVE', 'EXPIRED'), ('SUSPENDED', 'EXPIRED')) $$;

-- An approval is executable when it has no lifecycle event and has not expired.
CREATE FUNCTION ub_approval_executable(t text, a text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT EXISTS (SELECT 1 FROM approvals x WHERE x.tenant_id = t AND x.id = a AND x.expires_at > clock_timestamp())
     AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = t AND e.approval_id = a) $$;

-- M09 binds a recorded M02 approval to the M08 approval request it was signed from.
CREATE TABLE plan_approval_bindings (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pab')),
  approval_request_id text NOT NULL,
  approval_id text NOT NULL,
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, approval_id),
  UNIQUE (tenant_id, approval_request_id, idempotency_key),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_request_id) REFERENCES plan_approval_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id)
);
SELECT ub_make_append_only('plan_approval_bindings');

CREATE TABLE execution_authorities (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'xau')),
  approval_id text NOT NULL,
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-z][a-z0-9-]{0,62}\.v[1-9][0-9]{0,5}:sha256:[0-9a-f]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  subject_type text NOT NULL CHECK (subject_type IN ('PLAN_ACTION', 'PROVIDER_CONTACT_REQUEST')),
  subject_id text NOT NULL CHECK (ub_id_ok(subject_id, 'cand') OR ub_id_ok(subject_id, 'pcr')),
  semantic_operation text NOT NULL CHECK (semantic_operation IN ('PURCHASE', 'SERVICE_BOOKING', 'PAID_CONTACT', 'PAID_LOOKUP')),
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  merchant_id text NOT NULL CHECK (ub_id_ok(merchant_id, 'mer')),
  purpose text NOT NULL CHECK (purpose ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  allowed_action_kinds text[] NOT NULL CHECK (cardinality(allowed_action_kinds) BETWEEN 1 AND 5
    AND allowed_action_kinds <@ ARRAY['PART_PURCHASE', 'SERVICE_JOB', 'DIAGNOSTIC_SERVICE', 'PAID_CONTACT',
      'CONTAINMENT_PURCHASE']::text[]),
  per_action_limit_minor bigint NOT NULL CHECK (per_action_limit_minor > 0),
  base_limit_minor bigint NOT NULL CHECK (base_limit_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  scope_digest text NOT NULL CHECK (scope_digest ~ '^sha256:[0-9a-f]{64}$'),
  signature_algorithm text NOT NULL CHECK (signature_algorithm = 'ED25519'),
  signature_key_id text NOT NULL CHECK (signature_key_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  signature_value text NOT NULL CHECK (signature_value ~ '^[A-Za-z0-9_-]{86}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  issued_by_kind text NOT NULL CHECK (issued_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  issued_by_id text NOT NULL CHECK (length(issued_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, approval_id),
  UNIQUE (tenant_id, id, action_digest),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  CHECK (per_action_limit_minor <= base_limit_minor),
  CHECK (expires_at > issued_at)
);

-- The signed scope must be exactly its PLAN_ACTION approval's paid scope; a forged row is refused even when it
-- bypasses the service layer (authority forgery, digest substitution, cross-tenant parents).
CREATE FUNCTION ub_execution_authority_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'an execution authority is issued ACTIVE at version 1' USING ERRCODE = 'UB091';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM approvals a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.approval_id
       AND a.approval_kind = 'PLAN_ACTION' AND a.paid AND a.incident_id = NEW.incident_id AND a.site_id = NEW.site_id
       AND a.asset_revision_id = NEW.asset_revision_id AND a.evidence_revision_id = NEW.evidence_revision_id
       AND a.policy_revision_id = NEW.policy_revision_id AND a.plan_hash = NEW.plan_hash
       AND a.action_digest = NEW.action_digest AND a.provider_account_revision_id = NEW.provider_account_revision_id
       AND a.currency = NEW.currency AND a.max_amount_minor = NEW.base_limit_minor
       AND NEW.expires_at <= a.expires_at) THEN
    RAISE EXCEPTION 'execution authority scope does not equal its paid PLAN_ACTION approval' USING ERRCODE = 'UB091';
  END IF;
  IF NOT ub_approval_executable(NEW.tenant_id, NEW.approval_id) THEN
    RAISE EXCEPTION 'execution authority approval is not executable' USING ERRCODE = 'UB091';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_account_revisions r WHERE r.tenant_id = NEW.tenant_id
       AND r.id = NEW.provider_account_revision_id AND r.paid AND r.owner_service = 'KITE_BROKER_PAID') THEN
    RAISE EXCEPTION 'execution authority must pin a broker-owned paid revision' USING ERRCODE = 'UB091';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER execution_authorities_insert_guard BEFORE INSERT ON execution_authorities
  FOR EACH ROW EXECUTE FUNCTION ub_execution_authority_insert_guard();

CREATE FUNCTION ub_execution_authority_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(OLD) - ARRAY['status', 'version']) <> (to_jsonb(NEW) - ARRAY['status', 'version']) THEN
    RAISE EXCEPTION 'execution_authorities is immutable outside its lifecycle projection' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NOT ub_execution_authority_edge_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal execution authority transition % -> %', OLD.status, NEW.status USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER execution_authorities_update_guard BEFORE UPDATE ON execution_authorities
  FOR EACH ROW EXECUTE FUNCTION ub_execution_authority_update_guard();
CREATE TRIGGER execution_authorities_no_delete BEFORE DELETE ON execution_authorities
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER execution_authorities_no_truncate BEFORE TRUNCATE ON execution_authorities
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

ALTER TABLE approvals ADD CONSTRAINT approvals_target_execution_authority_fk
  FOREIGN KEY (tenant_id, target_execution_authority_id) REFERENCES execution_authorities (tenant_id, id) NOT VALID;

CREATE TABLE execution_authority_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'xae')),
  execution_authority_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL CHECK (event_type IN ('ISSUED', 'SUSPENDED', 'REACTIVATED', 'REVOKED', 'EXPIRED')),
  prior_status text CHECK (prior_status IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  new_status text NOT NULL CHECK (new_status IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, execution_authority_id, sequence),
  FOREIGN KEY (tenant_id, execution_authority_id) REFERENCES execution_authorities (tenant_id, id),
  CHECK ((sequence = 1) = (event_type = 'ISSUED')),
  CHECK ((event_type = 'ISSUED') = (prior_status IS NULL))
);
SELECT ub_make_append_only('execution_authority_events');

-- Kite-session activation: its own pre-egress operation identity; transport, outcome and capability are separate.
CREATE TABLE execution_authority_sessions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'kss')),
  execution_authority_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  client_operation_id text NOT NULL CHECK (ub_id_ok(client_operation_id, 'op')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  transport_state text NOT NULL CHECK (transport_state IN ('PREPARED', 'SEND_STARTED', 'ACKNOWLEDGED', 'UNKNOWN', 'DEFINITE_NO_EFFECT')),
  external_outcome_state text NOT NULL CHECK (external_outcome_state IN ('PROPOSED', 'AUTHORIZED', 'REQUESTED', 'ACCEPTED',
    'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED')),
  adapter_capability text NOT NULL CHECK (adapter_capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  provider_session_ref text CHECK (provider_session_ref IS NULL OR (provider_session_ref ~ '^[\x21-\x7E]+$' AND length(provider_session_ref) <= 256)),
  raw_provider_status text CHECK (raw_provider_status IS NULL OR length(raw_provider_status) BETWEEN 1 AND 256),
  raw_response_digest text CHECK (raw_response_digest IS NULL OR raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  send_lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  reconcile_count integer NOT NULL DEFAULT 0 CHECK (reconcile_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, execution_authority_id),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, provider_account_id, idempotency_key),
  FOREIGN KEY (tenant_id, execution_authority_id) REFERENCES execution_authorities (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  CHECK (transport_state <> 'PREPARED' OR external_outcome_state IN ('PROPOSED', 'AUTHORIZED')),
  CHECK (external_outcome_state <> 'UNKNOWN' OR next_reconcile_at IS NOT NULL OR adapter_capability = 'UNSUPPORTED')
);
CREATE INDEX execution_authority_sessions_reconcile_ix ON execution_authority_sessions (next_reconcile_at)
  WHERE next_reconcile_at IS NOT NULL;

CREATE FUNCTION ub_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  axes text[] := ARRAY['transport_state', 'external_outcome_state', 'adapter_capability', 'provider_session_ref',
    'raw_provider_status', 'raw_response_digest', 'reason_code', 'send_lease_expires_at', 'next_reconcile_at',
    'reconcile_count', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.transport_state <> 'PREPARED' OR NEW.external_outcome_state <> 'PROPOSED' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a Kite session operation is created PREPARED/PROPOSED' USING ERRCODE = 'UB092';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM execution_authorities x WHERE x.tenant_id = NEW.tenant_id
         AND x.id = NEW.execution_authority_id AND x.provider_account_revision_id = NEW.provider_account_revision_id) THEN
      RAISE EXCEPTION 'session must pin its authority''s provider-account revision' USING ERRCODE = 'UB092';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - axes) <> (to_jsonb(NEW) - axes) THEN
    RAISE EXCEPTION 'session operation identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'session version must advance by one' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.transport_state <> OLD.transport_state AND NOT ub_attempt_transport_edge_ok(OLD.transport_state, NEW.transport_state)
     OR NEW.external_outcome_state <> OLD.external_outcome_state
        AND NOT ub_external_outcome_edge_ok(OLD.external_outcome_state, NEW.external_outcome_state)
     OR OLD.adapter_capability = 'UNSUPPORTED' AND NEW.adapter_capability = 'ELIGIBLE'
     OR OLD.provider_session_ref IS NOT NULL AND NEW.provider_session_ref IS DISTINCT FROM OLD.provider_session_ref THEN
    RAISE EXCEPTION 'illegal Kite session transition' USING ERRCODE = 'UB092';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER execution_authority_sessions_guard BEFORE INSERT OR UPDATE ON execution_authority_sessions
  FOR EACH ROW EXECUTE FUNCTION ub_session_guard();
CREATE TRIGGER execution_authority_sessions_no_delete BEFORE DELETE ON execution_authority_sessions
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER execution_authority_sessions_no_truncate BEFORE TRUNCATE ON execution_authority_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- One budget account per authority. Its projection columns change only through the ledger trigger.
CREATE TABLE budget_accounts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'bac')),
  execution_authority_id text NOT NULL,
  base_limit_minor bigint NOT NULL CHECK (base_limit_minor >= 0),
  approved_adjustments_minor bigint NOT NULL DEFAULT 0,
  effective_limit_minor bigint GENERATED ALWAYS AS (base_limit_minor + approved_adjustments_minor) STORED,
  open_reserved_minor bigint NOT NULL DEFAULT 0 CHECK (open_reserved_minor >= 0),
  gross_captured_minor bigint NOT NULL DEFAULT 0 CHECK (gross_captured_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  reversed_minor bigint NOT NULL DEFAULT 0 CHECK (reversed_minor >= 0),
  net_settled_minor bigint GENERATED ALWAYS AS (gross_captured_minor - refunded_minor - reversed_minor) STORED,
  available_minor bigint GENERATED ALWAYS AS
    (base_limit_minor + approved_adjustments_minor - open_reserved_minor - gross_captured_minor) STORED,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, execution_authority_id),
  UNIQUE (tenant_id, id, execution_authority_id),
  FOREIGN KEY (tenant_id, execution_authority_id) REFERENCES execution_authorities (tenant_id, id),
  -- INV-05 account level: gross cap and net settlement.
  CHECK (base_limit_minor + approved_adjustments_minor >= 0),
  CHECK (refunded_minor + reversed_minor <= gross_captured_minor),
  CHECK (open_reserved_minor + gross_captured_minor <= base_limit_minor + approved_adjustments_minor)
);

CREATE FUNCTION ub_budget_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  proj text[] := ARRAY['approved_adjustments_minor', 'effective_limit_minor', 'open_reserved_minor',
    'gross_captured_minor', 'refunded_minor', 'reversed_minor', 'net_settled_minor', 'available_minor', 'version'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_adjustments_minor <> 0 OR NEW.open_reserved_minor <> 0 OR NEW.gross_captured_minor <> 0
       OR NEW.refunded_minor <> 0 OR NEW.reversed_minor <> 0 OR NEW.version <> 1
       OR NOT EXISTS (SELECT 1 FROM execution_authorities x WHERE x.tenant_id = NEW.tenant_id
            AND x.id = NEW.execution_authority_id AND x.base_limit_minor = NEW.base_limit_minor
            AND x.currency = NEW.currency) THEN
      RAISE EXCEPTION 'a budget account opens empty with its authority''s signed base limit' USING ERRCODE = 'UB093';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'budget_accounts changes only through append-only ledger movements' USING ERRCODE = 'UB001';
  END IF;
  IF (to_jsonb(OLD) - proj) <> (to_jsonb(NEW) - proj) OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'budget account identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_accounts_guard BEFORE INSERT OR UPDATE ON budget_accounts
  FOR EACH ROW EXECUTE FUNCTION ub_budget_account_guard();
CREATE TRIGGER budget_accounts_no_delete BEFORE DELETE ON budget_accounts
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER budget_accounts_no_truncate BEFORE TRUNCATE ON budget_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE commercial_intents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cin')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  plan_hash text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('PLAN_ACTION', 'PROVIDER_CONTACT_REQUEST')),
  subject_id text NOT NULL,
  approval_id text NOT NULL,
  execution_authority_id text NOT NULL,
  budget_account_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  semantic_operation text NOT NULL CHECK (semantic_operation IN ('PURCHASE', 'SERVICE_BOOKING', 'PAID_CONTACT', 'PAID_LOOKUP')),
  intent_key text NOT NULL CHECK (intent_key ~ '^commercial-intent-key\.v1:sha256:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^intent-request\.v1:sha256:[0-9a-f]{64}$'),
  request_idempotency_key text NOT NULL CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  -- The pre-generated client operation identity: fixed at creation, copied onto the single attempt.
  client_operation_id text NOT NULL CHECK (ub_id_ok(client_operation_id, 'op')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  open_reserved_minor bigint NOT NULL DEFAULT 0 CHECK (open_reserved_minor >= 0),
  captured_gross_minor bigint NOT NULL DEFAULT 0 CHECK (captured_gross_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  reversed_minor bigint NOT NULL DEFAULT 0 CHECK (reversed_minor >= 0),
  net_settled_minor bigint GENERATED ALWAYS AS (captured_gross_minor - refunded_minor - reversed_minor) STORED,
  state text NOT NULL CHECK (state IN ('CREATED', 'RESERVED', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'REFUNDED',
    'REVERSED')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  supersedes_intent_id text,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, action_digest, execution_authority_id),
  UNIQUE (tenant_id, intent_key),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, provider_account_id, idempotency_key),
  UNIQUE (tenant_id, id, provider_account_id, provider_account_revision_id, client_operation_id, idempotency_key),
  FOREIGN KEY (tenant_id, execution_authority_id, action_digest)
    REFERENCES execution_authorities (tenant_id, id, action_digest),
  FOREIGN KEY (tenant_id, budget_account_id, execution_authority_id)
    REFERENCES budget_accounts (tenant_id, id, execution_authority_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  FOREIGN KEY (tenant_id, supersedes_intent_id) REFERENCES commercial_intents (tenant_id, id),
  -- INV-05 intent level: reservation + capture within the cap; returns within the capture.
  CHECK (open_reserved_minor + captured_gross_minor <= max_amount_minor),
  CHECK (refunded_minor + reversed_minor <= captured_gross_minor)
);
-- INV-07: at most one non-FAILED intent per tenant and action digest, across authorities.
CREATE UNIQUE INDEX commercial_intents_one_live_per_digest_ux ON commercial_intents (tenant_id, action_digest)
  WHERE state <> 'FAILED';

CREATE FUNCTION ub_commercial_intent_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  money_cols text[] := ARRAY['open_reserved_minor', 'captured_gross_minor', 'refunded_minor', 'reversed_minor',
    'net_settled_minor'];
  lifecycle text[] := ARRAY['state', 'reason_code', 'version', 'updated_at'];
  latest text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'CREATED' OR NEW.version <> 1 OR NEW.open_reserved_minor <> 0 OR NEW.captured_gross_minor <> 0
       OR NEW.refunded_minor <> 0 OR NEW.reversed_minor <> 0 THEN
      RAISE EXCEPTION 'a commercial intent is created CREATED and empty' USING ERRCODE = 'UB094';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM execution_authorities x WHERE x.tenant_id = NEW.tenant_id
         AND x.id = NEW.execution_authority_id AND x.approval_id = NEW.approval_id AND x.incident_id = NEW.incident_id
         AND x.site_id = NEW.site_id AND x.asset_revision_id = NEW.asset_revision_id
         AND x.evidence_revision_id = NEW.evidence_revision_id AND x.policy_revision_id = NEW.policy_revision_id
         AND x.plan_hash = NEW.plan_hash AND x.action_digest = NEW.action_digest
         AND x.subject_type = NEW.subject_type AND x.subject_id = NEW.subject_id
         AND x.semantic_operation = NEW.semantic_operation
         AND x.provider_account_revision_id = NEW.provider_account_revision_id AND x.currency = NEW.currency
         AND NEW.max_amount_minor <= x.per_action_limit_minor
         AND x.status = 'ACTIVE' AND x.expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'commercial intent is outside its active execution authority' USING ERRCODE = 'UB094';
    END IF;
    SELECT i.id INTO latest FROM commercial_intents i WHERE i.tenant_id = NEW.tenant_id
       AND i.action_digest = NEW.action_digest ORDER BY i.created_at DESC, i.id DESC LIMIT 1;
    IF latest IS DISTINCT FROM NEW.supersedes_intent_id THEN
      RAISE EXCEPTION 'a successor intent must link the latest prior intent for its action digest' USING ERRCODE = 'UB094';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - money_cols - lifecycle) <> (to_jsonb(NEW) - money_cols - lifecycle) THEN
    RAISE EXCEPTION 'commercial intent identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF (OLD.open_reserved_minor, OLD.captured_gross_minor, OLD.refunded_minor, OLD.reversed_minor)
     IS DISTINCT FROM (NEW.open_reserved_minor, NEW.captured_gross_minor, NEW.refunded_minor, NEW.reversed_minor) THEN
    -- Money moves only inside the ledger trigger, and then nothing else on the row changes.
    IF pg_trigger_depth() < 2 OR (to_jsonb(OLD) - money_cols) <> (to_jsonb(NEW) - money_cols) THEN
      RAISE EXCEPTION 'intent money projections change only through ledger movements' USING ERRCODE = 'UB001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'commercial intent version must advance by one' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.state <> OLD.state AND NOT ub_economic_intent_edge_ok(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'illegal economic intent transition % -> %', OLD.state, NEW.state USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commercial_intents_guard BEFORE INSERT OR UPDATE ON commercial_intents
  FOR EACH ROW EXECUTE FUNCTION ub_commercial_intent_guard();
CREATE TRIGGER commercial_intents_no_delete BEFORE DELETE ON commercial_intents
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER commercial_intents_no_truncate BEFORE TRUNCATE ON commercial_intents
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE commercial_intent_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cit')),
  intent_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, intent_id, sequence),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES commercial_intents (tenant_id, id),
  CHECK ((sequence = 1) = (from_state IS NULL))
);
SELECT ub_make_append_only('commercial_intent_transitions');

-- Exactly one attempt per intent, ever: uncertainty is reconciled, never replaced by a second attempt.
CREATE TABLE external_attempts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'att')),
  intent_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  client_operation_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  adapter_id text NOT NULL CHECK (adapter_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  result_origin text NOT NULL CHECK (result_origin IN ('LOCAL_STAND_IN', 'RECORDED_CONTRACT', 'KITE_PASSPORT')),
  transport_state text NOT NULL CHECK (transport_state IN ('PREPARED', 'SEND_STARTED', 'ACKNOWLEDGED', 'UNKNOWN', 'DEFINITE_NO_EFFECT')),
  external_outcome_state text NOT NULL CHECK (external_outcome_state IN ('PROPOSED', 'AUTHORIZED', 'REQUESTED', 'ACCEPTED',
    'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED')),
  adapter_capability text NOT NULL CHECK (adapter_capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  provider_ref text CHECK (provider_ref IS NULL OR (provider_ref ~ '^[\x21-\x7E]+$' AND length(provider_ref) <= 256)),
  raw_provider_status text CHECK (raw_provider_status IS NULL OR length(raw_provider_status) BETWEEN 1 AND 256),
  raw_response_digest text CHECK (raw_response_digest IS NULL OR raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  send_lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  reconcile_count integer NOT NULL DEFAULT 0 CHECK (reconcile_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, intent_id),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, provider_account_id, idempotency_key),
  FOREIGN KEY (tenant_id, intent_id, provider_account_id, provider_account_revision_id, client_operation_id, idempotency_key)
    REFERENCES commercial_intents (tenant_id, id, provider_account_id, provider_account_revision_id, client_operation_id,
      idempotency_key),
  CHECK (transport_state <> 'PREPARED' OR external_outcome_state IN ('PROPOSED', 'AUTHORIZED')),
  CHECK (external_outcome_state <> 'UNKNOWN' OR next_reconcile_at IS NOT NULL OR adapter_capability = 'UNSUPPORTED')
);
CREATE INDEX external_attempts_reconcile_ix ON external_attempts (next_reconcile_at) WHERE next_reconcile_at IS NOT NULL;
CREATE INDEX external_attempts_send_started_ix ON external_attempts (send_lease_expires_at)
  WHERE transport_state = 'SEND_STARTED';

CREATE FUNCTION ub_external_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  axes text[] := ARRAY['transport_state', 'external_outcome_state', 'adapter_capability', 'provider_ref',
    'raw_provider_status', 'raw_response_digest', 'reason_code', 'send_lease_expires_at', 'next_reconcile_at',
    'reconcile_count', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.transport_state <> 'SEND_STARTED' OR NEW.external_outcome_state <> 'AUTHORIZED' OR NEW.version <> 1
       OR NOT EXISTS (SELECT 1 FROM commercial_intents i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.intent_id
            AND i.state = 'RESERVED') THEN
      RAISE EXCEPTION 'an attempt is inserted SEND_STARTED/AUTHORIZED with its reserving intent' USING ERRCODE = 'UB095';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_account_revisions r WHERE r.tenant_id = NEW.tenant_id
         AND r.id = NEW.provider_account_revision_id AND r.paid AND r.owner_service = 'KITE_BROKER_PAID') THEN
      RAISE EXCEPTION 'a paid attempt needs a broker-owned paid revision' USING ERRCODE = 'UB095';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - axes) <> (to_jsonb(NEW) - axes) THEN
    RAISE EXCEPTION 'attempt operation identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'attempt version must advance by one' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.transport_state <> OLD.transport_state AND NOT ub_attempt_transport_edge_ok(OLD.transport_state, NEW.transport_state)
     OR NEW.external_outcome_state <> OLD.external_outcome_state
        AND NOT ub_external_outcome_edge_ok(OLD.external_outcome_state, NEW.external_outcome_state)
     OR OLD.adapter_capability = 'UNSUPPORTED' AND NEW.adapter_capability = 'ELIGIBLE'
     OR OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'illegal external attempt transition' USING ERRCODE = 'UB095';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER external_attempts_guard BEFORE INSERT OR UPDATE ON external_attempts
  FOR EACH ROW EXECUTE FUNCTION ub_external_attempt_guard();
CREATE TRIGGER external_attempts_no_delete BEFORE DELETE ON external_attempts
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER external_attempts_no_truncate BEFORE TRUNCATE ON external_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- State/money/attempt consistency of an intent, checked at commit (reserve and SEND_STARTED commit together).
CREATE FUNCTION ub_commercial_intent_consistency() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  i commercial_intents%ROWTYPE;
  sent boolean;
  reserved boolean;
BEGIN
  SELECT * INTO i FROM commercial_intents WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  sent := EXISTS (SELECT 1 FROM external_attempts a WHERE a.tenant_id = i.tenant_id AND a.intent_id = i.id);
  reserved := EXISTS (SELECT 1 FROM budget_ledger_entries l WHERE l.tenant_id = i.tenant_id AND l.intent_id = i.id
    AND l.movement_type = 'RESERVE');
  IF i.state = 'CREATED' AND (sent OR reserved OR i.open_reserved_minor <> 0 OR i.captured_gross_minor <> 0)
     OR i.state IN ('RESERVED', 'SUBMITTED', 'UNKNOWN')
        AND (NOT sent OR NOT reserved OR i.open_reserved_minor = 0 OR i.captured_gross_minor <> 0)
     OR i.state = 'CONFIRMED' AND (NOT sent OR i.open_reserved_minor <> 0 OR i.captured_gross_minor = 0)
     OR i.state = 'FAILED' AND (i.open_reserved_minor <> 0 OR i.captured_gross_minor <> 0)
     OR i.state = 'REFUNDED' AND (NOT sent OR i.open_reserved_minor <> 0 OR i.refunded_minor = 0
        OR i.refunded_minor + i.reversed_minor <> i.captured_gross_minor)
     OR i.state = 'REVERSED' AND (NOT sent OR i.open_reserved_minor <> 0 OR i.reversed_minor = 0
        OR i.refunded_minor + i.reversed_minor <> i.captured_gross_minor) THEN
    RAISE EXCEPTION 'commercial intent % is inconsistent with its ledger and attempt in state % (sent %, reserved %, open %, captured %)',
      i.id, i.state, sent, reserved, i.open_reserved_minor, i.captured_gross_minor USING ERRCODE = 'UB096';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commercial_intents_consistency AFTER INSERT OR UPDATE ON commercial_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ub_commercial_intent_consistency();

CREATE TABLE budget_ledger_entries (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ble')),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  budget_account_id text NOT NULL,
  intent_id text,
  approval_id text,
  movement_type text NOT NULL CHECK (movement_type IN ('AUTHORITY_CREDIT', 'AUTHORITY_DEBIT', 'RESERVE', 'RELEASE',
    'CAPTURE', 'REFUND', 'REVERSAL')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_account_id text,
  provider_account_revision_id text,
  provider_event_key text CHECK (provider_event_key IS NULL OR provider_event_key ~ '^[\x21-\x7E]{1,200}$'),
  capture_entry_id text,
  returned_against_minor bigint NOT NULL DEFAULT 0,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, budget_account_id) REFERENCES budget_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES commercial_intents (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  FOREIGN KEY (tenant_id, capture_entry_id) REFERENCES budget_ledger_entries (tenant_id, id),
  -- INV-05 capture level.
  CHECK (returned_against_minor >= 0 AND returned_against_minor <= amount_minor),
  CHECK (movement_type = 'CAPTURE' OR returned_against_minor = 0),
  CHECK ((movement_type IN ('AUTHORITY_CREDIT', 'AUTHORITY_DEBIT')) = (intent_id IS NULL)),
  CHECK ((movement_type IN ('AUTHORITY_CREDIT', 'AUTHORITY_DEBIT')) = (approval_id IS NOT NULL)),
  CHECK ((movement_type IN ('REFUND', 'REVERSAL')) = (capture_entry_id IS NOT NULL)),
  CHECK (intent_id IS NULL OR (provider_account_id IS NOT NULL AND provider_account_revision_id IS NOT NULL
    AND provider_event_key IS NOT NULL))
);
-- Duplicate or concurrent provider events reuse one namespaced key and create no second movement.
CREATE UNIQUE INDEX budget_ledger_provider_event_ux ON budget_ledger_entries (tenant_id, provider_account_id, provider_event_key)
  WHERE provider_event_key IS NOT NULL;
CREATE UNIQUE INDEX budget_ledger_one_adjustment_per_approval_ux ON budget_ledger_entries (tenant_id, approval_id)
  WHERE approval_id IS NOT NULL;
CREATE UNIQUE INDEX budget_ledger_one_reserve_per_intent_ux ON budget_ledger_entries (tenant_id, intent_id)
  WHERE movement_type = 'RESERVE';
CREATE INDEX budget_ledger_account_ix ON budget_ledger_entries (tenant_id, budget_account_id, seq);

-- The ledger is the only writer of every projection (account, intent, capture). Applied AFTER INSERT so an
-- ON CONFLICT DO NOTHING duplicate never moves money. Lock order: intent -> account -> capture row.
CREATE FUNCTION ub_budget_ledger_apply() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  it commercial_intents%ROWTYPE;
  acc budget_accounts%ROWTYPE;
  cap budget_ledger_entries%ROWTYPE;
  auth execution_authorities%ROWTYPE;
  appr approvals%ROWTYPE;
BEGIN
  IF NEW.intent_id IS NOT NULL THEN
    SELECT * INTO it FROM commercial_intents WHERE tenant_id = NEW.tenant_id AND id = NEW.intent_id FOR NO KEY UPDATE;
    IF it.budget_account_id <> NEW.budget_account_id OR it.currency <> NEW.currency
       OR it.provider_account_id <> NEW.provider_account_id
       OR it.provider_account_revision_id <> NEW.provider_account_revision_id THEN
      RAISE EXCEPTION 'ledger movement does not match its intent' USING ERRCODE = 'UB097';
    END IF;
  END IF;
  SELECT * INTO acc FROM budget_accounts WHERE tenant_id = NEW.tenant_id AND id = NEW.budget_account_id FOR NO KEY UPDATE;
  IF acc.currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger movement currency differs from its account' USING ERRCODE = 'UB097';
  END IF;

  IF NEW.movement_type IN ('AUTHORITY_CREDIT', 'AUTHORITY_DEBIT') THEN
    SELECT * INTO appr FROM approvals WHERE tenant_id = NEW.tenant_id AND id = NEW.approval_id;
    IF appr.approval_kind IS DISTINCT FROM 'BUDGET_ADJUSTMENT'
       OR appr.target_execution_authority_id IS DISTINCT FROM acc.execution_authority_id
       OR appr.max_amount_minor <> NEW.amount_minor OR appr.currency <> NEW.currency
       OR NOT ub_approval_executable(NEW.tenant_id, NEW.approval_id) THEN
      RAISE EXCEPTION 'authority adjustment needs an executable BUDGET_ADJUSTMENT approval for this account'
        USING ERRCODE = 'UB097';
    END IF;
    UPDATE budget_accounts SET approved_adjustments_minor = approved_adjustments_minor
        + CASE WHEN NEW.movement_type = 'AUTHORITY_CREDIT' THEN NEW.amount_minor ELSE -NEW.amount_minor END,
      version = version + 1
     WHERE tenant_id = acc.tenant_id AND id = acc.id;
    RETURN NULL;
  END IF;

  IF NEW.movement_type = 'RESERVE' THEN
    SELECT * INTO auth FROM execution_authorities WHERE tenant_id = NEW.tenant_id AND id = acc.execution_authority_id;
    IF it.state <> 'CREATED' OR NEW.amount_minor > it.max_amount_minor - it.open_reserved_minor - it.captured_gross_minor
       OR NEW.amount_minor > auth.per_action_limit_minor THEN
      RAISE EXCEPTION 'reserve exceeds the intent or per-action bound' USING ERRCODE = 'UB098';
    END IF;
    IF NEW.amount_minor > acc.available_minor THEN
      RAISE EXCEPTION 'reserve exceeds the available gross authority' USING ERRCODE = 'UB098';
    END IF;
    UPDATE commercial_intents SET open_reserved_minor = open_reserved_minor + NEW.amount_minor
     WHERE tenant_id = it.tenant_id AND id = it.id;
    UPDATE budget_accounts SET open_reserved_minor = open_reserved_minor + NEW.amount_minor, version = version + 1
     WHERE tenant_id = acc.tenant_id AND id = acc.id;
  ELSIF NEW.movement_type IN ('RELEASE', 'CAPTURE') THEN
    IF NEW.amount_minor > it.open_reserved_minor THEN
      RAISE EXCEPTION '% exceeds the open reservation', NEW.movement_type USING ERRCODE = 'UB098';
    END IF;
    UPDATE commercial_intents SET open_reserved_minor = open_reserved_minor - NEW.amount_minor,
      captured_gross_minor = captured_gross_minor
        + CASE WHEN NEW.movement_type = 'CAPTURE' THEN NEW.amount_minor ELSE 0 END
     WHERE tenant_id = it.tenant_id AND id = it.id;
    UPDATE budget_accounts SET open_reserved_minor = open_reserved_minor - NEW.amount_minor,
      gross_captured_minor = gross_captured_minor
        + CASE WHEN NEW.movement_type = 'CAPTURE' THEN NEW.amount_minor ELSE 0 END,
      version = version + 1
     WHERE tenant_id = acc.tenant_id AND id = acc.id;
  ELSE
    SELECT * INTO cap FROM budget_ledger_entries WHERE tenant_id = NEW.tenant_id AND id = NEW.capture_entry_id FOR NO KEY UPDATE;
    IF cap.movement_type IS DISTINCT FROM 'CAPTURE' OR cap.intent_id IS DISTINCT FROM NEW.intent_id THEN
      RAISE EXCEPTION 'a return must reference a capture of the same intent' USING ERRCODE = 'UB099';
    END IF;
    IF cap.returned_against_minor + NEW.amount_minor > cap.amount_minor THEN
      RAISE EXCEPTION 'cumulative returns exceed the referenced capture' USING ERRCODE = 'UB099';
    END IF;
    UPDATE budget_ledger_entries SET returned_against_minor = returned_against_minor + NEW.amount_minor
     WHERE tenant_id = cap.tenant_id AND id = cap.id;
    UPDATE commercial_intents SET
      refunded_minor = refunded_minor + CASE WHEN NEW.movement_type = 'REFUND' THEN NEW.amount_minor ELSE 0 END,
      reversed_minor = reversed_minor + CASE WHEN NEW.movement_type = 'REVERSAL' THEN NEW.amount_minor ELSE 0 END
     WHERE tenant_id = it.tenant_id AND id = it.id;
    UPDATE budget_accounts SET
      refunded_minor = refunded_minor + CASE WHEN NEW.movement_type = 'REFUND' THEN NEW.amount_minor ELSE 0 END,
      reversed_minor = reversed_minor + CASE WHEN NEW.movement_type = 'REVERSAL' THEN NEW.amount_minor ELSE 0 END,
      version = version + 1
     WHERE tenant_id = acc.tenant_id AND id = acc.id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER budget_ledger_entries_apply AFTER INSERT ON budget_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ub_budget_ledger_apply();

CREATE FUNCTION ub_budget_ledger_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.returned_against_minor <> 0 THEN
      RAISE EXCEPTION 'a ledger movement starts with nothing returned against it' USING ERRCODE = 'UB097';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 OR (to_jsonb(OLD) - 'returned_against_minor') <> (to_jsonb(NEW) - 'returned_against_minor')
     OR NEW.returned_against_minor < OLD.returned_against_minor THEN
    RAISE EXCEPTION 'budget_ledger_entries is append-only' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_ledger_entries_guard BEFORE INSERT OR UPDATE ON budget_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ub_budget_ledger_guard();
CREATE TRIGGER budget_ledger_entries_no_delete BEFORE DELETE ON budget_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER budget_ledger_entries_no_truncate BEFORE TRUNCATE ON budget_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- Payment observations kept apart from fulfillment: a receipt never proves delivery, work or recovery.
CREATE TABLE external_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rcp')),
  attempt_id text NOT NULL,
  intent_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PAYMENT_NEGOTIATION', 'PROVIDER_ACCEPTANCE', 'PAYMENT_SETTLEMENT', 'REFUND',
    'REVERSAL', 'NO_EFFECT_PROOF')),
  result_origin text NOT NULL CHECK (result_origin IN ('LOCAL_STAND_IN', 'RECORDED_CONTRACT', 'KITE_PASSPORT')),
  normalized_digest text NOT NULL CHECK (normalized_digest ~ '^sha256:[0-9a-f]{64}$'),
  raw_response_digest text CHECK (raw_response_digest IS NULL OR raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider_status text CHECK (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 256),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, attempt_id, kind, normalized_digest),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES external_attempts (tenant_id, id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES commercial_intents (tenant_id, id)
);
SELECT ub_make_append_only('external_receipts');

-- Verified execution-reference uses: a replayed reference is recognised and acts at most once per operation.
CREATE TABLE broker_reference_uses (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'bru')),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  operation text NOT NULL CHECK (operation IN ('ACTIVATE_SESSION', 'EXECUTE', 'RECONCILE')),
  target_kind text NOT NULL CHECK (target_kind IN ('EXECUTION_AUTHORITY', 'COMMERCIAL_INTENT')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, nonce, operation)
);
SELECT ub_make_append_only('broker_reference_uses');
