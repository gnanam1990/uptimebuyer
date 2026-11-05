// The incident engine (FR-03, FR-04, INV-09, INV-11, NFR-03, NFR-08). Triggers — a qualifying LIVE telemetry window
// or an authorized manual report — converge on ONE active incident per tenant/site/asset/fault window. Convergence is
// decided by the database: the dedupe key is a generated column and `incidents_one_active_ux` is a partial unique
// index; an insert that loses the race does nothing and the trigger re-reads and appends to the winner. A trigger on
// a RECOVERED incident inside its pinned watch window reopens it (RECOVERED -> REOPENED -> TRIAGING) instead of
// inserting. Opening pins every revision, the procedure, the deadline basis and the initial owner in one transaction.
import {
  AssetIdSchema,
  UtcInstantSchema,
  type AssetId,
  type DomainEventEnvelope,
  type IncidentId,
} from '@uptimebuyer/contracts';
import {
  appendOperatorEvidence,
  appendSystemEvidence,
  authorize,
  consumeOnce,
  dbNow,
  pgCode,
  recordAudit,
  tenantCommand,
  unavailable,
  UNIQUE_VIOLATION,
  versionConflict,
  type CommandMeta,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { TelemetryAcceptedEventSchema, TelemetryStaleEventSchema } from '@uptimebuyer/telemetry';
import { z } from 'zod';
import {
  effectiveProcedure,
  effectiveRulesForAsset,
  toRule,
  type ProcedureRevisionRecord,
  type RuleRevisionRecord,
} from './config.js';
import { computeOriginalDeadline } from './deadline.js';
import { appendDeadlineEvent } from './deadline-store.js';
import {
  actorFor,
  bumpRow,
  deny,
  emit,
  isoOf,
  lockReceiptKey,
  ms,
  newIncidentDataId,
  newIncidentId,
  parseInput,
  requireAt,
  transitionRow,
  validation,
  withReceipt,
  type IncidentRow,
} from './internal.js';
import { evaluateRuleWindow, type WindowOutcome, type WindowSample } from './rules.js';

/** Live-sample read bound per rule evaluation (NFR-04). */
const MAX_WINDOW_SAMPLES = 5_000;
/** Samples linked to one signal; the full count is kept as `window_sample_total`. */
const MAX_SIGNAL_SAMPLES = 500;
/** An evaluation instant may run ahead of the database clock by at most this much (and never behind it). */
const MAX_AT_LEAD_MS = 3_600_000;
const CONVERGE_ATTEMPTS = 6;
const ACTIVE_STATES = [
  'DETECTED',
  'TRIAGING',
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
];

export type TriggerOutcome = 'OPENED' | 'ATTACHED' | 'REOPENED' | 'DUPLICATE';

interface AssetRow {
  id: string;
  site_id: string;
  current_revision_id: string;
  status: string;
  timezone: string;
}

type QualifiedWindow = Extract<WindowOutcome, { qualified: true }>;

interface ManualReportPayload {
  reportKind: 'FAULT_REPORT' | 'REOPEN_EVIDENCE';
  reasonCode: string;
  note: string | null;
  observedAt: string;
  attachments: { blobId: string; role: 'PHOTO' | 'DOCUMENT' | 'OTHER' }[];
}

interface Trigger {
  kind: 'TELEMETRY_RULE' | 'MANUAL_REPORT';
  asset: AssetRow;
  rule: RuleRevisionRecord;
  /** Evaluation / report instant: selects the procedure and policy and bounds the watch window. */
  at: string;
  assetRevisionId: string;
  inputOrigin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT' | 'OPERATOR_REPORT';
  triggerEventAt: string;
  triggerReceivedAt: string;
  basisEventAt: string;
  window?: QualifiedWindow;
  sampleRows?: Map<string, SampleRow>;
  manual?: ManualReportPayload;
}

export interface TriggerResult {
  incidentId: IncidentId;
  outcome: TriggerOutcome;
  version: number;
  signalId: string | null;
  manualReportId: string | null;
}

interface SampleRow {
  id: string;
  channel_id: string;
  channel_revision_id: string;
  calibration_revision: number;
  device_assignment_id: string;
  asset_revision_id: string;
  event_at: Date;
  received_at: Date;
  value_int: string;
  ingestion_class: 'LIVE' | 'LATE' | 'BACKFILL';
  quality_flags: string[];
  input_origin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT';
}

async function loadAsset(c: Tx, ctx: TenantContext, meta: CommandMeta, assetId: unknown): Promise<AssetRow> {
  if (!AssetIdSchema.safeParse(assetId).success) throw unavailable(meta);
  const { rows } = await c.query<AssetRow>(
    `SELECT a.id, a.site_id, a.current_revision_id, a.status, s.timezone FROM assets a
       JOIN sites s ON s.tenant_id = a.tenant_id AND s.id = a.site_id
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [ctx.tenantId, assetId],
  );
  if (!rows[0]) throw unavailable(meta);
  return rows[0];
}

const dedupeSql = `ub_incident_dedupe_key($1, $2, $3, $4)`;

async function activeIncident(c: Tx, ctx: TenantContext, t: Trigger): Promise<IncidentRow | undefined> {
  const { rows } = await c.query<IncidentRow>(
    `SELECT * FROM incidents WHERE tenant_id = $1 AND dedupe_key = ${dedupeSql} AND state <> 'RECOVERED' FOR SHARE`,
    [ctx.tenantId, t.asset.site_id, t.asset.id, t.rule.faultWindowKey],
  );
  return rows[0];
}

async function recoveredInWatchWindow(c: Tx, ctx: TenantContext, t: Trigger): Promise<IncidentRow | undefined> {
  const { rows } = await c.query<IncidentRow>(
    `SELECT i.* FROM incidents i
       JOIN incident_rule_revisions r ON r.tenant_id = i.tenant_id AND r.id = i.rule_revision_id
      WHERE i.tenant_id = $1 AND i.dedupe_key = ${dedupeSql} AND i.state = 'RECOVERED'
        AND $5::timestamptz > i.recovered_at
        AND $6::timestamptz <= i.recovered_at + r.watch_window_ms * interval '1 millisecond'
      ORDER BY i.recovered_at DESC LIMIT 1
      FOR UPDATE OF i`,
    [ctx.tenantId, t.asset.site_id, t.asset.id, t.rule.faultWindowKey, t.triggerEventAt, t.at],
  );
  return rows[0];
}

function manualSignalDigest(manualReportId: string | null): string {
  return canonicalDigest('incident-signal', 1, { kind: 'MANUAL_REPORT', manualReportId });
}

/** Append the trigger's evidence (manual report + attachments, or the exact device samples) to an incident. */
async function recordSignal(
  c: Tx,
  ctx: TenantContext,
  incident: Pick<IncidentRow, 'id' | 'site_id' | 'asset_id'>,
  t: Trigger,
  outcome: 'OPENED' | 'ATTACHED' | 'REOPENED',
): Promise<{ signalId: string | null; manualReportId: string | null }> {
  const actor = actorFor(ctx);
  let manualReportId: string | null = null;
  if (t.manual) {
    manualReportId = newIncidentDataId('manualReport');
    const reportDigest = canonicalDigest('incident-manual-report', 1, {
      tenantId: ctx.tenantId,
      manualReportId,
      incidentId: incident.id,
      assetId: incident.asset_id,
      ruleRevisionId: t.rule.ruleRevisionId,
      reportedBy: actor.id,
      ...t.manual,
    });
    await c.query(
      `INSERT INTO incident_manual_reports (tenant_id, id, incident_id, site_id, asset_id, report_kind, rule_revision_id,
         reported_by_user_id, reason_code, note, observed_at, report_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        ctx.tenantId,
        manualReportId,
        incident.id,
        incident.site_id,
        incident.asset_id,
        t.manual.reportKind,
        t.rule.ruleRevisionId,
        actor.id,
        t.manual.reasonCode,
        t.manual.note,
        t.manual.observedAt,
        reportDigest,
      ],
    );
    for (const [i, a] of t.manual.attachments.entries())
      await c.query(
        `INSERT INTO incident_manual_report_attachments (tenant_id, report_id, ordinal, blob_id, role) VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenantId, manualReportId, i + 1, a.blobId, a.role],
      );
    await appendOperatorEvidence(
      c,
      ctx,
      {
        kind: 'MATERIAL_INPUT',
        trust: 'OPERATOR_ATTESTED',
        subject: { aggregateType: 'incident', aggregateId: incident.id },
        incidentId: incident.id,
        payloadSchema: 'incident.manual_report.v1',
        payloadDigest: `sha256:${reportDigest.split(':sha256:')[1]}`,
        payloadRef: null,
        supersedesEvidenceId: null,
      },
      { siteId: incident.site_id as never },
    );
  }
  const signalId = newIncidentDataId('signal');
  const telemetry = t.kind === 'TELEMETRY_RULE' ? t.window! : null;
  let runSamples = telemetry ? telemetry.runs.flatMap((r) => r.samples) : [];
  if (telemetry && outcome === 'ATTACHED') {
    // Corroboration is incremental: link only readings not already linked to this incident, so a long breach
    // re-evaluated after every reading adds each sample once (bounded growth, NFR-04).
    const seen = await c.query<{ sample_id: string }>(
      `SELECT s.sample_id FROM incident_signal_samples s
         JOIN incident_signals g ON g.tenant_id = s.tenant_id AND g.id = s.signal_id
        WHERE s.tenant_id = $1 AND g.incident_id = $2 AND s.sample_id = ANY($3)`,
      [ctx.tenantId, incident.id, runSamples.map((x) => x.sampleId)],
    );
    const linkedBefore = new Set(seen.rows.map((r) => r.sample_id));
    runSamples = runSamples.filter((x) => !linkedBefore.has(x.sampleId));
    if (runSamples.length === 0) return { signalId: null, manualReportId };
  }
  const digest = telemetry
    ? canonicalDigest('incident-signal', 1, {
        kind: 'TELEMETRY_TRIGGER',
        ruleRevisionId: t.rule.ruleRevisionId,
        sampleIds: runSamples.map((x) => x.sampleId),
      })
    : manualSignalDigest(manualReportId);
  const linked = runSamples.slice(-MAX_SIGNAL_SAMPLES);
  const total = runSamples.length;
  const windowStart = linked.length > 0 ? Math.min(...linked.map((x) => x.eventAtMs)) : null;
  const windowEnd = linked.length > 0 ? Math.max(...linked.map((x) => x.eventAtMs)) : null;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO incident_signals (tenant_id, id, incident_id, signal_kind, trust, outcome, input_origin, rule_revision_id,
       manual_report_id, window_start_at, window_end_at, sample_count, window_sample_total, channel_count, peak_value_int,
       reason_code, signal_digest, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (tenant_id, incident_id, signal_digest) DO NOTHING RETURNING id`,
    [
      ctx.tenantId,
      signalId,
      incident.id,
      telemetry ? 'TELEMETRY_TRIGGER' : 'MANUAL_REPORT',
      telemetry ? 'DEVICE_AUTHENTICATED' : 'OPERATOR_ATTESTED',
      outcome,
      t.inputOrigin,
      telemetry ? t.rule.ruleRevisionId : null,
      manualReportId,
      windowStart === null ? null : isoOf(new Date(windowStart)),
      windowEnd === null ? null : isoOf(new Date(windowEnd)),
      linked.length,
      total,
      telemetry ? new Set(linked.map((x) => x.channelId)).size : 0,
      linked.length === 0
        ? null
        : t.rule.comparator === 'ABOVE'
          ? Math.max(...runSamples.map((x) => x.valueInt))
          : Math.min(...runSamples.map((x) => x.valueInt)),
      telemetry ? 'QUALIFIED' : t.manual!.reasonCode,
      digest,
      actor.kind,
      actor.id,
    ],
  );
  if (!rows[0]) return { signalId: null, manualReportId };
  if (linked.length > 0) {
    const rowsById = t.sampleRows!;
    const cols = linked.map((s) => rowsById.get(s.sampleId)!);
    await c.query(
      `INSERT INTO incident_signal_samples (tenant_id, signal_id, sample_id, ordinal, channel_id, channel_revision_id,
         calibration_revision, device_assignment_id, asset_revision_id, event_at)
       SELECT $1, $2, x.sample_id, x.ord, x.channel_id, x.channel_revision_id, x.calibration_revision,
              x.device_assignment_id, x.asset_revision_id, x.event_at
         FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::timestamptz[])
           WITH ORDINALITY AS x(sample_id, channel_id, channel_revision_id, calibration_revision, device_assignment_id,
             asset_revision_id, event_at, ord)`,
      [
        ctx.tenantId,
        signalId,
        cols.map((r) => r.id),
        cols.map((r) => r.channel_id),
        cols.map((r) => r.channel_revision_id),
        cols.map((r) => r.calibration_revision),
        cols.map((r) => r.device_assignment_id),
        cols.map((r) => r.asset_revision_id),
        cols.map((r) => r.event_at),
      ],
    );
  }
  return { signalId: rows[0].id, manualReportId };
}

async function authorityPolicyAt(c: Tx, tenantId: string, at: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT r.id FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE r.tenant_id = $1 AND p.policy_key = 'AUTHORITY' AND r.effective_at <= $2
      ORDER BY r.effective_at DESC LIMIT 1`,
    [tenantId, at],
  );
  return rows[0]?.id ?? null;
}

/** Insert a new incident and everything it pins. Returns undefined when another trigger already holds the window. */
async function openIncident(
  c: Tx,
  ctx: TenantContext,
  t: Trigger,
  procedure: ProcedureRevisionRecord,
): Promise<TriggerResult | undefined> {
  const actor = actorFor(ctx);
  const incidentId = newIncidentId();
  const assignmentId = newIncidentDataId('assignment');
  const correlationId = ctx.correlationId;
  const openedAt = await dbNow(c);
  const policyRevisionId = await authorityPolicyAt(c, ctx.tenantId, t.at);
  const basisAt = procedure.deadlineBasis === 'TRIGGER_EVENT_AT' ? t.basisEventAt : openedAt;
  const originalDeadline = computeOriginalDeadline(basisAt, procedure.responseDeadlineMs);
  const timezoneBasis = procedure.timezoneBasis === 'UTC' ? 'UTC' : `SITE_LOCAL:${t.asset.timezone}`;
  const basisDigest = canonicalDigest('incident-deadline-basis', 1, {
    tenantId: ctx.tenantId,
    incidentId,
    siteId: t.asset.site_id,
    assetId: t.asset.id,
    ruleRevisionId: t.rule.ruleRevisionId,
    procedureRevisionId: procedure.procedureRevisionId,
    procedureBodyDigest: procedure.bodyDigest,
    deadlineKind: procedure.deadlineKind,
    deadlineBasis: procedure.deadlineBasis,
    basisAt,
    responseDeadlineMs: procedure.responseDeadlineMs,
    timezoneBasis,
  });
  const openLatencyMs = Math.max(0, ms(openedAt) - ms(t.triggerReceivedAt));
  const { rows } = await c.query<IncidentRow>(
    `INSERT INTO incidents (tenant_id, id, site_id, asset_id, asset_revision_id, rule_revision_id, procedure_revision_id,
       policy_revision_id, trigger_kind, trigger_input_origin, state, fault_family, fault_window_key, urgency,
       trigger_event_at, trigger_received_at, opened_at, open_latency_ms, deadline_kind, deadline_basis,
       deadline_basis_at, deadline_computed_at, deadline_basis_digest, deadline_timezone_basis,
       original_response_deadline_at, current_response_deadline_at, deadline_status, current_assignment_id,
       correlation_id, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DETECTED', $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $16,
       $21, $22, $23, $23, 'RUNNING', $24, $25, 1)
     ON CONFLICT (tenant_id, dedupe_key) WHERE state <> 'RECOVERED' DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      incidentId,
      t.asset.site_id,
      t.asset.id,
      t.assetRevisionId,
      t.rule.ruleRevisionId,
      procedure.procedureRevisionId,
      policyRevisionId,
      t.kind,
      t.inputOrigin,
      t.rule.faultFamily,
      t.rule.faultWindowKey,
      t.rule.urgency,
      t.triggerEventAt,
      t.triggerReceivedAt,
      openedAt,
      openLatencyMs,
      procedure.deadlineKind,
      procedure.deadlineBasis,
      basisAt,
      basisDigest,
      timezoneBasis,
      originalDeadline,
      assignmentId,
      correlationId,
    ],
  );
  const row = rows[0];
  if (!row) return undefined;
  await c.query(
    `INSERT INTO incident_transitions (tenant_id, id, incident_id, incident_version, from_state, to_state, reason_code,
       actor_kind, actor_id)
     VALUES ($1, $2, $3, 1, NULL, 'DETECTED', $4, $5, $6)`,
    [
      ctx.tenantId,
      newIncidentDataId('transition'),
      incidentId,
      t.kind === 'MANUAL_REPORT' ? 'MANUAL_REPORT' : 'RULE_QUALIFIED',
      actor.kind,
      actor.id,
    ],
  );
  await c.query(
    `INSERT INTO incident_assignments (tenant_id, id, incident_id, assignee_user_id, assignment_kind, assigned_by_kind,
       assigned_by_id, reason_code, incident_version)
     VALUES ($1, $2, $3, $4, 'INITIAL', $5, $6, 'PROCEDURE_INITIAL_OWNER', 1)`,
    [ctx.tenantId, assignmentId, incidentId, procedure.initialAssigneeUserId, actor.kind, actor.id],
  );
  await c.query(
    `INSERT INTO incident_deadline_events (tenant_id, id, incident_id, sequence, event_type, prior_deadline_at,
       new_deadline_at, prior_status, new_status, effective_at, procedure_revision_id, basis_digest, reason_code,
       authorized_by_kind, authorized_by_id, authorized_role, approved_at, incident_version)
     VALUES ($1, $2, $3, 1, 'SET', NULL, $4, NULL, 'RUNNING', $5, $6, $7, 'PROCEDURE_DEADLINE_SET', $8, $9, NULL, $5, 1)`,
    [
      ctx.tenantId,
      newIncidentDataId('deadlineEvent'),
      incidentId,
      originalDeadline,
      openedAt,
      procedure.procedureRevisionId,
      basisDigest,
      actor.kind,
      actor.id,
    ],
  );
  const signal = await recordSignal(c, ctx, row, t, 'OPENED');
  const critical = t.rule.urgency === 'CRITICAL';
  await emit(c, ctx, row, 'incident.opened.v1', {
    incidentId,
    siteId: row.site_id,
    assetId: row.asset_id,
    assetRevisionId: row.asset_revision_id,
    ruleRevisionId: row.rule_revision_id,
    procedureRevisionId: row.procedure_revision_id,
    policyRevisionId: row.policy_revision_id,
    triggerKind: row.trigger_kind,
    triggerInputOrigin: row.trigger_input_origin,
    urgency: row.urgency,
    faultFamily: row.fault_family,
    faultWindowKey: row.fault_window_key,
    dedupeKey: row.dedupe_key,
    triggerEventAt: isoOf(row.trigger_event_at),
    openedAt: isoOf(row.opened_at),
    openLatencyMs,
    originalResponseDeadlineAt: isoOf(row.original_response_deadline_at),
    deadlineBasisDigest: row.deadline_basis_digest,
    initialAssignmentId: assignmentId,
    notification: { required: critical, reasonCode: critical ? 'CRITICAL_INCIDENT_OPENED' : 'INCIDENT_OPENED' },
  });
  await emit(c, ctx, row, 'incident.assignment_changed.v1', {
    incidentId,
    assignmentId,
    assignmentKind: 'INITIAL',
    assigneeUserId: procedure.initialAssigneeUserId,
    supersededAssignmentId: null,
    reasonCode: 'PROCEDURE_INITIAL_OWNER',
    nextActionDueAt: null,
  });
  await emit(c, ctx, row, 'incident.deadline_changed.v1', {
    incidentId,
    sequence: 1,
    eventType: 'SET',
    priorDeadlineAt: null,
    newDeadlineAt: originalDeadline,
    originalDeadlineAt: originalDeadline,
    newStatus: 'RUNNING',
    procedureRevisionId: procedure.procedureRevisionId,
    reasonCode: 'PROCEDURE_DEADLINE_SET',
  });
  if (t.kind === 'TELEMETRY_RULE') {
    const w = t.window!;
    await appendSystemEvidence(c, ctx, {
      kind: 'POLICY_DECISION',
      trust: 'AUTHORITATIVE',
      subject: { aggregateType: 'incident', aggregateId: incidentId },
      incidentId,
      payloadSchema: 'incident.rule_decision.v1',
      payloadDigest: `sha256:${
        canonicalDigest('incident-rule-decision', 1, {
          ruleRevisionId: t.rule.ruleRevisionId,
          ruleBodyDigest: t.rule.bodyDigest,
          at: t.at,
          sampleIds: w.runs.flatMap((r) => r.samples.map((s) => s.sampleId)),
        }).split(':sha256:')[1]
      }`,
      payloadRef: null,
      supersedesEvidenceId: null,
    });
  }
  const triaging = await transitionRow(c, ctx, row, 'TRIAGING', 'SOURCE_PERSISTED');
  return {
    incidentId: incidentId as IncidentId,
    outcome: 'OPENED',
    version: triaging.version,
    signalId: signal.signalId,
    manualReportId: signal.manualReportId,
  };
}

