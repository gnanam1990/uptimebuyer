// Deterministic recovery assessment (FR-15, FR-16, INV-01, INV-03, INV-14). An engine worker names an incident only;
// everything else is reloaded server-side. In one transaction (incident row locked FOR UPDATE, the M04 lock order) the
// assessment opens or reuses the incident's single open evaluation for the current binding (superseding an open one
// whose milestone, policy, evidence, asset or channel binding changed; a revoked device fails it and escalates),
// checks expiry (EXPIRED escalates) and evaluates the gates. A non-passing result is recorded (OBSERVING with its
// reasons). A passing one is handed to the sanctioned closeout (closeout.ts), which re-runs every gate under lock
// inside M04's recovery hook transaction and commits the closeout with the RECOVERED transition. Concurrent assessors
// serialize on the incident; the losers report the one closeout. Idempotency-Key replays return the original result.
import { DomainError, newId } from '@uptimebuyer/contracts';
import {
  appendOutboxEvent,
  pgCode,
  recordAudit,
  sha256Digest,
  tenantCommand,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { advanceIncident, escalateIncident } from '@uptimebuyer/incidents';
import { UtcInstantSchema } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { closeoutWithEvaluation, type CloseoutFaults } from './closeout.js';
import {
  computeGates,
  desiredBinding,
  loadRule,
  pinnedChannels,
  type DesiredBinding,
  type EvaluationRow,
} from './evaluation.js';
import {
  IdempotencyKey,
  actorFor,
  assertSigning,
  evaluationInstant,
  isoOf,
  loadIncident,
  ms,
  newRecoveryId,
  parseInput,
  readReceipt,
  requestDigest,
  writeReceipt,
  type IncidentRow,
  type RecoverySigning,
} from './internal.js';
import { loadPolicy } from './policy.js';

const AssessSchema = z.strictObject({
  incidentId: z.string().max(128),
  idempotencyKey: IdempotencyKey,
  asOf: UtcInstantSchema.optional(),
});

export type AssessmentOutcome = 'NOT_READY' | 'OBSERVING' | 'PASSED' | 'FAILED' | 'EXPIRED' | 'ALREADY_RECOVERED';

export interface RecoveryAssessmentResult extends Record<string, unknown> {
  incidentId: string;
  recoveryEvaluationId: string | null;
  outcome: AssessmentOutcome;
  reasonCodes: string[];
  closeoutId: string | null;
  manifestDigest: string | null;
  incidentState: string;
  incidentVersion: number;
  window: { firstSampleAt: string; lastSampleAt: string; sampleCount: number; stableMs: number } | null;
}

type PhaseA =
  | { kind: 'DONE'; result: RecoveryAssessmentResult; escalate: { evaluationId: string; reason: string } | null }
  | { kind: 'READY'; evaluationId: string; incidentVersion: number };

const ESCALATING = new Set(['BINDING_REVOKED', 'EVIDENCE_DISPUTED', 'OBSERVATION_LIMIT_EXCEEDED']);

export async function assessRecovery(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof AssessSchema>,
  signing: RecoverySigning,
  opts: { faults?: CloseoutFaults } = {},
): Promise<RecoveryAssessmentResult> {
  const input = parseInput(AssessSchema, raw);
  assertSigning(signing);
  const asOfMs = input.asOf === undefined ? undefined : ms(input.asOf);
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = await phaseA(pool, ctx, input, signing);
    if (a.kind === 'DONE') {
      if (a.escalate) return { ...a.result, ...(await escalate(pool, ctx, a.result.incidentId, a.escalate)) };
      return a.result;
    }
    try {
      return await closeoutWithEvaluation(
        pool,
        ctx,
        {
          incidentId: input.incidentId,
          evaluationId: a.evaluationId,
          expectedVersion: a.incidentVersion,
          hookIdempotencyKey: `rcv-${sha256Digest(input.idempotencyKey).slice(7, 47)}`,
          receipt: { key: input.idempotencyKey, digest: assessDigest(ctx, input) },
          asOfMs,
        },
        signing,
        opts.faults,
      );
    } catch (e) {
      const err = e as DomainError & { details?: { reasonCode?: string } };
      const raced =
        err.code === 'VERSION_CONFLICT' ||
        err.code === 'STATE_TRANSITION_INVALID' ||
        (err.code === 'POLICY_HOLD' && err.details?.reasonCode === 'RECOVERY_EVALUATION_NOT_PASSED') ||
        pgCode(e) === '23505' ||
        pgCode(e) === '40001' ||
        pgCode(e) === '40P01';
      if (!raced) throw e;
      // Another assessor (or a change) won the race: re-assess from durable state; it sees the closeout or records why not.
    }
  }
  throw new DomainError('VERSION_CONFLICT', 'The recovery assessment kept racing; retry.', {
    reasonCode: 'RECOVERY_ASSESSMENT_RETRY_EXHAUSTED',
  });
}

