-- M08 cost-to-recovery planning (FR-09, INV-03, INV-04, INV-10, INV-16): versioned tenant risk estimates, immutable
-- revision-bound recovery plans with their evaluated actions, the append-only plan lifecycle (STATE-MACHINES §4) with
-- a mutable state projection guarded by the legal edge table, and server-derived approval requests. Every table has
-- tenant_id, a tenant-leading key and tenant-leading composite foreign keys. Guards raise UB081..UB084.

-- The versioned tenant risk estimate: downtime cost rate, deadline-conditioned inventory-loss probability and
-- repeat-failure risk, scoped tenant-wide (site_id NULL) or to one site. A new revision never edits an old one.
CREATE TABLE tenant_risk_estimates (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'tre')),
  site_id text,
  scope_key text GENERATED ALWAYS AS (coalesce(site_id, '*')) STORED,
  revision integer NOT NULL CHECK (revision >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^tenant-risk-estimate\.v1:sha256:[0-9a-f]{64}$'),
  basis text NOT NULL CHECK (basis IN ('OPERATOR_ESTIMATE', 'HISTORICAL_ANALYSIS', 'MODEL_INFORMED')),
  effective_at timestamptz NOT NULL,
  published_by_kind text NOT NULL CHECK (published_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  published_by_id text NOT NULL CHECK (length(published_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, scope_key, revision),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
CREATE INDEX tenant_risk_estimates_scope_ix ON tenant_risk_estimates (tenant_id, scope_key, effective_at DESC);
SELECT ub_make_append_only('tenant_risk_estimates');

CREATE TABLE recovery_plans (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pln')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  -- Economic input revisions (NULL when absent: such a plan is INCOMPLETE and HELD).
  risk_estimate_id text,
  inventory_registry_revision_id text,
  revision integer NOT NULL CHECK (revision >= 1),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^recovery-plan\.v1:sha256:[0-9a-f]{64}$'),
  rule_version text NOT NULL CHECK (rule_version ~ '^[a-z][a-z0-9-]{0,62}\.r[1-9][0-9]{0,5}$'),
  state text NOT NULL CHECK (state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'HELD', 'APPROVED', 'REJECTED', 'EXECUTING',
    'COMPLETED', 'INVALIDATED')),
  outcome text NOT NULL CHECK (outcome IN ('RANKED', 'INCOMPLETE', 'NO_ELIGIBLE_CANDIDATE')),
  hold_reasons text[] NOT NULL CHECK (cardinality(hold_reasons) <= 16),
  -- The incident's projected deadline as read at evaluation (current_response_deadline_at + latest event sequence).
  deadline_at timestamptz,
  deadline_status text CHECK (deadline_status IN ('RUNNING', 'PAUSED', 'EXPIRED')),
  deadline_event_sequence integer CHECK (deadline_event_sequence >= 1),
  procedure_revision_id text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  -- The full exposed computation (inputs, provenance, components, ranking) exactly as hashed.
  computation jsonb NOT NULL CHECK (jsonb_typeof(computation) = 'object'),
  in_flight_reconciliation boolean NOT NULL DEFAULT false,
  invalidated_at timestamptz,
  invalidated_reason text CHECK (invalidated_reason IS NULL OR invalidated_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, plan_hash),
  UNIQUE (tenant_id, incident_id, revision),
  UNIQUE (tenant_id, id, incident_id),
  UNIQUE (tenant_id, id, plan_hash),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, risk_estimate_id) REFERENCES tenant_risk_estimates (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_registry_revision_id) REFERENCES registry_revisions (tenant_id, id),
  CHECK ((state = 'INVALIDATED') = (invalidated_at IS NOT NULL)),
  CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL)),
  CHECK (NOT in_flight_reconciliation OR state = 'INVALIDATED'),
  CHECK (state NOT IN ('APPROVABLE', 'APPROVED', 'REJECTED', 'EXECUTING', 'COMPLETED') OR outcome = 'RANKED'),
  CHECK (state <> 'HELD' OR outcome <> 'RANKED'),
  CHECK ((deadline_at IS NULL) = (deadline_status IS NULL) AND (deadline_at IS NULL) = (deadline_event_sequence IS NULL))
);
CREATE INDEX recovery_plans_open_ix ON recovery_plans (tenant_id, incident_id)
  WHERE state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING');

