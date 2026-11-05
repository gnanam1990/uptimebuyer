-- M10 order, service-job and external-outcome reconciliation (FR-13, FR-17, NFR-02, NFR-03, INV-07, INV-08, INV-12,
-- INV-14). Purchase orders and service jobs are SEPARATE tables with separate constrained state enums and separate
-- SQL edge functions (cross-kind transitions are impossible). Each row binds exactly one M09 commercial intent and
-- copies its pre-egress client operation identity and pinned provider-account revision; the stable action digest plus
-- execution authority maps to one order/job, and a successor for the digest exists only when every predecessor has a
-- definite-no-effect proof stamp (composes with commercial_intents_one_live_per_digest_ux, never weakens it). Every
-- state change is backed by an immutable fulfillment observation whose foreign key pins the order's own
-- provider-account revision (stale-revision retargeting is refused by the database). Material changes are recorded as
-- append-only change proposals that can never be auto-accepted. SQLSTATEs UB101..UB104.

-- Legal edges, transcribed from @uptimebuyer/domain MACHINES (T-006 compares every pair).
CREATE FUNCTION ub_purchase_order_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (
    ('REQUESTED', 'ACCEPTED'), ('REQUESTED', 'REJECTED'), ('REQUESTED', 'CANCELLED'),
    ('REQUESTED', 'FAILED'), ('REQUESTED', 'UNKNOWN'), ('UNKNOWN', 'ACCEPTED'), ('UNKNOWN', 'REJECTED'),
    ('UNKNOWN', 'ORDERED'), ('UNKNOWN', 'PARTIALLY_FILLED'), ('UNKNOWN', 'SHIPPED'),
    ('UNKNOWN', 'DELIVERED'), ('UNKNOWN', 'CANCELLED'), ('UNKNOWN', 'FAILED'), ('ACCEPTED', 'ORDERED'),
    ('ACCEPTED', 'SUBSTITUTION_PROPOSED'), ('ACCEPTED', 'CHANGE_REVIEW'), ('ACCEPTED', 'CANCELLED'),
    ('ACCEPTED', 'FAILED'), ('ACCEPTED', 'UNKNOWN'), ('ORDERED', 'PARTIALLY_FILLED'),
    ('ORDERED', 'SHIPPED'), ('ORDERED', 'SUBSTITUTION_PROPOSED'), ('ORDERED', 'CHANGE_REVIEW'),
    ('ORDERED', 'CANCELLED'), ('ORDERED', 'FAILED'), ('ORDERED', 'UNKNOWN'),
    ('PARTIALLY_FILLED', 'SHIPPED'), ('PARTIALLY_FILLED', 'DELIVERED'),
    ('PARTIALLY_FILLED', 'SUBSTITUTION_PROPOSED'), ('PARTIALLY_FILLED', 'CHANGE_REVIEW'),
    ('PARTIALLY_FILLED', 'CANCELLED'), ('PARTIALLY_FILLED', 'FAILED'), ('PARTIALLY_FILLED', 'UNKNOWN'),
    ('SHIPPED', 'DELIVERED'), ('SHIPPED', 'PARTIALLY_FILLED'), ('SHIPPED', 'CHANGE_REVIEW'),
    ('SHIPPED', 'FAILED'), ('SHIPPED', 'UNKNOWN'), ('DELIVERED', 'VERIFIED'), ('DELIVERED', 'DISPUTED'),
    ('SUBSTITUTION_PROPOSED', 'CANCELLED'), ('CHANGE_REVIEW', 'CANCELLED')) $$;