/** RECOVERED -> REOPENED -> TRIAGING for a recurrence inside the watch window (history is kept). */
export async function reopenRow(
  c: Tx,
  ctx: TenantContext,
  row: IncidentRow,
  reasonCode: string,
  trigger: 'TELEMETRY_RULE' | 'MANUAL_REPORT' | 'OPERATOR_COMMAND' | 'RECOVERY_ENGINE',
  guardRef: string | null = null,
): Promise<IncidentRow> {
  // A reopened incident never presents a deadline that already passed as running (or met): under the pinned procedure
  // the ledger records EXPIRE first; the original deadline and its basis are untouched.
  const now = await dbNow(c);
  if (row.deadline_status === 'RUNNING' && ms(row.current_response_deadline_at) <= ms(now))
    row = await appendDeadlineEvent(c, ctx, row, {
      eventType: 'EXPIRE',
      reasonCode: 'DEADLINE_PASSED_BEFORE_REOPEN',
      effectiveAt: now,
      role: null,
    });
  const reopened = await transitionRow(c, ctx, row, 'REOPENED', reasonCode, {
    guardRef,
    extraSet:
      'recovered_at = NULL, reopen_count = reopen_count + 1, acknowledged_at = NULL, acknowledged_by_user_id = NULL',
  });
  await emit(c, ctx, reopened, 'incident.reopened.v1', {
    incidentId: row.id,
    from: 'RECOVERED',
    reasonCode,
    reopenCount: reopened.reopen_count,
    trigger,
    notification: { required: true, reasonCode: 'INCIDENT_REOPENED' },
  });
  return transitionRow(c, ctx, reopened, 'TRIAGING', 'NEW_EVIDENCE_RECORDED');
}