const assessDigest = (ctx: TenantContext, input: z.output<typeof AssessSchema>) =>
  requestDigest(ctx, 'recovery.assess.v1', { incidentId: input.incidentId, asOf: input.asOf ?? null });

async function phaseA(
  pool: Db,
  ctx: TenantContext,
  input: z.output<typeof AssessSchema>,
  signing: RecoverySigning,
): Promise<PhaseA> {
  const meta = { action: 'recovery.assess', resourceType: 'incident', resourceId: input.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await loadIncident(c, ctx, meta, input.incidentId, { action: 'recovery.engine', lock: 'UPDATE' });
    const digest = assessDigest(ctx, input);
    const prior = await readReceipt<RecoveryAssessmentResult>(c, ctx, input.idempotencyKey, digest);
    if (prior) return { kind: 'DONE', result: prior, escalate: null };
    const done = async (
      r: {
        recoveryEvaluationId: string | null;
        outcome: AssessmentOutcome;
        reasonCodes: string[];
        closeoutId: string | null;
        window: RecoveryAssessmentResult['window'];
        manifestDigest?: string | null;
      },
      escalate: { evaluationId: string; reason: string } | null = null,
    ): Promise<PhaseA> => {
      const result: RecoveryAssessmentResult = {
        incidentId: inc.id,
        incidentState: inc.state,
        incidentVersion: inc.version,
        manifestDigest: null,
        ...r,
      };
      // Escalating outcomes are not cached: a retry must re-attempt the escalation from durable state.
      if (!escalate) await writeReceipt(c, ctx, input.idempotencyKey, 'recovery.assess.v1', digest, result);
      await recordAudit(c, ctx, { ...meta, resourceId: inc.id, result: 'SUCCEEDED', metadata: { outcome: r.outcome } });
      return { kind: 'DONE', result, escalate };
    };

    if (inc.state === 'RECOVERED') {
      const co = await c.query<{ id: string; evaluation_id: string; manifest_digest: string }>(
        `SELECT id, evaluation_id, manifest_digest FROM recovery_closeouts
          WHERE tenant_id = $1 AND incident_id = $2 AND recovery_cycle = $3`,
        [ctx.tenantId, inc.id, inc.reopen_count],
      );
      return done({
        recoveryEvaluationId: co.rows[0]?.evaluation_id ?? null,
        outcome: 'ALREADY_RECOVERED',
        reasonCodes: [],
        closeoutId: co.rows[0]?.id ?? null,
        manifestDigest: co.rows[0]?.manifest_digest ?? null,
        window: null,
      });
    }
    if (inc.state !== 'VERIFYING')
      return done({
        recoveryEvaluationId: null,
        outcome: 'NOT_READY',
        reasonCodes: ['INCIDENT_NOT_VERIFYING'],
        closeoutId: null,
        window: null,
      });

    const { nowMs, atMs } = await evaluationInstant(c, input.asOf);
    const openRows = await c.query<EvaluationRow>(
      `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state IN ('PENDING', 'OBSERVING')
        FOR UPDATE`,
      [ctx.tenantId, inc.id],
    );
    let ev: EvaluationRow | undefined = openRows.rows[0];
    const desired = await desiredBinding(c, inc);
    if (ev && (typeof desired === 'string' || desired.bindingDigest !== ev.binding_digest)) {
      const reason = await supersessionReason(c, ev, desired);
      await decide(c, ctx, ev, 'FAILED', reason, atMs, []);
      if (ESCALATING.has(reason))
        return done(
          { recoveryEvaluationId: ev.id, outcome: 'FAILED', reasonCodes: [reason], closeoutId: null, window: null },
          { evaluationId: ev.id, reason },
        );
      ev = undefined;
    }
    if (!ev) {
      if (typeof desired === 'string')
        return done({
          recoveryEvaluationId: null,
          outcome: 'NOT_READY',
          reasonCodes: [desired],
          closeoutId: null,
          window: null,
        });
      // A decided evaluation for the very same binding is not re-opened (an expired milestone stays expired).
      const decided = await c.query<EvaluationRow>(
        `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND binding_digest = $3
            AND state IN ('FAILED', 'EXPIRED') ORDER BY decided_at DESC LIMIT 1`,
        [ctx.tenantId, inc.id, desired.bindingDigest],
      );
      const d = decided.rows[0];
      if (d && d.state_reason && ESCALATING.has(d.state_reason))
        return done(
          {
            recoveryEvaluationId: d.id,
            outcome: d.state as 'FAILED' | 'EXPIRED',
            reasonCodes: [d.state_reason],
            closeoutId: null,
            window: null,
          },
          { evaluationId: d.id, reason: d.state_reason },
        );
      ev = await openEvaluation(c, ctx, inc, desired);
    }
    void nowMs;
    if (atMs > ev.expires_at.getTime()) {
      await decide(c, ctx, ev, 'EXPIRED', 'OBSERVATION_LIMIT_EXCEEDED', atMs, []);
      return done(
        {
          recoveryEvaluationId: ev.id,
          outcome: 'EXPIRED',
          reasonCodes: ['OBSERVATION_LIMIT_EXCEEDED'],
          closeoutId: null,
          window: null,
        },
        { evaluationId: ev.id, reason: 'OBSERVATION_LIMIT_EXCEEDED' },
      );
    }
    const pins = await pinnedChannels(c, ctx.tenantId, ev.id);
    const policy = await loadPolicy(c, ctx.tenantId, ev.recovery_policy_revision_id);
    const rule = await loadRule(c, ctx.tenantId, ev.rule_revision_id);
    const gates = await computeGates(c, ctx, inc, ev, pins, policy, rule, atMs, signing);
    if (gates.passed) return { kind: 'READY', evaluationId: ev.id, incidentVersion: inc.version };
    const window =
      gates.window.channels.length > 0 && gates.window.channels.every((ch) => ch.firstAtMs !== null)
        ? {
            firstSampleAt: isoOf(Math.min(...gates.window.channels.map((ch) => ch.firstAtMs!))),
            lastSampleAt: isoOf(Math.max(...gates.window.channels.map((ch) => ch.lastAtMs!))),
            sampleCount: gates.window.channels.reduce((n, ch) => n + ch.sampleIds.length, 0),
            stableMs: Math.min(...gates.window.channels.map((ch) => ch.stableMs)),
          }
        : null;
    await recordAssessment(c, ctx, ev, 'OBSERVING', gates.reasonCodes, atMs, window);
    return done({
      recoveryEvaluationId: ev.id,
      outcome: 'OBSERVING',
      reasonCodes: gates.reasonCodes,
      closeoutId: null,
      window,
    });
  });
}

