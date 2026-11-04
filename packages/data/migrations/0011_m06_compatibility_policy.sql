-- M06 compatibility and deterministic safety policy (FR-06, FR-10, FR-21, INV-02, INV-03, INV-04, INV-15).
--
-- candidate_actions: immutable revision-bound proposed actions with a server-computed action digest.
-- compatibility_decisions: one immutable ALLOW/HOLD/REJECT row per exact evaluated tuple (candidate, asset/evidence/
--   policy revisions, action digest, authority-evidence digest). Only the lifecycle projection may move
--   CURRENT -> SUPERSEDED, once, with a reason; every other column is frozen.
-- compatibility_authority_records: immutable HMAC-signed named-engineer / policy-approver authority, scoped to the held
--   decision's exact tuple, with append-only INVALIDATED/REVOKED events.
-- compatibility_decision_authorities: which authority an ALLOW applied; the database refuses links whose scope does
--   not match the decision, and refuses an exception ALLOW without covering links (deferred check).
-- compatibility_policy_activations: one row per AUTHORITY policy revision once its effectiveness was applied.

CREATE TABLE candidate_actions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cand')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('PART_PURCHASE', 'SERVICE_JOB', 'DIAGNOSTIC_SERVICE', 'PAID_CONTACT', 'CONTAINMENT_PURCHASE')),
  component text NOT NULL CHECK (component ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  component_label text NOT NULL CHECK (length(component_label) BETWEEN 1 AND 200),
  manufacturer text CHECK (manufacturer IS NULL OR length(manufacturer) BETWEEN 1 AND 200),
  part_number text CHECK (part_number IS NULL OR length(part_number) BETWEEN 1 AND 80),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  vendor_id text CHECK (vendor_id IS NULL OR length(vendor_id) BETWEEN 1 AND 80),
  provider_account_revision_id text NOT NULL,
  merchant_id text NOT NULL CHECK (ub_id_ok(merchant_id, 'mer')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purpose text NOT NULL CHECK (purpose ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  offer_observed_at timestamptz,
  -- Server-resolved candidate claims (cited spans, with server-derived source attributes).
  claims jsonb NOT NULL CHECK (jsonb_typeof(claims) = 'object'),
  -- Display-only context (model confidence, rank, seller text). Never read by the evaluator.
  explanation jsonb NOT NULL CHECK (jsonb_typeof(explanation) = 'object'),
  proposal_id text,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  candidate_key text NOT NULL CHECK (candidate_key ~ '^candidate-key\.v1:sha256:[0-9a-f]{64}$'),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^candidate-registration\.v1:sha256:[0-9a-f]{64}$'),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  created_by_id text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, candidate_digest),
  UNIQUE (tenant_id, id, incident_id, asset_revision_id, evidence_revision_id, policy_revision_id, action_digest, candidate_key),
  FOREIGN KEY (tenant_id, incident_id, site_id, asset_id) REFERENCES incidents (tenant_id, id, site_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_revision_id) REFERENCES provider_account_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES reasoning_proposals (tenant_id, id)
);
CREATE INDEX candidate_actions_incident_ix ON candidate_actions (tenant_id, incident_id, candidate_key);
SELECT ub_make_append_only('candidate_actions');

-- A candidate binds an evidence revision of its own incident and asset revision, and an AUTHORITY policy revision.
CREATE FUNCTION ub_candidate_action_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM evidence_revisions e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.evidence_revision_id
                    AND e.incident_id = NEW.incident_id AND e.asset_revision_id = NEW.asset_revision_id) THEN
    RAISE EXCEPTION 'candidate action evidence revision is not bound to its incident and asset revision'
      USING ERRCODE = 'UB062';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
                  WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.policy_revision_id AND p.policy_key = 'AUTHORITY') THEN
    RAISE EXCEPTION 'candidate action must bind an AUTHORITY policy revision' USING ERRCODE = 'UB062';
  END IF;
  IF NEW.proposal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reasoning_proposals rp WHERE rp.tenant_id = NEW.tenant_id
                    AND rp.id = NEW.proposal_id AND rp.incident_id = NEW.incident_id) THEN
    RAISE EXCEPTION 'candidate action proposal belongs to another incident' USING ERRCODE = 'UB062';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER candidate_actions_guard BEFORE INSERT ON candidate_actions
  FOR EACH ROW EXECUTE FUNCTION ub_candidate_action_guard();