CREATE FUNCTION ub_service_job_edge_ok(f text, t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (f, t) IN (
    ('REQUESTED', 'ACCEPTED'), ('REQUESTED', 'REJECTED'), ('REQUESTED', 'CANCELLED'),
    ('REQUESTED', 'FAILED'), ('REQUESTED', 'UNKNOWN'), ('UNKNOWN', 'ACCEPTED'), ('UNKNOWN', 'REJECTED'),
    ('UNKNOWN', 'SCHEDULED'), ('UNKNOWN', 'RESCHEDULED'), ('UNKNOWN', 'NO_SHOW'),
    ('UNKNOWN', 'EN_ROUTE'), ('UNKNOWN', 'ARRIVED'), ('UNKNOWN', 'IN_PROGRESS'),
    ('UNKNOWN', 'WORK_REPORTED_COMPLETE'), ('UNKNOWN', 'CANCELLED'), ('UNKNOWN', 'FAILED'),
    ('ACCEPTED', 'SCHEDULED'), ('ACCEPTED', 'RESCHEDULED'), ('ACCEPTED', 'CANCELLED'),
    ('ACCEPTED', 'FAILED'), ('ACCEPTED', 'UNKNOWN'), ('SCHEDULED', 'SCHEDULED'),
    ('SCHEDULED', 'EN_ROUTE'), ('SCHEDULED', 'RESCHEDULED'), ('SCHEDULED', 'NO_SHOW'),
    ('SCHEDULED', 'CANCELLED'), ('SCHEDULED', 'FAILED'), ('SCHEDULED', 'UNKNOWN'),
    ('RESCHEDULED', 'SCHEDULED'), ('RESCHEDULED', 'EN_ROUTE'), ('RESCHEDULED', 'RESCHEDULED'),
    ('RESCHEDULED', 'NO_SHOW'), ('RESCHEDULED', 'CANCELLED'), ('RESCHEDULED', 'FAILED'),
    ('RESCHEDULED', 'UNKNOWN'), ('EN_ROUTE', 'ARRIVED'), ('EN_ROUTE', 'RESCHEDULED'),
    ('EN_ROUTE', 'NO_SHOW'), ('EN_ROUTE', 'CANCELLED'), ('EN_ROUTE', 'FAILED'), ('EN_ROUTE', 'UNKNOWN'),
    ('ARRIVED', 'IN_PROGRESS'), ('ARRIVED', 'SCOPE_CHANGE_PROPOSED'), ('ARRIVED', 'CANCELLED'),
    ('ARRIVED', 'FAILED'), ('IN_PROGRESS', 'WORK_REPORTED_COMPLETE'),
    ('IN_PROGRESS', 'SCOPE_CHANGE_PROPOSED'), ('IN_PROGRESS', 'CANCELLED'), ('IN_PROGRESS', 'FAILED'),
    ('IN_PROGRESS', 'UNKNOWN'), ('WORK_REPORTED_COMPLETE', 'VERIFIED'),
    ('WORK_REPORTED_COMPLETE', 'DISPUTED'), ('SCOPE_CHANGE_PROPOSED', 'CANCELLED')) $$;

CREATE TABLE purchase_orders (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pur')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  candidate_action_id text NOT NULL,
  commercial_intent_id text NOT NULL,
  execution_authority_id text NOT NULL,
  approval_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  client_operation_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_idempotency_key text NOT NULL CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  provider_ref text CHECK (provider_ref IS NULL OR provider_ref ~ '^[\x21-\x7E]{1,128}$'),
  state text NOT NULL CHECK (state IN ('REQUESTED', 'ACCEPTED', 'ORDERED', 'PARTIALLY_FILLED', 'SHIPPED', 'DELIVERED',
    'VERIFIED', 'DISPUTED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN')),
  approved_quantity integer NOT NULL CHECK (approved_quantity BETWEEN 1 AND 1000000),
  quantity_filled integer NOT NULL DEFAULT 0 CHECK (quantity_filled BETWEEN 0 AND 1000000),
  approved_amount_minor bigint NOT NULL CHECK (approved_amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  approved_eta_at timestamptz,
  blocked_reason text CHECK (blocked_reason IS NULL OR blocked_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  cancel_requested_at timestamptz,
  no_effect_proven_at timestamptz,
  last_observation_id text,
  last_observed_at timestamptz,
  last_provider_sequence bigint CHECK (last_provider_sequence IS NULL OR last_provider_sequence >= 0),
  next_poll_at timestamptz,
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  supersedes_order_id text,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, commercial_intent_id),
  UNIQUE (tenant_id, action_digest, execution_authority_id),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, commercial_intent_id, provider_account_id, provider_account_revision_id, client_operation_id,
    idempotency_key) REFERENCES commercial_intents (tenant_id, id, provider_account_id, provider_account_revision_id,
    client_operation_id, idempotency_key),
  FOREIGN KEY (tenant_id, execution_authority_id, action_digest)
    REFERENCES execution_authorities (tenant_id, id, action_digest),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_action_id) REFERENCES candidate_actions (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_order_id) REFERENCES purchase_orders (tenant_id, id),
  CHECK (no_effect_proven_at IS NULL OR state IN ('REJECTED', 'CANCELLED', 'FAILED'))
);
-- INV-07 at the order level: at most one order per tenant and action digest without definite-no-effect proof.
CREATE UNIQUE INDEX purchase_orders_one_live_per_digest_ux ON purchase_orders (tenant_id, action_digest)
  WHERE no_effect_proven_at IS NULL;
