// Incident command view (FR-19, UI-SPEC §7-8.0): register, revisioned projection with the pinned SOP procedure,
// append-only timeline (transitions, assignments, deadline events), same-tenant assignable members, and the
// versioned commands assign / accept / handoff / adjust-deadline / escalate / acknowledge. Commands take the expected
// aggregate version from If-Match and the Idempotency-Key header; a stale version is the command's own 409
// VERSION_CONFLICT carrying currentVersion, so the client reloads instead of overwriting (UI-SPEC §8.0).
import {
  AdjustDeadlineBodySchema,
  AssignIncidentBodySchema,
  EmptyBodySchema,
  EscalateIncidentBodySchema,
  HandoffIncidentBodySchema,
  ListIncidentsQuerySchema,
} from '@uptimebuyer/contracts/api';
import { authorize, listAssignableMembers, type TenantContext } from '@uptimebuyer/data';
import {
  acceptAssignment,
  acknowledgeIncident,
  adjustIncidentDeadline,
  assignIncident,
  escalateIncident,
  getIncident,
  getIncidentPins,
  getIncidentTimeline,
  handoffIncident,
  listIncidents,
  type IncidentView,
  type ProcedureRevisionRecord,
} from '@uptimebuyer/incidents';
import type { FastifyInstance } from 'fastify';
import { ctxOf, type RouteDeps } from '../app.js';
import { body, commandTarget, expectedVersion, idempotencyKey, notFound, query } from '../http.js';

const ACTIVE = new Set([
  'DETECTED',
  'TRIAGING',
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
]);
type Availability = { allowed: boolean; reasonCode: string | null };
const ok: Availability = { allowed: true, reasonCode: null };
const no = (reasonCode: string): Availability => ({ allowed: false, reasonCode });

/**
 * What this principal may attempt now, with the blocking reason for each disabled command (UI-SPEC §11: a disabled
 * action explains itself). Advisory only: every command re-authorizes and re-checks state on the server.
 */
export function commandAvailability(
  ctx: TenantContext,
  inc: IncidentView,
  procedure: ProcedureRevisionRecord,
): Record<string, Availability> {
  const me = ctx.principal.kind === 'HUMAN' ? ctx.principal.id : null;
  const manage = authorize(ctx, { action: 'incident.manage', siteId: inc.siteId as never });
  const ack = authorize(ctx, { action: 'incident.acknowledge', siteId: inc.siteId as never });
  const adjustRole = ctx.grants.some(
    (g) => g.role === procedure.adjustRole && (g.siteId === null || g.siteId === inc.siteId),
  );
  const cur = inc.currentAssignment;
  const recovered = inc.state === 'RECOVERED';
  const denied = (d: ReturnType<typeof authorize>) => (d.allowed ? null : no(d.reasonCode));
  return {
    acknowledge: denied(ack) ?? (inc.acknowledgedAt ? no('ALREADY_ACKNOWLEDGED') : ok),
    assign: denied(manage) ?? (recovered ? no('INCIDENT_RECOVERED') : ok),
    accept: !cur
      ? no('NO_CURRENT_ASSIGNMENT')
      : cur.assigneeUserId !== me
        ? no('NOT_ASSIGNEE')
        : cur.acceptedAt
          ? no('ASSIGNMENT_ALREADY_ACCEPTED')
          : ok,
    handoff:
      denied(manage) ??
      (!cur || cur.assigneeUserId !== me || !cur.acceptedAt
        ? no('NOT_ACCEPTED_OWNER')
        : recovered
          ? no('INCIDENT_RECOVERED')
          : ok),
    escalate: denied(manage) ?? (ACTIVE.has(inc.state) ? ok : no('STATE_NOT_ESCALATABLE')),
    deadlinePause:
      denied(manage) ??
      (!procedure.pauseAllowed
        ? no('PROCEDURE_PAUSE_NOT_ALLOWED')
        : !adjustRole
          ? no('PROCEDURE_ROLE_REQUIRED')
          : inc.deadlineStatus !== 'RUNNING'
            ? no(`DEADLINE_${inc.deadlineStatus}`)
            : ok),
    deadlineResume: denied(manage) ?? (inc.deadlineStatus !== 'PAUSED' ? no('DEADLINE_NOT_PAUSED') : ok),
    deadlineShorten: denied(manage) ?? (inc.deadlineStatus === 'EXPIRED' ? no('DEADLINE_EXPIRED') : ok),
    deadlineExtend:
      denied(manage) ??
      (procedure.maxExtensionMs <= 0
        ? no('PROCEDURE_EXTENSION_NOT_ALLOWED')
        : !adjustRole
          ? no('PROCEDURE_ROLE_REQUIRED')
          : inc.deadlineStatus === 'EXPIRED'
            ? no('DEADLINE_EXPIRED')
            : ok),
  };
}