CREATE TABLE compatibility_decisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cmp')),
  candidate_action_id text NOT NULL,
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  candidate_key text NOT NULL,
  authority_set_digest text NOT NULL CHECK (authority_set_digest ~ '^compatibility-authority-set\.v1:sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('ALLOW', 'HOLD', 'REJECT')),
  lifecycle text NOT NULL DEFAULT 'CURRENT' CHECK (lifecycle IN ('CURRENT', 'SUPERSEDED')),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) BETWEEN 1 AND 64),
  blocking_reasons text[] NOT NULL CHECK (cardinality(blocking_reasons) <= 64),
  satisfied_checks text[] NOT NULL,
  missing_fields text[] NOT NULL,
  conflicting_fields text[] NOT NULL,
  required_authorities jsonb NOT NULL CHECK (jsonb_typeof(required_authorities) = 'array'),
  recovery_paths text[] NOT NULL,
  applied_authority_ids text[] NOT NULL,
  exception_classes_applied text[] NOT NULL
    CHECK (exception_classes_applied <@ ARRAY['SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL']::text[]),
  overrides_applied text[] NOT NULL CHECK (overrides_applied <@ ARRAY['VENDOR_NOT_APPROVED', 'VENDOR_STATUS_UNKNOWN',
    'WARRANTY_REQUIRES_OEM_PART', 'WARRANTY_STATUS_UNKNOWN']::text[]),
  authority_findings jsonb NOT NULL CHECK (jsonb_typeof(authority_findings) = 'array'),
  approval_route jsonb NOT NULL CHECK (jsonb_typeof(approval_route) = 'object'),
  safety_class text NOT NULL CHECK (safety_class IN ('STANDARD', 'SAFETY_CRITICAL', 'PROHIBITED')),
  exact_match boolean NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_digest text NOT NULL CHECK (input_digest ~ '^compatibility-input\.v1:sha256:[0-9a-f]{64}$'),
  -- INV-02: explanation is display-only and labelled as such.
  explanation jsonb CHECK (explanation IS NULL OR explanation ->> 'authority' = 'NONE'),
  rule_version text NOT NULL CHECK (rule_version ~ '^compatibility-engine\.v[1-9][0-9]*$'),
  policy_rule_set text CHECK (policy_rule_set IS NULL OR policy_rule_set ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  decided_at timestamptz NOT NULL,
  superseded_at timestamptz,
  superseded_reason text CHECK (superseded_reason IS NULL OR superseded_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  superseded_by_decision_id text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, candidate_action_id, asset_revision_id, evidence_revision_id, policy_revision_id, action_digest,
    authority_set_digest),
  UNIQUE (tenant_id, id, candidate_action_id),
  FOREIGN KEY (tenant_id, candidate_action_id, incident_id, asset_revision_id, evidence_revision_id, policy_revision_id,
    action_digest, candidate_key)
    REFERENCES candidate_actions (tenant_id, id, incident_id, asset_revision_id, evidence_revision_id, policy_revision_id,
      action_digest, candidate_key),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  -- Deferred: the superseding row is inserted after the prior row's one-shot stamp (one CURRENT per lineage).
  FOREIGN KEY (tenant_id, superseded_by_decision_id) REFERENCES compatibility_decisions (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((decision = 'ALLOW') = (cardinality(blocking_reasons) = 0)),
  CHECK ((lifecycle = 'CURRENT') = (superseded_at IS NULL)),
  CHECK ((superseded_at IS NULL) = (superseded_reason IS NULL)),
  CHECK (superseded_by_decision_id IS NULL OR superseded_at IS NOT NULL),
  CHECK (decision <> 'ALLOW' OR safety_class <> 'PROHIBITED'),
  CHECK (decision <> 'ALLOW' OR exact_match OR cardinality(exception_classes_applied) > 0),
  CHECK (decision <> 'ALLOW' OR safety_class <> 'SAFETY_CRITICAL'
    OR 'SAFETY_CRITICAL' = ANY (exception_classes_applied))
);
-- At most one CURRENT decision per candidate lineage; UNEVALUATED is the absence of a CURRENT row.
CREATE UNIQUE INDEX compatibility_decisions_one_current_ux ON compatibility_decisions (tenant_id, incident_id, candidate_key)
  WHERE lifecycle = 'CURRENT';
CREATE INDEX compatibility_decisions_evidence_ix ON compatibility_decisions (tenant_id, evidence_revision_id)
  WHERE lifecycle = 'CURRENT';
CREATE INDEX compatibility_decisions_policy_ix ON compatibility_decisions (tenant_id, policy_revision_id)
  WHERE lifecycle = 'CURRENT';

-- The decision row is never edited: the only permitted UPDATE is the one-shot CURRENT -> SUPERSEDED projection.
CREATE FUNCTION ub_compatibility_decision_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  frozen text[] := ARRAY['lifecycle', 'superseded_at', 'superseded_reason', 'superseded_by_decision_id'];
BEGIN
  IF OLD.lifecycle = 'CURRENT' AND NEW.lifecycle = 'SUPERSEDED' AND NEW.superseded_at IS NOT NULL
     AND NEW.superseded_reason IS NOT NULL
     AND (to_jsonb(OLD) - frozen) = (to_jsonb(NEW) - frozen) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compatibility decisions are immutable; only CURRENT -> SUPERSEDED may be stamped'
    USING ERRCODE = 'UB001';
END
$$;
CREATE TRIGGER compatibility_decisions_update_guard BEFORE UPDATE ON compatibility_decisions
  FOR EACH ROW EXECUTE FUNCTION ub_compatibility_decision_guard();
CREATE TRIGGER compatibility_decisions_no_delete BEFORE DELETE ON compatibility_decisions
  FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation();
CREATE TRIGGER compatibility_decisions_no_truncate BEFORE TRUNCATE ON compatibility_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

CREATE TABLE compatibility_authority_records (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cau')),
  kind text NOT NULL CHECK (kind IN ('ENGINEER_EXCEPTION', 'POLICY_APPROVAL')),
  held_decision_id text NOT NULL,
  candidate_action_id text NOT NULL,
  incident_id text NOT NULL,
  site_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  policy_revision_id text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^action\.v1:sha256:[0-9a-f]{64}$'),
  candidate_key text NOT NULL,
  exception_classes text[] NOT NULL
    CHECK (exception_classes <@ ARRAY['SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL']::text[]),
  overridden_reasons text[] NOT NULL CHECK (overridden_reasons <@ ARRAY['VENDOR_NOT_APPROVED', 'VENDOR_STATUS_UNKNOWN',
    'WARRANTY_REQUIRES_OEM_PART', 'WARRANTY_STATUS_UNKNOWN']::text[]),
  actor_user_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role ~ '^[a-z][a-z_]{1,39}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  reason_text text NOT NULL CHECK (length(reason_text) BETWEEN 1 AND 2000 AND length(btrim(reason_text)) > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- HMAC-SHA256 under the authority service's per-tenant derived key; verified at every evaluation and execution check.
  signature_algorithm text NOT NULL CHECK (signature_algorithm = 'HMAC-SHA256'),
  signature_key_id text NOT NULL CHECK (signature_key_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  signature_value text NOT NULL CHECK (signature_value ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, held_decision_id, kind),
  FOREIGN KEY (tenant_id, held_decision_id, candidate_action_id)
    REFERENCES compatibility_decisions (tenant_id, id, candidate_action_id),
  FOREIGN KEY (tenant_id, candidate_action_id, incident_id, asset_revision_id, evidence_revision_id, policy_revision_id,
    action_digest, candidate_key)
    REFERENCES candidate_actions (tenant_id, id, incident_id, asset_revision_id, evidence_revision_id, policy_revision_id,
      action_digest, candidate_key),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK (expires_at > issued_at),
  CHECK (kind <> 'ENGINEER_EXCEPTION'
    OR (actor_role = 'engineer' AND cardinality(exception_classes) > 0 AND cardinality(overridden_reasons) = 0)),
  CHECK (kind <> 'POLICY_APPROVAL'
    OR (actor_role IN ('maintenance_approver', 'finance_approver', 'admin') AND cardinality(overridden_reasons) > 0
      AND cardinality(exception_classes) = 0))
);
CREATE INDEX compatibility_authority_records_candidate_ix ON compatibility_authority_records (tenant_id, candidate_action_id);
CREATE INDEX compatibility_authority_records_evidence_ix ON compatibility_authority_records (tenant_id, evidence_revision_id);
SELECT ub_make_append_only('compatibility_authority_records');

-- At most one lifecycle event per authority record: once invalidated or revoked it never applies again.
CREATE TABLE compatibility_authority_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cae')),
  authority_record_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('INVALIDATED', 'REVOKED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, authority_record_id),
  FOREIGN KEY (tenant_id, authority_record_id) REFERENCES compatibility_authority_records (tenant_id, id)
);
SELECT ub_make_append_only('compatibility_authority_events');

CREATE TABLE compatibility_decision_authorities (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL DEFAULT 'cda_' || gen_random_uuid() CHECK (ub_id_ok(id, 'cda')),
  decision_id text NOT NULL,
  authority_record_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, decision_id, authority_record_id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES compatibility_decisions (tenant_id, id),
  FOREIGN KEY (tenant_id, authority_record_id) REFERENCES compatibility_authority_records (tenant_id, id)
);
SELECT ub_make_append_only('compatibility_decision_authorities');

-- A link must name an active, unexpired authority for exactly the decision's tuple, applied to that decision.
CREATE FUNCTION ub_compatibility_decision_authority_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  d compatibility_decisions%ROWTYPE;
  a compatibility_authority_records%ROWTYPE;
BEGIN
  SELECT * INTO d FROM compatibility_decisions WHERE tenant_id = NEW.tenant_id AND id = NEW.decision_id;
  SELECT * INTO a FROM compatibility_authority_records WHERE tenant_id = NEW.tenant_id AND id = NEW.authority_record_id;
  IF d.id IS NULL OR a.id IS NULL
     OR a.candidate_action_id <> d.candidate_action_id OR a.asset_revision_id <> d.asset_revision_id
     OR a.evidence_revision_id <> d.evidence_revision_id OR a.policy_revision_id <> d.policy_revision_id
     OR a.action_digest <> d.action_digest OR a.site_id <> d.site_id OR a.incident_id <> d.incident_id
     OR d.lifecycle <> 'CURRENT' OR d.decision = 'REJECT'
     OR NOT (NEW.authority_record_id = ANY (d.applied_authority_ids))
     OR a.issued_at > d.decided_at OR a.expires_at <= d.decided_at
     OR EXISTS (SELECT 1 FROM compatibility_authority_events e
                 WHERE e.tenant_id = NEW.tenant_id AND e.authority_record_id = NEW.authority_record_id) THEN
    RAISE EXCEPTION 'authority record does not cover this compatibility decision' USING ERRCODE = 'UB061';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER compatibility_decision_authorities_guard BEFORE INSERT ON compatibility_decision_authorities
  FOR EACH ROW EXECUTE FUNCTION ub_compatibility_decision_authority_guard();

-- At commit, a decision that applied an exception or override must carry exactly its covering authority links.
CREATE FUNCTION ub_compatibility_decision_cover_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  linked text[];
  classes text[];
  overrides text[];
BEGIN
  SELECT coalesce(array_agg(l.authority_record_id ORDER BY l.authority_record_id), '{}'),
         coalesce(array_agg(DISTINCT c) FILTER (WHERE c IS NOT NULL), '{}'),
         coalesce(array_agg(DISTINCT o) FILTER (WHERE o IS NOT NULL), '{}')
    INTO linked, classes, overrides
    FROM compatibility_decision_authorities l
    JOIN compatibility_authority_records a ON a.tenant_id = l.tenant_id AND a.id = l.authority_record_id
    LEFT JOIN LATERAL unnest(a.exception_classes) AS c ON true
    LEFT JOIN LATERAL unnest(a.overridden_reasons) AS o ON true
   WHERE l.tenant_id = NEW.tenant_id AND l.decision_id = NEW.id;
  IF NOT (NEW.exception_classes_applied <@ classes) OR NOT (NEW.overrides_applied <@ overrides)
     OR NOT (linked @> NEW.applied_authority_ids AND linked <@ NEW.applied_authority_ids) THEN
    RAISE EXCEPTION 'compatibility decision applies authority it is not linked to' USING ERRCODE = 'UB061';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER compatibility_decisions_cover_check AFTER INSERT ON compatibility_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ub_compatibility_decision_cover_check();

CREATE TABLE compatibility_policy_activations (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cpa')),
  policy_revision_id text NOT NULL,
  previous_policy_revision_id text,
  superseded_decision_count integer NOT NULL CHECK (superseded_decision_count >= 0),
  invalidated_authority_count integer NOT NULL CHECK (invalidated_authority_count >= 0),
  invalidated_approval_count integer NOT NULL CHECK (invalidated_approval_count >= 0),
  activated_by_kind text NOT NULL CHECK (activated_by_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  activated_by_id text NOT NULL CHECK (length(activated_by_id) BETWEEN 1 AND 128),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_revision_id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_policy_revision_id) REFERENCES policy_revisions (tenant_id, id)
);
SELECT ub_make_append_only('compatibility_policy_activations');
