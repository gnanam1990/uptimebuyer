-- M13 security review S5 (forward fix of 0021): dual approval is decided over the AUTHORITY revision in force AND
-- every scheduled (future-dated) AUTHORITY revision, so a queued control cannot be superseded and an active one cannot
-- be weakened by one administrator:
-- - every AUTHORITY change needs a proposal approved by a second administrator while the current or any scheduled
--   AUTHORITY revision has a non-empty separationOfDuties section;
-- - any other key needs it while the current or any scheduled AUTHORITY revision names it in dualApprovalPolicyKeys;
-- - an AUTHORITY revision that enables the section is refused while an unreviewed (no proposal) future-dated
--   revision of AUTHORITY or a key it names is queued, so nothing published before the control takes effect after it.
-- The guard takes the per-tenant governance advisory lock (the same key the service takes) so concurrent inserts
-- serialize. NULL-safe per ADR 0004: every decision is EXISTS / coalesce(..., false). SQLSTATE UB131.

-- Does a body carry a non-empty separation-of-duties section?
CREATE FUNCTION ub_sod_active(body jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT coalesce(
      (jsonb_typeof(body -> 'separationOfDuties' -> 'spend') = 'array'
         AND jsonb_array_length(body -> 'separationOfDuties' -> 'spend') > 0)
      OR (jsonb_typeof(body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') = 'array'
         AND jsonb_array_length(body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') > 0),
      false)
  $$;

CREATE OR REPLACE FUNCTION ub_policy_dual_approval_required(t text, key text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
       WHERE r.tenant_id = t AND p.policy_key = 'AUTHORITY'
         AND (r.effective_at > clock_timestamp()
              OR r.id = (SELECT c.id FROM policy_revisions c JOIN policies cp ON cp.tenant_id = c.tenant_id AND cp.id = c.policy_id
                          WHERE c.tenant_id = t AND cp.policy_key = 'AUTHORITY' AND c.effective_at <= clock_timestamp()
                          ORDER BY c.effective_at DESC, c.revision DESC LIMIT 1))
         AND ((key = 'AUTHORITY' AND ub_sod_active(r.body))
              OR coalesce(jsonb_typeof(r.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') = 'array'
                          AND (r.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') ? key, false)))
  $$;

CREATE OR REPLACE FUNCTION ub_policy_revision_dual_approval_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  key text;
BEGIN
  SELECT p.policy_key INTO key FROM policies p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.policy_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key refuses a missing policy
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('policy-governance:' || NEW.tenant_id, 0));
  IF ub_policy_dual_approval_required(NEW.tenant_id, key) AND NOT EXISTS (
       SELECT 1 FROM policy_change_proposals x
        WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.proposal_id AND x.policy_key = key
          AND x.proposed_by_user_id = NEW.published_by_user_id
          AND NEW.approved_by_user_id IS NOT NULL
          AND NEW.approved_by_user_id IS DISTINCT FROM x.proposed_by_user_id
          AND x.decision IS NULL AND x.published_policy_revision_id IS NULL) THEN
    RAISE EXCEPTION 'dual approval required for this policy key' USING ERRCODE = 'UB131';
  END IF;
  -- Enabling the section over a queued unreviewed revision would let that revision undo it later.
  IF key = 'AUTHORITY' AND ub_sod_active(NEW.body) AND EXISTS (
       SELECT 1 FROM policy_revisions q JOIN policies qp ON qp.tenant_id = q.tenant_id AND qp.id = q.policy_id
        WHERE q.tenant_id = NEW.tenant_id AND q.effective_at > clock_timestamp() AND q.proposal_id IS NULL
          AND (qp.policy_key = 'AUTHORITY'
               OR coalesce(jsonb_typeof(NEW.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') = 'array'
                           AND (NEW.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') ? qp.policy_key, false))) THEN
    RAISE EXCEPTION 'an unreviewed future revision is queued' USING ERRCODE = 'UB131';
  END IF;
  RETURN NEW;
END
$$;