const procedureWire = (p: ProcedureRevisionRecord) => ({
  procedureRevisionId: p.procedureRevisionId,
  procedureKey: p.procedureKey,
  revision: p.revision,
  deadlineKind: p.deadlineKind,
  deadlineBasis: p.deadlineBasis,
  responseDeadlineMs: p.responseDeadlineMs,
  pauseAllowed: p.pauseAllowed,
  maxExtensionMs: p.maxExtensionMs,
  adjustRole: p.adjustRole,
  timezoneBasis: p.timezoneBasis,
  effectiveAt: p.effectiveAt,
});

const VERBS = ['acknowledge', 'assign', 'handoff', 'adjust-deadline', 'escalate'] as const;

export function registerIncidentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/v1/incidents', async (req) => {
    const ctx = ctxOf(req);
    const q = query(req, ListIncidentsQuerySchema);
    const incidents = await listIncidents(deps.pool, ctx, {
      ...(q.siteId ? { siteId: q.siteId } : {}),
      ...(q.activeOnly ? { activeOnly: q.activeOnly === 'true' } : {}),
      ...(q.states ? { states: q.states.split(',') as never } : {}),
      limit: q.limit ? Math.min(Number(q.limit), 500) : 100,
    });
    return { incidents };
  });

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId', async (req) => {
    const ctx = ctxOf(req);
    const incident = await getIncident(deps.pool, ctx, req.params.incidentId);
    const pins = await getIncidentPins(deps.pool, ctx, incident.incidentId);
    return {
      incident,
      procedure: procedureWire(pins.procedure),
      commands: commandAvailability(ctx, incident, pins.procedure),
    };
  });

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/timeline', async (req) =>
    getIncidentTimeline(deps.pool, ctxOf(req), req.params.incidentId),
  );

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/assignable-members', async (req) => {
    const ctx = ctxOf(req);
    const incident = await getIncident(deps.pool, ctx, req.params.incidentId);
    return { members: await listAssignableMembers(deps.pool, ctx, { siteId: incident.siteId }) };
  });

  // POST /v1/incidents/{incidentId}:{verb}
  app.post<{ Params: { target: string } }>('/v1/incidents/:target', async (req) => {
    const t = commandTarget(req.params.target, VERBS);
    if (!t) throw notFound();
    const ctx = ctxOf(req);
    const base = { expectedVersion: expectedVersion(req), idempotencyKey: idempotencyKey(req) };
    switch (t.verb) {
      case 'acknowledge':
        body(req, EmptyBodySchema);
        return acknowledgeIncident(deps.pool, ctx, t.id, base);
      case 'assign': {
        const b = body(req, AssignIncidentBodySchema);
        return assignIncident(deps.pool, ctx, t.id, {
          ...base,
          assigneeUserId: b.assigneeUserId,
          reasonCode: b.reasonCode,
          ...(b.nextActionDueAt ? { nextActionDueAt: b.nextActionDueAt } : {}),
        });
      }
      case 'handoff': {
        const b = body(req, HandoffIncidentBodySchema);
        return handoffIncident(deps.pool, ctx, t.id, { ...base, ...b });
      }
      case 'adjust-deadline': {
        const b = body(req, AdjustDeadlineBodySchema);
        return adjustIncidentDeadline(deps.pool, ctx, t.id, {
          ...base,
          eventType: b.eventType,
          reasonCode: b.reasonCode,
          ...(b.newDeadlineAt ? { newDeadlineAt: b.newDeadlineAt } : {}),
        });
      }
      case 'escalate':
        return escalateIncident(deps.pool, ctx, t.id, { ...base, ...body(req, EscalateIncidentBodySchema) });
    }
  });

  // POST /v1/incidents/{incidentId}/assignments/{assignmentId}:accept
  app.post<{ Params: { incidentId: string; target: string } }>(
    '/v1/incidents/:incidentId/assignments/:target',
    async (req) => {
      const t = commandTarget(req.params.target, ['accept'] as const);
      if (!t) throw notFound();
      const ctx = ctxOf(req);
      body(req, EmptyBodySchema);
      return acceptAssignment(deps.pool, ctx, req.params.incidentId, t.id, {
        expectedVersion: expectedVersion(req),
        idempotencyKey: idempotencyKey(req),
      });
    },
  );
}