async function supersessionReason(c: Tx, ev: EvaluationRow, desired: DesiredBinding | string): Promise<string> {
  const { rows } = await c.query<{ revoked: boolean }>(
    `SELECT bool_or(d.status = 'REVOKED' OR sc.status <> 'ACTIVE') AS revoked FROM recovery_evaluation_channels p
       JOIN devices d ON d.tenant_id = p.tenant_id AND d.id = p.device_id
       JOIN sensor_channels sc ON sc.tenant_id = p.tenant_id AND sc.id = p.channel_id
      WHERE p.tenant_id = $1 AND p.evaluation_id = $2`,
    [ev.tenant_id, ev.id],
  );
  if (rows[0]?.revoked) return 'BINDING_REVOKED';
  if (typeof desired === 'string')
    return desired === 'MILESTONE_MISSING' ? 'MILESTONE_SUPERSEDED' : 'BINDING_SUPERSEDED';
  if (desired.milestone.id !== ev.milestone_id) return 'MILESTONE_SUPERSEDED';
  if (desired.evidenceRevisionId !== ev.evidence_revision_id) return 'EVIDENCE_REVISION_SUPERSEDED';
  return 'BINDING_SUPERSEDED';
}

async function openEvaluation(c: Tx, ctx: TenantContext, inc: IncidentRow, d: DesiredBinding): Promise<EvaluationRow> {
  const id = newRecoveryId('evaluation');
  const actor = actorFor(ctx);
  await c.query(
    `INSERT INTO recovery_evaluations (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
       plan_id, plan_action_id, action_digest, evidence_revision_id, recovery_policy_revision_id, rule_revision_id,
       milestone_id, observation_boundary_at, stable_window_ms, expires_at, binding_digest, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'PENDING')`,
    [
      ctx.tenantId,
      id,
      inc.id,
      inc.site_id,
      inc.asset_id,
      inc.asset_revision_id,
      inc.reopen_count,
      d.milestone.plan_id,
      d.milestone.plan_action_id,
      d.milestone.action_digest,
      d.evidenceRevisionId,
      d.policy.id,
      d.rule.id,
      d.milestone.id,
      d.milestone.occurred_at,
      d.stableWindowMs,
      isoOf(d.expiresAtMs),
      d.bindingDigest,
    ],
  );
  for (const [i, p] of d.channels.entries())
    await c.query(
      `INSERT INTO recovery_evaluation_channels (tenant_id, evaluation_id, ordinal, device_id, device_assignment_id,
         channel_id, channel_revision_id, calibration_revision, asset_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        id,
        i + 1,
        p.device_id,
        p.device_assignment_id,
        p.channel_id,
        p.channel_revision_id,
        p.calibration_revision,
        p.asset_revision_id,
      ],
    );
  await c.query(
    `INSERT INTO recovery_evaluation_transitions (tenant_id, id, evaluation_id, sequence, from_state, to_state, reason_code,
       actor_kind, actor_id) VALUES ($1, $2, $3, 1, NULL, 'PENDING', 'EVALUATION_OPENED', $4, $5),
       ($1, $6, $3, 2, 'PENDING', 'OBSERVING', 'OBSERVATION_BOUNDARY_FROZEN', $4, $5)`,
    [
      ctx.tenantId,
      newRecoveryId('evaluationTransition'),
      id,
      actor.kind,
      actor.id,
      newRecoveryId('evaluationTransition'),
    ],
  );
  const { rows } = await c.query<EvaluationRow>(
    `UPDATE recovery_evaluations SET state = 'OBSERVING', version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, id],
  );
  await appendOutboxEvent(c, ctx, {
    eventType: 'recovery.assessed.v1',
    aggregateType: 'recovery_evaluation',
    aggregateId: id,
    aggregateVersion: 2,
    payload: {
      recoveryEvaluationId: id,
      incidentId: inc.id,
      from: 'PENDING',
      to: 'OBSERVING',
      reasonCode: 'OBSERVATION_BOUNDARY_FROZEN',
    },
    correlationId: inc.correlation_id,
    causationId: newId('command'),
  });
  return rows[0]!;
}

