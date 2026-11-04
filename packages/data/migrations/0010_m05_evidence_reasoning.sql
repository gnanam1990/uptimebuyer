-- M05 evidence and manual reasoning (FR-05, NFR-04, NFR-10, INV-02, INV-03, INV-10, INV-13).
-- Parsed documents, their page/section/record spans and exact extracted facts are immutable; a document leaves the
-- applicable evidence set only through an append-only WITHDRAWN event. Each committed evidence revision records the
-- documents and conflicts it contains and its content digest. Citations are issued per (revision, span) and can only
-- name a document of that revision. Reasoning runs are recorded once with their final status; a model proposal is
-- never authority (authority = 'NONE') and its only mutable projection is a one-shot supersession stamp.

-- An evidence revision must bind a revision of the incident's own asset (closes the M04 residual: the asset revision
-- of an evidence revision could previously belong to another asset).
CREATE FUNCTION ub_evidence_revision_asset_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM incidents i
      JOIN asset_revisions r ON r.tenant_id = i.tenant_id AND r.asset_id = i.asset_id
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.incident_id AND r.id = NEW.asset_revision_id
  ) THEN
    RAISE EXCEPTION 'evidence revision % binds an asset revision outside its incident''s asset', NEW.id
      USING ERRCODE = 'UB051';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER evidence_revisions_asset_guard BEFORE INSERT ON evidence_revisions
  FOR EACH ROW EXECUTE FUNCTION ub_evidence_revision_asset_guard();

CREATE TABLE evidence_documents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'doc')),
  blob_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('MANUAL', 'PARTS_LIST', 'WARRANTY', 'WORK_ORDER', 'VENDOR_RECORD', 'TRANSCRIPT',
    'OTHER')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  document_revision text NOT NULL CHECK (length(document_revision) BETWEEN 1 AND 100),
  manufacturer text NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  bom_revision text CHECK (bom_revision IS NULL OR length(bom_revision) BETWEEN 1 AND 100),
  serial text CHECK (serial IS NULL OR length(serial) BETWEEN 1 AND 200),
  site_id text,
  asset_id text,
  source_kind text NOT NULL CHECK (source_kind IN ('OEM_PUBLICATION', 'TENANT_RECORD', 'SERVICE_HISTORY',
    'PROVIDER_DOCUMENT', 'COMMUNICATION', 'REGISTRY_SNAPSHOT')),
  -- A provenance label only. It is never dereferenced: nothing in the system fetches documents by URL.
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 300),
  trust_level text NOT NULL CHECK (trust_level IN ('AUTHORITATIVE', 'OPERATOR_ATTESTED', 'PROVIDER_REPORTED')),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'text/plain', 'text/markdown', 'text/csv')),
  extraction_method text NOT NULL CHECK (extraction_method IN ('PDF_TEXT', 'STRUCTURED_IMPORT', 'MANUAL_ENTRY')),
  parser_version text NOT NULL CHECK (parser_version ~ '^[a-z][a-z0-9-]{0,40}\.v[1-9][0-9]*$'),
  page_count integer NOT NULL CHECK (page_count >= 0),
  span_count integer NOT NULL CHECK (span_count >= 1),
  active_content_removed text[] NOT NULL DEFAULT '{}',
  consent_ref text CHECK (consent_ref IS NULL OR length(consent_ref) BETWEEN 1 AND 200),
  purposes text[] NOT NULL DEFAULT '{}' CHECK (purposes <@ ARRAY['EVIDENCE_REASONING']::text[]),
  applicability_digest text NOT NULL CHECK (applicability_digest ~ '^evidence-applicability\.v1:sha256:[0-9a-f]{64}$'),
  supersedes_document_id text,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, blob_id),
  UNIQUE (tenant_id, blob_id, role, applicability_digest),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES evidence_blobs (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES assets (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, supersedes_document_id) REFERENCES evidence_documents (tenant_id, id),
  CHECK ((site_id IS NULL) = (asset_id IS NULL)),
  CHECK ((role = 'TRANSCRIPT') = (source_kind = 'COMMUNICATION')),
  -- Private communication content needs a consent reference and an explicit purpose before any model may see it.
  CHECK (source_kind <> 'COMMUNICATION' OR (consent_ref IS NOT NULL AND cardinality(purposes) >= 1 AND asset_id IS NOT NULL)),
  CHECK (source_kind <> 'REGISTRY_SNAPSHOT' OR (role IN ('WARRANTY', 'VENDOR_RECORD') AND asset_id IS NOT NULL)),
  CHECK (supersedes_document_id IS DISTINCT FROM id)
);
CREATE INDEX evidence_documents_applicability_ix ON evidence_documents (tenant_id, manufacturer, model);
SELECT ub_make_append_only('evidence_documents');

