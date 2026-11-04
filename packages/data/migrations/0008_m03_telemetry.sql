-- M03 telemetry (FR-02, FR-22, INV-01, INV-11, INV-16): immutable samples pinned to the device-to-asset assignment,
-- asset revision and channel/calibration revision effective at SOURCE event time; immutable LIVE/LATE/BACKFILL
-- classification under a versioned, digest-pinned lateness policy; batch, rejection, sequence-gap and dropped-counter
-- records; and a per-channel freshness projection (FRESH | STALE | OFFLINE | INVALID) kept separate from ingestion
-- class and quality, which the database refuses to mark FRESH without a LIVE, flag-free basis sample.
-- Conventions: tenant_id + (tenant_id, id) keys + tenant-leading composite FKs; append-only via ub_make_append_only.
-- Binding violations raise SQLSTATE UB031.

-- Device input class (FR-22, HARDWARE-IOT §9): a simulator is a separate, visibly labelled device class. Every sample
-- from a SIMULATOR device is stored as SIMULATED_INPUT. The class is fixed at registration.
ALTER TABLE devices ADD COLUMN input_class text NOT NULL DEFAULT 'PHYSICAL_SENSOR'
  CHECK (input_class IN ('PHYSICAL_SENSOR', 'SIMULATOR'));

CREATE FUNCTION ub_device_input_class_fixed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.input_class IS DISTINCT FROM OLD.input_class THEN
    RAISE EXCEPTION 'devices.input_class is fixed at registration' USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER devices_input_class_fixed BEFORE UPDATE OF input_class ON devices
  FOR EACH ROW EXECUTE FUNCTION ub_device_input_class_fixed();

-- Composite keys so a sample can reference "this device's channel" and "this device's assignment" directly.
ALTER TABLE sensor_channels ADD CONSTRAINT sensor_channels_tenant_device_id_key UNIQUE (tenant_id, device_id, id);
ALTER TABLE device_asset_assignments
  ADD CONSTRAINT device_asset_assignments_tenant_device_id_key UNIQUE (tenant_id, device_id, id);

-- One authenticated, signature-verified request. Counts are final when the row is written (end of the ingest
-- transaction); the body digest is retained for audit, the body itself is not.
CREATE TABLE telemetry_batches (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'tbt')),
  device_id text NOT NULL,
  delivery text NOT NULL CHECK (delivery IN ('LIVE', 'BACKFILL')),
  received_at timestamptz NOT NULL,
  signed_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 1000),
  sample_count integer NOT NULL CHECK (sample_count >= message_count),
  accepted_count integer NOT NULL CHECK (accepted_count >= 0),
  duplicate_count integer NOT NULL CHECK (duplicate_count >= 0),
  rejected_count integer NOT NULL CHECK (rejected_count >= 0),
  disclosure_count integer NOT NULL CHECK (disclosure_count >= 0),
  min_event_at timestamptz NOT NULL,
  max_event_at timestamptz NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[0-9a-f]{64}$'),
  firmware text CHECK (firmware IS NULL OR firmware ~ '^[A-Za-z0-9._:+-]{1,128}$'),
  battery_mv integer CHECK (battery_mv IS NULL OR battery_mv BETWEEN 0 AND 100000),
  correlation_id text NOT NULL CHECK (ub_id_ok(correlation_id, 'corr')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  CHECK (accepted_count + duplicate_count + rejected_count = sample_count),
  CHECK (min_event_at <= max_event_at)
);
CREATE INDEX telemetry_batches_device_ix ON telemetry_batches (tenant_id, device_id, received_at);
SELECT ub_make_append_only('telemetry_batches');

