-- M07 security review: contact-point provenance and review (destination-hijack fix).
--
-- Each discovered contact point now records the search and exact account revision it came from and its intake
-- state: DISCOVERED, or PENDING_REVIEW when a search attaches a new point to a provider already linked to an
-- approved-vendor record. Admin review decisions are an append-only log (latest wins). A contact request may use a
-- point only when its latest review is VERIFIED, or when it is unreviewed, DISCOVERED and from the request's own
-- pinned account revision (enforced by M07 and re-checked by the insert guard below).

ALTER TABLE service_provider_contact_points
  ADD COLUMN source_search_id text,
  ADD COLUMN source_provider_account_revision_id text,
  ADD COLUMN intake_state text NOT NULL DEFAULT 'DISCOVERED' CHECK (intake_state IN ('DISCOVERED', 'PENDING_REVIEW')),
  ADD CONSTRAINT service_provider_contact_points_search_fk
    FOREIGN KEY (tenant_id, source_search_id) REFERENCES provider_searches (tenant_id, id),
  ADD CONSTRAINT service_provider_contact_points_revision_fk
    FOREIGN KEY (tenant_id, source_provider_account_revision_id) REFERENCES provider_account_revisions (tenant_id, id);

CREATE TABLE service_provider_contact_point_reviews (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'spv')),
  contact_point_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('VERIFIED', 'REJECTED')),
  reviewed_by_user_id text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_point_id) REFERENCES service_provider_contact_points (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);
CREATE INDEX service_provider_contact_point_reviews_ix
  ON service_provider_contact_point_reviews (tenant_id, contact_point_id, reviewed_at);
SELECT ub_make_append_only('service_provider_contact_point_reviews');

-- New contact requests must target a usable point (defence in depth behind M07's check).
CREATE FUNCTION ub_contact_point_usable_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  cp record;
  latest text;
BEGIN
  SELECT p.intake_state, p.source_provider_account_revision_id, p.channel INTO cp
    FROM service_provider_contact_points p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.contact_point_id;
  SELECT r.decision INTO latest FROM service_provider_contact_point_reviews r
   WHERE r.tenant_id = NEW.tenant_id AND r.contact_point_id = NEW.contact_point_id
   ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1;
  IF cp.channel IS DISTINCT FROM NEW.channel THEN
    RAISE EXCEPTION 'contact point channel does not match the request' USING ERRCODE = 'UB075';
  END IF;
  IF NOT (latest = 'VERIFIED' OR (latest IS NULL AND cp.intake_state = 'DISCOVERED'
          AND cp.source_provider_account_revision_id = NEW.provider_account_revision_id)) THEN
    RAISE EXCEPTION 'contact point is not approved for this request' USING ERRCODE = 'UB075';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_contact_requests_point_guard BEFORE INSERT ON provider_contact_requests
  FOR EACH ROW EXECUTE FUNCTION ub_contact_point_usable_guard();
