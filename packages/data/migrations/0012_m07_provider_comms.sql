-- M07 provider discovery, contact, communication, quote and notification records (FR-07, FR-08, FR-20, NFR-03,
-- NFR-04, NFR-06, INV-08, INV-12, INV-13). Provider accounts and their immutable revisions are the M02 tables; this
-- migration only adds the M07 behaviour tables around them.
--
-- service_providers: tenant-scoped normalized identity. Discovery source lives on search results; the approved-
--   vendor projection is a separate column set only from a registry APPROVED_VENDOR record (never by search rank).
-- provider_searches / provider_search_results: immutable bounded discovery requests pinned to an exact account
--   revision; results carry rank with no authority.
-- provider_contact_requests: immutable intended contacts pinned to an exact account revision; the only mutation is
--   the one-shot invalidation stamp (unexecuted work after supersession).
-- provider_contact_attempts: one row per M07 operation (unpaid) or broker-linked mirror (paid) with separate
--   transport / external outcome / adapter capability / raw status axes; legal-edge guard in the database.
-- provider_contact_attempt_events: append-only observations behind every projection change.
-- provider_consents, provider_communications, provider_communication_bodies: consent/disclosure-bound transcripts.
--   Raw content is isolated in the body table (erasable); the communication row keeps only redacted text and the
--   minimum approved excerpt. Transcript rows carry authority 'NONE'.
-- provider_quotes: immutable quote revisions; explicit missing fields; authority 'NONE'.
-- provider_broker_event_receipts: once-only consumption of commercial_intent.state_changed.v1 per tenant/event.
-- provider_command_receipts: (tenant, route, idempotency key) -> request digest and result.
-- notifications: role-routed, deduplicated deliveries with deep-link context and a separate delivery state.