-- Immutable samples. Every row stores the exact assignment, asset revision, channel revision and calibration
-- revision effective at its source event time, the source value/unit and canonical value, source and receipt time,
-- boot id and sequence, quality flags, the immutable ingestion class and the lateness policy that produced it.
CREATE TABLE telemetry_samples (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'tsm')),
  batch_id text NOT NULL,
  device_id text NOT NULL,
  channel_id text NOT NULL,
  channel_revision_id text NOT NULL,
  calibration_revision integer NOT NULL CHECK (calibration_revision >= 1),
  device_assignment_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  boot_id text NOT NULL CHECK (boot_id ~ '^boot_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  kind text NOT NULL,
  unit text NOT NULL,
  value_int bigint NOT NULL,
  raw_value_int bigint NOT NULL,
  source_unit text NOT NULL CHECK (source_unit IN ('mC', 'mF', 'mK', 'mA', 'mW', 'bool', 'none')),
  source_value_int bigint NOT NULL,
  conversion text NOT NULL CHECK (conversion IN ('EXACT', 'ROUNDED_HALF_EVEN')),
  quality_flags text[] NOT NULL DEFAULT '{}'
    CHECK (quality_flags <@ ARRAY['UNCALIBRATED', 'OUT_OF_RANGE', 'SENSOR_FAULT']::text[]),
  ingestion_class text NOT NULL CHECK (ingestion_class IN ('LIVE', 'LATE', 'BACKFILL')),
  lateness_ms bigint NOT NULL,
  lateness_policy_version text NOT NULL CHECK (lateness_policy_version ~ '^telemetry-lateness\.v[1-9][0-9]*$'),
  lateness_policy_digest text NOT NULL
    CHECK (lateness_policy_digest ~ '^telemetry-lateness-policy\.v1:sha256:[0-9a-f]{64}$'),
  delivery text NOT NULL CHECK (delivery IN ('LIVE', 'BACKFILL')),
  input_origin text NOT NULL CHECK (input_origin IN ('PHYSICAL_SENSOR', 'SIMULATED_INPUT')),
  sample_digest text NOT NULL CHECK (sample_digest ~ '^telemetry-sample\.v1:sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id),
  -- Idempotent delivery: one sample per channel, boot and sequence.
  UNIQUE (tenant_id, channel_id, boot_id, sequence),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES telemetry_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, device_id, channel_id) REFERENCES sensor_channels (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, channel_id, channel_revision_id) REFERENCES sensor_channel_revisions (tenant_id, channel_id, id),
  FOREIGN KEY (tenant_id, device_id, device_assignment_id)
    REFERENCES device_asset_assignments (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  CHECK ((kind, unit) IN (
    ('TEMPERATURE', 'MILLI_CELSIUS'), ('CURRENT', 'MILLI_AMPERE'), ('POWER', 'MILLI_WATT'),
    ('DOOR', 'BOOLEAN'), ('HEARTBEAT', 'NONE'))),
  -- A buffered delivery is never LIVE; a LIVE sample is never more than its policy's live lag (checked in code) and
  -- never from the future beyond the bounded skew recorded as negative lateness.
  CHECK (NOT (delivery = 'BACKFILL' AND ingestion_class = 'LIVE'))
);
CREATE INDEX telemetry_samples_channel_time_ix ON telemetry_samples (tenant_id, channel_id, event_at);
CREATE INDEX telemetry_samples_device_boot_seq_ix ON telemetry_samples (tenant_id, device_id, boot_id, sequence);
CREATE INDEX telemetry_samples_assignment_ix ON telemetry_samples (tenant_id, device_assignment_id, event_at);
CREATE INDEX telemetry_samples_channel_revision_ix ON telemetry_samples (tenant_id, channel_revision_id, event_at);
CREATE INDEX telemetry_samples_asset_revision_ix ON telemetry_samples (tenant_id, asset_revision_id, event_at);
SELECT ub_make_append_only('telemetry_samples');

-- The database re-derives the binding on every insert: exactly one assignment of this device effective at the
-- source time, naming this asset revision, which was not superseded at that time; exactly one revision of this
-- channel effective at that time, matching the stored kind/unit/calibration revision.
CREATE FUNCTION ub_telemetry_sample_binding_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM device_asset_assignments a
   WHERE a.tenant_id = NEW.tenant_id AND a.device_id = NEW.device_id
     AND a.valid_from <= NEW.event_at AND (a.valid_to IS NULL OR a.valid_to > NEW.event_at);
  IF n <> 1 THEN
    RAISE EXCEPTION 'telemetry sample binding is missing or overlapping at its source time' USING ERRCODE = 'UB031';
  END IF;
  PERFORM 1 FROM device_asset_assignments a
    JOIN asset_revisions r ON r.tenant_id = a.tenant_id AND r.asset_id = a.asset_id AND r.id = a.asset_revision_id
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.device_assignment_id AND a.device_id = NEW.device_id
     AND a.asset_id = NEW.asset_id AND a.asset_revision_id = NEW.asset_revision_id
     AND a.valid_from <= NEW.event_at AND (a.valid_to IS NULL OR a.valid_to > NEW.event_at)
     AND (r.superseded_at IS NULL OR r.superseded_at > NEW.event_at);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry sample binding is not the assignment effective at its source time' USING ERRCODE = 'UB031';
  END IF;
  SELECT count(*) INTO n FROM sensor_channel_revisions c
   WHERE c.tenant_id = NEW.tenant_id AND c.channel_id = NEW.channel_id
     AND c.valid_from <= NEW.event_at AND (c.valid_to IS NULL OR c.valid_to > NEW.event_at);
  IF n <> 1 THEN
    RAISE EXCEPTION 'telemetry sample channel binding is missing or overlapping at its source time' USING ERRCODE = 'UB031';
  END IF;
  PERFORM 1 FROM sensor_channel_revisions c
   WHERE c.tenant_id = NEW.tenant_id AND c.channel_id = NEW.channel_id AND c.id = NEW.channel_revision_id
     AND c.valid_from <= NEW.event_at AND (c.valid_to IS NULL OR c.valid_to > NEW.event_at)
     AND c.kind = NEW.kind AND c.unit = NEW.unit AND c.calibration_revision = NEW.calibration_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry sample channel binding is not the revision effective at its source time' USING ERRCODE = 'UB031';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER telemetry_samples_binding_guard BEFORE INSERT ON telemetry_samples
  FOR EACH ROW EXECUTE FUNCTION ub_telemetry_sample_binding_guard();

-- Rebinding or supersession can never move an interval end underneath an already-bound sample (history cannot be
-- reinterpreted): the one-shot valid_to / superseded_at stamp must be strictly later than every bound source time.
CREATE FUNCTION ub_interval_end_after_bound_telemetry() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  stamp timestamptz;
  bound timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'device_asset_assignments' THEN
    stamp := NEW.valid_to;
    IF stamp IS NULL OR OLD.valid_to IS NOT DISTINCT FROM stamp THEN RETURN NEW; END IF;
    SELECT max(event_at) INTO bound FROM telemetry_samples
     WHERE tenant_id = NEW.tenant_id AND device_assignment_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'sensor_channel_revisions' THEN
    stamp := NEW.valid_to;
    IF stamp IS NULL OR OLD.valid_to IS NOT DISTINCT FROM stamp THEN RETURN NEW; END IF;
    SELECT max(event_at) INTO bound FROM telemetry_samples
     WHERE tenant_id = NEW.tenant_id AND channel_revision_id = NEW.id;
  ELSE
    stamp := NEW.superseded_at;
    IF stamp IS NULL OR OLD.superseded_at IS NOT DISTINCT FROM stamp THEN RETURN NEW; END IF;
    SELECT max(event_at) INTO bound FROM telemetry_samples
     WHERE tenant_id = NEW.tenant_id AND asset_revision_id = NEW.id;
  END IF;
  IF bound IS NOT NULL AND stamp <= bound THEN
    RAISE EXCEPTION '% interval cannot end at or before bound telemetry at %', TG_TABLE_NAME, bound
      USING ERRCODE = 'UB031';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER device_asset_assignments_end_after_telemetry BEFORE UPDATE OF valid_to ON device_asset_assignments
  FOR EACH ROW EXECUTE FUNCTION ub_interval_end_after_bound_telemetry();
CREATE TRIGGER sensor_channel_revisions_end_after_telemetry BEFORE UPDATE OF valid_to ON sensor_channel_revisions
  FOR EACH ROW EXECUTE FUNCTION ub_interval_end_after_bound_telemetry();
CREATE TRIGGER asset_revisions_end_after_telemetry BEFORE UPDATE OF superseded_at ON asset_revisions
  FOR EACH ROW EXECUTE FUNCTION ub_interval_end_after_bound_telemetry();

-- Authenticated samples that were not stored, with a stable reason (binding, channel, unit, time, conflict). A
-- channel the device does not own is recorded only as a digest of the requested reference.
CREATE TABLE telemetry_rejections (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'trj')),
  batch_id text NOT NULL,
  device_id text NOT NULL,
  channel_id text,
  requested_channel_digest text NOT NULL CHECK (requested_channel_digest ~ '^sha256:[0-9a-f]{64}$'),
  boot_id text NOT NULL CHECK (boot_id ~ '^boot_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  delivery text NOT NULL CHECK (delivery IN ('LIVE', 'BACKFILL')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'BINDING_MISSING', 'BINDING_OVERLAPPING', 'BINDING_SUPERSEDED', 'CHANNEL_UNKNOWN', 'CHANNEL_RETIRED',
    'CHANNEL_REVISION_MISSING', 'CHANNEL_REVISION_OVERLAPPING', 'UNIT_MISMATCH', 'VALUE_OUT_OF_CONTRACT',
    'FUTURE_EVENT_TIME', 'EVENT_OUTSIDE_ACCEPTANCE_WINDOW', 'DUPLICATE_CONFLICT')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES telemetry_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id, channel_id) REFERENCES sensor_channels (tenant_id, device_id, id)
);
CREATE INDEX telemetry_rejections_device_ix ON telemetry_rejections (tenant_id, device_id, boot_id, sequence);
SELECT ub_make_append_only('telemetry_rejections');

