-- M13 data lifecycle (FR-23, INV-10, NFR-06): retention expiry, privacy-request erasure and legal hold for raw
-- governed payloads — raw fulfillment-webhook bodies (M10), raw CMMS record bodies (M11) and raw communication bodies
-- (M07). Erasure never breaks an append-only invariant: the only permitted change to those rows is one tombstoned
-- erasure of the raw payload column; every digest, seal and decision that references the row is untouched, so the
-- evidence-ledger hash chain and every recovery decision stay reproducible. An active legal hold covering the row's
-- tenant/site/asset/incident chain refuses the erasure in the database as well as in the service. SQLSTATE UB132.
-- Lock order (ADR 0006/0008): erasure transactions take the per-tenant legal-hold advisory lock before touching rows.

-- 1. Tombstones record retention-expiry erasures as well as privacy-request erasures (one tombstone per target).
ALTER TABLE redaction_tombstones ALTER COLUMN privacy_request_id DROP NOT NULL;
ALTER TABLE redaction_tombstones
  ADD COLUMN basis text NOT NULL DEFAULT 'PRIVACY_REQUEST' CHECK (basis IN ('PRIVACY_REQUEST', 'RETENTION_EXPIRED')),
  ADD COLUMN retention_policy_revision_id text,
  ADD COLUMN target_column text CHECK (target_column IS NULL OR target_column ~ '^[a-z][a-z_]{0,63}$'),
  ADD COLUMN erased_digest text CHECK (erased_digest IS NULL OR erased_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN actor_kind text CHECK (actor_kind IS NULL OR actor_kind IN ('HUMAN', 'SERVICE', 'WORKER')),
  ADD COLUMN actor_id text CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT redaction_tombstones_basis_ck CHECK (
    (basis = 'PRIVACY_REQUEST' AND privacy_request_id IS NOT NULL AND retention_policy_revision_id IS NULL)
    OR (basis = 'RETENTION_EXPIRED' AND privacy_request_id IS NULL AND retention_policy_revision_id IS NOT NULL)),
  ADD CONSTRAINT redaction_tombstones_retention_fk FOREIGN KEY (tenant_id, retention_policy_revision_id)
    REFERENCES policy_revisions (tenant_id, id);
CREATE UNIQUE INDEX redaction_tombstones_target_ux
  ON redaction_tombstones (tenant_id, target_table, target_id, coalesce(target_column, ''));

-- 2. Does an active legal hold cover a row with this chain? An unknown (NULL) level is covered by any hold at that
--    level (fail closed). Holds are matched on their own scope id, so a pre-0007 hold without a chain still covers.
CREATE FUNCTION ub_legal_hold_covers(t text, s text, a text, i text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM legal_holds h
       WHERE h.tenant_id = t AND h.released_at IS NULL
         AND (h.scope_type = 'TENANT'
              OR (h.scope_type = 'SITE' AND (s IS NULL OR h.scope_id = s))
              OR (h.scope_type = 'ASSET' AND (a IS NULL OR h.scope_id = a))
              OR (h.scope_type = 'INCIDENT' AND (i IS NULL OR h.scope_id = i))))
  $$;

-- Is there a tombstone for exactly this target row?
CREATE FUNCTION ub_tombstone_targets(t text, tomb text, tbl text, target text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (SELECT 1 FROM redaction_tombstones x
                    WHERE x.tenant_id = t AND x.id = tomb AND x.target_table = tbl AND x.target_id = target)
  $$;

-- 3. Raw fulfillment-webhook bodies (M10). raw_body_digest stays; raw_body becomes NULL once, with its tombstone.
ALTER TABLE fulfillment_observations
  ADD COLUMN raw_body_erased_at timestamptz,
  ADD COLUMN raw_body_erasure_id text,
  ADD CONSTRAINT fulfillment_observations_erasure_ck CHECK (
    (raw_body_erased_at IS NULL) = (raw_body_erasure_id IS NULL) AND (raw_body_erased_at IS NULL OR raw_body IS NULL)),
  ADD CONSTRAINT fulfillment_observations_erasure_fk FOREIGN KEY (tenant_id, raw_body_erasure_id)
    REFERENCES redaction_tombstones (tenant_id, id);

CREATE FUNCTION ub_fulfillment_observation_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  frozen constant text[] := ARRAY['raw_body', 'raw_body_erased_at', 'raw_body_erasure_id'];
  inc text;
  site text;
  asset text;
BEGIN
  IF coalesce(
       (to_jsonb(NEW) - frozen) = (to_jsonb(OLD) - frozen)
       AND OLD.raw_body_erasure_id IS NULL AND OLD.raw_body IS NOT NULL
       AND NEW.raw_body IS NULL AND NEW.raw_body_erased_at IS NOT NULL AND NEW.raw_body_erasure_id IS NOT NULL
       AND ub_tombstone_targets(NEW.tenant_id, NEW.raw_body_erasure_id, 'fulfillment_observations', NEW.id),
       false) IS NOT TRUE THEN
    RAISE EXCEPTION 'fulfillment observations are append-only; only a tombstoned raw-body erasure is permitted'
      USING ERRCODE = 'UB001';
  END IF;
  SELECT o.incident_id, o.site_id, i.asset_id INTO inc, site, asset
    FROM (SELECT incident_id, site_id FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.purchase_order_id
          UNION ALL
          SELECT incident_id, site_id FROM service_jobs WHERE tenant_id = NEW.tenant_id AND id = NEW.service_job_id) o
    LEFT JOIN incidents i ON i.tenant_id = NEW.tenant_id AND i.id = o.incident_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal-hold:' || NEW.tenant_id, 0));
  IF ub_legal_hold_covers(NEW.tenant_id, site, asset, inc) THEN
    RAISE EXCEPTION 'an active legal hold blocks this erasure' USING ERRCODE = 'UB132';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER fulfillment_observations_no_update ON fulfillment_observations;
CREATE TRIGGER fulfillment_observations_guard BEFORE UPDATE ON fulfillment_observations
  FOR EACH ROW EXECUTE FUNCTION ub_fulfillment_observation_guard();

-- 4. Raw CMMS (and other recovery) record bodies (M11). body_digest and the HMAC seal over it stay; body becomes the
--    erased marker once, with its tombstone. Structured columns that decisions read are never touched.
ALTER TABLE recovery_evidence
  ADD COLUMN body_erased_at timestamptz,
  ADD COLUMN body_erasure_id text,
  ADD CONSTRAINT recovery_evidence_erasure_ck CHECK (
    (body_erased_at IS NULL) = (body_erasure_id IS NULL) AND (body_erased_at IS NULL OR body = '{"erased": true}'::jsonb)),
  ADD CONSTRAINT recovery_evidence_erasure_fk FOREIGN KEY (tenant_id, body_erasure_id)
    REFERENCES redaction_tombstones (tenant_id, id);

CREATE FUNCTION ub_recovery_evidence_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  frozen constant text[] := ARRAY['body', 'body_erased_at', 'body_erasure_id'];
BEGIN
  IF coalesce(
       (to_jsonb(NEW) - frozen) = (to_jsonb(OLD) - frozen)
       AND OLD.body_erasure_id IS NULL
       AND NEW.body = '{"erased": true}'::jsonb AND NEW.body_erased_at IS NOT NULL AND NEW.body_erasure_id IS NOT NULL
       AND ub_tombstone_targets(NEW.tenant_id, NEW.body_erasure_id, 'recovery_evidence', NEW.id),
       false) IS NOT TRUE THEN
    RAISE EXCEPTION 'recovery evidence is append-only; only a tombstoned body erasure is permitted' USING ERRCODE = 'UB001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal-hold:' || NEW.tenant_id, 0));
  IF ub_legal_hold_covers(NEW.tenant_id, NEW.site_id, NEW.asset_id, NEW.incident_id) THEN
    RAISE EXCEPTION 'an active legal hold blocks this erasure' USING ERRCODE = 'UB132';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER recovery_evidence_no_update ON recovery_evidence;
