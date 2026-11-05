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

export interface DisputeFaults {
  /** Thrown from here simulates a crash after the dispute committed and before its reopen/escalation. */
  beforeEffect?(): void;
}

/**
 * Dispute recovery evidence. The dispute row commits first (incident -> open evaluation locked, the closeout's order,
 * so a racing PASSED either commits before it or never). Its incident effect (escalate an open evaluation's incident,
 * or reopen a recovered one whose closeout pins this evidence) is then applied and the Idempotency-Key receipt is
 * written only once that effect is durable. A replay or a new request on already-disputed evidence re-derives the
 * effect from durable state and completes it, so a crash between the two never yields a cached success.
 */
export async function disputeRecoveryEvidence(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof DisputeSchema>,
  opts: { faults?: DisputeFaults } = {},
): Promise<DisputeResult> {
  const input = parseInput(DisputeSchema, raw);
  const meta = { action: 'recovery.evidence.dispute', resourceType: 'recovery_evidence', resourceId: input.evidenceId };
  const first = await tenantCommand(pool, ctx, meta, async (c) => {
    const ev0 = await loadEvidence(c, ctx.tenantId, input.evidenceId);
    if (!ev0) throw unavailable(meta);
    // Lock order: incident first (as the closeout), then the open evaluation, then the dispute insert.
    const inc = await loadIncident(c, ctx, meta, ev0.incident_id, { action: 'recovery.dispute', lock: 'UPDATE' });
    const digest = requestDigest(ctx, 'recovery.dispute.v1', { evidenceId: ev0.id, reasonCode: input.reasonCode });
    const prior = await readReceipt<DisputeResult>(c, ctx, input.idempotencyKey, digest);
    if (prior) return { settled: prior, digest, incidentId: inc.id, disputeId: prior.disputeId, evidenceId: ev0.id };
    const openLocked = await c.query<EvaluationRow>(
      `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state IN ('PENDING', 'OBSERVING')
        FOR UPDATE`,
      [ctx.tenantId, inc.id],
    );
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM recovery_evidence_disputes WHERE tenant_id = $1 AND evidence_id = $2`,
      [ctx.tenantId, ev0.id],
    );
    let disputeId = existing.rows[0]?.id;
    if (!disputeId) {
      disputeId = newRecoveryId('dispute');
      const actor = actorFor(ctx);
      await c.query(
        `INSERT INTO recovery_evidence_disputes (tenant_id, id, evidence_id, incident_id, reason_code, actor_kind, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, disputeId, ev0.id, inc.id, input.reasonCode, actor.kind, actor.id],
      );
      await recordAudit(c, ctx, {
        ...meta,
        result: 'SUCCEEDED',
        reasonCode: input.reasonCode,
        metadata: { disputeId },
      });
    }
    // An open evaluation resting on this evidence fails in the same transaction as the dispute.
    const ev = openLocked.rows[0];
    if (inc.state === 'VERIFYING' && ev) {
      const milestone = (
        await c.query<{ source_evidence_id: string }>(
          `SELECT source_evidence_id FROM intervention_milestones WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, ev.milestone_id],
        )
      ).rows[0];
      const bound =
        milestone?.source_evidence_id === ev0.id ||
        (ev0.plan_id === ev.plan_id &&
          ev0.action_digest === ev.action_digest &&
          (ev0.source_kind === 'CMMS' || ev0.source_kind === 'AUTHORIZED_OPERATOR'));
      if (bound) {
        const { atMs } = await evaluationInstant(c, undefined);
        await decide(c, ctx, ev, 'FAILED', 'EVIDENCE_DISPUTED', atMs, [input.reasonCode]);
      }
    }
    return { settled: null, digest, incidentId: inc.id, disputeId, evidenceId: ev0.id };
  });
  if (first.settled) return first.settled;
  opts.faults?.beforeEffect?.();
  const incidentEffect = await applyDisputeEffect(
    pool,
    ctx,
    first.incidentId,
    first.evidenceId,
    first.disputeId,
    input.reasonCode,
  );
  const result: DisputeResult = { disputeId: first.disputeId, evidenceId: first.evidenceId, incidentEffect };
  // The receipt is written only now that the effect is durable.
  return tenantCommand(pool, ctx, meta, (c) =>
    writeReceipt(c, ctx, input.idempotencyKey, 'recovery.dispute.v1', first.digest, result),
  );
}

/** Re-derive and complete a dispute's incident effect from durable state (idempotent). */
async function applyDisputeEffect(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  evidenceId: string,
  disputeId: string,
  reasonCode: string,
): Promise<DisputeResult['incidentEffect']> {
  const meta = { action: 'recovery.evidence.dispute', resourceType: 'incident', resourceId: incidentId };
  const state = await tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await loadIncident(c, ctx, meta, incidentId, { action: 'recovery.dispute', lock: null });
    const pinning = await c.query<CloseoutRow & { reopen_ref: string | null }>(
      `SELECT co.* FROM recovery_closeouts co
        WHERE co.tenant_id = $1 AND co.incident_id = $2
          AND (EXISTS (SELECT 1 FROM intervention_milestones m WHERE m.tenant_id = co.tenant_id AND m.id = co.milestone_id
                         AND m.source_evidence_id = $3)
            OR EXISTS (SELECT 1 FROM recovery_evaluation_signoffs g WHERE g.tenant_id = co.tenant_id
                         AND g.evaluation_id = co.evaluation_id AND g.evidence_id = $3))
        ORDER BY co.recovery_cycle DESC LIMIT 1`,
      [ctx.tenantId, inc.id, evidenceId],
    );
    const failed = await c.query<{ id: string }>(
      `SELECT ev.id FROM recovery_evaluations ev
        WHERE ev.tenant_id = $1 AND ev.incident_id = $2 AND ev.recovery_cycle = $3 AND ev.state = 'FAILED'
          AND ev.state_reason = 'EVIDENCE_DISPUTED'
          AND EXISTS (SELECT 1 FROM recovery_evaluation_transitions t WHERE t.tenant_id = ev.tenant_id
                        AND t.evaluation_id = ev.id AND t.to_state = 'FAILED')
        ORDER BY ev.decided_at DESC LIMIT 1`,
      [ctx.tenantId, inc.id, inc.reopen_count],
    );
    return { inc, closeout: pinning.rows[0], failedEvaluationId: failed.rows[0]?.id ?? null };
  });
  const { inc, closeout } = state;
  if (closeout) {
    if (closeout.reopened_at !== null) return 'REOPENED';
    if (inc.state === 'RECOVERED' && closeout.recovery_cycle === inc.reopen_count) {
      await reopenIncident(pool, ctx, inc.id, {
        expectedVersion: inc.version,
        idempotencyKey: `rcv-dispute-${disputeId.slice(4, 44)}`,
        reasonCode: 'RECOVERY_EVIDENCE_DISPUTED',
        note: `Recovery evidence ${evidenceId} disputed (${reasonCode}).`,
      });
      await stampAfterReopen(pool, ctx, closeout, 'RECOVERY_EVIDENCE_DISPUTED', disputeId);
      return 'REOPENED';
    }
  }
  if (state.failedEvaluationId) {
    const r = await escalate(pool, ctx, inc.id, {
      evaluationId: state.failedEvaluationId,
      reason: 'EVIDENCE_DISPUTED',
    });
    return r.incidentState === 'ESCALATED' ? 'ESCALATED' : 'EVALUATION_FAILED';
  }
  return 'NONE';
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
