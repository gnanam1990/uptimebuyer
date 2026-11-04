// Deadline ledger persistence shared by the deadline commands, the expiry sweep and reopen: replay the stored
// ledger, refuse drift between ledger and projection, plan the next event under the incident's PINNED procedure,
// update the projection under the version compare-and-set and append the event and its outbox record.
import { DomainError } from '@uptimebuyer/contracts';
import type { TenantContext, Tx } from '@uptimebuyer/data';
import { loadProcedure } from './config.js';
import { planDeadlineEvent, replayDeadlineEvents, type DeadlineEventRecord } from './deadline.js';
import { actorFor, bumpRow, emit, isoOf, ms, newIncidentDataId, type IncidentRow } from './internal.js';

interface DeadlineRow {
  sequence: number;
  event_type: DeadlineEventRecord['eventType'];
  prior_deadline_at: Date | null;
  new_deadline_at: Date;
  prior_status: DeadlineEventRecord['priorStatus'];
  new_status: DeadlineEventRecord['newStatus'];
  effective_at: Date;
}

export async function loadDeadlineEvents(c: Tx, tenantId: string, incidentId: string): Promise<DeadlineEventRecord[]> {
  const { rows } = await c.query<DeadlineRow>(
    `SELECT sequence, event_type, prior_deadline_at, new_deadline_at, prior_status, new_status, effective_at
       FROM incident_deadline_events WHERE tenant_id = $1 AND incident_id = $2 ORDER BY sequence`,
    [tenantId, incidentId],
  );
  return rows.map((r) => ({
    sequence: r.sequence,
    eventType: r.event_type,
    priorDeadlineAt: r.prior_deadline_at ? isoOf(r.prior_deadline_at) : null,
    newDeadlineAt: isoOf(r.new_deadline_at),
    priorStatus: r.prior_status,
    newStatus: r.new_status,
    effectiveAt: isoOf(r.effective_at),
  }));
}

/** Plan, append and project one deadline event under the pinned procedure (shared by commands and the sweep). */
export async function appendDeadlineEvent(
  c: Tx,
  ctx: TenantContext,
  row: IncidentRow,
  cmd: {
    eventType: 'PAUSE' | 'RESUME' | 'SHORTEN' | 'EXTEND' | 'EXPIRE';
    newDeadlineAt?: string;
    reasonCode: string;
    effectiveAt: string;
    role: string | null;
  },
): Promise<IncidentRow> {
  const procedure = await loadProcedure(c, ctx.tenantId, row.procedure_revision_id);
  const events = await loadDeadlineEvents(c, ctx.tenantId, row.id);
  const projection = replayDeadlineEvents(events);
  // The stored projection must equal the ledger before anything is appended (no silent drift).
  if (
    ms(projection.currentDeadlineAt) !== ms(row.current_response_deadline_at) ||
    projection.status !== row.deadline_status ||
    ms(projection.originalDeadlineAt) !== ms(row.original_response_deadline_at)
  )
    throw new DomainError('EVIDENCE_APPEND_INVALID', 'The deadline projection does not match its ledger.', {
      reasonCode: 'DEADLINE_PROJECTION_DRIFT',
    });
  const planned = planDeadlineEvent(
    projection,
    {
      eventType: cmd.eventType,
      effectiveAt: cmd.effectiveAt,
      ...(cmd.newDeadlineAt !== undefined ? { newDeadlineAt: cmd.newDeadlineAt } : {}),
    },
    { pauseAllowed: procedure.pauseAllowed, maxExtensionMs: procedure.maxExtensionMs },
  );
  const extendedDelta = cmd.eventType === 'EXTEND' ? ms(planned.newDeadlineAt) - ms(planned.priorDeadlineAt) : 0;
  const updated = await bumpRow(
    c,
    ctx,
    row,
    `current_response_deadline_at = $4, deadline_status = $5, deadline_paused_at = $6,
     deadline_extended_ms = deadline_extended_ms + $7`,
    [planned.newDeadlineAt, planned.newStatus, planned.newStatus === 'PAUSED' ? cmd.effectiveAt : null, extendedDelta],
  );
  const actor = actorFor(ctx);
  const sequence = events.length + 1;
  await c.query(
    `INSERT INTO incident_deadline_events (tenant_id, id, incident_id, sequence, event_type, prior_deadline_at,
       new_deadline_at, prior_status, new_status, effective_at, procedure_revision_id, basis_digest, reason_code,
       authorized_by_kind, authorized_by_id, authorized_role, approved_at, incident_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $10, $17)`,
    [
      ctx.tenantId,
      newIncidentDataId('deadlineEvent'),
      row.id,
      sequence,
      cmd.eventType,
      planned.priorDeadlineAt,
      planned.newDeadlineAt,
      planned.priorStatus,
      planned.newStatus,
      cmd.effectiveAt,
      row.procedure_revision_id,
      row.deadline_basis_digest,
      cmd.reasonCode,
      actor.kind,
      actor.id,
      cmd.role,
      updated.version,
    ],
  );
  await emit(c, ctx, updated, 'incident.deadline_changed.v1', {
    incidentId: row.id,
    sequence,
    eventType: cmd.eventType,
    priorDeadlineAt: planned.priorDeadlineAt,
    newDeadlineAt: planned.newDeadlineAt,
    originalDeadlineAt: isoOf(row.original_response_deadline_at),
    newStatus: planned.newStatus,
    procedureRevisionId: row.procedure_revision_id,
    reasonCode: cmd.reasonCode,
  });
  return updated;
}
