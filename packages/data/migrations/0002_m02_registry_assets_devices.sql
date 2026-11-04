-- M02 registry (FR-01): versioned registry provenance, stable assets with immutable revisions and an explicit
-- current pointer, devices, immutable effective-dated device-to-asset assignments, and stable sensor channels with
-- immutable effective-dated kind/unit/calibration revisions. Overlapping intervals are excluded (btree_gist).

-- Every registry registration or edit appends one provenance revision (actor, source, time). Typed tables below
-- hold the constrained current/revision data; this ledger keeps every prior version readable.
CREATE TABLE registry_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rgr')),
  entity_kind text NOT NULL CHECK (entity_kind IN
    ('TENANT', 'SITE', 'ASSET', 'DEVICE', 'SENSOR_CHANNEL', 'WARRANTY', 'APPROVED_VENDOR', 'FOOD_AT_RISK')),
  entity_id text NOT NULL CHECK (entity_id ~ '^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$'),
  revision integer NOT NULL CHECK (revision >= 1),
  schema_name text NOT NULL CHECK (schema_name ~ '^registry\.[a-z_]+\.v[1-9][0-9]*$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^registry\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entity_kind, entity_id, revision),
  CHECK ((actor_kind = 'PLATFORM') = (actor_id IS NULL)),
  CHECK (entity_kind <> 'TENANT' OR entity_id = tenant_id)
);
SELECT ub_make_append_only('registry_revisions');

CREATE TABLE assets (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'ast')),
  site_id text NOT NULL,
  current_revision_id text NOT NULL CHECK (ub_id_ok(current_revision_id, 'arv')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
CREATE INDEX assets_site_ix ON assets (tenant_id, site_id);

-- Immutable equipment identity. Editing manufacturer/model/serial/safety class/BOM appends a revision; the prior
-- revision is only stamped superseded_at and stays bound to every historical decision.
CREATE TABLE asset_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'arv')),
  asset_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  manufacturer text NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  serial text CHECK (serial IS NULL OR length(serial) BETWEEN 1 AND 200),
  safety_class text NOT NULL CHECK (safety_class IN ('STANDARD', 'ELEVATED', 'SAFETY_CRITICAL')),
  bom_revision text NOT NULL CHECK (length(bom_revision) BETWEEN 1 AND 100),
  valid_from timestamptz NOT NULL,
  superseded_at timestamptz,
  identity_digest text NOT NULL CHECK (identity_digest ~ '^asset-identity\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, asset_id, id),
  UNIQUE (tenant_id, asset_id, revision),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (superseded_at IS NULL OR superseded_at >= valid_from)
);
CREATE UNIQUE INDEX asset_revisions_one_current_ux ON asset_revisions (tenant_id, asset_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX asset_revisions_current_identity_ux ON asset_revisions (tenant_id, manufacturer, model, serial)
  WHERE serial IS NOT NULL AND superseded_at IS NULL;
SELECT ub_make_append_only('asset_revisions', 'superseded_at');

-- The current pointer must name a revision of the same asset in the same tenant.
ALTER TABLE assets ADD CONSTRAINT assets_current_revision_fk
  FOREIGN KEY (tenant_id, id, current_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE devices (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'dev')),
  site_id text NOT NULL,
  credential_ref text NOT NULL CHECK (ub_secret_ref_ok(credential_ref)),
  status text NOT NULL DEFAULT 'PROVISIONED' CHECK (status IN ('PROVISIONED', 'ONLINE', 'STALE', 'OFFLINE', 'REVOKED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)
);
CREATE INDEX devices_id_ix ON devices (id);

-- Immutable effective-dated binding of a device to an exact asset revision; closing an interval is a one-shot
-- valid_to stamp, and one device can never have two overlapping intervals.
CREATE TABLE device_asset_assignments (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'dasg')),
  device_id text NOT NULL,
  asset_id text NOT NULL,
  asset_revision_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  assignment_digest text NOT NULL CHECK (assignment_digest ~ '^device-assignment\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, device_id, revision),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id, asset_revision_id) REFERENCES asset_revisions (tenant_id, asset_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, device_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX device_asset_assignments_open_ix ON device_asset_assignments (tenant_id, asset_id) WHERE valid_to IS NULL;
SELECT ub_make_append_only('device_asset_assignments', 'valid_to');

CREATE TABLE sensor_channels (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'chn')),
  device_id text NOT NULL,
  current_revision_id text NOT NULL CHECK (ub_id_ok(current_revision_id, 'chr')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE TABLE sensor_channel_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'chr')),
  channel_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  kind text NOT NULL,
  unit text NOT NULL,
  source_unit text,
  calibration_revision integer NOT NULL CHECK (calibration_revision >= 1),
  calibration_offset_milli integer NOT NULL DEFAULT 0,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  channel_digest text NOT NULL CHECK (channel_digest ~ '^sensor-channel\.v1:sha256:[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  UNIQUE (tenant_id, channel_id, revision),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES sensor_channels (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  -- Unit allowlist per kind; only temperature retains a source unit.
  CHECK ((kind, unit) IN (
    ('TEMPERATURE', 'MILLI_CELSIUS'), ('CURRENT', 'MILLI_AMPERE'), ('POWER', 'MILLI_WATT'),
    ('DOOR', 'BOOLEAN'), ('HEARTBEAT', 'NONE'))),
  CHECK ((kind = 'TEMPERATURE' AND source_unit IN ('CELSIUS', 'FAHRENHEIT', 'KELVIN'))
    OR (kind <> 'TEMPERATURE' AND source_unit IS NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, channel_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
);
SELECT ub_make_append_only('sensor_channel_revisions', 'valid_to');

ALTER TABLE sensor_channels ADD CONSTRAINT sensor_channels_current_revision_fk
  FOREIGN KEY (tenant_id, id, current_revision_id) REFERENCES sensor_channel_revisions (tenant_id, channel_id, id)
  DEFERRABLE INITIALLY DEFERRED;
