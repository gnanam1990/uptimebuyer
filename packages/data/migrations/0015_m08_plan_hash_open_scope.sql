-- M08 security-review forward fix (INV-03 liveness): a plan hash is unique per incident among plans that are not
-- INVALIDATED. An invalidated revision keeps its hash for lineage, but no longer blocks a fresh revision with the
-- same inputs (e.g. a candidate set planned again after another set superseded it). Approval requests still bind
-- (plan_id, plan_hash), so a request can never float from the invalidated revision to the new one.
ALTER TABLE recovery_plans DROP CONSTRAINT recovery_plans_tenant_id_incident_id_plan_hash_key;
CREATE UNIQUE INDEX recovery_plans_live_hash_ux ON recovery_plans (tenant_id, incident_id, plan_hash)
  WHERE state <> 'INVALIDATED';
