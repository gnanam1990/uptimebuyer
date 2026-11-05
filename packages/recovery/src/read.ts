// Recovery reads (INV-11, INV-14, INV-16). The recovery gate is the single answer to "may completion-dependent value
// be released?": true only while the incident is RECOVERED under a non-reopened closeout of its current cycle whose
// evaluation PASSED. Metrics never count a reopened closeout as a stable recovery. Every read authorizes at the
// incident's site; foreign and out-of-site ids are the same RESOURCE_UNAVAILABLE as absence.
import { SiteIdSchema } from '@uptimebuyer/contracts';
import { readableSites, tenantCommand, unavailable, type Db, type TenantContext, type Tx } from '@uptimebuyer/data';
import { canReadAt, isoOf, isoOrNull, loadIncident, requireAt, type IncidentRow } from './internal.js';

export interface RecoveryGate extends Record<string, unknown> {
  incidentId: string;
  recovered: boolean;
  releasesCompletionValue: boolean;
  closeoutId: string | null;
  reasons: string[];
}

async function gateOf(c: Tx, inc: IncidentRow): Promise<RecoveryGate> {
  const { rows } = await c.query<{ id: string; recovery_cycle: number; reopened_at: Date | null; state: string }>(
    `SELECT co.id, co.recovery_cycle, co.reopened_at, ev.state FROM recovery_closeouts co
       JOIN recovery_evaluations ev ON ev.tenant_id = co.tenant_id AND ev.id = co.evaluation_id
      WHERE co.tenant_id = $1 AND co.incident_id = $2 ORDER BY co.recovery_cycle`,
    [inc.tenant_id, inc.id],
  );
  const current = rows.find(
    (r) => r.recovery_cycle === inc.reopen_count && r.reopened_at === null && r.state === 'PASSED',
  );
  const reasons: string[] = [];
  if (inc.state !== 'RECOVERED') reasons.push('INCIDENT_NOT_RECOVERED');
  if (!current) reasons.push('NO_ACTIVE_CLOSEOUT');
  if (rows.some((r) => r.reopened_at !== null)) reasons.push('CLOSEOUT_REOPENED');
  const recovered = inc.state === 'RECOVERED' && current !== undefined;
  return {
    incidentId: inc.id,
    recovered,
    releasesCompletionValue: recovered,
    closeoutId: recovered ? current!.id : null,
    reasons: recovered ? [] : reasons,
  };
}

export async function getRecoveryGate(pool: Db, ctx: TenantContext, incidentId: string): Promise<RecoveryGate> {
  const meta = { action: 'recovery.read', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await loadIncident(c, ctx, meta, incidentId, { action: 'recovery.read', lock: null });
    return gateOf(c, inc);
  });
}

export async function getRecoveryStatus(pool: Db, ctx: TenantContext, incidentId: string) {
  const meta = { action: 'recovery.read', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await loadIncident(c, ctx, meta, incidentId, { action: 'recovery.read', lock: null });
    const ms = await c.query(
      `SELECT * FROM intervention_milestones WHERE tenant_id = $1 AND incident_id = $2 ORDER BY verified_at, id`,
      [ctx.tenantId, inc.id],
    );
    const evs = await c.query(
      `SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at, id`,
      [ctx.tenantId, inc.id],
    );
    const cos = await c.query(
      `SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recovery_cycle`,
      [ctx.tenantId, inc.id],
    );
    return {
      incidentId: inc.id,
      incidentState: inc.state,
      recoveryCycle: inc.reopen_count,
      milestones: ms.rows.map((m) => ({
        interventionMilestoneId: m.id as string,
        milestoneType: m.milestone_type as string,
        occurredAt: isoOf(m.occurred_at),
        verifiedAt: isoOf(m.verified_at),
        sourceEvidenceId: m.source_evidence_id as string,
        sourceKind: m.source_kind as string,
        recoveryCycle: m.recovery_cycle as number,
      })),
      evaluations: evs.rows.map((e) => ({
        recoveryEvaluationId: e.id as string,
        state: e.state as string,
        stateReason: e.state_reason as string | null,
        recoveryCycle: e.recovery_cycle as number,
        interventionMilestoneId: e.milestone_id as string,
        observationBoundaryAt: isoOf(e.observation_boundary_at),
        actionDigest: e.action_digest as string,
        recoveryPolicyRevisionId: e.recovery_policy_revision_id as string,
        expiresAt: isoOf(e.expires_at),
        decidedAt: isoOrNull(e.decided_at),
      })),
      closeouts: cos.rows.map((co) => ({
        closeoutId: co.id as string,
        recoveryEvaluationId: co.evaluation_id as string,
        recoveryCycle: co.recovery_cycle as number,
        manifestDigest: co.manifest_digest as string,
        decidedAt: isoOf(co.decided_at),
        reopenedAt: isoOrNull(co.reopened_at),
        reopenReasonCode: co.reopen_reason_code as string | null,
      })),
      gate: await gateOf(c, inc),
    };
  });
}