CREATE UNIQUE INDEX purchase_orders_provider_ref_ux ON purchase_orders (tenant_id, provider_account_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE INDEX purchase_orders_poll_ix ON purchase_orders (next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX purchase_orders_incident_ix ON purchase_orders (tenant_id, incident_id);

CREATE TABLE service_jobs (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'sjb')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  candidate_action_id text NOT NULL,
  commercial_intent_id text NOT NULL,
  execution_authority_id text NOT NULL,
  approval_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  client_operation_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_idempotency_key text NOT NULL CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  provider_ref text CHECK (provider_ref IS NULL OR provider_ref ~ '^[\x21-\x7E]{1,128}$'),
  state text NOT NULL CHECK (state IN ('REQUESTED', 'ACCEPTED', 'SCHEDULED', 'RESCHEDULED', 'EN_ROUTE', 'ARRIVED',
    'IN_PROGRESS', 'WORK_REPORTED_COMPLETE', 'SCOPE_CHANGE_PROPOSED', 'NO_SHOW', 'VERIFIED', 'DISPUTED', 'REJECTED',
    'CANCELLED', 'FAILED', 'UNKNOWN')),
  approved_quantity integer NOT NULL CHECK (approved_quantity BETWEEN 1 AND 1000000),
  approved_amount_minor bigint NOT NULL CHECK (approved_amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  approved_eta_at timestamptz,
  scheduled_start_at timestamptz,
  blocked_reason text CHECK (blocked_reason IS NULL OR blocked_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  cancel_requested_at timestamptz,
  no_effect_proven_at timestamptz,
  last_observation_id text,
  last_observed_at timestamptz,
  last_provider_sequence bigint CHECK (last_provider_sequence IS NULL OR last_provider_sequence >= 0),
  next_poll_at timestamptz,
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  supersedes_order_id text,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, commercial_intent_id),
  UNIQUE (tenant_id, action_digest, execution_authority_id),
  UNIQUE (tenant_id, provider_account_id, client_operation_id),
  UNIQUE (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, commercial_intent_id, provider_account_id, provider_account_revision_id, client_operation_id,
    idempotency_key) REFERENCES commercial_intents (tenant_id, id, provider_account_id, provider_account_revision_id,
    client_operation_id, idempotency_key),
  FOREIGN KEY (tenant_id, execution_authority_id, action_digest)
    REFERENCES execution_authorities (tenant_id, id, action_digest),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_action_id) REFERENCES candidate_actions (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_order_id) REFERENCES service_jobs (tenant_id, id),
  CHECK (no_effect_proven_at IS NULL OR state IN ('REJECTED', 'CANCELLED', 'FAILED'))
);
CREATE UNIQUE INDEX service_jobs_one_live_per_digest_ux ON service_jobs (tenant_id, action_digest)
  WHERE no_effect_proven_at IS NULL;
CREATE UNIQUE INDEX service_jobs_provider_ref_ux ON service_jobs (tenant_id, provider_account_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE INDEX service_jobs_poll_ix ON service_jobs (next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX service_jobs_incident_ix ON service_jobs (tenant_id, incident_id);

-- Immutable provider/broker/operator observations. The composite foreign key to the order carries the order's pinned
-- provider-account revision, so an observation verified under any other revision cannot attach to it.
CREATE TABLE fulfillment_observations (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'fob')),
  order_kind text NOT NULL CHECK (order_kind IN ('PURCHASE_ORDER', 'SERVICE_JOB')),
  purchase_order_id text,
  service_job_id text,
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('WEBHOOK', 'POLL', 'BROKER', 'OPERATOR')),
  -- Event identity namespaced by tenant and provider account (the unique key below).
  provider_event_key text NOT NULL CHECK (provider_event_key ~ '^[\x21-\x7E]+$' AND length(provider_event_key) <= 300),
  webhook_delivery_id text,
  raw_status text NOT NULL CHECK (length(raw_status) BETWEEN 1 AND 256),
  normalized_state text,
  raw_body bytea CHECK (raw_body IS NULL OR octet_length(raw_body) <= 65536),
  raw_body_digest text CHECK (raw_body_digest IS NULL OR raw_body_digest ~ '^sha256:[0-9a-f]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  observed_at timestamptz NOT NULL,
  provider_sequence bigint CHECK (provider_sequence IS NULL OR provider_sequence >= 0),
  disposition text NOT NULL CHECK (disposition IN ('APPLIED', 'STALE', 'ILLEGAL', 'UNMAPPED', 'NO_CHANGE', 'NOT_FOUND',
    'REFUSED')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, provider_event_key),
  FOREIGN KEY (tenant_id, purchase_order_id, provider_account_id, provider_account_revision_id)
    REFERENCES purchase_orders (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, service_job_id, provider_account_id, provider_account_revision_id)
    REFERENCES service_jobs (tenant_id, id, provider_account_id, provider_account_revision_id),
  FOREIGN KEY (tenant_id, webhook_delivery_id) REFERENCES webhook_deliveries (tenant_id, id),
  CHECK ((order_kind = 'PURCHASE_ORDER') = (purchase_order_id IS NOT NULL)),
  CHECK ((order_kind = 'SERVICE_JOB') = (service_job_id IS NOT NULL)),
  CHECK ((source = 'WEBHOOK') = (webhook_delivery_id IS NOT NULL)),
  CHECK (order_kind <> 'PURCHASE_ORDER' OR normalized_state IS NULL OR normalized_state IN ('REQUESTED', 'ACCEPTED',
    'ORDERED', 'PARTIALLY_FILLED', 'SHIPPED', 'DELIVERED', 'VERIFIED', 'DISPUTED', 'SUBSTITUTION_PROPOSED',
    'CHANGE_REVIEW', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN')),
  CHECK (order_kind <> 'SERVICE_JOB' OR normalized_state IS NULL OR normalized_state IN ('REQUESTED', 'ACCEPTED',
    'SCHEDULED', 'RESCHEDULED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'WORK_REPORTED_COMPLETE', 'SCOPE_CHANGE_PROPOSED',
    'NO_SHOW', 'VERIFIED', 'DISPUTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN')),
  CHECK (disposition <> 'APPLIED' OR normalized_state IS NOT NULL)
);
SELECT ub_make_append_only('fulfillment_observations');
CREATE INDEX fulfillment_observations_po_ix ON fulfillment_observations (tenant_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE INDEX fulfillment_observations_sj_ix ON fulfillment_observations (tenant_id, service_job_id)
  WHERE service_job_id IS NOT NULL;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_last_observation_fk
  FOREIGN KEY (tenant_id, last_observation_id) REFERENCES fulfillment_observations (tenant_id, id);
ALTER TABLE service_jobs ADD CONSTRAINT service_jobs_last_observation_fk
  FOREIGN KEY (tenant_id, last_observation_id) REFERENCES fulfillment_observations (tenant_id, id);

CREATE TABLE purchase_order_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pot')),
  purchase_order_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text NOT NULL,
  to_state text NOT NULL,
  observation_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, purchase_order_id, sequence),
  UNIQUE (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, observation_id) REFERENCES fulfillment_observations (tenant_id, id),
  CHECK (ub_purchase_order_edge_ok(from_state, to_state))
);
SELECT ub_make_append_only('purchase_order_transitions');

CREATE TABLE service_job_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'sjt')),
  service_job_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text NOT NULL,
  to_state text NOT NULL,
  observation_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, service_job_id, sequence),
  UNIQUE (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, service_job_id) REFERENCES service_jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, observation_id) REFERENCES fulfillment_observations (tenant_id, id),
  CHECK (ub_service_job_edge_ok(from_state, to_state))
);
SELECT ub_make_append_only('service_job_transitions');