/** OBSERVING -> FAILED | EXPIRED with its reason, an assessment row and the event (decided evaluations are immutable). */
export async function decide(
  c: Tx,
  ctx: TenantContext,
  ev: EvaluationRow,
  to: 'FAILED' | 'EXPIRED',
  reason: string,
  atMs: number,
  extraReasons: string[],
): Promise<void> {
  const actor = actorFor(ctx);
  await c.query(
    `UPDATE recovery_evaluations SET state = $3, state_reason = $4, decided_at = clock_timestamp(), version = version + 1,
       updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, ev.id, to, reason],
  );
  await c.query(
    `INSERT INTO recovery_evaluation_transitions (tenant_id, id, evaluation_id, sequence, from_state, to_state, reason_code,
       actor_kind, actor_id)
     SELECT $1, $2, $3, coalesce(max(sequence), 0) + 1, $4, $5, $6, $7, $8
       FROM recovery_evaluation_transitions WHERE tenant_id = $1 AND evaluation_id = $3`,
    [ctx.tenantId, newRecoveryId('evaluationTransition'), ev.id, ev.state, to, reason, actor.kind, actor.id],
  );
  await recordAssessment(c, ctx, ev, to, [reason, ...extraReasons], atMs, null);
  const inc = await c.query<{ correlation_id: string }>(
    `SELECT correlation_id FROM incidents WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, ev.incident_id],
  );
  await appendOutboxEvent(c, ctx, {
    eventType: 'recovery.assessed.v1',
    aggregateType: 'recovery_evaluation',
    aggregateId: ev.id,
    aggregateVersion: ev.version + 1,
    payload: { recoveryEvaluationId: ev.id, incidentId: ev.incident_id, from: ev.state, to, reasonCode: reason },
    correlationId: inc.rows[0]!.correlation_id,
    causationId: newId('command'),
  });
}