-- A plan binds an evidence revision of its own incident and asset revision, an AUTHORITY policy revision, a risk
-- estimate scoped to its tenant or site, and a FOOD_AT_RISK registry revision of its own asset. It starts DRAFT.
CREATE FUNCTION ub_recovery_plan_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.state <> 'DRAFT' OR NEW.version <> 1 OR NEW.invalidated_at IS NOT NULL OR NEW.in_flight_reconciliation THEN
    RAISE EXCEPTION 'a recovery plan is created DRAFT at version 1' USING ERRCODE = 'UB081';
  END IF;
  IF EXISTS (SELECT 1 FROM evidence_revisions e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.evidence_revision_id
              AND (e.incident_id IS DISTINCT FROM NEW.incident_id OR e.asset_revision_id IS DISTINCT FROM NEW.asset_revision_id)) THEN
    RAISE EXCEPTION 'plan evidence revision is not bound to its incident and asset revision' USING ERRCODE = 'UB081';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
              WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.policy_revision_id AND p.policy_key <> 'AUTHORITY') THEN
    RAISE EXCEPTION 'plan must bind an AUTHORITY policy revision' USING ERRCODE = 'UB081';
  END IF;
  IF NEW.risk_estimate_id IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_risk_estimates t WHERE t.tenant_id = NEW.tenant_id
              AND t.id = NEW.risk_estimate_id AND t.site_id IS NOT NULL AND t.site_id <> NEW.site_id) THEN
    RAISE EXCEPTION 'plan risk estimate is scoped to another site' USING ERRCODE = 'UB081';
  END IF;
  IF NEW.inventory_registry_revision_id IS NOT NULL AND EXISTS (SELECT 1 FROM registry_revisions g
              WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.inventory_registry_revision_id
                AND (g.entity_kind <> 'FOOD_AT_RISK' OR g.entity_id <> NEW.asset_id)) THEN
    RAISE EXCEPTION 'plan inventory value is not a FOOD_AT_RISK record of its asset' USING ERRCODE = 'UB081';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_plans_insert_guard BEFORE INSERT ON recovery_plans
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_plan_insert_guard();