export async function getCloseout(pool: Db, ctx: TenantContext, closeoutId: string) {
  const meta = { action: 'recovery.read', resourceType: 'recovery_closeout', resourceId: closeoutId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (!/^rco_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(closeoutId)) throw unavailable(meta);
    const { rows } = await c.query(`SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      closeoutId,
    ]);
    const co = rows[0];
    if (!co || !canReadAt(ctx, co.site_id)) throw unavailable(meta);
    requireAt(ctx, meta, 'recovery.read', co.site_id);
    return {
      closeoutId: co.id as string,
      incidentId: co.incident_id as string,
      recoveryEvaluationId: co.evaluation_id as string,
      recoveryCycle: co.recovery_cycle as number,
      manifest: co.manifest as Record<string, unknown>,
      manifestDigest: co.manifest_digest as string,
      decisionSignature: co.decision_signature as string,
      signatureKeyId: co.signature_key_id as string,
      decidedAt: isoOf(co.decided_at),
      reopenedAt: isoOrNull(co.reopened_at),
      reopenReasonCode: co.reopen_reason_code as string | null,
      reopenRef: co.reopen_ref as string | null,
    };
  });
}

/**
 * Closeout metrics over the sites the caller may read (or one named site): `reopened` closeouts were followed by a
 * reopen of their incident (whatever the cause) and are never `stable`; `pendingWatch` closeouts are still inside the
 * pinned watch window; `stable` closeouts outlived it without a reopen.
 */
export async function recoveryMetrics(
  pool: Db,
  ctx: TenantContext,
  opts: { siteId?: string },
): Promise<{ closeouts: number; stable: number; pendingWatch: number; reopened: number }> {
  const meta = { action: 'recovery.metrics', resourceType: 'site', resourceId: opts.siteId ?? null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    let sites: string[] | null;
    if (opts.siteId !== undefined) {
      if (!SiteIdSchema.safeParse(opts.siteId).success) throw unavailable(meta);
      requireAt(ctx, meta, 'recovery.read', opts.siteId);
      sites = [opts.siteId];
    } else sites = readableSites(ctx);
    const { rows } = await c.query<{ closeouts: number; reopened: number; pending: number; stable: number }>(
      `SELECT count(*)::int AS closeouts,
              count(*) FILTER (WHERE i.reopen_count > co.recovery_cycle)::int AS reopened,
              count(*) FILTER (WHERE i.reopen_count = co.recovery_cycle
                AND co.decided_at + rr.watch_window_ms * interval '1 millisecond' > clock_timestamp())::int AS pending,
              count(*) FILTER (WHERE i.reopen_count = co.recovery_cycle
                AND co.decided_at + rr.watch_window_ms * interval '1 millisecond' <= clock_timestamp())::int AS stable
         FROM recovery_closeouts co
         JOIN incidents i ON i.tenant_id = co.tenant_id AND i.id = co.incident_id
         JOIN recovery_evaluations ev ON ev.tenant_id = co.tenant_id AND ev.id = co.evaluation_id
         JOIN incident_rule_revisions rr ON rr.tenant_id = ev.tenant_id AND rr.id = ev.rule_revision_id
        WHERE co.tenant_id = $1 AND ($2::text[] IS NULL OR co.site_id = ANY($2::text[]))`,
      [ctx.tenantId, sites],
    );
    const r = rows[0]!;
    return { closeouts: r.closeouts, stable: r.stable, pendingWatch: r.pending, reopened: r.reopened };
  });
}