/** Converge one trigger on the single active incident for its window (see the module comment). */
async function converge(c: Tx, ctx: TenantContext, meta: CommandMeta, t: Trigger): Promise<TriggerResult> {
  for (let attempt = 0; attempt < CONVERGE_ATTEMPTS; attempt++) {
    const active = await activeIncident(c, ctx, t);
    if (active) {
      const s = await recordSignal(c, ctx, active, t, 'ATTACHED');
      return {
        incidentId: active.id as IncidentId,
        outcome: s.signalId ? 'ATTACHED' : 'DUPLICATE',
        version: active.version,
        signalId: s.signalId,
        manualReportId: s.manualReportId,
      };
    }
    const recovered = await recoveredInWatchWindow(c, ctx, t);
    if (recovered) {
      await c.query('SAVEPOINT incident_reopen');
      try {
        const row = await reopenRow(c, ctx, recovered, 'RECURRENCE_IN_WATCH_WINDOW', t.kind);
        await c.query('RELEASE SAVEPOINT incident_reopen');
        const s = await recordSignal(c, ctx, row, t, 'REOPENED');
        return {
          incidentId: row.id as IncidentId,
          outcome: 'REOPENED',
          version: row.version,
          signalId: s.signalId,
          manualReportId: s.manualReportId,
        };
      } catch (e) {
        // Another trigger opened a new active incident for this window meanwhile: append to it instead.
        if (pgCode(e) !== UNIQUE_VIOLATION) throw e;
        await c.query('ROLLBACK TO SAVEPOINT incident_reopen');
        continue;
      }
    }
    const procedure = await effectiveProcedure(c, ctx.tenantId, t.rule.procedureKey, t.at);
    if (!procedure) throw validation('PROCEDURE_NOT_EFFECTIVE');
    const opened = await openIncident(c, ctx, t, procedure);
    if (opened) return opened;
  }
  void meta;
  throw versionConflict('INCIDENT_CONVERGENCE_RETRY_EXHAUSTED');
}

