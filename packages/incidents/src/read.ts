// Incident read models (API-EVENT-SPEC: GET /v1/incidents, GET /v1/incidents/{incidentId}). Tenant from the server
// context only; a foreign, nonexistent or out-of-site incident is the same audited RESOURCE_UNAVAILABLE. The view
// carries every pinned reference, the authoritative deadline projection (original and current), the current owner and
// the optional risk estimates separately labelled NON_AUTHORITATIVE.
import { UtcInstantSchema, type IncidentState } from '@uptimebuyer/contracts';
import { dbNow, readableSites, tenantCommand, type Db, type TenantContext, type Tx } from '@uptimebuyer/data';
import { z } from 'zod';
import { canRead, isoOf, isoOrNull, loadIncident, ms, parseInput, type IncidentRow } from './internal.js';
import { loadProcedure, toRule, type ProcedureRevisionRecord, type RuleRevisionRecord } from './config.js';

export interface AssignmentView {
  assignmentId: string;
  assigneeUserId: string;
  assignmentKind: 'INITIAL' | 'ASSIGN' | 'HANDOFF';
  assignedBy: { kind: string; id: string };
  assignedAt: string;
  reasonCode: string;
  nextActionDueAt: string | null;
  acceptedAt: string | null;
  supersededAt: string | null;
  supersededByAssignmentId: string | null;
  handoffFromAssignmentId: string | null;
  handoffDigest: string | null;
  incidentVersion: number;
}

