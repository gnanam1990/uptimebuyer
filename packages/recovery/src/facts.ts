// Read-only facts the recovery engine derives from other modules' durable state inside its own transaction: the
// incident's approved, live actions (M10 orders/jobs of its executing or completed M08 plan, never a no-effect or
// terminal-failure lineage), when the current recovery cycle started and when it entered execution.
import type { Tx } from '@uptimebuyer/data';

export interface ApprovedAction {
  order_kind: 'PURCHASE_ORDER' | 'SERVICE_JOB';
  order_id: string;
  plan_id: string;
  plan_hash: string;
  plan_state: string;
  plan_action_id: string;
  action_digest: string;
  action_kind: string;
  candidate_action_id: string;
  part_manufacturer: string | null;
  part_number: string | null;
  order_state: string;
  commercial_intent_id: string;
  economic_state: string;
  approved_amount_minor: string;
  currency: string;
}

export async function approvedActions(c: Tx, tenantId: string, incidentId: string): Promise<ApprovedAction[]> {
  const { rows } = await c.query<ApprovedAction>(
    `SELECT o.order_kind, o.id AS order_id, o.plan_id, p.plan_hash, p.state AS plan_state, o.plan_action_id,
            o.action_digest, pa.action_kind, o.candidate_action_id, ca.manufacturer AS part_manufacturer,
            ca.part_number, o.state AS order_state, o.commercial_intent_id, ci.state AS economic_state,
            o.approved_amount_minor::text, o.currency
       FROM (
         SELECT 'PURCHASE_ORDER' AS order_kind, id, tenant_id, incident_id, plan_id, plan_action_id, candidate_action_id,
                action_digest, state, commercial_intent_id, approved_amount_minor, currency, no_effect_proven_at, created_at
           FROM purchase_orders WHERE tenant_id = $1 AND incident_id = $2
         UNION ALL
         SELECT 'SERVICE_JOB', id, tenant_id, incident_id, plan_id, plan_action_id, candidate_action_id,
                action_digest, state, commercial_intent_id, approved_amount_minor, currency, no_effect_proven_at, created_at
           FROM service_jobs WHERE tenant_id = $1 AND incident_id = $2
       ) o
       JOIN recovery_plans p ON p.tenant_id = o.tenant_id AND p.id = o.plan_id AND p.incident_id = o.incident_id
       JOIN plan_actions pa ON pa.tenant_id = o.tenant_id AND pa.plan_id = o.plan_id AND pa.id = o.plan_action_id
       JOIN candidate_actions ca ON ca.tenant_id = o.tenant_id AND ca.id = o.candidate_action_id
       JOIN commercial_intents ci ON ci.tenant_id = o.tenant_id AND ci.id = o.commercial_intent_id
      WHERE o.no_effect_proven_at IS NULL AND o.state NOT IN ('REJECTED', 'CANCELLED', 'FAILED')
        AND p.state IN ('EXECUTING', 'COMPLETED')
      ORDER BY o.created_at, o.id`,
    [tenantId, incidentId],
  );
  return rows;
}

/** Start of the current recovery cycle: the latest RECOVERED -> REOPENED transition (epoch for cycle 0). */
export async function cycleStart(c: Tx, tenantId: string, incidentId: string): Promise<Date> {
  const { rows } = await c.query<{ at: Date | null }>(
    `SELECT max(created_at) AS at FROM incident_transitions
      WHERE tenant_id = $1 AND incident_id = $2 AND to_state = 'REOPENED'`,
    [tenantId, incidentId],
  );
  return rows[0]?.at ?? new Date(0);
}

/** When the current cycle first entered EXECUTING (null if it never did). */
export async function executingSince(c: Tx, tenantId: string, incidentId: string): Promise<Date | null> {
  const { rows } = await c.query<{ at: Date | null }>(
    `SELECT min(t.created_at) AS at FROM incident_transitions t
      WHERE t.tenant_id = $1 AND t.incident_id = $2 AND t.to_state = 'EXECUTING'
        AND t.incident_version > coalesce((SELECT max(r.incident_version) FROM incident_transitions r
                                            WHERE r.tenant_id = $1 AND r.incident_id = $2 AND r.to_state = 'REOPENED'), 0)`,
    [tenantId, incidentId],
  );
  return rows[0]?.at ?? null;
}

export async function disputedIds(c: Tx, tenantId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await c.query<{ evidence_id: string }>(
    `SELECT evidence_id FROM recovery_evidence_disputes WHERE tenant_id = $1 AND evidence_id = ANY($2::text[])`,
    [tenantId, ids],
  );
  return new Set(rows.map((r) => r.evidence_id));
}

/** Active CMMS integrations (not revoked) and their sites. */
export async function activeIntegrations(c: Tx, tenantId: string): Promise<Map<string, string>> {
  const { rows } = await c.query<{ id: string; site_id: string }>(
    `SELECT id, site_id FROM cmms_integrations WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId],
  );
  return new Map(rows.map((r) => [r.id, r.site_id]));
}