-- ---------------------------------------------------------------------------------------------------------------
-- Shared legal-edge predicate for the attempt projection (mirrors @uptimebuyer/domain MACHINES; unchanged is legal).
CREATE FUNCTION ub_attempt_edge_ok(machine text, f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT f = t OR CASE machine
      WHEN 'TRANSPORT' THEN (f, t) IN (('PREPARED', 'SEND_STARTED'), ('SEND_STARTED', 'ACKNOWLEDGED'),
                                       ('SEND_STARTED', 'UNKNOWN'), ('SEND_STARTED', 'DEFINITE_NO_EFFECT'))
      WHEN 'OUTCOME' THEN (f, t) IN (('PROPOSED', 'AUTHORIZED'), ('AUTHORIZED', 'REQUESTED'), ('REQUESTED', 'ACCEPTED'),
                                     ('ACCEPTED', 'CONFIRMED'), ('REQUESTED', 'FAILED'), ('REQUESTED', 'CANCELLED'),
                                     ('ACCEPTED', 'FAILED'), ('ACCEPTED', 'CANCELLED'), ('AUTHORIZED', 'UNKNOWN'),
                                     ('REQUESTED', 'UNKNOWN'), ('ACCEPTED', 'UNKNOWN'), ('UNKNOWN', 'ACCEPTED'),
                                     ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED'), ('UNKNOWN', 'CANCELLED'),
                                     -- a multi-step observation folded into one projection write
                                     ('AUTHORIZED', 'ACCEPTED'), ('AUTHORIZED', 'CONFIRMED'), ('AUTHORIZED', 'FAILED'),
                                     ('REQUESTED', 'CONFIRMED'))
      WHEN 'CAPABILITY' THEN (f, t) = ('ELIGIBLE', 'UNSUPPORTED')
      ELSE false END
  $$;

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE service_providers (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'spr')),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^service-provider\.v1:sha256:[0-9a-f]{64}$'),
  provider_kind text NOT NULL
    CHECK (provider_kind IN ('TECHNICIAN', 'SUPPLIER', 'DIAGNOSTIC_SERVICE', 'CONTAINMENT_SUPPLIER', 'CATALOG')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  normalized_name text NOT NULL CHECK (normalized_name ~ '^[a-z0-9]+( [a-z0-9]+)*$' AND length(normalized_name) <= 200),
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  postal_code text CHECK (postal_code IS NULL OR postal_code ~ '^[A-Z0-9]{2,10}$'),
  website_domain text CHECK (website_domain IS NULL OR website_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  service_area jsonb NOT NULL CHECK (jsonb_typeof(service_area) = 'object'),
  -- Approved-vendor projection: only from a registry APPROVED_VENDOR record; discovery never sets it.
  approved_vendor_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (approved_vendor_status IN ('UNKNOWN', 'APPROVED', 'NOT_APPROVED')),
  approved_vendor_ref text CHECK (approved_vendor_ref IS NULL OR ub_id_ok(approved_vendor_ref, 'vnd')),
  approved_vendor_checked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  CHECK ((approved_vendor_status = 'UNKNOWN') = (approved_vendor_ref IS NULL)),
  CHECK ((approved_vendor_ref IS NULL) = (approved_vendor_checked_at IS NULL))
);

-- Identity is immutable once discovered; only the vendor projection and version may change.
CREATE FUNCTION ub_service_provider_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'service providers are never deleted' USING ERRCODE = 'UB001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['approved_vendor_status', 'approved_vendor_ref', 'approved_vendor_checked_at', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approved_vendor_status', 'approved_vendor_ref', 'approved_vendor_checked_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'service provider identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'service provider version must advance by one' USING ERRCODE = 'UB071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER service_providers_guard BEFORE UPDATE OR DELETE ON service_providers
  FOR EACH ROW EXECUTE FUNCTION ub_service_provider_guard();

CREATE TABLE service_provider_contact_points (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'spc')),
  service_provider_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('PHONE', 'EMAIL', 'API')),
  -- Restricted: never logged, exported or placed in a model input. The digest is the join/dedupe key.
  value text NOT NULL CHECK (length(value) BETWEEN 3 AND 320),
  value_digest text NOT NULL CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, service_provider_id, id),
  UNIQUE (tenant_id, service_provider_id, channel, value_digest),
  FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id)
);
SELECT ub_make_append_only('service_provider_contact_points');

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_searches (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'psh')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  query jsonb NOT NULL CHECK (jsonb_typeof(query) = 'object'),
  query_digest text NOT NULL CHECK (query_digest ~ '^provider-search-query\.v1:sha256:[0-9a-f]{64}$'),
  max_results integer NOT NULL CHECK (max_results BETWEEN 1 AND 100),
  max_pages integer NOT NULL CHECK (max_pages BETWEEN 1 AND 10),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 30000),
  max_cost_minor bigint NOT NULL CHECK (max_cost_minor = 0),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'COMPLETED', 'TRUNCATED', 'PARTIAL', 'FAILED', 'BLOCKED')),
  state_reason text CHECK (state_reason IS NULL OR state_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  retry_after_ms integer CHECK (retry_after_ms IS NULL OR retry_after_ms BETWEEN 0 AND 86400000),
  adapter_capability text NOT NULL DEFAULT 'ELIGIBLE' CHECK (adapter_capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  adapter_class text CHECK (adapter_class IS NULL OR adapter_class IN ('LIVE', 'SANDBOX', 'RECORDED_FIXTURE', 'SYNTHETIC_FIXTURE', 'LOCAL_FAKE')),
  pages_fetched integer NOT NULL DEFAULT 0 CHECK (pages_fetched BETWEEN 0 AND 10),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count BETWEEN 0 AND 100),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  CHECK ((state = 'PENDING') = (completed_at IS NULL)),
  CHECK (result_count <= max_results AND pages_fetched <= max_pages)
);
CREATE INDEX provider_searches_incident_ix ON provider_searches (tenant_id, incident_id, created_at);

-- The request is immutable; the projection may move once from PENDING to a terminal state.
CREATE FUNCTION ub_provider_search_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider searches are append-only' USING ERRCODE = 'UB001';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'provider search % is already terminal', OLD.id USING ERRCODE = 'UB001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'state_reason', 'retry_after_ms', 'adapter_capability', 'adapter_class', 'pages_fetched', 'result_count', 'completed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'state_reason', 'retry_after_ms', 'adapter_capability', 'adapter_class', 'pages_fetched', 'result_count', 'completed_at']) THEN
    RAISE EXCEPTION 'provider search request is immutable' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_searches_guard BEFORE UPDATE OR DELETE ON provider_searches
  FOR EACH ROW EXECUTE FUNCTION ub_provider_search_guard();
