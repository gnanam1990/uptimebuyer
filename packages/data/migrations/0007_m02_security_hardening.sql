-- M02 security hardening (forward fix; 0001..0006 are unchanged):
-- 1. Secret references are bound to their owning tenant ('secretref:<ns>/tenants/<tenantId>/<path>', no dot
--    segments), so no row can point at another tenant's secret (confused deputy).
-- 2. Only a VALID webhook delivery occupies the (tenant, account, provider event) replay key; INVALID deliveries are
--    recorded as separate rows and can no longer poison the namespace.
-- 3. Legal holds and privacy requests carry their resolved scope chain (site, asset, incident) so overlap is decided
--    across ancestors and descendants.
-- 4. An evidence-ledger entry can be corrected at most once (no correction forks).
-- 5. Machine-principal token ids (jti) are recorded once, rejecting replay within the token lifetime.

-- 1 ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION ub_tenant_secret_ref_ok(ref text, tenant text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT length(ref) <= 300
       AND ref ~ '^secretref:[a-z0-9-]{1,32}/tenants/[^/]+/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
       AND split_part(ref, '/', 3) = tenant
       AND ref !~ '/\.{1,2}(/|$)'
  $$;

ALTER TABLE devices ADD CONSTRAINT devices_credential_ref_tenant_ck
  CHECK (ub_tenant_secret_ref_ok(credential_ref, tenant_id));
ALTER TABLE service_identities ADD CONSTRAINT service_identities_credential_ref_tenant_ck
  CHECK (ub_tenant_secret_ref_ok(credential_ref, tenant_id));
ALTER TABLE integration_identities ADD CONSTRAINT integration_identities_credential_ref_tenant_ck
  CHECK (ub_tenant_secret_ref_ok(credential_ref, tenant_id));
ALTER TABLE provider_account_revisions ADD CONSTRAINT provider_account_revisions_credential_ref_tenant_ck
  CHECK (ub_tenant_secret_ref_ok(credential_ref, tenant_id));
ALTER TABLE provider_account_revisions ADD CONSTRAINT provider_account_revisions_verifier_ref_tenant_ck
  CHECK (webhook_verifier_ref IS NULL OR ub_tenant_secret_ref_ok(webhook_verifier_ref, tenant_id));

-- 2 ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  con text;
BEGIN
  SELECT c.conname INTO con
    FROM pg_constraint c
   WHERE c.conrelid = 'webhook_deliveries'::regclass AND c.contype = 'u'
     AND c.conkey = ARRAY(
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'webhook_deliveries'::regclass
          AND attname IN ('tenant_id', 'provider_account_id', 'provider_event_id')
        ORDER BY array_position(ARRAY['tenant_id', 'provider_account_id', 'provider_event_id']::name[], attname))::int2[];
  IF con IS NULL THEN
    RAISE EXCEPTION 'webhook_deliveries replay-key constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE webhook_deliveries DROP CONSTRAINT %I', con);
END
$$;
CREATE UNIQUE INDEX webhook_deliveries_valid_event_ux ON webhook_deliveries (tenant_id, provider_account_id, provider_event_id)
  WHERE signature_result = 'VALID';
CREATE INDEX webhook_deliveries_event_ix ON webhook_deliveries (tenant_id, provider_account_id, provider_event_id);

-- 3 ---------------------------------------------------------------------------------------------------------------
ALTER TABLE assets ADD CONSTRAINT assets_site_asset_uk UNIQUE (tenant_id, site_id, id);

ALTER TABLE legal_holds
  ADD COLUMN site_id text,
  ADD COLUMN asset_id text,
  ADD COLUMN incident_id text CHECK (incident_id IS NULL OR ub_id_ok(incident_id, 'inc'));
