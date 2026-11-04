-- M02 transactional outbox, consumer receipts, jobs and audit (NFR-02, NFR-03, NFR-09).
-- Outbox content is immutable; only publication bookkeeping (lease, attempts, published_at once) may change.

CREATE TABLE outbox_events (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL UNIQUE CHECK (ub_id_ok(id, 'evt')),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z_]{0,63}$'),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr')),
  causation_id text NOT NULL CHECK (ub_id_ok(causation_id, 'cmd') OR ub_id_ok(causation_id, 'evt')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error_code text,
  PRIMARY KEY (tenant_id, id),
  -- Logical idempotency: one event of a type per aggregate version.
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX outbox_events_unpublished_ix ON outbox_events (seq) WHERE published_at IS NULL;

CREATE FUNCTION ub_outbox_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bookkeeping text[] := ARRAY['published_at', 'lease_owner', 'lease_expires_at', 'publish_attempts', 'last_error_code'];
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'UB001';
  END IF;
  IF (to_jsonb(OLD) - bookkeeping) <> (to_jsonb(NEW) - bookkeeping) THEN
    RAISE EXCEPTION 'table % is append-only: event content is immutable', TG_TABLE_NAME USING ERRCODE = 'UB001';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'table % is append-only: published_at is a one-shot stamp', TG_TABLE_NAME USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_events_guard BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION ub_outbox_guard();
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation();

-- Idempotent-consumer receipts: inserted in the consumer's own transaction, so an event's effect and its receipt
-- commit or roll back together and redelivery is applied at most once per consumer.
CREATE TABLE outbox_consumer_receipts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  consumer text NOT NULL CHECK (consumer ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  event_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES outbox_events (tenant_id, id)
);
SELECT ub_make_append_only('outbox_consumer_receipts');

CREATE TABLE jobs (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'job')),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'DEAD')),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  CHECK ((state = 'RUNNING') = (lease_owner IS NOT NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX jobs_runnable_ix ON jobs (run_after) WHERE state IN ('PENDING', 'RUNNING');

CREATE TABLE audit_entries (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'aud')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('HUMAN', 'DEVICE', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM', 'WEBHOOK')),
  actor_id text CHECK (actor_id IS NULL OR length(actor_id) <= 128),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type text CHECK (resource_type IS NULL OR resource_type ~ '^[a-z][a-z_]{0,63}$'),
  resource_id text CHECK (resource_id IS NULL OR length(resource_id) <= 128),
  result text NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_entries_time_ix ON audit_entries (tenant_id, occurred_at);
CREATE INDEX audit_entries_correlation_ix ON audit_entries (tenant_id, correlation_id);
SELECT ub_make_append_only('audit_entries');

-- Platform security log for events that must not be attributed to (or reveal) a tenant: rejected tenant
-- resolution, unknown webhook bindings and failed authentication. Requested values are stored only as digests.
CREATE TABLE security_audit_entries (
  id text PRIMARY KEY CHECK (ub_id_ok(id, 'sau')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  principal_kind text NOT NULL CHECK (principal_kind IN ('HUMAN', 'DEVICE', 'SERVICE', 'INTEGRATION', 'ANONYMOUS')),
  principal_id text CHECK (principal_id IS NULL OR length(principal_id) <= 128),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  requested_digest text CHECK (requested_digest IS NULL OR requested_digest ~ '^sha256:[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr'))
);
CREATE INDEX security_audit_entries_time_ix ON security_audit_entries (occurred_at);
SELECT ub_make_append_only('security_audit_entries');