// ---------------------------------------------------------------------------------------------------------------
// Telemetry rule evaluation

export interface RuleEvaluation {
  ruleRevisionId: string;
  ruleKey: string;
  outcome: TriggerOutcome | 'NOT_QUALIFIED';
  reasonCode: string;
  incidentId: IncidentId | null;
  version: number | null;
}

export interface EvaluateInput {
  assetId: AssetId | string;
  /** Evaluation instant; never earlier than the database clock and at most one hour ahead of it. */
  at?: string;
}

const EvaluateInputSchema = z.strictObject({ assetId: z.string().max(128), at: UtcInstantSchema.optional() });

async function evaluationInstant(c: Tx, requested: string | undefined): Promise<string> {
  const now = await dbNow(c);
  if (requested === undefined) return now;
  if (ms(requested) > ms(now) + MAX_AT_LEAD_MS) throw validation('EVALUATION_TIME_OUT_OF_BOUNDS');
  return ms(requested) > ms(now) ? isoOf(requested) : now;
}

async function loadWindowSamples(
  c: Tx,
  tenantId: string,
  assetId: string,
  rule: RuleRevisionRecord,
  at: string,
): Promise<SampleRow[]> {
  const lookbackMs = rule.durationMs + rule.maxGapMs + rule.maxEvaluationLagMs;
  const { rows } = await c.query<SampleRow>(
    `SELECT id, channel_id, channel_revision_id, calibration_revision, device_assignment_id, asset_revision_id, event_at,
            received_at, value_int, ingestion_class, quality_flags, input_origin
       FROM telemetry_samples
      WHERE tenant_id = $1 AND asset_id = $2 AND kind = $3 AND ingestion_class = 'LIVE' AND quality_flags = '{}'
        AND event_at <= $4 AND event_at > $4::timestamptz - $5 * interval '1 millisecond'
      ORDER BY event_at DESC, id DESC LIMIT $6`,
    [tenantId, assetId, rule.channelKind, at, lookbackMs, MAX_WINDOW_SAMPLES],
  );
  return rows.reverse();
}