CREATE TRIGGER recovery_evidence_guard BEFORE UPDATE ON recovery_evidence
  FOR EACH ROW EXECUTE FUNCTION ub_recovery_evidence_guard();

-- 5. Raw communication bodies (M07) keep their single-erasure guard; an active legal hold now refuses it too.
CREATE FUNCTION ub_communication_body_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  inc text;
  site text;
  asset text;
BEGIN
  SELECT m.incident_id, m.site_id, q.asset_id INTO inc, site, asset
    FROM provider_communications m
    LEFT JOIN provider_contact_requests q ON q.tenant_id = m.tenant_id AND q.id = m.contact_request_id
   WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.communication_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal-hold:' || NEW.tenant_id, 0));
  IF ub_legal_hold_covers(NEW.tenant_id, site, asset, inc) THEN
    RAISE EXCEPTION 'an active legal hold blocks this erasure' USING ERRCODE = 'UB132';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_communication_bodies_hold_guard BEFORE UPDATE ON provider_communication_bodies
  FOR EACH ROW EXECUTE FUNCTION ub_communication_body_hold_guard();

-- Retention sweeps scan by age.
CREATE INDEX fulfillment_observations_retention_ix ON fulfillment_observations (tenant_id, recorded_at)
  WHERE raw_body IS NOT NULL;
CREATE INDEX recovery_evidence_retention_ix ON recovery_evidence (tenant_id, recorded_at)
  WHERE body_erased_at IS NULL AND source_kind = 'CMMS';