-- Sequence gaps as observed when a sequence jumped past the highest one seen for the device and boot. Outstanding
-- ranges are derived at read time from what later arrived or was disclosed as dropped.
CREATE TABLE telemetry_sequence_gaps (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'tgp')),
  device_id text NOT NULL,
  boot_id text NOT NULL CHECK (boot_id ~ '^boot_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  from_sequence bigint NOT NULL CHECK (from_sequence >= 0),
  to_sequence bigint NOT NULL,
  detected_at timestamptz NOT NULL,
  batch_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, device_id, boot_id, from_sequence),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES telemetry_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (to_sequence >= from_sequence)
);
SELECT ub_make_append_only('telemetry_sequence_gaps');

-- Edge overflow disclosures: the dropped-message counter, the dropped sequence/time range and per-channel aggregates.
-- Aggregates explain history only; they are never samples and never contribute to any recovery window.
CREATE TABLE telemetry_drop_disclosures (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'tdd')),
  device_id text NOT NULL,
  batch_id text NOT NULL,
  boot_id text NOT NULL CHECK (boot_id ~ '^boot_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  dropped_total bigint NOT NULL CHECK (dropped_total >= 1),
  dropped_messages bigint NOT NULL CHECK (dropped_messages >= 1 AND dropped_messages <= dropped_total),
  from_sequence bigint NOT NULL CHECK (from_sequence >= 0),
  to_sequence bigint NOT NULL,
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  aggregates jsonb NOT NULL CHECK (jsonb_typeof(aggregates) = 'array' AND jsonb_array_length(aggregates) <= 16),
  received_at timestamptz NOT NULL,
  input_origin text NOT NULL CHECK (input_origin IN ('PHYSICAL_SENSOR', 'SIMULATED_INPUT')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, device_id, boot_id, from_sequence, to_sequence),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES telemetry_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (to_sequence >= from_sequence),
  CHECK (first_event_at <= last_event_at)
);
SELECT ub_make_append_only('telemetry_drop_disclosures');