async function hasOlderLiveSample(
  c: Tx,
  tenantId: string,
  assetId: string,
  rule: RuleRevisionRecord,
  at: string,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM telemetry_samples WHERE tenant_id = $1 AND asset_id = $2 AND kind = $3 AND ingestion_class = 'LIVE'
        AND quality_flags = '{}' AND event_at <= $4 LIMIT 1`,
    [tenantId, assetId, rule.channelKind, at],
  );
  return rowCount === 1;
}

async function evaluateAssetTx(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  asset: AssetRow,
  at: string,
): Promise<RuleEvaluation[]> {
  const out: RuleEvaluation[] = [];
  for (const rule of await effectiveRulesForAsset(c, ctx.tenantId, { id: asset.id, siteId: asset.site_id }, at)) {
    const sampleRows = await loadWindowSamples(c, ctx.tenantId, asset.id, rule, at);
    const samples: WindowSample[] = sampleRows.map((r) => ({
      sampleId: r.id,
      channelId: r.channel_id,
      eventAtMs: r.event_at.getTime(),
      receivedAtMs: r.received_at.getTime(),
      valueInt: Number(r.value_int),
      ingestionClass: r.ingestion_class,
      qualityFlags: r.quality_flags,
      inputOrigin: r.input_origin,
    }));
    const window = evaluateRuleWindow(rule, samples, ms(at));
    const base = { ruleRevisionId: rule.ruleRevisionId, ruleKey: rule.ruleKey };
    if (!window.qualified) {
      // No live reading inside the bounded window, but an older one exists: the signal is stale, not absent.
      const reasonCode =
        window.reasonCode === 'NO_LIVE_SAMPLES' && (await hasOlderLiveSample(c, ctx.tenantId, asset.id, rule, at))
          ? 'STALE_SIGNAL'
          : window.reasonCode;
      out.push({ ...base, outcome: 'NOT_QUALIFIED', reasonCode, incidentId: null, version: null });
      continue;
    }
    if (!(await effectiveProcedure(c, ctx.tenantId, rule.procedureKey, at))) {
      out.push({
        ...base,
        outcome: 'NOT_QUALIFIED',
        reasonCode: 'PROCEDURE_NOT_EFFECTIVE',
        incidentId: null,
        version: null,
      });
      continue;
    }
    const byId = new Map(sampleRows.map((r) => [r.id, r]));
    const newest = window.runs.flatMap((r) => r.samples).reduce((a, b) => (b.eventAtMs > a.eventAtMs ? b : a));
    const result = await converge(c, ctx, meta, {
      kind: 'TELEMETRY_RULE',
      asset,
      rule,
      at,
      assetRevisionId: byId.get(newest.sampleId)!.asset_revision_id,
      inputOrigin: window.inputOrigin,
      triggerEventAt: isoOf(new Date(window.lastEventAtMs)),
      triggerReceivedAt: isoOf(new Date(window.lastReceivedAtMs)),
      basisEventAt: isoOf(new Date(window.onsetAtMs)),
      window,
      sampleRows: byId,
    });
    out.push({
      ...base,
      outcome: result.outcome,
      reasonCode: 'QUALIFIED',
      incidentId: result.incidentId,
      version: result.version,
    });
  }
  return out;
}

/** Evaluate every rule in force for an asset at `at` (engine workers only). */
export async function evaluateIncidentRules(
  pool: Db,
  ctx: TenantContext,
  raw: EvaluateInput,
): Promise<{ assetId: string; at: string; evaluations: RuleEvaluation[] }> {
  const input = parseInput(EvaluateInputSchema, raw);
  const meta = { action: 'incident.evaluate', resourceType: 'asset', resourceId: input.assetId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'incident.engine', null);
    const asset = await loadAsset(c, ctx, meta, input.assetId);
    const at = await evaluationInstant(c, input.at);
    return { assetId: asset.id, at, evaluations: await evaluateAssetTx(c, ctx, meta, asset, at) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Manual report

const ManualReportInputSchema = z.strictObject({
  idempotencyKey: z.string().max(128),
  assetId: z.string().max(128),
  ruleKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  note: z.string().min(1).max(2000).optional(),
  observedAt: UtcInstantSchema.optional(),
  attachments: z
    .array(
      z.strictObject({
        blobId: z.string().regex(/^blb_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
        role: z.enum(['PHOTO', 'DOCUMENT', 'OTHER']),
      }),
    )
    .max(20)
    .optional(),
});
export type ManualReportInput = z.input<typeof ManualReportInputSchema>;

/** Accepted skew for a reported observation time: no future observations, and at most one day old. */
const OBSERVED_FUTURE_SKEW_MS = 5_000;
const OBSERVED_MAX_AGE_MS = 86_400_000;

export async function attachmentsInTenant(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  attachments: readonly { blobId: string }[],
): Promise<void> {
  const ids = attachments.map((a) => a.blobId);
  if (new Set(ids).size !== ids.length) throw validation('DUPLICATE_ATTACHMENT');
  if (ids.length === 0) return;
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM evidence_blobs WHERE tenant_id = $1 AND id = ANY($2)`,
    [ctx.tenantId, ids],
  );
  if (rows[0]!.n !== ids.length) throw unavailable(meta, null, 'evidence_blob');
}