CREATE TRIGGER provider_searches_no_truncate BEFORE TRUNCATE ON provider_searches
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE provider_search_results (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'psx')),
  search_id text NOT NULL,
  service_provider_id text NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 100),
  -- Search rank is ordering only; it can never approve compatibility, vendor status or spend.
  rank_authority text NOT NULL DEFAULT 'NONE' CHECK (rank_authority = 'NONE'),
  source_kind text NOT NULL CHECK (source_kind IN ('PROVIDER_API', 'DIRECTORY', 'OPERATOR_ENTRY')),
  external_ref text CHECK (external_ref IS NULL OR (length(external_ref) BETWEEN 1 AND 128 AND external_ref ~ '^[\x21-\x7E]+$')),
  service_area_match text NOT NULL CHECK (service_area_match IN ('IN_AREA', 'OUT_OF_AREA', 'UNKNOWN')),
  availability_status text NOT NULL CHECK (availability_status IN ('AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN')),
  availability_next_at timestamptz,
  price_amount_minor bigint CHECK (price_amount_minor IS NULL OR price_amount_minor >= 0),
  price_currency text CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
  price_basis text CHECK (price_basis IS NULL OR price_basis IN ('CALLOUT', 'HOURLY', 'FIXED', 'ESTIMATE')),
  eta_minutes integer CHECK (eta_minutes IS NULL OR eta_minutes BETWEEN 0 AND 100000),
  capabilities text[] NOT NULL DEFAULT '{}',
  raw_response_digest text NOT NULL CHECK (raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, search_id, rank),
  UNIQUE (tenant_id, search_id, service_provider_id),
  FOREIGN KEY (tenant_id, search_id) REFERENCES provider_searches (tenant_id, id),
  FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  CHECK ((price_amount_minor IS NULL) = (price_currency IS NULL)),
  CHECK (price_amount_minor IS NULL OR price_basis IS NOT NULL)
);
SELECT ub_make_append_only('provider_search_results');

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_contact_requests (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pcr')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text,
  service_provider_id text NOT NULL,
  contact_point_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('PHONE', 'EMAIL', 'API')),
  purpose_code text NOT NULL CHECK (purpose_code IN ('QUOTE', 'AVAILABILITY', 'ARRIVAL_ESTIMATE', 'DIAGNOSTIC_COMMITMENT')),
  request_digest text NOT NULL CHECK (request_digest ~ '^provider-contact-request\.v1:sha256:[0-9a-f]{64}$'),
  message_template text NOT NULL CHECK (message_template ~ '^[a-z][a-z0-9-]{0,63}\.v[1-9][0-9]{0,3}$'),
  -- Consent / recording policy references (FR-08, INV-13).
  recording_disclosure text NOT NULL CHECK (recording_disclosure IN ('REQUIRED', 'NOT_APPLICABLE')),
  processing_consent text NOT NULL CHECK (processing_consent IN ('REQUIRED', 'NOT_REQUIRED')),
  retention_class text NOT NULL CHECK (retention_class IN ('COMMUNICATION_SHORT', 'COMMUNICATION_STANDARD')),
  paid boolean NOT NULL,
  action_digest text CHECK (action_digest IS NULL OR action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  plan_hash text CHECK (plan_hash IS NULL OR plan_hash ~ '^provider-contact-plan\.v1:sha256:[0-9a-f]{64}$'),
  merchant_id text CHECK (merchant_id IS NULL OR ub_id_ok(merchant_id, 'mer')),
  max_cost_minor bigint NOT NULL CHECK (max_cost_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 60000),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invalidated_at timestamptz,
  invalidation_reason text CHECK (invalidation_reason IS NULL OR invalidation_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, service_provider_id, channel, purpose_code, request_digest),
  UNIQUE (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, service_provider_id, contact_point_id)
    REFERENCES service_provider_contact_points (tenant_id, service_provider_id, id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id),
  -- Paid contacts are bounded commercial intents: action digest, plan hash, merchant and a positive cap.
  CHECK (paid = (action_digest IS NOT NULL)),
  CHECK (paid = (plan_hash IS NOT NULL)),
  CHECK (paid = (merchant_id IS NOT NULL)),
  CHECK (NOT paid OR (policy_revision_id IS NOT NULL AND max_cost_minor > 0)),
  CHECK (paid OR max_cost_minor = 0),
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);
SELECT ub_make_append_only('provider_contact_requests', 'invalidated_at', 'invalidation_reason');