-- A material change is recorded, never applied: it blocks the order/job and sends any changed candidate back through
-- evidence, compatibility and approval. Merchant substitutions are never auto-accepted.
CREATE TABLE fulfillment_change_proposals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'fcp')),
  order_kind text NOT NULL CHECK (order_kind IN ('PURCHASE_ORDER', 'SERVICE_JOB')),
  purchase_order_id text,
  service_job_id text,
  observation_id text,
  change_kind text NOT NULL CHECK (change_kind IN ('PARTIAL_FILL', 'SUBSTITUTION', 'QUANTITY_CHANGE', 'PRICE_CHANGE',
    'ETA_CHANGE', 'STOCK_CHANGE', 'RESCHEDULE', 'NO_SHOW', 'SCOPE_CHANGE', 'CANCELLATION', 'PROVIDER_FAILURE',
    'REJECTION', 'DISPUTE', 'REVOCATION')),
  approved jsonb NOT NULL CHECK (jsonb_typeof(approved) = 'object'),
  proposed jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  requires_reentry text[] NOT NULL CHECK (cardinality(requires_reentry) BETWEEN 1 AND 3
    AND requires_reentry <@ ARRAY['EVIDENCE', 'COMPATIBILITY', 'APPROVAL']::text[]),
  auto_accepted boolean NOT NULL DEFAULT false CHECK (NOT auto_accepted),
  invalidated_plan_id text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, service_job_id) REFERENCES service_jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, observation_id) REFERENCES fulfillment_observations (tenant_id, id),
  FOREIGN KEY (tenant_id, invalidated_plan_id) REFERENCES recovery_plans (tenant_id, id),
  CHECK ((order_kind = 'PURCHASE_ORDER') = (purchase_order_id IS NOT NULL)),
  CHECK ((order_kind = 'SERVICE_JOB') = (service_job_id IS NOT NULL)),
  CHECK ((change_kind = 'REVOCATION') = (observation_id IS NULL))
);
SELECT ub_make_append_only('fulfillment_change_proposals');
CREATE UNIQUE INDEX fulfillment_change_proposals_observation_ux ON fulfillment_change_proposals
  (tenant_id, observation_id, change_kind) WHERE observation_id IS NOT NULL;
