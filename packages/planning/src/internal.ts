// Shared persistence helpers for M08: identifiers, typed errors, actor fields, the planning lock and the incident
// row (only its deadline projection columns are planning inputs; the procedure table is never read).
import { randomUUID } from 'node:crypto';
import { DomainError, type UtcInstant } from '@uptimebuyer/contracts';
import { actorOf, unavailable, type CommandMeta, type TenantContext, type Tx } from '@uptimebuyer/data';

export const PLANNING_ID_PREFIXES = Object.freeze({
  plan: 'pln',
  planAction: 'pla',
  planTransition: 'plt',
  approvalRequest: 'apq',
  riskEstimate: 'tre',
} as const);
export const newPlanningId = (kind: keyof typeof PLANNING_ID_PREFIXES) =>
  `${PLANNING_ID_PREFIXES[kind]}_${randomUUID()}`;

export const hold = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('POLICY_HOLD', 'Planning holds this request.', { reasonCode, ...details });
export const invalid = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode, ...details });

export const isoOf = (d: Date | string | null | undefined): UtcInstant | null =>
  d === null || d === undefined ? null : (new Date(d).toISOString() as UtcInstant);

export function actorFields(ctx: TenantContext): { kind: 'HUMAN' | 'SERVICE' | 'WORKER'; id: string } {
  const a = actorOf(ctx);
  const kind = ctx.principal.kind === 'WORKER' ? 'WORKER' : ctx.principal.kind === 'HUMAN' ? 'HUMAN' : 'SERVICE';
  return { kind, id: String(a.id).slice(0, 128) };
}

/** Serializes plan creation, revalidation and approval-request preparation per incident. */
export const planningLock = (tenantId: string, incidentId: string) => `planning:${tenantId}:${incidentId}`;

/** Open (non-terminal) plan states that a bound-input change invalidates. HELD/REJECTED/COMPLETED are terminal. */
export const OPEN_PLAN_STATES = Object.freeze(['DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING'] as const);

export interface IncidentRow {
  id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  procedure_revision_id: string;
  state: string;
  current_response_deadline_at: Date;
  deadline_status: 'RUNNING' | 'PAUSED' | 'EXPIRED';
  deadline_event_sequence: number | null;
  deadline_event_at: Date | null;
}

/** The incident and its deadline projection (current_response_deadline_at + latest authorized deadline event). */
export async function loadIncident(
  c: Tx,
  tenantId: string,
  incidentId: string,
  meta: CommandMeta,
  opts: { lock?: boolean } = {},
): Promise<IncidentRow> {
  const { rows } = await c.query<IncidentRow>(
    `SELECT i.id, i.site_id, i.asset_id, i.asset_revision_id, i.procedure_revision_id, i.state,
            i.current_response_deadline_at, i.deadline_status,
            (SELECT max(e.sequence) FROM incident_deadline_events e WHERE e.tenant_id = i.tenant_id AND e.incident_id = i.id)
              AS deadline_event_sequence,
            (SELECT e.created_at FROM incident_deadline_events e WHERE e.tenant_id = i.tenant_id AND e.incident_id = i.id
              ORDER BY e.sequence DESC LIMIT 1) AS deadline_event_at
       FROM incidents i WHERE i.tenant_id = $1 AND i.id = $2 ${opts.lock ? 'FOR SHARE OF i' : ''}`,
    [tenantId, String(incidentId)],
  );
  if (!rows[0]) throw unavailable(meta, String(incidentId), 'incident');
  return rows[0];
}

/** Strict reference id shape check (bounded length) before any lookup. */
export const refOk = (prefix: string, v: unknown): v is string =>
  typeof v === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$`).test(v);