CREATE FUNCTION ub_contact_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  rev record;
BEGIN
  SELECT paid, owner_service INTO rev FROM provider_account_revisions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.provider_account_revision_id;
  IF rev.paid IS DISTINCT FROM NEW.paid THEN
    RAISE EXCEPTION 'contact request paid flag must equal its pinned account revision' USING ERRCODE = 'UB072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_revisions e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.evidence_revision_id
                   AND e.incident_id = NEW.incident_id AND e.asset_revision_id = NEW.asset_revision_id) THEN
    RAISE EXCEPTION 'contact request evidence revision is not bound to its incident and asset revision'
      USING ERRCODE = 'UB072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_contact_requests_guard BEFORE INSERT ON provider_contact_requests
  FOR EACH ROW EXECUTE FUNCTION ub_contact_request_guard();

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_contact_attempts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pca')),
  contact_request_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  paid boolean NOT NULL,
  commercial_intent_id text CHECK (commercial_intent_id IS NULL OR ub_id_ok(commercial_intent_id, 'cin')),
  execution_authority_id text CHECK (execution_authority_id IS NULL OR ub_id_ok(execution_authority_id, 'xau')),
  approval_id text,
  client_operation_id text NOT NULL CHECK (ub_id_ok(client_operation_id, 'op')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^provider-contact-request\.v1:sha256:[0-9a-f]{64}$'),
  transport_state text NOT NULL CHECK (transport_state IN ('PREPARED', 'SEND_STARTED', 'ACKNOWLEDGED', 'UNKNOWN', 'DEFINITE_NO_EFFECT')),
  external_outcome_state text NOT NULL CHECK (external_outcome_state IN ('PROPOSED', 'AUTHORIZED', 'REQUESTED', 'ACCEPTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED')),
  adapter_capability text NOT NULL CHECK (adapter_capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  capability_reason text CHECK (capability_reason IS NULL OR capability_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  economic_state text CHECK (economic_state IS NULL OR economic_state IN ('CREATED', 'RESERVED', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'REFUNDED', 'REVERSED')),
  raw_provider_status text CHECK (raw_provider_status IS NULL OR (length(raw_provider_status) BETWEEN 1 AND 64 AND raw_provider_status ~ '^[\x21-\x7E]+$')),
  provider_ref text CHECK (provider_ref IS NULL OR (length(provider_ref) BETWEEN 1 AND 128 AND provider_ref ~ '^[\x21-\x7E]+$')),
  raw_response_digest text CHECK (raw_response_digest IS NULL OR raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  next_reconcile_at timestamptz,
  manual_review boolean NOT NULL DEFAULT false,
  definite_no_effect boolean NOT NULL DEFAULT false,
  -- M07_PREFLIGHT: M07's own pre-egress capability block (nothing was sent anywhere).
  result_origin text NOT NULL CHECK (result_origin IN ('M07_ADAPTER', 'M07_PREFLIGHT', 'KITE_BROKER', 'CONTRACT_FAKE')),
  -- NONE until dispatch binds the adapter (set once).
  adapter_class text NOT NULL CHECK (adapter_class IN ('NONE', 'LIVE', 'SANDBOX', 'RECORDED_FIXTURE', 'SYNTHETIC_FIXTURE', 'LOCAL_FAKE', 'BROKER')),
  last_broker_event_version integer CHECK (last_broker_event_version IS NULL OR last_broker_event_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, contact_request_id, attempt_number),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, provider_account_id, idempotency_key),
  FOREIGN KEY (tenant_id, contact_request_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_contact_requests (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  -- Paid attempts are broker-linked mirrors; an unlinked paid row exists only as a pre-egress capability block.
  CHECK (NOT paid OR commercial_intent_id IS NOT NULL OR (adapter_capability = 'UNSUPPORTED' AND transport_state = 'PREPARED')),
  CHECK (paid OR (commercial_intent_id IS NULL AND execution_authority_id IS NULL AND economic_state IS NULL)),
  CHECK (NOT paid OR result_origin IN ('KITE_BROKER', 'CONTRACT_FAKE', 'M07_PREFLIGHT')),
  CHECK (paid OR result_origin IN ('M07_ADAPTER', 'M07_PREFLIGHT')),
  CHECK (result_origin <> 'M07_PREFLIGHT' OR (transport_state = 'PREPARED' AND adapter_capability = 'UNSUPPORTED')),
  CHECK ((commercial_intent_id IS NULL) = (execution_authority_id IS NULL)),
  -- UNKNOWN always exposes either its next reconciliation time or a manual-review disposition.
  CHECK (external_outcome_state <> 'UNKNOWN' OR next_reconcile_at IS NOT NULL OR manual_review),
  CHECK (NOT definite_no_effect OR external_outcome_state IN ('PROPOSED', 'AUTHORIZED', 'FAILED')),
  -- FAILED is an authoritative no-effect outcome; it can never be a relabelled timeout.
  CHECK (external_outcome_state <> 'FAILED' OR definite_no_effect),
  CHECK (transport_state <> 'PREPARED' OR external_outcome_state IN ('PROPOSED', 'AUTHORIZED'))
);
-- At most one live (possibly effective) attempt per contact request; a successor needs definite no-effect proof.
CREATE UNIQUE INDEX provider_contact_attempts_one_live_ux ON provider_contact_attempts (tenant_id, contact_request_id)
  WHERE NOT definite_no_effect;
CREATE UNIQUE INDEX provider_contact_attempts_intent_ux ON provider_contact_attempts (tenant_id, commercial_intent_id)
  WHERE commercial_intent_id IS NOT NULL;
CREATE INDEX provider_contact_attempts_reconcile_ix ON provider_contact_attempts (next_reconcile_at)
  WHERE next_reconcile_at IS NOT NULL;

CREATE FUNCTION ub_contact_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  rev record;
  ident text[] := ARRAY['tenant_id', 'id', 'contact_request_id', 'attempt_number', 'provider_account_id',
    'provider_account_revision_id', 'paid', 'client_operation_id', 'idempotency_key', 'request_digest',
    'result_origin', 'created_at', 'approval_id'];
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contact attempts are append-only' USING ERRCODE = 'UB001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r.paid, r.owner_service, r.superseded_at, p.status INTO rev
      FROM provider_account_revisions r JOIN provider_accounts p ON p.tenant_id = r.tenant_id AND p.id = r.provider_account_id
     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.provider_account_revision_id;
    IF rev.paid IS DISTINCT FROM NEW.paid
       OR (NEW.paid AND rev.owner_service <> 'KITE_BROKER_PAID')
       OR (NOT NEW.paid AND rev.owner_service <> 'M07_UNPAID') THEN
      RAISE EXCEPTION 'attempt owner must match the pinned account revision (paid = broker only)' USING ERRCODE = 'UB073';
    END IF;
    -- New egress work only on the current revision of an active account; history keeps its pinned revision.
    IF NEW.transport_state <> 'PREPARED' OR NEW.adapter_capability <> 'UNSUPPORTED' THEN
      IF rev.superseded_at IS NOT NULL OR rev.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'attempt pinned to a superseded or disabled account revision' USING ERRCODE = 'UB073';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM provider_contact_requests q WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.contact_request_id
                 AND q.invalidated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'contact request was invalidated' USING ERRCODE = 'UB073';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH c IN ARRAY ident LOOP
    IF to_jsonb(OLD) -> c IS DISTINCT FROM to_jsonb(NEW) -> c THEN
      RAISE EXCEPTION 'attempt identity column % is immutable', c USING ERRCODE = 'UB001';
    END IF;
  END LOOP;
  IF OLD.adapter_class <> 'NONE' AND NEW.adapter_class IS DISTINCT FROM OLD.adapter_class THEN
    RAISE EXCEPTION 'attempt adapter class is bound once' USING ERRCODE = 'UB001';
  END IF;
  IF OLD.commercial_intent_id IS NOT NULL AND NEW.commercial_intent_id IS DISTINCT FROM OLD.commercial_intent_id THEN
    RAISE EXCEPTION 'attempt commercial intent link is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF NOT ub_attempt_edge_ok('TRANSPORT', OLD.transport_state, NEW.transport_state)
     OR NOT ub_attempt_edge_ok('OUTCOME', OLD.external_outcome_state, NEW.external_outcome_state)
     OR NOT ub_attempt_edge_ok('CAPABILITY', OLD.adapter_capability, NEW.adapter_capability) THEN
    RAISE EXCEPTION 'illegal attempt transition (% -> %, % -> %, % -> %)', OLD.transport_state, NEW.transport_state,
      OLD.external_outcome_state, NEW.external_outcome_state, OLD.adapter_capability, NEW.adapter_capability
      USING ERRCODE = 'UB074';
  END IF;
  -- Post-egress loss of reconciliation never relabels the effect: capability and outcome cannot move together.
  IF OLD.adapter_capability = 'ELIGIBLE' AND NEW.adapter_capability = 'UNSUPPORTED' AND OLD.transport_state <> 'PREPARED'
     AND NEW.external_outcome_state <> OLD.external_outcome_state THEN
    RAISE EXCEPTION 'capability loss after egress cannot change the external outcome' USING ERRCODE = 'UB074';
  END IF;
  IF OLD.definite_no_effect AND NOT NEW.definite_no_effect THEN
    RAISE EXCEPTION 'definite no-effect proof cannot be withdrawn' USING ERRCODE = 'UB074';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'attempt version must advance by one' USING ERRCODE = 'UB071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_contact_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON provider_contact_attempts
  FOR EACH ROW EXECUTE FUNCTION ub_contact_attempt_guard();
CREATE TRIGGER provider_contact_attempts_no_truncate BEFORE TRUNCATE ON provider_contact_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE provider_contact_attempt_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pce')),
  attempt_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  observation_kind text NOT NULL CHECK (observation_kind IN ('PREPARED', 'PRE_EGRESS_BLOCK', 'SEND_STARTED', 'HANDOFF',
    'ADAPTER_RESULT', 'TIMEOUT', 'LOOKUP', 'WEBHOOK', 'BROKER_SUBMITTED', 'BROKER_EVENT', 'CAPABILITY_CHANGE')),
  transport_state text NOT NULL,
  external_outcome_state text NOT NULL,
  adapter_capability text NOT NULL,
  economic_state text,
  raw_provider_status text CHECK (raw_provider_status IS NULL OR length(raw_provider_status) <= 64),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  raw_response_digest text CHECK (raw_response_digest IS NULL OR raw_response_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_event_id text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, attempt_id, sequence),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES provider_contact_attempts (tenant_id, id)
);
SELECT ub_make_append_only('provider_contact_attempt_events');

CREATE TABLE provider_broker_event_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pbr')),
  event_id text NOT NULL CHECK (ub_id_ok(event_id, 'evt')),
  commercial_intent_id text NOT NULL CHECK (ub_id_ok(commercial_intent_id, 'cin')),
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  attempt_id text,
  disposition text NOT NULL CHECK (disposition IN ('APPLIED', 'STALE', 'QUARANTINED')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  result_origin text NOT NULL CHECK (result_origin IN ('KITE_BROKER', 'CONTRACT_FAKE')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES provider_contact_attempts (tenant_id, id)
);
SELECT ub_make_append_only('provider_broker_event_receipts');

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_consents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pcs')),
  contact_request_id text NOT NULL,
  service_provider_id text NOT NULL,
  consent_kind text NOT NULL CHECK (consent_kind IN ('RECORDING', 'PROCESSING')),
  purpose text NOT NULL CHECK (purpose IN ('QUOTE_RECORDING', 'EVIDENCE_REASONING')),
  status text NOT NULL CHECK (status IN ('GRANTED', 'DECLINED', 'WITHDRAWN')),
  captured_via text NOT NULL CHECK (captured_via IN ('PROVIDER_API', 'PHONE_DISCLOSURE_ACK', 'EMAIL_REPLY', 'OPERATOR_ATTESTED')),
  disclosure_digest text CHECK (disclosure_digest IS NULL OR disclosure_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_attempt_id text,
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  recorded_by_id text NOT NULL CHECK (length(recorded_by_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_request_id) REFERENCES provider_contact_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  FOREIGN KEY (tenant_id, source_attempt_id) REFERENCES provider_contact_attempts (tenant_id, id)
);
CREATE INDEX provider_consents_request_ix ON provider_consents (tenant_id, contact_request_id, consent_kind, recorded_at);
SELECT ub_make_append_only('provider_consents');

CREATE TABLE provider_communications (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pcm')),
  contact_attempt_id text NOT NULL,
  contact_request_id text NOT NULL,
  service_provider_id text NOT NULL,
  incident_id text NOT NULL,
  site_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('OUTBOUND', 'INBOUND')),
  comm_type text NOT NULL CHECK (comm_type IN ('EMAIL', 'PHONE_TRANSCRIPT', 'API_MESSAGE')),
  transcript_source text NOT NULL CHECK (transcript_source IN ('PROVIDER_TRANSCRIPTION', 'ADAPTER_CAPTURE', 'OPERATOR_NOTES')),
  source_adapter_class text NOT NULL CHECK (source_adapter_class IN ('LIVE', 'SANDBOX', 'RECORDED_FIXTURE', 'SYNTHETIC_FIXTURE', 'LOCAL_FAKE', 'BROKER', 'OPERATOR')),
  recording_disclosure text NOT NULL CHECK (recording_disclosure IN ('GIVEN', 'NOT_GIVEN', 'NOT_APPLICABLE')),
  recording_consent_id text,
  processing_consent_id text,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  redacted_text text NOT NULL CHECK (length(redacted_text) <= 20000),
  redaction_manifest jsonb NOT NULL CHECK (jsonb_typeof(redaction_manifest) = 'object'),
  minimum_excerpt text CHECK (minimum_excerpt IS NULL OR length(minimum_excerpt) <= 2000),
  excerpt_digest text CHECK (excerpt_digest IS NULL OR excerpt_digest ~ '^sha256:[0-9a-f]{64}$'),
  retention_class text NOT NULL CHECK (retention_class IN ('COMMUNICATION_SHORT', 'COMMUNICATION_STANDARD')),
  retain_until timestamptz NOT NULL,
  -- Transcript text is evidence only; it can never approve, decide compatibility, spend or close anything.
  authority text NOT NULL DEFAULT 'NONE' CHECK (authority = 'NONE'),
  observed_at timestamptz NOT NULL,
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  recorded_by_id text NOT NULL CHECK (length(recorded_by_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_attempt_id) REFERENCES provider_contact_attempts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_request_id) REFERENCES provider_contact_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, recording_consent_id) REFERENCES provider_consents (tenant_id, id),
  FOREIGN KEY (tenant_id, processing_consent_id) REFERENCES provider_consents (tenant_id, id),
  CHECK ((minimum_excerpt IS NULL) = (excerpt_digest IS NULL)),
  CHECK (minimum_excerpt IS NULL OR processing_consent_id IS NOT NULL),
  CHECK (comm_type <> 'PHONE_TRANSCRIPT' OR recording_disclosure <> 'NOT_APPLICABLE'),
  CHECK (recording_disclosure <> 'GIVEN' OR recording_consent_id IS NOT NULL)
);
CREATE INDEX provider_communications_request_ix ON provider_communications (tenant_id, contact_request_id, observed_at);
SELECT ub_make_append_only('provider_communications');

-- Raw communication content: isolated, role-restricted, never exported or placed in a model input. The only
-- permitted change is cryptographic-style erasure: raw_text -> NULL together with the erased_at stamp.
CREATE TABLE provider_communication_bodies (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pcb')),
  communication_id text NOT NULL,
  raw_text text CHECK (raw_text IS NULL OR length(raw_text) <= 20000),
  erased_at timestamptz,
  erasure_reason text CHECK (erasure_reason IS NULL OR erasure_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, communication_id),
  FOREIGN KEY (tenant_id, communication_id) REFERENCES provider_communications (tenant_id, id),
  CHECK ((erased_at IS NULL) = (raw_text IS NOT NULL)),
  CHECK ((erased_at IS NULL) = (erasure_reason IS NULL))
);
CREATE FUNCTION ub_communication_body_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'communication bodies are erased, never deleted' USING ERRCODE = 'UB001';
  END IF;
  IF OLD.erased_at IS NOT NULL OR NEW.raw_text IS NOT NULL OR NEW.erased_at IS NULL
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.communication_id <> OLD.communication_id THEN
    RAISE EXCEPTION 'communication body permits only one erasure' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_communication_bodies_guard BEFORE UPDATE OR DELETE ON provider_communication_bodies
  FOR EACH ROW EXECUTE FUNCTION ub_communication_body_guard();
CREATE TRIGGER provider_communication_bodies_no_truncate BEFORE TRUNCATE ON provider_communication_bodies
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_quotes (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pqt')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  contact_request_id text NOT NULL,
  service_provider_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  supersedes_quote_id text,
  source_kind text NOT NULL CHECK (source_kind IN ('ADAPTER_RESPONSE', 'OPERATOR_ENTRY', 'BROKER_RESULT')),
  source_attempt_id text,
  source_communication_id text,
  source_evidence_digest text NOT NULL CHECK (source_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_adapter_class text NOT NULL CHECK (source_adapter_class IN ('LIVE', 'SANDBOX', 'RECORDED_FIXTURE', 'SYNTHETIC_FIXTURE', 'LOCAL_FAKE', 'BROKER', 'OPERATOR')),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^provider-quote-scope\.v1:sha256:[0-9a-f]{64}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('DIAGNOSTIC_VISIT', 'REPAIR_LABOR', 'PART_SUPPLY', 'CONTAINMENT')),
  part_number text CHECK (part_number IS NULL OR length(part_number) BETWEEN 1 AND 80),
  manufacturer text CHECK (manufacturer IS NULL OR length(manufacturer) BETWEEN 1 AND 200),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  tax_minor bigint CHECK (tax_minor IS NULL OR tax_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  eta_minutes integer CHECK (eta_minutes IS NULL OR eta_minutes BETWEEN 0 AND 100000),
  availability_status text NOT NULL CHECK (availability_status IN ('AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN')),
  valid_until timestamptz,
  missing_fields text[] NOT NULL CHECK (missing_fields <@ ARRAY['amount', 'tax', 'eta', 'validity', 'availability']::text[]),
  -- A quote is commercial evidence only: it never approves compatibility, spend or closure.
  authority text NOT NULL DEFAULT 'NONE' CHECK (authority = 'NONE'),
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  recorded_by_id text NOT NULL CHECK (length(recorded_by_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, contact_request_id, revision),
  UNIQUE (tenant_id, supersedes_quote_id),
  FOREIGN KEY (tenant_id, contact_request_id) REFERENCES provider_contact_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_quote_id) REFERENCES provider_quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, source_attempt_id) REFERENCES provider_contact_attempts (tenant_id, id),
  FOREIGN KEY (tenant_id, source_communication_id) REFERENCES provider_communications (tenant_id, id),
  CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CHECK (tax_minor IS NULL OR amount_minor IS NOT NULL),
  CHECK ((revision = 1) = (supersedes_quote_id IS NULL)),
  CHECK (source_kind <> 'ADAPTER_RESPONSE' OR source_attempt_id IS NOT NULL)
);
CREATE INDEX provider_quotes_incident_ix ON provider_quotes (tenant_id, incident_id, recorded_at);
SELECT ub_make_append_only('provider_quotes');

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE provider_command_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pck')),
  route text NOT NULL CHECK (route ~ '^[a-z][a-z0-9_.]{2,63}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_ref text NOT NULL CHECK (length(result_ref) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, route, idempotency_key)
);
SELECT ub_make_append_only('provider_command_receipts');

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE notifications (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ntf')),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^notification\.v1:sha256:[0-9a-f]{64}$'),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('CRITICAL_INCIDENT', 'INCIDENT_ESCALATED', 'INCIDENT_REOPENED',
    'ASSIGNMENT', 'DEADLINE_EXPIRED', 'EVIDENCE_GAP', 'APPROVAL_REQUIRED', 'SPEND_EXCEPTION', 'PROVIDER_CHANGE', 'RECOVERY')),
  routing_version text NOT NULL CHECK (routing_version ~ '^notification-routing\.v[1-9][0-9]{0,3}$'),
  source_event_id text NOT NULL CHECK (ub_id_ok(source_event_id, 'evt')),
  source_event_type text NOT NULL CHECK (source_event_type ~ '^[a-z_]+\.[a-z_]+\.v[1-9]$'),
  incident_id text,
  site_id text NOT NULL,
  recipient_user_id text NOT NULL,
  recipient_role text NOT NULL CHECK (recipient_role IN ('viewer', 'operator', 'maintenance_approver', 'finance_approver',
    'engineer', 'admin', 'auditor', 'assignee')),
  channel text NOT NULL CHECK (channel IN ('LOCAL_INBOX')),
  severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'NORMAL')),
  title_code text NOT NULL CHECK (title_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  -- Direct context: an in-app path plus opaque ids and the recovery path; never contact values or transcript text.
  deep_link text NOT NULL CHECK (deep_link ~ '^/[a-z0-9/_-]{1,200}(\?[a-zA-Z0-9=&_-]{1,200})?$'),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DELIVERED', 'UNKNOWN', 'FAILED')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 10),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) <= 128),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id),
  CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL))
);
CREATE INDEX notifications_pending_ix ON notifications (next_attempt_at) WHERE state IN ('PENDING', 'UNKNOWN');
CREATE INDEX notifications_recipient_ix ON notifications (tenant_id, recipient_user_id, created_at);

CREATE FUNCTION ub_notification_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notifications are append-only' USING ERRCODE = 'UB001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'delivery_attempts', 'provider_ref', 'next_attempt_at', 'delivered_at', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'delivery_attempts', 'provider_ref', 'next_attempt_at', 'delivered_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'notification content is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF OLD.state IN ('DELIVERED', 'FAILED') THEN
    RAISE EXCEPTION 'notification % is terminal', OLD.id USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'notification version must advance by one' USING ERRCODE = 'UB071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notifications_guard BEFORE UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION ub_notification_guard();
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();