-- Only the lifecycle projection may change, one legal STATE-MACHINES §4 edge at a time with version + 1.
CREATE FUNCTION ub_recovery_plan_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  projection text[] := ARRAY['state', 'version', 'in_flight_reconciliation', 'invalidated_at', 'invalidated_reason'];
BEGIN
  IF (to_jsonb(OLD) - projection) <> (to_jsonb(NEW) - projection) THEN
    RAISE EXCEPTION 'recovery_plans is append-only outside its lifecycle projection' USING ERRCODE = 'UB001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'recovery plan version must advance by one' USING ERRCODE = 'UB001';
  END IF;
  IF (OLD.state, NEW.state) NOT IN (('DRAFT', 'EVALUATED'), ('EVALUATED', 'APPROVABLE'), ('EVALUATED', 'HELD'),
      ('APPROVABLE', 'APPROVED'), ('APPROVABLE', 'REJECTED'), ('APPROVED', 'EXECUTING'), ('EXECUTING', 'COMPLETED'),
      ('DRAFT', 'INVALIDATED'), ('EVALUATED', 'INVALIDATED'), ('APPROVABLE', 'INVALIDATED'), ('APPROVED', 'INVALIDATED'),
      ('EXECUTING', 'INVALIDATED')) THEN
    RAISE EXCEPTION 'illegal recovery plan transition % -> %', OLD.state, NEW.state USING ERRCODE = 'UB001';
  END IF;
  IF NEW.in_flight_reconciliation AND OLD.state <> 'EXECUTING' THEN
    RAISE EXCEPTION 'only an executing plan carries in-flight reconciliation' USING ERRCODE = 'UB001';
  END IF;
  IF OLD.state = 'EXECUTING' AND NEW.state = 'INVALIDATED' AND NOT NEW.in_flight_reconciliation THEN
    RAISE EXCEPTION 'invalidating an executing plan requires in-flight reconciliation' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recovery_plans_update_guard BEFORE UPDATE ON recovery_plans
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_plan_update_guard();
CREATE TRIGGER recovery_plans_no_delete BEFORE DELETE ON recovery_plans
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER recovery_plans_no_truncate BEFORE TRUNCATE ON recovery_plans
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- One evaluated candidate of a plan: ranked (ordinal), eligible but unranked, incomplete, held or rejected.
CREATE TABLE plan_actions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pla')),
  plan_id text NOT NULL,
  incident_id text NOT NULL,
  candidate_action_id text NOT NULL,
  compatibility_decision_id text,
  quote_id text,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  action_kind text NOT NULL
    CHECK (action_kind IN ('PART_PURCHASE', 'SERVICE_JOB', 'DIAGNOSTIC_SERVICE', 'PAID_CONTACT', 'CONTAINMENT_PURCHASE')),
  disposition text NOT NULL CHECK (disposition IN ('RANKED', 'ELIGIBLE_UNRANKED', 'INCOMPLETE', 'HELD', 'REJECTED')),
  ordinal integer CHECK (ordinal >= 1),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) <= 64),
  provider_score integer CHECK (provider_score BETWEEN 0 AND 1000000),
  amount_minor bigint CHECK (amount_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  provider_account_revision_id text,
  merchant_id text CHECK (merchant_id IS NULL OR ub_id_ok(merchant_id, 'mer')),
  expected_cost_minor bigint CHECK (expected_cost_minor >= 0),
  expected_cost_low_minor bigint CHECK (expected_cost_low_minor >= 0),
  expected_cost_high_minor bigint CHECK (expected_cost_high_minor >= 0),
  deadline_penalty_minor bigint CHECK (deadline_penalty_minor >= 0),
  expected_delay_ms bigint CHECK (expected_delay_ms >= 0),
  deadline_fit text CHECK (deadline_fit IN ('WITHIN_DEADLINE', 'MISSES_DEADLINE', 'DEADLINE_PASSED')),
  recovery_eta_at timestamptz,
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'array'),
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'array'),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, plan_id, id),
  UNIQUE (tenant_id, plan_id, ordinal),
  UNIQUE (tenant_id, plan_id, action_digest),
  UNIQUE (tenant_id, plan_id, candidate_action_id),
  FOREIGN KEY (tenant_id, plan_id, incident_id) REFERENCES recovery_plans (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, candidate_action_id) REFERENCES candidate_actions (tenant_id, id),
  FOREIGN KEY (tenant_id, compatibility_decision_id) REFERENCES compatibility_decisions (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES provider_quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_revision_id) REFERENCES provider_account_revisions (tenant_id, id),
  CHECK ((disposition = 'RANKED') = (ordinal IS NOT NULL)),
  CHECK ((disposition IN ('RANKED', 'ELIGIBLE_UNRANKED')) = (expected_cost_minor IS NOT NULL)),
  CHECK ((expected_cost_minor IS NULL) = (expected_cost_low_minor IS NULL)
     AND (expected_cost_minor IS NULL) = (expected_cost_high_minor IS NULL)
     AND (expected_cost_minor IS NULL) = (deadline_fit IS NULL)),
  CHECK (expected_cost_minor IS NULL OR (expected_cost_low_minor <= expected_cost_minor
     AND expected_cost_minor <= expected_cost_high_minor)),
  CHECK (disposition NOT IN ('RANKED', 'ELIGIBLE_UNRANKED') OR (provider_score IS NOT NULL AND amount_minor IS NOT NULL
     AND currency IS NOT NULL AND compatibility_decision_id IS NOT NULL AND quote_id IS NOT NULL)),
  CHECK ((amount_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX plan_actions_quote_ix ON plan_actions (tenant_id, quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX plan_actions_decision_ix ON plan_actions (tenant_id, compatibility_decision_id)
  WHERE compatibility_decision_id IS NOT NULL;
SELECT ub_make_append_only('plan_actions');

-- An action names a candidate of its plan's incident with that candidate's exact action digest, that candidate's
-- decision and a quote of the same incident. A missing parent is left to the composite foreign keys (23503).
CREATE FUNCTION ub_plan_action_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM candidate_actions c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.candidate_action_id
              AND (c.incident_id <> NEW.incident_id OR c.action_digest <> NEW.action_digest OR c.kind <> NEW.action_kind)) THEN
    RAISE EXCEPTION 'plan action does not match its candidate' USING ERRCODE = 'UB082';
  END IF;
  IF NEW.compatibility_decision_id IS NOT NULL AND EXISTS (SELECT 1 FROM compatibility_decisions d
              WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.compatibility_decision_id
                AND (d.candidate_action_id <> NEW.candidate_action_id OR d.action_digest <> NEW.action_digest)) THEN
    RAISE EXCEPTION 'plan action decision belongs to another candidate' USING ERRCODE = 'UB082';
  END IF;
  IF NEW.quote_id IS NOT NULL AND EXISTS (SELECT 1 FROM provider_quotes q WHERE q.tenant_id = NEW.tenant_id
              AND q.id = NEW.quote_id AND q.incident_id <> NEW.incident_id) THEN
    RAISE EXCEPTION 'plan action quote belongs to another incident' USING ERRCODE = 'UB082';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_actions_guard BEFORE INSERT ON plan_actions FOR EACH ROW EXECUTE FUNCTION ub_plan_action_guard();

CREATE TABLE recovery_plan_transitions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'plt')),
  plan_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, plan_id, sequence),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES recovery_plans (tenant_id, id),
  CHECK ((sequence = 1) = (from_state IS NULL))
);
SELECT ub_make_append_only('recovery_plan_transitions');

