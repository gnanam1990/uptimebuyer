-- M02 privacy lifecycle state (FR-23, NFR-06, INV-10): legal holds, privacy requests (export, redaction,
-- deletion) and non-sensitive redaction tombstones. Retention periods are a versioned RETENTION policy revision.
-- Erasure workers belong to later modules; these tables make holds and requests durable and auditable.

CREATE TABLE legal_holds (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'lgh')),
  scope_type text NOT NULL CHECK (scope_type IN ('TENANT', 'SITE', 'ASSET', 'INCIDENT')),
  scope_id text NOT NULL CHECK (scope_id ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  placed_by_user_id text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  released_by_user_id text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, placed_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, released_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK ((released_at IS NULL) = (released_by_user_id IS NULL)),
  CHECK (scope_type <> 'TENANT' OR scope_id = tenant_id)
);
CREATE INDEX legal_holds_active_ix ON legal_holds (tenant_id, scope_type, scope_id) WHERE released_at IS NULL;
SELECT ub_make_append_only('legal_holds', 'released_at', 'released_by_user_id');

CREATE TABLE privacy_requests (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'prq')),
  request_type text NOT NULL CHECK (request_type IN ('EXPORT', 'REDACTION', 'DELETION')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('CONTACT', 'USER', 'COMMUNICATION')),
  subject_ref_digest text NOT NULL CHECK (subject_ref_digest ~ '^sha256:[0-9a-f]{64}$'),
  scope_type text NOT NULL CHECK (scope_type IN ('TENANT', 'SITE', 'ASSET', 'INCIDENT')),
  scope_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('RECEIVED', 'BLOCKED_LEGAL_HOLD', 'IN_PROGRESS', 'COMPLETED', 'REJECTED')),
  requested_by_user_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);

-- What remains after a lawful erasure/redaction: which record, why, under which request. No payload content.
CREATE TABLE redaction_tombstones (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rdt')),
  privacy_request_id text NOT NULL,
  target_table text NOT NULL CHECK (target_table ~ '^[a-z][a-z_]{0,63}$'),
  target_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  redacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, privacy_request_id) REFERENCES privacy_requests (tenant_id, id)
);
SELECT ub_make_append_only('redaction_tombstones');