-- Per-channel freshness projection (mutable, versioned). FRESH requires a LIVE, flag-free basis sample of this
-- channel whose source/receipt times are the projection's, no open invalidation, and an evaluation inside the
-- freshness threshold. The vocabulary has no healthy or recovered state.
CREATE TABLE telemetry_channel_health (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'thp')),
  device_id text NOT NULL,
  channel_id text NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('FRESH', 'STALE', 'OFFLINE', 'INVALID')),
  status_reason text NOT NULL CHECK (status_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  source_time timestamptz,
  receipt_time timestamptz,
  basis_sample_id text,
  invalid_reason text CHECK (invalid_reason IS NULL OR invalid_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  invalid_at timestamptz,
  last_received_at timestamptz,
  last_ingestion_class text CHECK (last_ingestion_class IS NULL OR last_ingestion_class IN ('LIVE', 'LATE', 'BACKFILL')),
  freshness_threshold_ms bigint NOT NULL CHECK (freshness_threshold_ms > 0),
  offline_threshold_ms bigint NOT NULL,
  freshness_policy_version text NOT NULL CHECK (freshness_policy_version ~ '^telemetry-freshness\.v[1-9][0-9]*$'),
  freshness_policy_digest text NOT NULL
    CHECK (freshness_policy_digest ~ '^telemetry-freshness-policy\.v1:sha256:[0-9a-f]{64}$'),
  evaluated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_id),
  FOREIGN KEY (tenant_id, device_id, channel_id) REFERENCES sensor_channels (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, basis_sample_id) REFERENCES telemetry_samples (tenant_id, id),
  CHECK (offline_threshold_ms > freshness_threshold_ms),
  CHECK ((source_time IS NULL) = (basis_sample_id IS NULL) AND (source_time IS NULL) = (receipt_time IS NULL)),
  CHECK ((invalid_reason IS NULL) = (invalid_at IS NULL)),
  CHECK (freshness <> 'FRESH' OR (
    basis_sample_id IS NOT NULL
    AND (invalid_at IS NULL OR invalid_at < source_time)
    AND evaluated_at - source_time <= freshness_threshold_ms * interval '1 millisecond'))
);
CREATE INDEX telemetry_channel_health_device_ix ON telemetry_channel_health (tenant_id, device_id);
CREATE INDEX telemetry_channel_health_sweep_ix ON telemetry_channel_health (freshness, source_time);

CREATE FUNCTION ub_telemetry_health_basis_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.basis_sample_id IS NOT NULL THEN
    PERFORM 1 FROM telemetry_samples s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.basis_sample_id AND s.channel_id = NEW.channel_id
       AND s.ingestion_class = 'LIVE' AND s.quality_flags = '{}'
       AND s.event_at = NEW.source_time AND s.received_at = NEW.receipt_time;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'health basis must be a LIVE, flag-free sample of this channel with matching times'
        USING ERRCODE = 'UB031';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER telemetry_channel_health_basis_guard BEFORE INSERT OR UPDATE ON telemetry_channel_health
  FOR EACH ROW EXECUTE FUNCTION ub_telemetry_health_basis_guard();