CREATE TABLE evidence_document_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'dve')),
  document_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('WITHDRAWN')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES evidence_documents (tenant_id, id)
);
SELECT ub_make_append_only('evidence_document_events');

CREATE TABLE evidence_document_spans (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'spn')),
  document_id text NOT NULL,
  blob_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object' AND locator->>'kind' IN ('PAGE', 'SECTION', 'RECORD')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  text_digest text NOT NULL CHECK (text_digest ~ '^sha256:[0-9a-f]{64}$'),
  injection_flags text[] NOT NULL DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, document_id),
  UNIQUE (tenant_id, document_id, ordinal),
  FOREIGN KEY (tenant_id, document_id, blob_id) REFERENCES evidence_documents (tenant_id, id, blob_id)
);
CREATE INDEX evidence_document_spans_search_ix ON evidence_document_spans USING gin (search_vector);
SELECT ub_make_append_only('evidence_document_spans');

CREATE TABLE evidence_document_facts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'efc')),
  document_id text NOT NULL,
  span_id text NOT NULL,
  fact_key text NOT NULL CHECK (fact_key ~ '^(part|spec):[a-z0-9][a-z0-9-]{0,79}$'),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, span_id, fact_key, value),
  FOREIGN KEY (tenant_id, span_id, document_id) REFERENCES evidence_document_spans (tenant_id, id, document_id)
);
CREATE INDEX evidence_document_facts_document_ix ON evidence_document_facts (tenant_id, document_id);
SELECT ub_make_append_only('evidence_document_facts');

-- 1:1 extension of an evidence revision: why it was committed and the digest of its exact content (asset revision plus
-- applicable document set), used to make an unchanged commit a no-op.
CREATE TABLE evidence_revision_contents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'evr')),
  incident_id text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^evidence-content\.v1:sha256:[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  document_count integer NOT NULL CHECK (document_count >= 0),
  conflict_count integer NOT NULL CHECK (conflict_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents (tenant_id, id)
);
SELECT ub_make_append_only('evidence_revision_contents');

CREATE TABLE evidence_revision_documents (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'erd')),
  evidence_revision_id text NOT NULL,
  document_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_revision_id, document_id),
  UNIQUE (tenant_id, evidence_revision_id, ordinal),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES evidence_documents (tenant_id, id)
);
SELECT ub_make_append_only('evidence_revision_documents');

-- Deterministic conflicts: one exact fact key with more than one normalized value inside a revision. Every value
-- keeps every source span; nothing here is a compatibility verdict.
CREATE TABLE evidence_revision_conflicts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ecf')),
  evidence_revision_id text NOT NULL,
  fact_key text NOT NULL CHECK (fact_key ~ '^(part|spec):[a-z0-9][a-z0-9-]{0,79}$'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) >= 2),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_revision_id, fact_key),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id)
);
SELECT ub_make_append_only('evidence_revision_conflicts');

-- A citation names one span of one document that is part of the cited evidence revision (composite FKs).
CREATE TABLE citations (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'cit')),
  evidence_revision_id text NOT NULL,
  document_id text NOT NULL,
  span_id text NOT NULL,
  blob_id text NOT NULL,
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'),
  quoted_digest text NOT NULL CHECK (quoted_digest ~ '^sha256:[0-9a-f]{64}$'),
  extraction_method text NOT NULL CHECK (extraction_method IN ('PDF_TEXT', 'STRUCTURED_IMPORT', 'MANUAL_ENTRY')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_revision_id, span_id),
  FOREIGN KEY (tenant_id, evidence_revision_id, document_id)
    REFERENCES evidence_revision_documents (tenant_id, evidence_revision_id, document_id),
  FOREIGN KEY (tenant_id, span_id, document_id) REFERENCES evidence_document_spans (tenant_id, id, document_id),
  FOREIGN KEY (tenant_id, document_id, blob_id) REFERENCES evidence_documents (tenant_id, id, blob_id)
);
SELECT ub_make_append_only('citations');