export function boundedObservedAt(now: string, observedAt: string | undefined): string {
  if (observedAt === undefined) return now;
  const t = ms(observedAt);
  if (t > ms(now) + OBSERVED_FUTURE_SKEW_MS || t < ms(now) - OBSERVED_MAX_AGE_MS)
    throw validation('OBSERVED_AT_OUT_OF_BOUNDS');
  return isoOf(observedAt);
}

/**
 * An authorized operator's fault report (T-020). It opens or joins the asset's incident for the rule's fault window,
 * records actor, reason, note and in-tenant attachments, and is operator-attested evidence only: it never carries
 * samples and never satisfies a telemetry rule.
 */
export async function submitManualReport(pool: Db, ctx: TenantContext, raw: ManualReportInput): Promise<TriggerResult> {
  const input = parseInput(ManualReportInputSchema, raw, 'INVALID_MANUAL_REPORT');
  const meta = { action: 'incident.manual_report', resourceType: 'asset', resourceId: input.assetId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    // Lock order everywhere: Idempotency-Key first, then incident rows (see commands.ts).
    await lockReceiptKey(c, ctx, input.idempotencyKey);
    const asset = await loadAsset(c, ctx, meta, input.assetId);
    if (
      ctx.principal.kind === 'HUMAN' &&
      !authorize(ctx, { action: 'registry.read', siteId: asset.site_id as never }).allowed
    )
      throw unavailable(meta);
    requireAt(ctx, meta, 'incident.report', asset.site_id, asset.id);
    const { idempotencyKey, ...request } = input;
    return withReceipt(
      c,
      ctx,
      { commandType: 'incident.manual_report.v1', idempotencyKey, request: { ...request } },
      null,
      async () => {
        const now = await dbNow(c);
        const observedAt = boundedObservedAt(now, input.observedAt);
        const rule = (
          await effectiveRulesForAsset(c, ctx.tenantId, { id: asset.id, siteId: asset.site_id }, now, input.ruleKey)
        )[0];
        if (!rule) throw unavailable(meta, input.ruleKey, 'incident_rule');
        await attachmentsInTenant(c, ctx, meta, input.attachments ?? []);
        if (asset.status !== 'ACTIVE') throw deny(meta, 'ASSET_NOT_ACTIVE', asset.id);
        const result = await converge(c, ctx, meta, {
          kind: 'MANUAL_REPORT',
          asset,
          rule,
          at: now,
          assetRevisionId: asset.current_revision_id,
          inputOrigin: 'OPERATOR_REPORT',
          triggerEventAt: observedAt,
          triggerReceivedAt: now,
          basisEventAt: observedAt,
          manual: {
            reportKind: 'FAULT_REPORT',
            reasonCode: input.reasonCode,
            note: input.note ?? null,
            observedAt,
            attachments: input.attachments ?? [],
          },
        });
        await recordAudit(c, ctx, {
          action: 'incident.manual_report',
          resourceType: 'incident',
          resourceId: result.incidentId,
          result: 'SUCCEEDED',
          reasonCode: input.reasonCode,
          metadata: { outcome: result.outcome, manualReportId: result.manualReportId },
        });
        return { ...result } as TriggerResult & Record<string, unknown>;
      },
    );
  });
}

