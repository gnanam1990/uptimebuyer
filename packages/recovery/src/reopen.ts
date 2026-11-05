// Escalation and reopening (FR-16, FR-17, INV-01, INV-10). Disputed recovery evidence fails the open evaluation and
// escalates the incident, or, after closeout, reopens it through M04; a lost recovery signal inside the pinned watch
// window reopens it through M04's engine path; a repeat fault is reopened by M04's own rule engine and linked here from
// `incident.reopened.v1`. The closeout is never deleted or rewritten: it gets a one-shot reopen stamp (reason and the
// record that caused it), the PASSED evaluation and its pins stay as they were, and a REOPEN update is queued for the
// CMMS. Lock order: incident row (FOR UPDATE) -> evaluation row (FOR UPDATE), the same as the closeout transaction, so a
// dispute and a PASSED commit serialize and exactly one wins.
import type { DomainError } from '@uptimebuyer/contracts';
import { UtcInstantSchema, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import {
  consumeOnce,
  recordAudit,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { reopenIncident, reopenRecoveredIncident } from '@uptimebuyer/incidents';
import { z } from 'zod';
import { decide, escalate } from './assess.js';
import { enqueueCmmsUpdate } from './cmms.js';
import { loadEvidence } from './evidence.js';
import type { EvaluationRow } from './evaluation.js';
import {
  IdempotencyKey,
  actorFor,
  evaluationInstant,
  loadIncident,
  newRecoveryId,
  parseInput,
  readReceipt,
  requestDigest,
  requireAt,
  writeReceipt,
} from './internal.js';
import { num } from './policy.js';

interface CloseoutRow {
  id: string;
  incident_id: string;
  site_id: string;
  evaluation_id: string;
  recovery_cycle: number;
  reopened_at: Date | null;
}

/** One-shot reopen stamp + the CMMS REOPEN update, in the caller's transaction (no-op when already stamped). */
export async function stampCloseoutReopened(
  c: Tx,
  tenantId: string,
  closeout: CloseoutRow,
  reasonCode: string,
  ref: string,
  reopenCount: number,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE recovery_closeouts SET reopened_at = clock_timestamp(), reopen_reason_code = $3, reopen_ref = $4
      WHERE tenant_id = $1 AND id = $2 AND reopened_at IS NULL`,
    [tenantId, closeout.id, reasonCode.slice(0, 64), ref],
  );
  if (rowCount !== 1) return false;
  await enqueueCmmsUpdate(c, tenantId, {
    incidentId: closeout.incident_id,
    siteId: closeout.site_id,
    updateKind: 'REOPEN',
    sourceType: 'recovery_closeout',
    sourceId: closeout.id,
    sourceVersion: 1,
    payload: {
      status: 'REOPENED',
      closeoutId: closeout.id,
      recoveryEvaluationId: closeout.evaluation_id,
      recoveryCycle: closeout.recovery_cycle,
      reopenCount,
      reasonCode,
      reopenRef: ref,
    },
  });
  return true;
}

async function stampAfterReopen(pool: Db, ctx: TenantContext, closeout: CloseoutRow, reason: string, ref: string) {
  const meta = { action: 'recovery.closeout.reopen', resourceType: 'recovery_closeout', resourceId: closeout.id };
  await tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await c.query<{ reopen_count: number }>(
      `SELECT reopen_count FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, closeout.incident_id],
    );
    if (await stampCloseoutReopened(c, ctx.tenantId, closeout, reason, ref, inc.rows[0]!.reopen_count))
      await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: reason.slice(0, 64) });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Disputes

const DisputeSchema = z.strictObject({
  evidenceId: z.string().max(128),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  idempotencyKey: IdempotencyKey,
});

export interface DisputeResult extends Record<string, unknown> {
  disputeId: string;
  evidenceId: string;
  incidentEffect: 'NONE' | 'EVALUATION_FAILED' | 'ESCALATED' | 'REOPENED';
}

