-- M02 policies, evidence and approvals (FR-21, INV-03, INV-10, INV-15). Policy revisions are immutable and
-- effective-dated; evidence blobs, revisions and the hash-chained ledger are append-only; approvals are immutable
-- signed scopes whose revocation, invalidation or consumption is a single append-only approval event.
-- incident_id columns stay prefix-checked text until M04 adds the incidents table and its composite FKs.

CREATE TABLE policies (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'plc')),
  policy_key text NOT NULL CHECK (policy_key IN ('AUTHORITY', 'RETENTION')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_key)
);

CREATE TABLE policy_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pol')),
  policy_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  schema_name text NOT NULL CHECK (schema_name ~ '^policy\.[a-z_]+\.v[1-9][0-9]*$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^policy\.v1:sha256:[0-9a-f]{64}$'),
  effective_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_user_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_id, revision),
  UNIQUE (tenant_id, policy_id, effective_at),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES policies (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  -- No retroactive policy: a revision cannot take effect before it was published (small clock tolerance).
  CHECK (effective_at >= published_at - interval '5 seconds')
);
SELECT ub_make_append_only('policy_revisions');

-- Content-addressed, tenant-prefixed immutable objects. The key is derived from tenant and digest, so a row can
-- never point at another tenant's object namespace.
CREATE TABLE evidence_blobs (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'blb')),
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  trust_level text NOT NULL CHECK (trust_level IN
    ('AUTHORITATIVE', 'OPERATOR_ATTESTED', 'PROVIDER_REPORTED', 'MODEL_PROPOSED', 'CONTRACT_FAKE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sha256),
  CHECK (object_key = 'tenants/' || tenant_id || '/evidence/' || substr(sha256, 8))
);
SELECT ub_make_append_only('evidence_blobs');

CREATE TABLE evidence_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'evr')),
  incident_id text NOT NULL CHECK (ub_id_ok(incident_id, 'inc')),
  asset_revision_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  previous_revision_id text,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, incident_id, revision),
  FOREIGN KEY (tenant_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  CHECK ((revision = 1) = (previous_revision_id IS NULL))
);
SELECT ub_make_append_only('evidence_revisions');

CREATE TABLE evidence_revision_items (
  tenant_id text NOT NULL REFERENCES tenants (id),
  revision_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  blob_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('MANUAL', 'PARTS_LIST', 'WARRANTY', 'WORK_ORDER', 'VENDOR_RECORD',
    'TELEMETRY_WINDOW', 'TRANSCRIPT', 'QUOTE', 'RECEIPT', 'PHOTO', 'OTHER')),
  locator jsonb CHECK (locator IS NULL OR jsonb_typeof(locator) = 'object'),
  source_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, revision_id, ordinal),
  UNIQUE (tenant_id, revision_id, blob_id, role),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES evidence_blobs (tenant_id, id)
);
SELECT ub_make_append_only('evidence_revision_items');

-- The shared append-only evidence-ledger envelope (FR-18, INV-10): one hash chain per tenant; corrections link to
-- the record they supersede; the predecessor digest must exist in the same tenant chain.
CREATE TABLE evidence_ledger_entries (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'evd')),
  sequence integer NOT NULL CHECK (sequence >= 1),
  kind text NOT NULL CHECK (kind IN ('MATERIAL_INPUT', 'MODEL_PROPOSAL', 'POLICY_DECISION', 'APPROVAL',
    'EXTERNAL_ACTION', 'PAYMENT_STATE', 'RECEIPT', 'RECOVERY_DECISION')),
  trust text NOT NULL CHECK (trust IN
    ('AUTHORITATIVE', 'OPERATOR_ATTESTED', 'PROVIDER_REPORTED', 'MODEL_PROPOSED', 'CONTRACT_FAKE')),
  subject_aggregate_type text NOT NULL,
  subject_aggregate_id text NOT NULL CHECK (subject_aggregate_id ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  incident_id text CHECK (incident_id IS NULL OR ub_id_ok(incident_id, 'inc')),
  recorded_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr')),
  causation_id text,
  payload_schema text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload_ref text,
  supersedes_evidence_id text,
  previous_envelope_digest text,
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^evidence-envelope\.v1:sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, envelope_digest),
  FOREIGN KEY (tenant_id, payload_ref) REFERENCES evidence_blobs (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_evidence_id) REFERENCES evidence_ledger_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_envelope_digest) REFERENCES evidence_ledger_entries (tenant_id, envelope_digest),
  CHECK ((sequence = 1) = (previous_envelope_digest IS NULL)),
  CHECK (supersedes_evidence_id IS DISTINCT FROM id)
);
SELECT ub_make_append_only('evidence_ledger_entries');

CREATE TABLE approvals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'apr')),
  approval_kind text NOT NULL CHECK (approval_kind IN ('PLAN_ACTION', 'BUDGET_ADJUSTMENT')),
  target_execution_authority_id text
    CHECK (target_execution_authority_id IS NULL OR ub_id_ok(target_execution_authority_id, 'xau')),
  incident_id text NOT NULL CHECK (ub_id_ok(incident_id, 'inc')),
  site_id text NOT NULL,
  asset_revision_id text NOT NULL,
  evidence_revision_id text,
  policy_revision_id text NOT NULL,
  plan_hash text CHECK (plan_hash IS NULL OR plan_hash ~ '^[a-z][a-z0-9-]{0,62}\.v[1-9][0-9]{0,5}:sha256:[0-9a-f]{64}$'),
  action_digest text
    CHECK (action_digest IS NULL OR action_digest ~ '^[a-z][a-z0-9-]{0,62}\.v[1-9][0-9]{0,5}:sha256:[0-9a-f]{64}$'),
  action_class text NOT NULL
    CHECK (action_class IN ('STANDARD', 'SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL', 'POLICY_OVERRIDE')),
  paid boolean NOT NULL,
  provider_account_revision_id text,
  actor_user_id text NOT NULL,
  actor_role text NOT NULL,
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz NOT NULL,
  signature_digest text NOT NULL CHECK (signature_digest ~ '^approval\.v1:sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_revision_id) REFERENCES evidence_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK ((approval_kind = 'BUDGET_ADJUSTMENT') = (target_execution_authority_id IS NOT NULL)),
  CHECK (approval_kind <> 'PLAN_ACTION'
    OR (evidence_revision_id IS NOT NULL AND plan_hash IS NOT NULL AND action_digest IS NOT NULL)),
  CHECK (NOT paid OR provider_account_revision_id IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX approvals_asset_revision_ix ON approvals (tenant_id, asset_revision_id);
SELECT ub_make_append_only('approvals');

-- At most one lifecycle event per approval: once revoked, invalidated or consumed it can never execute again.
CREATE TABLE approval_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ape')),
  approval_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('REVOKED', 'INVALIDATED', 'CONSUMED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, approval_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES approvals (tenant_id, id)
);
SELECT ub_make_append_only('approval_events');