CREATE UNIQUE INDEX fulfillment_change_proposals_revocation_po_ux ON fulfillment_change_proposals
  (tenant_id, purchase_order_id) WHERE change_kind = 'REVOCATION' AND purchase_order_id IS NOT NULL;
CREATE UNIQUE INDEX fulfillment_change_proposals_revocation_sj_ux ON fulfillment_change_proposals
  (tenant_id, service_job_id) WHERE change_kind = 'REVOCATION' AND service_job_id IS NOT NULL;

-- Insert: REQUESTED at version 1, exactly the bound intent/authority/plan action, the right semantic operation for the
-- table, and a successor only behind definite-no-effect predecessors (linked to the latest one).
CREATE FUNCTION ub_order_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  op text := CASE TG_TABLE_NAME WHEN 'purchase_orders' THEN 'PURCHASE' ELSE 'SERVICE_BOOKING' END;
  latest text;
  open_prior boolean;
BEGIN
  IF NEW.state <> 'REQUESTED' OR NEW.version <> 1 OR NEW.provider_ref IS NOT NULL OR NEW.blocked_reason IS NOT NULL
     OR NEW.cancel_requested_at IS NOT NULL OR NEW.no_effect_proven_at IS NOT NULL OR NEW.last_observation_id IS NOT NULL
     OR NEW.last_observed_at IS NOT NULL OR NEW.poll_count <> 0 THEN
    RAISE EXCEPTION 'an order/job is created REQUESTED at version 1 with no observations' USING ERRCODE = 'UB101';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commercial_intents i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.commercial_intent_id
       AND i.incident_id = NEW.incident_id AND i.site_id = NEW.site_id AND i.action_digest = NEW.action_digest
       AND i.execution_authority_id = NEW.execution_authority_id AND i.approval_id = NEW.approval_id
       AND i.subject_type = 'PLAN_ACTION' AND i.subject_id = NEW.candidate_action_id AND i.semantic_operation = op
       AND i.max_amount_minor = NEW.approved_amount_minor AND i.currency = NEW.currency) THEN
    RAISE EXCEPTION 'order/job does not equal its commercial intent (or is the wrong kind)' USING ERRCODE = 'UB101';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM plan_actions pa JOIN plan_approval_bindings b ON b.tenant_id = pa.tenant_id
         AND b.plan_id = pa.plan_id AND b.plan_action_id = pa.id
       WHERE pa.tenant_id = NEW.tenant_id AND pa.plan_id = NEW.plan_id AND pa.id = NEW.plan_action_id
         AND pa.candidate_action_id = NEW.candidate_action_id AND pa.action_digest = NEW.action_digest
         AND b.approval_id = NEW.approval_id) THEN
    RAISE EXCEPTION 'order/job is not the approved plan action' USING ERRCODE = 'UB101';
  END IF;
  EXECUTE format('SELECT (SELECT id FROM %I WHERE tenant_id = $1 AND action_digest = $2 AND id <> $3
                   ORDER BY created_at DESC, id DESC LIMIT 1),
                  EXISTS (SELECT 1 FROM %I WHERE tenant_id = $1 AND action_digest = $2 AND id <> $3
                   AND no_effect_proven_at IS NULL)', TG_TABLE_NAME, TG_TABLE_NAME)
    INTO latest, open_prior USING NEW.tenant_id, NEW.action_digest, NEW.id;
  IF open_prior OR latest IS DISTINCT FROM NEW.supersedes_order_id THEN
    RAISE EXCEPTION 'a successor needs definite-no-effect predecessors and must link the latest' USING ERRCODE = 'UB102';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER purchase_orders_insert_guard BEFORE INSERT ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION ub_order_insert_guard();