export async function disputeRecoveryEvidence(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof DisputeSchema>,
): Promise<DisputeResult> {
  const input = parseInput(DisputeSchema, raw);
  const meta = { action: 'recovery.evidence.dispute', resourceType: 'recovery_evidence', resourceId: input.evidenceId };
  const planned = await tenantCommand(pool, ctx, meta, async (c) => {
    const ev0 = await loadEvidence(c, ctx.tenantId, input.evidenceId);
    if (!ev0) throw unavailable(meta);
    // Lock order: incident first (as the closeout), then the evaluation.
    const inc = await loadIncident(c, ctx, meta, ev0.incident_id, { action: 'recovery.dispute', lock: 'UPDATE' });
    const digest = requestDigest(ctx, 'recovery.dispute.v1', { evidenceId: ev0.id, reasonCode: input.reasonCode });
    const prior = await readReceipt<DisputeResult>(c, ctx, input.idempotencyKey, digest);
    if (prior) return { result: prior, effect: null };
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM recovery_evidence_disputes WHERE tenant_id = $1 AND evidence_id = $2`,
      [ctx.tenantId, ev0.id],
    );
    if (existing.rows[0]) {
      const result: DisputeResult = { disputeId: existing.rows[0].id, evidenceId: ev0.id, incidentEffect: 'NONE' };
      return {
        result: await writeReceipt(c, ctx, input.idempotencyKey, 'recovery.dispute.v1', digest, result),
        effect: null,
      };
    }
    // Lock the open evaluation (incident -> evaluation, the closeout's order) before the dispute exists.
    const openLocked = await c.query<EvaluationRow>(
      `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state IN ('PENDING', 'OBSERVING')
        FOR UPDATE`,
      [ctx.tenantId, inc.id],
    );
    const disputeId = newRecoveryId('dispute');
    const actor = actorFor(ctx);
    await c.query(
      `INSERT INTO recovery_evidence_disputes (tenant_id, id, evidence_id, incident_id, reason_code, actor_kind, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, disputeId, ev0.id, inc.id, input.reasonCode, actor.kind, actor.id],
    );
    let effect:
      { kind: 'ESCALATE'; evaluationId: string } | { kind: 'REOPEN'; closeout: CloseoutRow; version: number } | null =
      null;
    if (inc.state === 'VERIFYING') {
      const ev = openLocked.rows[0];
      const milestone = ev
        ? (
            await c.query<{ source_evidence_id: string }>(
              `SELECT source_evidence_id FROM intervention_milestones WHERE tenant_id = $1 AND id = $2`,
              [ctx.tenantId, ev.milestone_id],
            )
          ).rows[0]
        : undefined;
      const bound =
        ev &&
        (milestone?.source_evidence_id === ev0.id ||
          (ev0.plan_id === ev.plan_id &&
            ev0.action_digest === ev.action_digest &&
            (ev0.source_kind === 'CMMS' || ev0.source_kind === 'AUTHORIZED_OPERATOR')));
      if (ev && bound) {
        const { atMs } = await evaluationInstant(c, undefined);
        await decide(c, ctx, ev, 'FAILED', 'EVIDENCE_DISPUTED', atMs, [input.reasonCode]);
        effect = { kind: 'ESCALATE', evaluationId: ev.id };
      }
    } else if (inc.state === 'RECOVERED') {
      const co = await c.query<CloseoutRow>(
        `SELECT co.* FROM recovery_closeouts co
          WHERE co.tenant_id = $1 AND co.incident_id = $2 AND co.recovery_cycle = $3 AND co.reopened_at IS NULL
            AND (EXISTS (SELECT 1 FROM intervention_milestones m WHERE m.tenant_id = co.tenant_id AND m.id = co.milestone_id
                           AND m.source_evidence_id = $4)
              OR EXISTS (SELECT 1 FROM recovery_evaluation_signoffs g WHERE g.tenant_id = co.tenant_id
                           AND g.evaluation_id = co.evaluation_id AND g.evidence_id = $4))`,
        [ctx.tenantId, inc.id, inc.reopen_count, ev0.id],
      );
      if (co.rows[0]) effect = { kind: 'REOPEN', closeout: co.rows[0], version: inc.version };
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode, metadata: { disputeId } });
    const result: DisputeResult = {
      disputeId,
      evidenceId: ev0.id,
      incidentEffect: effect === null ? 'NONE' : effect.kind === 'ESCALATE' ? 'ESCALATED' : 'REOPENED',
    };
    return {
      result: await writeReceipt(c, ctx, input.idempotencyKey, 'recovery.dispute.v1', digest, result),
      effect,
      incidentId: inc.id,
    };
  });
  const { result, effect } = planned;
  if (!effect) return result;
  const incidentId = (planned as { incidentId: string }).incidentId;
  if (effect.kind === 'ESCALATE') {
    const r = await escalate(pool, ctx, incidentId, { evaluationId: effect.evaluationId, reason: 'EVIDENCE_DISPUTED' });
    return r.incidentState === 'ESCALATED' ? result : { ...result, incidentEffect: 'EVALUATION_FAILED' };
  }
  await reopenIncident(pool, ctx, incidentId, {
    expectedVersion: effect.version,
    idempotencyKey: `rcv-dispute-${result.disputeId.slice(4, 44)}`,
    reasonCode: 'RECOVERY_EVIDENCE_DISPUTED',
    note: `Recovery evidence ${result.evidenceId} disputed (${input.reasonCode}).`,
  });
  await stampAfterReopen(pool, ctx, effect.closeout, 'RECOVERY_EVIDENCE_DISPUTED', result.disputeId);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Lost recovery signal