-- A prepared (not approved) request: the exact scope an approver would sign. Executable authority is M09's.
CREATE TABLE plan_approval_requests (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'apq')),
  plan_id text NOT NULL,
  plan_action_id text NOT NULL,
  incident_id text NOT NULL,
  site_id text NOT NULL,
  plan_hash text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  action_kind text NOT NULL,
  action_class text NOT NULL
    CHECK (action_class IN ('STANDARD', 'SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL', 'POLICY_OVERRIDE')),
  compatibility_decision_id text NOT NULL,
  approval_route jsonb NOT NULL CHECK (jsonb_typeof(approval_route) = 'object'),
  provider_account_revision_id text NOT NULL,
  merchant_id text NOT NULL CHECK (ub_id_ok(merchant_id, 'mer')),
  paid boolean NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^plan-approval-request\.v1:sha256:[0-9a-f]{64}$'),
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  requested_by_id text NOT NULL CHECK (length(requested_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invalidated_at timestamptz,
  invalidated_reason text CHECK (invalidated_reason IS NULL OR invalidated_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, plan_action_id),
  FOREIGN KEY (tenant_id, plan_id, plan_hash) REFERENCES recovery_plans (tenant_id, id, plan_hash),
  FOREIGN KEY (tenant_id, plan_id, incident_id) REFERENCES recovery_plans (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, plan_id, plan_action_id) REFERENCES plan_actions (tenant_id, plan_id, id),
  FOREIGN KEY (tenant_id, compatibility_decision_id) REFERENCES compatibility_decisions (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_revision_id) REFERENCES provider_account_revisions (tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL))
);
SELECT ub_make_append_only('plan_approval_requests', 'invalidated_at', 'invalidated_reason');

-- The prepared scope must equal its plan and ranked action exactly; a forged amount, currency, revision, account
-- or digest is refused even if a caller bypassed the service layer. Only an APPROVABLE plan's RANKED action.
CREATE FUNCTION ub_plan_approval_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recovery_plans p JOIN plan_actions a ON a.tenant_id = p.tenant_id AND a.plan_id = p.id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id AND a.id = NEW.plan_action_id
       AND p.state = 'APPROVABLE' AND a.disposition = 'RANKED'
       AND p.plan_hash = NEW.plan_hash AND p.incident_id = NEW.incident_id AND p.site_id = NEW.site_id
       AND p.asset_revision_id = NEW.asset_revision_id AND p.evidence_revision_id = NEW.evidence_revision_id
       AND p.policy_revision_id = NEW.policy_revision_id
       AND a.action_digest = NEW.action_digest AND a.action_kind = NEW.action_kind
       AND a.compatibility_decision_id = NEW.compatibility_decision_id
       AND a.provider_account_revision_id = NEW.provider_account_revision_id AND a.merchant_id = NEW.merchant_id
       AND a.amount_minor = NEW.max_amount_minor AND a.currency = NEW.currency) THEN
    RAISE EXCEPTION 'approval request scope does not match an approvable plan action' USING ERRCODE = 'UB083';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_approval_requests_guard BEFORE INSERT ON plan_approval_requests
  FOR EACH ROW EXECUTE FUNCTION ub_plan_approval_request_guard();
