-- M07 security forward fix (0013 is unchanged): the contact-point insert guard must fail CLOSED.
--
-- 0013's ub_contact_point_usable_guard used `IF NOT (<allowed>) THEN RAISE`. Under SQL three-valued logic a NULL
-- <allowed> skips the RAISE: with no review row `latest = 'VERIFIED'` is NULL, so an unreviewed PENDING_REVIEW point,
-- an unreviewed point with a NULL source revision (legacy / pre-0013 rows) or one from another account revision was
-- accepted. The redefinition keeps every non-NULL outcome identical and treats NULL as "not allowed": the allowed
-- condition is collapsed with coalesce(..., false) and checked with IS NOT TRUE, and a missing contact point is
-- refused explicitly. Rule and audit of every guard: docs/adr/0004-sql-guard-null-safety.md.

CREATE OR REPLACE FUNCTION ub_contact_point_usable_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  cp record;
  latest text;
BEGIN
  SELECT p.intake_state, p.source_provider_account_revision_id, p.channel INTO cp
    FROM service_provider_contact_points p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.contact_point_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact point is not approved for this request' USING ERRCODE = 'UB075';
  END IF;
  SELECT r.decision INTO latest FROM service_provider_contact_point_reviews r
   WHERE r.tenant_id = NEW.tenant_id AND r.contact_point_id = NEW.contact_point_id
   ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1;
  IF cp.channel IS DISTINCT FROM NEW.channel THEN
    RAISE EXCEPTION 'contact point channel does not match the request' USING ERRCODE = 'UB075';
  END IF;
  IF coalesce(latest = 'VERIFIED' OR (latest IS NULL AND cp.intake_state = 'DISCOVERED'
          AND cp.source_provider_account_revision_id = NEW.provider_account_revision_id), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'contact point is not approved for this request' USING ERRCODE = 'UB075';
  END IF;
  RETURN NEW;
END
$$;