const MonitorSchema = z.strictObject({ asOf: UtcInstantSchema.optional(), limit: z.int().min(1).max(500).optional() });

interface WatchRow extends CloseoutRow {
  version: number;
  lost_signal_after_ms: string;
  newest: Date | null;
  at: Date;
}

export async function monitorRecoveredIncidents(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof MonitorSchema>,
): Promise<{ checked: number; reopened: string[] }> {
  const input = parseInput(MonitorSchema, raw);
  const meta = { action: 'recovery.monitor', resourceType: 'incident', resourceId: null };
  const rows = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'recovery.engine', null);
    const { atMs } = await evaluationInstant(c, input.asOf);
    const { rows } = await c.query<WatchRow>(
      `SELECT co.*, i.version, p.lost_signal_after_ms, $2::timestamptz AS at,
              (SELECT max(s.event_at) FROM telemetry_samples s
                 JOIN recovery_evaluation_channels pc ON pc.tenant_id = s.tenant_id AND pc.channel_id = s.channel_id
                WHERE pc.tenant_id = co.tenant_id AND pc.evaluation_id = co.evaluation_id
                  AND s.ingestion_class = 'LIVE' AND s.delivery = 'LIVE' AND cardinality(s.quality_flags) = 0
                  AND s.event_at <= $2::timestamptz + interval '5 seconds') AS newest
         FROM recovery_closeouts co
         JOIN incidents i ON i.tenant_id = co.tenant_id AND i.id = co.incident_id
         JOIN recovery_evaluations ev ON ev.tenant_id = co.tenant_id AND ev.id = co.evaluation_id
         JOIN recovery_policy_revisions p ON p.tenant_id = ev.tenant_id AND p.id = ev.recovery_policy_revision_id
         JOIN incident_rule_revisions rr ON rr.tenant_id = ev.tenant_id AND rr.id = ev.rule_revision_id
        WHERE co.tenant_id = $1 AND co.reopened_at IS NULL AND i.state = 'RECOVERED' AND co.recovery_cycle = i.reopen_count
          AND co.decided_at + rr.watch_window_ms * interval '1 millisecond' >= $2::timestamptz
        ORDER BY co.decided_at, co.id LIMIT $3`,
      [ctx.tenantId, new Date(atMs).toISOString(), input.limit ?? 100],
    );
    return rows;
  });
  const reopened: string[] = [];
  for (const r of rows) {
    const lost = r.newest === null || r.at.getTime() - r.newest.getTime() > num(r.lost_signal_after_ms);
    if (!lost) continue;
    try {
      await reopenRecoveredIncident(pool, ctx, r.incident_id, {
        expectedVersion: r.version,
        idempotencyKey: `rcv-lost-${r.id.slice(4, 44)}`,
        reasonCode: 'RECOVERY_SIGNAL_LOST',
        guardRef: r.id,
      });
    } catch (e) {
      const code = (e as DomainError).code;
      if (code === 'VERSION_CONFLICT' || code === 'STATE_TRANSITION_INVALID') continue;
      throw e;
    }
    await stampAfterReopen(pool, ctx, r, 'RECOVERY_SIGNAL_LOST', r.id);
    reopened.push(r.incident_id);
  }
  return { checked: rows.length, reopened };
}

// ---------------------------------------------------------------------------------------------------------------
// Repeat fault (M04-initiated reopen) linkage

export const RECOVERY_REOPEN_CONSUMER = 'recovery-closeout-reopen.v1';

export async function handleIncidentReopenedEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE'> {
  return consumeOnce(pool, RECOVERY_REOPEN_CONSUMER, envelope, async (c, ctx) => {
    if (envelope.eventType !== 'incident.reopened.v1') return;
    const p = envelope.payload as { reopenCount?: number; reasonCode?: string };
    if (typeof p.reopenCount !== 'number' || p.reopenCount < 1 || typeof p.reasonCode !== 'string') return;
    const { rows } = await c.query<CloseoutRow>(
      `SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2 AND recovery_cycle = $3`,
      [ctx.tenantId, envelope.aggregateId, p.reopenCount - 1],
    );
    if (rows[0]) await stampCloseoutReopened(c, ctx.tenantId, rows[0], p.reasonCode, envelope.eventId, p.reopenCount);
  });
}