CREATE TRIGGER service_jobs_insert_guard BEFORE INSERT ON service_jobs
  FOR EACH ROW EXECUTE FUNCTION ub_order_insert_guard();

-- Update: identity immutable; poll scheduling may change alone; otherwise version + 1, a legal edge of THIS table's
-- machine, every state change backed by a new observation (leaving UNKNOWN only by reconciliation evidence), and
-- set-once provider reference, block, cancellation request and no-effect proof (the latter only for a FAILED intent).
CREATE FUNCTION ub_order_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  sched text[] := ARRAY['next_poll_at', 'poll_count', 'updated_at'];
  proj text[] := ARRAY['state', 'provider_ref', 'quantity_filled', 'scheduled_start_at', 'blocked_reason',
    'cancel_requested_at', 'no_effect_proven_at', 'last_observation_id', 'last_observed_at', 'last_provider_sequence',
    'next_poll_at', 'poll_count', 'version', 'updated_at'];
  edge_ok boolean;
  src text;
BEGIN
  IF (to_jsonb(OLD) - sched) = (to_jsonb(NEW) - sched) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - proj) <> (to_jsonb(NEW) - proj) THEN
    RAISE EXCEPTION 'order/job identity is immutable' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'order/job version must advance by one' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.state <> OLD.state THEN
    edge_ok := CASE TG_TABLE_NAME WHEN 'purchase_orders' THEN ub_purchase_order_edge_ok(OLD.state, NEW.state)
      ELSE ub_service_job_edge_ok(OLD.state, NEW.state) END;
    IF NOT edge_ok THEN
      RAISE EXCEPTION 'illegal % transition % -> %', TG_TABLE_NAME, OLD.state, NEW.state USING ERRCODE = 'UB103';
    END IF;
  END IF;
  IF NEW.state <> OLD.state OR NEW.last_observation_id IS DISTINCT FROM OLD.last_observation_id THEN
    IF NEW.last_observation_id IS NULL OR NEW.last_observation_id IS NOT DISTINCT FROM OLD.last_observation_id THEN
      RAISE EXCEPTION 'every order/job state change is backed by a new observation' USING ERRCODE = 'UB103';
    END IF;
    SELECT o.source INTO src FROM fulfillment_observations o WHERE o.tenant_id = NEW.tenant_id
       AND o.id = NEW.last_observation_id AND o.disposition = 'APPLIED' AND o.normalized_state = NEW.state
       AND coalesce(o.purchase_order_id, o.service_job_id) = NEW.id;
    IF src IS NULL OR (OLD.state = 'UNKNOWN' AND NEW.state <> 'UNKNOWN' AND src NOT IN ('BROKER', 'POLL', 'WEBHOOK')) THEN
      RAISE EXCEPTION 'order/job transition lacks its applied (reconciliation) observation' USING ERRCODE = 'UB103';
    END IF;
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR OLD.blocked_reason IS NOT NULL AND NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason
     OR OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
     OR OLD.no_effect_proven_at IS NOT NULL AND NEW.no_effect_proven_at IS DISTINCT FROM OLD.no_effect_proven_at
     OR NEW.last_observed_at < OLD.last_observed_at THEN
    RAISE EXCEPTION 'set-once order/job evidence cannot change' USING ERRCODE = 'UB104';
  END IF;
  IF TG_TABLE_NAME = 'purchase_orders' THEN
    IF (to_jsonb(NEW) ->> 'quantity_filled')::int < (to_jsonb(OLD) ->> 'quantity_filled')::int THEN
      RAISE EXCEPTION 'filled quantity never decreases' USING ERRCODE = 'UB104';
    END IF;
  END IF;
  IF OLD.no_effect_proven_at IS NULL AND NEW.no_effect_proven_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM commercial_intents i WHERE i.tenant_id = NEW.tenant_id
       AND i.id = NEW.commercial_intent_id AND i.state = 'FAILED') THEN
    RAISE EXCEPTION 'definite-no-effect proof requires the FAILED commercial intent' USING ERRCODE = 'UB104';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER purchase_orders_update_guard BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION ub_order_update_guard();
CREATE TRIGGER service_jobs_update_guard BEFORE UPDATE ON service_jobs
  FOR EACH ROW EXECUTE FUNCTION ub_order_update_guard();
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER purchase_orders_no_truncate BEFORE TRUNCATE ON purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER service_jobs_no_delete BEFORE DELETE ON service_jobs
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER service_jobs_no_truncate BEFORE TRUNCATE ON service_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();