-- One immutable row per reasoning attempt, written once with its final status (the model call never runs inside a
-- database transaction). Inputs and outputs are referenced by digest and tenant object key; no secret fields exist.
CREATE TABLE reasoning_runs (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rsn')),
  incident_id text NOT NULL,
  site_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  asset_revision_id text NOT NULL,
  policy_revision_id text,
  adapter text NOT NULL CHECK (adapter IN ('SERV_REASONING', 'CONTRACT_FAKE')),
  capability text NOT NULL CHECK (capability IN ('ELIGIBLE', 'UNSUPPORTED')),
  capability_reason text CHECK (capability_reason IS NULL OR capability_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  status text NOT NULL CHECK (status IN ('NOT_RUN', 'COMPLETED', 'REJECTED', 'FAILED')),
  disposition text NOT NULL CHECK (disposition IN ('NOT_RUN', 'PROPOSAL_ONLY', 'NEEDS_HUMAN_REVIEW',
    'SUPERSEDED_BEFORE_RECORDING', 'REJECTED', 'FAILED')),
  model_id text CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 200),
  model_version text CHECK (model_version IS NULL OR length(model_version) BETWEEN 1 AND 200),
  response_ids text[] NOT NULL DEFAULT '{}',
  config_digest text NOT NULL CHECK (config_digest ~ '^reasoning-config\.v1:sha256:[0-9a-f]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  prompt_template_digest text NOT NULL CHECK (prompt_template_digest ~ '^reasoning-prompt\.v1:sha256:[0-9a-f]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^reasoning-input\.v1:sha256:[0-9a-f]{64}$'),
  input_object_key text NOT NULL,
  output_digest text CHECK (output_digest IS NULL OR output_digest ~ '^sha256:[0-9a-f]{64}$'),
  output_object_key text,
  confidence_ppm integer CHECK (confidence_ppm IS NULL OR confidence_ppm BETWEEN 0 AND 1000000),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  turns integer NOT NULL CHECK (turns >= 0),
  tool_calls integer NOT NULL CHECK (tool_calls >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  rejection_reasons text[] NOT NULL DEFAULT '{}',
  injection_flags text[] NOT NULL DEFAULT '{}',
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('SERVICE', 'WORKER')),
  created_by_id text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, incident_id, site_id) REFERENCES incidents (tenant_id, id, site_id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  CHECK ((status = 'NOT_RUN') = (capability = 'UNSUPPORTED')),
  CHECK ((status = 'NOT_RUN') = (disposition = 'NOT_RUN')),
  CHECK (status <> 'NOT_RUN' OR (output_digest IS NULL AND model_id IS NULL AND turns = 0)),
  CHECK ((output_digest IS NULL) = (output_object_key IS NULL)),
  CHECK (input_object_key ~ ('^tenants/' || tenant_id || '/reasoning/[0-9a-f]{64}$')),
  CHECK (output_object_key IS NULL OR output_object_key ~ ('^tenants/' || tenant_id || '/reasoning/[0-9a-f]{64}$'))
);
CREATE INDEX reasoning_runs_incident_ix ON reasoning_runs (tenant_id, incident_id, completed_at);
SELECT ub_make_append_only('reasoning_runs');

CREATE TABLE reasoning_proposals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rpr')),
  reasoning_run_id text NOT NULL,
  incident_id text NOT NULL,
  evidence_revision_id text NOT NULL,
  asset_revision_id text NOT NULL,
  policy_revision_id text,
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^reasoning-proposal\.v1:sha256:[0-9a-f]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  -- INV-02: a model proposal is never an approval, compatibility verdict, spend authority or closure.
  authority text NOT NULL DEFAULT 'NONE' CHECK (authority = 'NONE'),
  result_origin text NOT NULL CHECK (result_origin IN ('SERV_REASONING', 'CONTRACT_FAKE')),
  disposition text NOT NULL CHECK (disposition IN ('PROPOSAL_ONLY', 'NEEDS_HUMAN_REVIEW', 'SUPERSEDED_BEFORE_RECORDING')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  annotations jsonb NOT NULL CHECK (jsonb_typeof(annotations) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at timestamptz,
  superseded_by_evidence_revision_id text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reasoning_run_id),
  FOREIGN KEY (tenant_id, reasoning_run_id, incident_id) REFERENCES reasoning_runs (tenant_id, id, incident_id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  CHECK ((superseded_at IS NULL) = (superseded_by_evidence_revision_id IS NULL)),
  CHECK (superseded_by_evidence_revision_id IS DISTINCT FROM evidence_revision_id),
  CHECK (disposition <> 'SUPERSEDED_BEFORE_RECORDING' OR superseded_at IS NOT NULL)
);
CREATE INDEX reasoning_proposals_current_ix ON reasoning_proposals (tenant_id, incident_id) WHERE superseded_at IS NULL;
SELECT ub_make_append_only('reasoning_proposals', 'superseded_at', 'superseded_by_evidence_revision_id');