export interface IncidentView {
  incidentId: string;
  tenantId: string;
  siteId: string;
  assetId: string;
  assetRevisionId: string;
  ruleRevisionId: string;
  procedureRevisionId: string;
  policyRevisionId: string | null;
  triggerKind: 'TELEMETRY_RULE' | 'MANUAL_REPORT';
  triggerInputOrigin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT' | 'OPERATOR_REPORT';
  state: IncidentState;
  pausedFromState: IncidentState | null;
  version: number;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  faultFamily: string;
  faultWindowKey: string;
  dedupeKey: string;
  signalState: 'LIVE' | 'UNCERTAIN';
  triggerEventAt: string;
  triggerReceivedAt: string;
  openedAt: string;
  openLatencyMs: number;
  deadlineKind: 'RESPONSE' | 'CONTAINMENT';
  deadlineBasis: 'TRIGGER_EVENT_AT' | 'OPENED_AT';
  deadlineBasisAt: string;
  deadlineComputedAt: string;
  deadlineBasisDigest: string;
  deadlineTimezoneBasis: string;
  originalResponseDeadlineAt: string;
  currentResponseDeadlineAt: string;
  deadlineStatus: 'RUNNING' | 'PAUSED' | 'EXPIRED';
  deadlinePausedAt: string | null;
  deadlineExtendedMs: number;
  /** True when the authoritative deadline is EXPIRED or a RUNNING deadline has passed (never "met" by recovery). */
  deadlineOverdue: boolean;
  currentAssignment: AssignmentView | null;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  recoveredAt: string | null;
  reopenCount: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SignalView {
  signalId: string;
  signalKind: 'TELEMETRY_TRIGGER' | 'MANUAL_REPORT' | 'STALE_SIGNAL';
  trust: 'DEVICE_AUTHENTICATED' | 'OPERATOR_ATTESTED' | 'SYSTEM_DERIVED';
  outcome: 'OPENED' | 'ATTACHED' | 'REOPENED';
  inputOrigin: string;
  ruleRevisionId: string | null;
  manualReportId: string | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
  sampleCount: number;
  windowSampleTotal: number;
  channelCount: number;
  peakValueInt: number | null;
  reasonCode: string;
  signalDigest: string;
  actor: { kind: string; id: string };
  recordedAt: string;
  samples: {
    sampleId: string;
    channelId: string;
    channelRevisionId: string;
    calibrationRevision: number;
    deviceAssignmentId: string;
    assetRevisionId: string;
    eventAt: string;
  }[];
}

export interface IncidentTimeline {
  incidentId: string;
  version: number;
  transitions: {
    incidentVersion: number;
    fromState: IncidentState | null;
    toState: IncidentState;
    pausedFromState: IncidentState | null;
    reasonCode: string;
    guardRef: string | null;
    actor: { kind: string; id: string };
    createdAt: string;
  }[];
  signals: SignalView[];
  assignments: AssignmentView[];
  deadlineEvents: {
    sequence: number;
    eventType: 'SET' | 'PAUSE' | 'RESUME' | 'SHORTEN' | 'EXTEND' | 'EXPIRE';
    priorDeadlineAt: string | null;
    newDeadlineAt: string;
    priorStatus: 'RUNNING' | 'PAUSED' | 'EXPIRED' | null;
    newStatus: 'RUNNING' | 'PAUSED' | 'EXPIRED';
    effectiveAt: string;
    procedureRevisionId: string;
    basisDigest: string;
    reasonCode: string;
    authorizedBy: { kind: string; id: string };
    authorizedRole: string | null;
    approvedAt: string;
    incidentVersion: number;
  }[];
  manualReports: {
    manualReportId: string;
    reportKind: 'FAULT_REPORT' | 'REOPEN_EVIDENCE';
    ruleRevisionId: string;
    reportedByUserId: string;
    reasonCode: string;
    note: string | null;
    observedAt: string;
    recordedAt: string;
    reportDigest: string;
    attachments: { ordinal: number; blobId: string; role: string }[];
  }[];
  acknowledgements: { userId: string; incidentVersion: number; acknowledgedAt: string }[];
  riskEstimates: {
    riskEstimateId: string;
    authority: 'NON_AUTHORITATIVE';
    estimateKind: 'FOOD_SAFE_TIME';
    estimatorKind: 'MODEL' | 'RULE' | 'OPERATOR';
    sourceRevision: string;
    asOf: string;
    safeTimeRemainingMs: number;
    lowerBoundMs: number;
    upperBoundMs: number;
    confidencePpm: number;
    provenanceDigest: string;
    recordedBy: { kind: string; id: string };
    recordedAt: string;
  }[];
}

/** Bound on every timeline list (NFR-04); a timeline longer than this is truncated to its newest entries. */
const TIMELINE_LIMIT = 1_000;
/** Bound on linked samples returned with a timeline (each signal links at most 500, linking is incremental). */
const TIMELINE_SAMPLE_LIMIT = 20_000;

function toAssignment(r: Record<string, unknown>): AssignmentView {
  return {
    assignmentId: r.id as string,
    assigneeUserId: r.assignee_user_id as string,
    assignmentKind: r.assignment_kind as AssignmentView['assignmentKind'],
    assignedBy: { kind: r.assigned_by_kind as string, id: r.assigned_by_id as string },
    assignedAt: isoOf(r.assigned_at as Date),
    reasonCode: r.reason_code as string,
    nextActionDueAt: isoOrNull(r.next_action_due_at as Date | null),
    acceptedAt: isoOrNull(r.accepted_at as Date | null),
    supersededAt: isoOrNull(r.superseded_at as Date | null),
    supersededByAssignmentId: (r.superseded_by_assignment_id as string | null) ?? null,
    handoffFromAssignmentId: (r.handoff_from_assignment_id as string | null) ?? null,
    handoffDigest: (r.handoff_digest as string | null) ?? null,
    incidentVersion: r.incident_version as number,
  };
}

async function toView(c: Tx, row: IncidentRow): Promise<IncidentView> {
  let currentAssignment: AssignmentView | null = null;
  if (row.current_assignment_id) {
    const a = await c.query(
      `SELECT * FROM incident_assignments WHERE tenant_id = $1 AND incident_id = $2 AND id = $3`,
      [row.tenant_id, row.id, row.current_assignment_id],
    );
    if (a.rows[0]) currentAssignment = toAssignment(a.rows[0]);
  }
  return {
    incidentId: row.id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    assetId: row.asset_id,
    assetRevisionId: row.asset_revision_id,
    ruleRevisionId: row.rule_revision_id,
    procedureRevisionId: row.procedure_revision_id,
    policyRevisionId: row.policy_revision_id,
    triggerKind: row.trigger_kind,
    triggerInputOrigin: row.trigger_input_origin,
    state: row.state,
    pausedFromState: row.paused_from_state,
    version: row.version,
    urgency: row.urgency,
    faultFamily: row.fault_family,
    faultWindowKey: row.fault_window_key,
    dedupeKey: row.dedupe_key,
    signalState: row.signal_state,
    triggerEventAt: isoOf(row.trigger_event_at),
    triggerReceivedAt: isoOf(row.trigger_received_at),
    openedAt: isoOf(row.opened_at),
    openLatencyMs: Number(row.open_latency_ms),
    deadlineKind: row.deadline_kind,
    deadlineBasis: row.deadline_basis,
    deadlineBasisAt: isoOf(row.deadline_basis_at),
    deadlineComputedAt: isoOf(row.deadline_computed_at),
    deadlineBasisDigest: row.deadline_basis_digest,
    deadlineTimezoneBasis: row.deadline_timezone_basis,
    originalResponseDeadlineAt: isoOf(row.original_response_deadline_at),
    currentResponseDeadlineAt: isoOf(row.current_response_deadline_at),
    deadlineStatus: row.deadline_status,
    deadlinePausedAt: isoOrNull(row.deadline_paused_at),
    deadlineExtendedMs: Number(row.deadline_extended_ms),
    deadlineOverdue:
      row.deadline_status === 'EXPIRED' ||
      (row.deadline_status === 'RUNNING' && row.current_response_deadline_at.getTime() <= ms(await dbNow(c))),
    currentAssignment,
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    acknowledgedByUserId: row.acknowledged_by_user_id,
    recoveredAt: isoOrNull(row.recovered_at),
    reopenCount: row.reopen_count,
    correlationId: row.correlation_id,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

/** One incident projection (human roles at its site, or the engine worker). */
export async function getIncident(pool: Db, ctx: TenantContext, incidentId: string): Promise<IncidentView> {
  const meta = { action: 'incident.read', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) =>
    toView(c, await loadIncident(c, ctx, meta, incidentId, { action: null, lock: null })),
  );
}

const ListSchema = z.strictObject({
  siteId: z.string().max(128).optional(),
  assetId: z.string().max(128).optional(),
  states: z
    .array(z.string().regex(/^[A-Z_]{1,32}$/))
    .max(11)
    .optional(),
  activeOnly: z.boolean().optional(),
  limit: z.int().min(1).max(500).optional(),
  after: z.strictObject({ openedAt: UtcInstantSchema, incidentId: z.string().max(128) }).optional(),
});

/** Incidents visible to the caller, newest first, keyset-paginated by (opened_at, id). */
export async function listIncidents(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof ListSchema>,
): Promise<IncidentView[]> {
  const input = parseInput(ListSchema, raw);
  const meta = { action: 'incident.list', resourceType: 'incident', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const engine = ctx.principal.kind === 'SERVICE' || ctx.principal.kind === 'WORKER';
    let sites: string[] | null = null;
    if (engine) {
      if (!canRead(ctx, '')) return [];
    } else sites = readableSites(ctx);
    if (sites !== null && sites.length === 0) return [];
    const { rows } = await c.query<IncidentRow>(
      `SELECT * FROM incidents
        WHERE tenant_id = $1 AND ($2::text[] IS NULL OR site_id = ANY($2))
          AND ($3::text IS NULL OR site_id = $3) AND ($4::text IS NULL OR asset_id = $4)
          AND ($5::text[] IS NULL OR state = ANY($5)) AND (NOT $6 OR state <> 'RECOVERED')
          AND ($7::timestamptz IS NULL OR (opened_at, id) < ($7, $8))
        ORDER BY opened_at DESC, id DESC LIMIT $9`,
      [
        ctx.tenantId,
        sites,
        input.siteId ?? null,
        input.assetId ?? null,
        input.states ?? null,
        input.activeOnly ?? false,
        input.after?.openedAt ?? null,
        input.after?.incidentId ?? null,
        input.limit ?? 100,
      ],
    );
    const out: IncidentView[] = [];
    for (const r of rows) out.push(await toView(c, r));
    return out;
  });
}

/** Full append-only history of one incident (bounded per list). */
export async function getIncidentTimeline(pool: Db, ctx: TenantContext, incidentId: string): Promise<IncidentTimeline> {
  const meta = { action: 'incident.read', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const row = await loadIncident(c, ctx, meta, incidentId, { action: null, lock: null });
    const q = (sql: string) => c.query(sql, [ctx.tenantId, row.id, TIMELINE_LIMIT]).then((r) => r.rows);
    const transitions = await q(
      `SELECT * FROM (SELECT * FROM incident_transitions WHERE tenant_id = $1 AND incident_id = $2
         ORDER BY incident_version DESC LIMIT $3) x ORDER BY incident_version`,
    );
    const signals = await q(
      `SELECT * FROM (SELECT * FROM incident_signals WHERE tenant_id = $1 AND incident_id = $2
         ORDER BY recorded_at DESC, id DESC LIMIT $3) x ORDER BY recorded_at, id`,
    );
    const samples = await c.query(
      `SELECT * FROM incident_signal_samples WHERE tenant_id = $1 AND signal_id = ANY($2) ORDER BY signal_id, ordinal LIMIT $3`,
      [ctx.tenantId, signals.map((s) => s.id), TIMELINE_SAMPLE_LIMIT],
    );
    const bySignal = new Map<string, SignalView['samples']>();
    for (const s of samples.rows) {
      const list = bySignal.get(s.signal_id) ?? [];
      list.push({
        sampleId: s.sample_id,
        channelId: s.channel_id,
        channelRevisionId: s.channel_revision_id,
        calibrationRevision: s.calibration_revision,
        deviceAssignmentId: s.device_assignment_id,
        assetRevisionId: s.asset_revision_id,
        eventAt: isoOf(s.event_at),
      });
      bySignal.set(s.signal_id, list);
    }
    const assignments = await q(
      `SELECT * FROM incident_assignments WHERE tenant_id = $1 AND incident_id = $2 ORDER BY incident_version, assigned_at LIMIT $3`,
    );
    const deadlineEvents = await q(
      `SELECT * FROM incident_deadline_events WHERE tenant_id = $1 AND incident_id = $2 ORDER BY sequence LIMIT $3`,
    );
    const reports = await q(
      `SELECT * FROM incident_manual_reports WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recorded_at, id LIMIT $3`,
    );
    const attachments = await c.query(
      `SELECT * FROM incident_manual_report_attachments WHERE tenant_id = $1 AND report_id = ANY($2) ORDER BY report_id, ordinal`,
      [ctx.tenantId, reports.map((r) => r.id)],
    );
    const acks = await q(
      `SELECT * FROM incident_acknowledgements WHERE tenant_id = $1 AND incident_id = $2 ORDER BY incident_version LIMIT $3`,
    );
    const risks = await q(
      `SELECT * FROM incident_risk_estimates WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recorded_at, id LIMIT $3`,
    );
    return {
      incidentId: row.id,
      version: row.version,
      transitions: transitions.map((t) => ({
        incidentVersion: t.incident_version,
        fromState: t.from_state,
        toState: t.to_state,
        pausedFromState: t.paused_from_state,
        reasonCode: t.reason_code,
        guardRef: t.guard_ref,
        actor: { kind: t.actor_kind, id: t.actor_id },
        createdAt: isoOf(t.created_at),
      })),
      signals: signals.map((s) => ({
        signalId: s.id,
        signalKind: s.signal_kind,
        trust: s.trust,
        outcome: s.outcome,
        inputOrigin: s.input_origin,
        ruleRevisionId: s.rule_revision_id,
        manualReportId: s.manual_report_id,
        windowStartAt: isoOrNull(s.window_start_at),
        windowEndAt: isoOrNull(s.window_end_at),
        sampleCount: s.sample_count,
        windowSampleTotal: s.window_sample_total,
        channelCount: s.channel_count,
        peakValueInt: s.peak_value_int === null ? null : Number(s.peak_value_int),
        reasonCode: s.reason_code,
        signalDigest: s.signal_digest,
        actor: { kind: s.actor_kind, id: s.actor_id },
        recordedAt: isoOf(s.recorded_at),
        samples: bySignal.get(s.id) ?? [],
      })),
      assignments: assignments.map(toAssignment),
      deadlineEvents: deadlineEvents.map((d) => ({
        sequence: d.sequence,
        eventType: d.event_type,
        priorDeadlineAt: isoOrNull(d.prior_deadline_at),
        newDeadlineAt: isoOf(d.new_deadline_at),
        priorStatus: d.prior_status,
        newStatus: d.new_status,
        effectiveAt: isoOf(d.effective_at),
        procedureRevisionId: d.procedure_revision_id,
        basisDigest: d.basis_digest,
        reasonCode: d.reason_code,
        authorizedBy: { kind: d.authorized_by_kind, id: d.authorized_by_id },
        authorizedRole: d.authorized_role,
        approvedAt: isoOf(d.approved_at),
        incidentVersion: d.incident_version,
      })),
      manualReports: reports.map((r) => ({
        manualReportId: r.id,
        reportKind: r.report_kind,
        ruleRevisionId: r.rule_revision_id,
        reportedByUserId: r.reported_by_user_id,
        reasonCode: r.reason_code,
        note: r.note,
        observedAt: isoOf(r.observed_at),
        recordedAt: isoOf(r.recorded_at),
        reportDigest: r.report_digest,
        attachments: attachments.rows
          .filter((a) => a.report_id === r.id)
          .map((a) => ({ ordinal: a.ordinal, blobId: a.blob_id, role: a.role })),
      })),
      acknowledgements: acks.map((a) => ({
        userId: a.user_id,
        incidentVersion: a.incident_version,
        acknowledgedAt: isoOf(a.acknowledged_at),
      })),
      riskEstimates: risks.map((r) => ({
        riskEstimateId: r.id,
        authority: r.authority,
        estimateKind: r.estimate_kind,
        estimatorKind: r.estimator_kind,
        sourceRevision: r.source_revision,
        asOf: isoOf(r.as_of),
        safeTimeRemainingMs: Number(r.safe_time_remaining_ms),
        lowerBoundMs: Number(r.lower_bound_ms),
        upperBoundMs: Number(r.upper_bound_ms),
        confidencePpm: r.confidence_ppm,
        provenanceDigest: r.provenance_digest,
        recordedBy: { kind: r.recorded_by_kind, id: r.recorded_by_id },
        recordedAt: isoOf(r.recorded_at),
      })),
    };
  });
}

/**
 * The incident's pinned operating procedure and incident-rule revisions (M12 operator surface, additive). These are
 * the revisions pinned at opening; a later publication never changes what this returns (UI-SPEC §8.0).
 */
export async function getIncidentPins(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
): Promise<{ procedure: ProcedureRevisionRecord; rule: RuleRevisionRecord }> {
  const meta = { action: 'incident.read', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const row = await loadIncident(c, ctx, meta, incidentId, { action: null, lock: null });
    const rule = await c.query(`SELECT * FROM incident_rule_revisions WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      row.rule_revision_id,
    ]);
    return { procedure: await loadProcedure(c, ctx.tenantId, row.procedure_revision_id), rule: toRule(rule.rows[0]!) };
  });
}