/** Record reopen evidence as an operator-attested report linked to the incident (used by reopenIncident). */
export async function recordReopenEvidence(
  c: Tx,
  ctx: TenantContext,
  row: IncidentRow,
  input: {
    reasonCode: string;
    note: string | null;
    attachments: { blobId: string; role: 'PHOTO' | 'DOCUMENT' | 'OTHER' }[];
  },
): Promise<string | null> {
  const { rows } = await c.query(`SELECT * FROM incident_rule_revisions WHERE tenant_id = $1 AND id = $2`, [
    ctx.tenantId,
    row.rule_revision_id,
  ]);
  const now = await dbNow(c);
  const s = await recordSignal(
    c,
    ctx,
    row,
    {
      kind: 'MANUAL_REPORT',
      asset: {
        id: row.asset_id,
        site_id: row.site_id,
        current_revision_id: row.asset_revision_id,
        status: 'ACTIVE',
        timezone: 'UTC',
      },
      rule: toRule(rows[0]!),
      at: now,
      assetRevisionId: row.asset_revision_id,
      inputOrigin: 'OPERATOR_REPORT',
      triggerEventAt: now,
      triggerReceivedAt: now,
      basisEventAt: now,
      manual: {
        reportKind: 'REOPEN_EVIDENCE',
        reasonCode: input.reasonCode,
        note: input.note,
        observedAt: now,
        attachments: input.attachments,
      },
    },
    'REOPENED',
  );
  return s.manualReportId;
}

// ---------------------------------------------------------------------------------------------------------------
// Stale data and the outbox consumer

/**
 * A channel went STALE/OFFLINE/INVALID (telemetry.stale.v1). For each active incident on an asset the device is bound
 * to whose pinned rule says ESCALATE_ACTIVE, record a system-derived STALE_SIGNAL, mark the signal UNCERTAIN and
 * escalate when the state allows it. Stale data never closes, recovers or de-escalates anything.
 */
