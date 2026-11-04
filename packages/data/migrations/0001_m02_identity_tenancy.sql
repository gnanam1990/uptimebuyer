-- M02 identity and tenancy: shared integrity helpers, tenants, global human users, tenant memberships, sites,
-- separate service and integration principals, and site-scoped role assignments.
-- Conventions: every tenant-owned table has tenant_id, a (tenant_id, id) key and composite tenant foreign keys.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prefixed opaque identifier check shared with @uptimebuyer/contracts ID_PREFIXES ('<prefix>_<4..64 body>').
CREATE FUNCTION ub_id_ok(v text, prefix text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT v ~ ('^' || prefix || '_[A-Za-z0-9][A-Za-z0-9-]{3,63}$') $$;

CREATE FUNCTION ub_secret_ref_ok(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT v ~ '^secretref:[a-z0-9-]{1,32}/[A-Za-z0-9._/-]{1,200}$' $$;

-- Append-only enforcement (INV-10). Raised with SQLSTATE UB001 so callers can distinguish it.
CREATE FUNCTION ub_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'UB001';
END
$$;

-- Immutable rows that carry one-shot stamp columns (superseded_at, valid_to, revoked_at, ...): an UPDATE may only
-- move the named columns from NULL to a value, at least one must be stamped, and every other column is unchanged.
CREATE FUNCTION ub_allow_stamp_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  c text;
  stamped boolean := false;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF o -> c IS DISTINCT FROM n -> c THEN
      IF o -> c = 'null'::jsonb AND n -> c <> 'null'::jsonb THEN
        stamped := true;
      ELSE
        RAISE EXCEPTION 'table % is append-only: stamp column % is already set', TG_TABLE_NAME, c USING ERRCODE = 'UB001';
      END IF;
    END IF;
    o := o - c;
    n := n - c;
  END LOOP;
  IF o <> n OR NOT stamped THEN
    RAISE EXCEPTION 'table % is append-only: only one-shot stamp columns may be set', TG_TABLE_NAME USING ERRCODE = 'UB001';
  END IF;
  RETURN NEW;
END
$$;

-- Attach append-only triggers: row UPDATE (fully forbidden, or stamp-only), row DELETE and statement TRUNCATE.
CREATE FUNCTION ub_make_append_only(tbl regclass, VARIADIC stamp_cols text[] DEFAULT '{}') RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  rel text := (SELECT relname FROM pg_class WHERE oid = tbl);
  args text;
BEGIN
  IF cardinality(stamp_cols) = 0 THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation()',
      rel || '_no_update', tbl);
  ELSE
    SELECT string_agg(quote_literal(c), ', ') INTO args FROM unnest(stamp_cols) AS c;
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION ub_allow_stamp_only(%s)',
      rel || '_stamp_only', tbl, args);
  END IF;
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ub_forbid_mutation()',
    rel || '_no_delete', tbl);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ub_forbid_mutation()',
    rel || '_no_truncate', tbl);
END
$$;

CREATE TABLE tenants (
  id text PRIMARY KEY CHECK (ub_id_ok(id, 'ten')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Global human identities. Only the OIDC subject mapping lives here; authority is always tenant-scoped.
CREATE TABLE users (
  id text PRIMARY KEY CHECK (ub_id_ok(id, 'usr')),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  external_subject text NOT NULL UNIQUE CHECK (length(external_subject) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tenant_memberships (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'mbr')),
  user_id text NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_ix ON tenant_memberships (user_id);

CREATE TABLE sites (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'sit')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL CHECK (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

-- Workload identities (API, workers, broker, gateway) are tenant-bound principals with opaque credential refs.
CREATE TABLE service_identities (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'svc')),
  workload text NOT NULL CHECK (workload IN ('api', 'general-worker', 'kite-broker', 'sensor-gateway', 'serv-agent')),
  credential_ref text NOT NULL CHECK (ub_secret_ref_ok(credential_ref)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

-- Integration principals (CMMS, provider callbacks). provider_account_id gains its FK in 0005.
CREATE TABLE integration_identities (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'itg')),
  provider_account_id text CHECK (provider_account_id IS NULL OR ub_id_ok(provider_account_id, 'pac')),
  credential_ref text NOT NULL CHECK (ub_secret_ref_ok(credential_ref)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

-- Site-scoped role grants. Exactly one principal column is set and must match principal_kind; devices hold no
-- roles (their only capability is implied by their kind). site_id NULL is a tenant-wide grant. Revocation is a
-- one-shot stamp; a grant is never edited or deleted.
CREATE TABLE role_assignments (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'rla')),
  principal_kind text NOT NULL CHECK (principal_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION')),
  user_id text,
  service_identity_id text,
  integration_identity_id text,
  role text NOT NULL,
  site_id text,
  granted_by_user_id text,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by_user_id text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, service_identity_id) REFERENCES service_identities (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_identity_id) REFERENCES integration_identities (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CHECK (num_nonnulls(user_id, service_identity_id, integration_identity_id) = 1),
  CHECK ((principal_kind = 'HUMAN') = (user_id IS NOT NULL)),
  CHECK ((principal_kind = 'SERVICE') = (service_identity_id IS NOT NULL)),
  CHECK ((principal_kind = 'INTEGRATION') = (integration_identity_id IS NOT NULL)),
  CHECK (
    (principal_kind = 'HUMAN'
      AND role IN ('viewer', 'operator', 'maintenance_approver', 'finance_approver', 'engineer', 'admin', 'auditor'))
    OR (principal_kind = 'SERVICE' AND role = 'worker')
    OR (principal_kind = 'INTEGRATION' AND role = 'integration')
  ),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX role_assignments_active_ux ON role_assignments (
  tenant_id, principal_kind, coalesce(user_id, service_identity_id, integration_identity_id), role, coalesce(site_id, '*')
) WHERE revoked_at IS NULL;
SELECT ub_make_append_only('role_assignments', 'revoked_at', 'revoked_by_user_id');
