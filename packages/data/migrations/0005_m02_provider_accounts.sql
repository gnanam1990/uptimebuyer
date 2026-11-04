-- M02-owned provider-account tables (behaviour is M07's): stable tenant/provider/environment identity, immutable
-- capability/owner/credential/verifier revisions, and webhook deliveries namespaced by tenant and provider account.
-- The webhook endpoint binding is stored only as a digest; the tenant is derived from it server-side.

CREATE TABLE provider_accounts (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pac')),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  environment text NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  current_revision_id text NOT NULL CHECK (ub_id_ok(current_revision_id, 'par')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  webhook_binding_digest text NOT NULL UNIQUE CHECK (webhook_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_key, environment)
);

CREATE TABLE provider_account_revisions (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'par')),
  provider_account_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  capabilities text[] NOT NULL CHECK (
    cardinality(capabilities) BETWEEN 1 AND 16
    AND capabilities <@ ARRAY['SEARCH', 'QUOTE', 'CONTACT_PHONE', 'CONTACT_EMAIL', 'CONTACT_API', 'PURCHASE',
      'SERVICE_BOOKING', 'WEBHOOK', 'KITE_SESSION', 'CMMS_SYNC']::text[]),
  paid boolean NOT NULL,
  owner_service text NOT NULL CHECK (owner_service IN ('M07_UNPAID', 'KITE_BROKER_PAID')),
  credential_ref text NOT NULL CHECK (ub_secret_ref_ok(credential_ref)),
  endpoint_policy_digest text NOT NULL CHECK (endpoint_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  webhook_verifier_ref text CHECK (webhook_verifier_ref IS NULL OR ub_secret_ref_ok(webhook_verifier_ref)),
  effective_at timestamptz NOT NULL,
  superseded_at timestamptz,
  actor_kind text NOT NULL CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'WORKER', 'PLATFORM')),
  actor_id text,
  source text NOT NULL CHECK (source IN ('API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING', 'MIGRATION')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, id),
  UNIQUE (tenant_id, provider_account_id, revision),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES provider_accounts (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  -- Paid capability is owned by the exclusive Kite broker; unpaid execution by M07 (INV-06).
  CHECK (paid = (owner_service = 'KITE_BROKER_PAID')),
  CHECK (superseded_at IS NULL OR superseded_at >= effective_at)
);
CREATE UNIQUE INDEX provider_account_revisions_one_current_ux ON provider_account_revisions (tenant_id, provider_account_id)
  WHERE superseded_at IS NULL;
SELECT ub_make_append_only('provider_account_revisions', 'superseded_at');

ALTER TABLE provider_accounts ADD CONSTRAINT provider_accounts_current_revision_fk
  FOREIGN KEY (tenant_id, id, current_revision_id)
  REFERENCES provider_account_revisions (tenant_id, provider_account_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approvals ADD CONSTRAINT approvals_provider_account_revision_fk
  FOREIGN KEY (tenant_id, provider_account_revision_id) REFERENCES provider_account_revisions (tenant_id, id);

ALTER TABLE integration_identities ADD CONSTRAINT integration_identities_provider_account_fk
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES provider_accounts (tenant_id, id);

-- Replay identity is exactly (tenant_id, provider_account_id, provider_event_id); the revision must belong to the
-- same account. processed_at is a one-shot stamp.
CREATE TABLE webhook_deliveries (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'whd')),
  provider_account_id text NOT NULL,
  provider_account_revision_id text NOT NULL,
  provider_event_id text NOT NULL
    CHECK (length(provider_event_id) BETWEEN 1 AND 256 AND provider_event_id ~ '^[\x21-\x7E]+$'),
  signature_result text NOT NULL CHECK (signature_result IN ('VALID', 'INVALID')),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, provider_event_id),
  FOREIGN KEY (tenant_id, provider_account_id, provider_account_revision_id)
    REFERENCES provider_account_revisions (tenant_id, provider_account_id, id)
);
SELECT ub_make_append_only('webhook_deliveries', 'processed_at');