async function applyStaleTx(
  c: Tx,
  ctx: TenantContext,
  input: { deviceId: string; channelId: string; freshness: string; statusReason: string; evaluatedAt: string },
): Promise<string[]> {
  const { rows } = await c.query<IncidentRow & { stale_behavior: string }>(
    `SELECT i.id FROM incidents i
       JOIN incident_rule_revisions r ON r.tenant_id = i.tenant_id AND r.id = i.rule_revision_id
      WHERE i.tenant_id = $1 AND i.state <> 'RECOVERED' AND r.stale_behavior = 'ESCALATE_ACTIVE'
        AND i.asset_id IN (SELECT asset_id FROM device_asset_assignments
                            WHERE tenant_id = $1 AND device_id = $2 AND valid_to IS NULL)
      ORDER BY i.id`,
    [ctx.tenantId, input.deviceId],
  );
  const touched: string[] = [];
  const actor = actorFor(ctx);
  for (const { id } of rows) {
    const locked = await c.query<IncidentRow>(`SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      ctx.tenantId,
      id,
    ]);
    const row = locked.rows[0]!;
    if (row.state === 'RECOVERED') continue;
    const digest = canonicalDigest('incident-signal', 1, {
      kind: 'STALE_SIGNAL',
      channelId: input.channelId,
      freshness: input.freshness,
      evaluatedAt: input.evaluatedAt,
    });
    const ins = await c.query(
      `INSERT INTO incident_signals (tenant_id, id, incident_id, signal_kind, trust, outcome, input_origin, reason_code,
         signal_digest, actor_kind, actor_id)
       VALUES ($1, $2, $3, 'STALE_SIGNAL', 'SYSTEM_DERIVED', 'ATTACHED', 'SYSTEM', $4, $5, $6, $7)
       ON CONFLICT (tenant_id, incident_id, signal_digest) DO NOTHING RETURNING id`,
      [ctx.tenantId, newIncidentDataId('signal'), id, input.statusReason, digest, actor.kind, actor.id],
    );
    if (ins.rowCount !== 1) continue;
    if (ACTIVE_STATES.includes(row.state))
      await transitionRow(c, ctx, row, 'ESCALATED', 'SIGNAL_UNCERTAIN', { extraSet: `signal_state = 'UNCERTAIN'` });
    else if (row.signal_state !== 'UNCERTAIN') await bumpRow(c, ctx, row, `signal_state = 'UNCERTAIN'`, []);
    touched.push(id);
  }
  return touched;
}

export async function applyTelemetryStale(
  pool: Db,
  ctx: TenantContext,
  raw: { deviceId: string; channelId: string; freshness: string; statusReason: string; evaluatedAt: string },
): Promise<{ escalated: string[] }> {
  const input = parseInput(
    z.strictObject({
      deviceId: z.string().regex(/^dev_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
      channelId: z.string().regex(/^chn_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
      freshness: z.enum(['STALE', 'OFFLINE', 'INVALID']),
      statusReason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      evaluatedAt: UtcInstantSchema,
    }),
    raw,
  );
  const meta = { action: 'incident.stale_signal', resourceType: 'device', resourceId: input.deviceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'incident.engine', null);
    return { escalated: await applyStaleTx(c, ctx, input) };
  });
}

/** The outbox consumer name used for incident detection. */
export const INCIDENT_ENGINE_CONSUMER = 'incident-engine.v1';

/**
 * Process one telemetry outbox event exactly once logically (consumeOnce receipt commits with the effects).
 * telemetry.accepted.v1 re-evaluates the rules of every asset the batch's samples are pinned to, at the batch receipt
 * time (rules re-read samples by event time; event order is irrelevant); telemetry.stale.v1 applies stale behaviour.
 */
export async function handleTelemetryEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED'> {
  if (envelope.eventType !== 'telemetry.accepted.v1' && envelope.eventType !== 'telemetry.stale.v1') return 'IGNORED';
  return consumeOnce(pool, INCIDENT_ENGINE_CONSUMER, envelope, async (c, ctx) => {
    const meta = { action: 'incident.evaluate', resourceType: 'device', resourceId: envelope.aggregateId };
    if (envelope.eventType === 'telemetry.accepted.v1') {
      const e = TelemetryAcceptedEventSchema.parse(envelope);
      if (e.payload.classCounts.LIVE === 0) return;
      const assets = await c.query<{ asset_id: string }>(
        `SELECT DISTINCT asset_id FROM telemetry_samples WHERE tenant_id = $1 AND batch_id = $2 AND ingestion_class = 'LIVE'`,
        [ctx.tenantId, e.payload.batchId],
      );
      for (const { asset_id } of assets.rows) {
        const asset = await loadAsset(c, ctx, meta, asset_id);
        // The batch receipt time, clamped into [database now, now + lead] so a consumer can never rewind it.
        const now = await dbNow(c);
        const lead = Math.min(ms(e.payload.receivedAt), ms(now) + MAX_AT_LEAD_MS);
        const at = lead > ms(now) ? isoOf(new Date(lead)) : now;
        await evaluateAssetTx(c, ctx, meta, asset, at);
      }
      return;
    }
    const e = TelemetryStaleEventSchema.parse(envelope);
    await applyStaleTx(c, ctx, {
      deviceId: e.payload.deviceId,
      channelId: e.payload.channelId,
      freshness: e.payload.freshness,
      statusReason: e.payload.statusReason,
      evaluatedAt: e.payload.evaluatedAt,
    });
  });
}
