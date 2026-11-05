-- M13 separation of duties (SECURITY.md §4, UI-SPEC §10, INV-15; M06/M12 residuals). Database backstops for the two
-- rules that need two people when the governing AUTHORITY policy revision says so:
-- 1. spend: under a `separationOfDuties.spend` rule covering the approval's currency and amount, the execution
--    authority is issued by a human who is not the approval's actor (the service also requires finance_approver);
-- 2. high-risk policy: a revision of a policy key named in the effective AUTHORITY policy's
--    `separationOfDuties.dualApprovalPolicyKeys` is inserted only from an open proposal by the publisher with a
--    recorded approver who is not the proposer; the proposal is stamped APPROVED in the same transaction. Proposals
--    are append-only; the decision is a one-time stamp.
-- SQLSTATEs UB130 (spend), UB131 (policy). Guards are NULL-safe (ADR 0004).

-- Does the AUTHORITY policy revision `p` declare a spend SoD rule covering (currency, amount)?
CREATE FUNCTION ub_spend_sod_required(t text, p text, currency text, amount bigint) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM policy_revisions r,
             jsonb_array_elements(CASE WHEN jsonb_typeof(r.body -> 'separationOfDuties' -> 'spend') = 'array'
                                       THEN r.body -> 'separationOfDuties' -> 'spend' ELSE '[]'::jsonb END) rule
       WHERE r.tenant_id = t AND r.id = p
         AND rule ->> 'currency' = currency
         AND (rule ->> 'minAmountMinor') ~ '^[0-9]{1,19}$'
         AND amount >= (rule ->> 'minAmountMinor')::numeric)
  $$;

CREATE FUNCTION ub_execution_authority_sod_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  a record;
BEGIN
  SELECT x.actor_user_id, x.policy_revision_id, x.currency, x.max_amount_minor INTO a
    FROM approvals x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.approval_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key refuses a missing approval
  END IF;
  IF ub_spend_sod_required(NEW.tenant_id, a.policy_revision_id, a.currency, a.max_amount_minor)
     AND (NEW.issued_by_kind IS DISTINCT FROM 'HUMAN' OR NEW.issued_by_id IS NOT DISTINCT FROM a.actor_user_id) THEN
    RAISE EXCEPTION 'separation of duties: the authority must be issued by a different human' USING ERRCODE = 'UB130';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER execution_authorities_sod_guard BEFORE INSERT ON execution_authorities
  FOR EACH ROW EXECUTE FUNCTION ub_execution_authority_sod_guard();

-- Proposals for high-risk policy revisions.
CREATE TABLE policy_change_proposals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'pcp')),
  policy_key text NOT NULL CHECK (policy_key IN ('AUTHORITY', 'RETENTION')),
  schema_name text NOT NULL CHECK (length(schema_name) BETWEEN 1 AND 100),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[0-9a-f]{64}$'),
  effective_at timestamptz,
  source text NOT NULL,
  proposed_by_user_id text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision text CHECK (decision IS NULL OR decision IN ('APPROVED', 'REJECTED')),
  decided_by_user_id text,
  decided_at timestamptz,
  published_policy_revision_id text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, decided_by_user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, published_policy_revision_id) REFERENCES policy_revisions (tenant_id, id),
  CHECK ((decision IS NULL) = (decided_by_user_id IS NULL) AND (decision IS NULL) = (decided_at IS NULL)),
  CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> proposed_by_user_id),
  CHECK ((decision IS NOT DISTINCT FROM 'APPROVED') = (published_policy_revision_id IS NOT NULL))
);
SELECT ub_make_append_only('policy_change_proposals', 'decision', 'decided_by_user_id', 'decided_at',
  'published_policy_revision_id');

ALTER TABLE policy_revisions
  ADD COLUMN proposal_id text,
  ADD COLUMN approved_by_user_id text,
  ADD CONSTRAINT policy_revisions_proposal_fk FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES policy_change_proposals (tenant_id, id),
  ADD CONSTRAINT policy_revisions_approver_fk FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES tenant_memberships (tenant_id, user_id),
  ADD CONSTRAINT policy_revisions_dual_approval_ck CHECK (
    (proposal_id IS NULL) = (approved_by_user_id IS NULL)
    AND (approved_by_user_id IS NULL OR approved_by_user_id <> published_by_user_id));
CREATE UNIQUE INDEX policy_revisions_one_per_proposal_ux ON policy_revisions (tenant_id, proposal_id)
  WHERE proposal_id IS NOT NULL;

-- Is `policy_key` named for dual approval by the AUTHORITY revision in force now?
CREATE FUNCTION ub_policy_dual_approval_required(t text, key text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce((
      SELECT jsonb_typeof(r.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') = 'array'
             AND (r.body -> 'separationOfDuties' -> 'dualApprovalPolicyKeys') ? key
        FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
       WHERE r.tenant_id = t AND p.policy_key = 'AUTHORITY' AND r.effective_at <= clock_timestamp()
       ORDER BY r.effective_at DESC, r.revision DESC LIMIT 1), false)
  $$;

CREATE FUNCTION ub_policy_revision_dual_approval_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  key text;
BEGIN
  SELECT p.policy_key INTO key FROM policies p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.policy_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key refuses a missing policy
  END IF;
  -- The revision is inserted first and the proposal is stamped APPROVED with it in the same transaction, so the
  -- guard requires an open proposal for this key by the publisher and a recorded approver who is someone else.
  IF ub_policy_dual_approval_required(NEW.tenant_id, key) AND NOT EXISTS (
       SELECT 1 FROM policy_change_proposals x
        WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.proposal_id AND x.policy_key = key
          AND x.proposed_by_user_id = NEW.published_by_user_id
          AND NEW.approved_by_user_id IS NOT NULL
          AND NEW.approved_by_user_id IS DISTINCT FROM x.proposed_by_user_id
          AND x.decision IS NULL AND x.published_policy_revision_id IS NULL) THEN
    RAISE EXCEPTION 'dual approval required for this policy key' USING ERRCODE = 'UB131';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER policy_revisions_dual_approval_guard BEFORE INSERT ON policy_revisions
  FOR EACH ROW EXECUTE FUNCTION ub_policy_revision_dual_approval_guard();