async function recordAssessment(
  c: Tx,
  ctx: TenantContext,
  ev: EvaluationRow,
  outcome: 'OBSERVING' | 'FAILED' | 'EXPIRED',
  reasons: string[],
  atMs: number,
  window: RecoveryAssessmentResult['window'],
): Promise<void> {
  const actor = actorFor(ctx);
  const codes = [...new Set(reasons)].slice(0, 32);
  await c.query(
    `INSERT INTO recovery_assessments (tenant_id, id, evaluation_id, incident_id, sequence, outcome, reason_codes,
       evaluated_at, as_of, window_first_at, window_last_at, sample_count, stable_ms, assessment_digest, actor_kind, actor_id)
     SELECT $1, $2, $3, $4, coalesce(max(sequence), 0) + 1, $5, $6, clock_timestamp(), $7, $8, $9, $10, $11, $12, $13, $14
       FROM recovery_assessments WHERE tenant_id = $1 AND evaluation_id = $3`,
    [
      ctx.tenantId,
      newRecoveryId('assessment'),
      ev.id,
      ev.incident_id,
      outcome,
      codes,
      isoOf(atMs),
      window?.firstSampleAt ?? null,
      window?.lastSampleAt ?? null,
      window?.sampleCount ?? 0,
      window?.stableMs ?? 0,
      canonicalDigest('recovery-assessment', 1, { evaluationId: ev.id, outcome, codes, asOf: isoOf(atMs), window }),
      actor.kind,
      actor.id,
    ],
  );
}

/** VERIFYING -> ESCALATED through M04's engine path, re-read and retried once on a version race. */
export async function escalate(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  why: { evaluationId: string; reason: string },
): Promise<{ incidentState: string; incidentVersion: number }> {
  const meta = { action: 'recovery.escalate', resourceType: 'incident', resourceId: incidentId };
  for (let i = 0; i < 3; i++) {
    const cur = await tenantCommand(pool, ctx, meta, (c) =>
      loadIncident(c, ctx, meta, incidentId, { action: null, lock: null }),
    );
    if (cur.state !== 'VERIFYING') return { incidentState: cur.state, incidentVersion: cur.version };
    const common = {
      expectedVersion: cur.version,
      idempotencyKey: `rcv-esc-${why.evaluationId.slice(4, 44)}-${cur.version}`,
      reasonCode: `RECOVERY_${why.reason}`.slice(0, 64),
    };
    try {
      // The engine escalates through M04's engine path; a human (a dispute) through M04's own operator command.
      const r =
        ctx.principal.kind === 'HUMAN'
          ? await escalateIncident(pool, ctx, incidentId, common)
          : await advanceIncident(pool, ctx, incidentId, { ...common, to: 'ESCALATED', guardRef: why.evaluationId });
      return { incidentState: r.state, incidentVersion: r.version };
    } catch (e) {
      if ((e as DomainError).code !== 'VERSION_CONFLICT') throw e;
    }
  }
  throw new DomainError('VERSION_CONFLICT', 'The incident kept changing while escalating.', {
    reasonCode: 'ESCALATION_RACED',
  });
}