-- Backfill the chain of any pre-existing holds (append-only stamp trigger suspended for this statement only).
-- A pre-existing INCIDENT hold has no known asset: its NULL site/asset makes it overlap every site- and asset-level
-- request in the tenant, which fails closed.
ALTER TABLE legal_holds DISABLE TRIGGER legal_holds_stamp_only;
UPDATE legal_holds h SET
  site_id = CASE h.scope_type WHEN 'SITE' THEN h.scope_id
                              WHEN 'ASSET' THEN (SELECT a.site_id FROM assets a WHERE a.tenant_id = h.tenant_id AND a.id = h.scope_id) END,
  asset_id = CASE WHEN h.scope_type = 'ASSET' THEN h.scope_id END,
  incident_id = CASE WHEN h.scope_type = 'INCIDENT' THEN h.scope_id END;
ALTER TABLE legal_holds ENABLE TRIGGER legal_holds_stamp_only;
ALTER TABLE legal_holds
  ADD CONSTRAINT legal_holds_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  ADD CONSTRAINT legal_holds_asset_fk FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES assets (tenant_id, site_id, id),
  ADD CONSTRAINT legal_holds_scope_chain_ck CHECK (
    (scope_type = 'TENANT' AND site_id IS NULL AND asset_id IS NULL AND incident_id IS NULL)
    OR (scope_type = 'SITE' AND site_id = scope_id AND asset_id IS NULL AND incident_id IS NULL)
    OR (scope_type = 'ASSET' AND asset_id = scope_id AND site_id IS NOT NULL AND incident_id IS NULL)
    OR (scope_type = 'INCIDENT' AND incident_id = scope_id AND asset_id IS NOT NULL AND site_id IS NOT NULL)
  ) NOT VALID;
CREATE INDEX legal_holds_chain_ix ON legal_holds (tenant_id, site_id, asset_id, incident_id) WHERE released_at IS NULL;

ALTER TABLE privacy_requests
  ADD COLUMN site_id text,
  ADD COLUMN asset_id text,
  ADD COLUMN incident_id text CHECK (incident_id IS NULL OR ub_id_ok(incident_id, 'inc'));
UPDATE privacy_requests p SET
  site_id = CASE p.scope_type WHEN 'SITE' THEN p.scope_id
                              WHEN 'ASSET' THEN (SELECT a.site_id FROM assets a WHERE a.tenant_id = p.tenant_id AND a.id = p.scope_id) END,
  asset_id = CASE WHEN p.scope_type = 'ASSET' THEN p.scope_id END,
  incident_id = CASE WHEN p.scope_type = 'INCIDENT' THEN p.scope_id END;
ALTER TABLE privacy_requests
  ADD CONSTRAINT privacy_requests_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  ADD CONSTRAINT privacy_requests_asset_fk FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES assets (tenant_id, site_id, id),
  ADD CONSTRAINT privacy_requests_scope_chain_ck CHECK (
    (scope_type = 'TENANT' AND scope_id = tenant_id AND site_id IS NULL AND asset_id IS NULL AND incident_id IS NULL)
    OR (scope_type = 'SITE' AND site_id = scope_id AND asset_id IS NULL AND incident_id IS NULL)
    OR (scope_type = 'ASSET' AND asset_id = scope_id AND site_id IS NOT NULL AND incident_id IS NULL)
    OR (scope_type = 'INCIDENT' AND incident_id = scope_id AND asset_id IS NOT NULL AND site_id IS NOT NULL)
  ) NOT VALID;

-- 4 ---------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX evidence_ledger_entries_one_correction_ux ON evidence_ledger_entries (tenant_id, supersedes_evidence_id)
  WHERE supersedes_evidence_id IS NOT NULL;

-- 5 ---------------------------------------------------------------------------------------------------------------
-- Rows past expires_at may be pruned; a replayed token is rejected by this key while it is still valid.
CREATE TABLE principal_token_uses (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (length(id) BETWEEN 16 AND 64),
  principal_kind text NOT NULL CHECK (principal_kind IN ('DEVICE', 'SERVICE', 'INTEGRATION')),
  principal_id text NOT NULL CHECK (length(principal_id) <= 80),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX principal_token_uses_expiry_ix ON principal_token_uses (expires_at);
