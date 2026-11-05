-- M13 security review S6: separation of duties for budget adjustments is decided on the authority the adjustment
-- produces. Under a spend rule covering the authority's currency, an AUTHORITY_CREDIT whose amount OR resulting
-- effective limit reaches the threshold must be signed (its BUDGET_ADJUSTMENT approval) by someone who is neither the
-- plan approval's actor nor the authority's issuer. NULL-safe per ADR 0004 (IS [NOT] DISTINCT FROM; a missing
-- adjustment approval is refused). SQLSTATE UB130.
CREATE FUNCTION ub_budget_credit_sod_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  f record;
BEGIN
  IF NEW.movement_type IS DISTINCT FROM 'AUTHORITY_CREDIT' THEN
    RETURN NEW;
  END IF;
  SELECT ba.effective_limit_minor, x.policy_revision_id, x.currency, x.issued_by_kind, x.issued_by_id,
         pa.actor_user_id AS plan_actor, adj.actor_user_id AS adjustment_actor
    INTO f
    FROM budget_accounts ba
    JOIN execution_authorities x ON x.tenant_id = ba.tenant_id AND x.id = ba.execution_authority_id
    JOIN approvals pa ON pa.tenant_id = x.tenant_id AND pa.id = x.approval_id
    LEFT JOIN approvals adj ON adj.tenant_id = NEW.tenant_id AND adj.id = NEW.approval_id
   WHERE ba.tenant_id = NEW.tenant_id AND ba.id = NEW.budget_account_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key refuses a missing account
  END IF;
  IF ub_spend_sod_required(NEW.tenant_id, f.policy_revision_id, f.currency,
                           greatest(NEW.amount_minor, f.effective_limit_minor + NEW.amount_minor))
     AND (f.adjustment_actor IS NULL
          OR f.adjustment_actor IS NOT DISTINCT FROM f.plan_actor
          OR (f.issued_by_kind IS NOT DISTINCT FROM 'HUMAN' AND f.adjustment_actor IS NOT DISTINCT FROM f.issued_by_id)) THEN
    RAISE EXCEPTION 'separation of duties: the adjustment must be approved by an uninvolved person' USING ERRCODE = 'UB130';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_ledger_entries_sod_guard BEFORE INSERT ON budget_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ub_budget_credit_sod_guard();
