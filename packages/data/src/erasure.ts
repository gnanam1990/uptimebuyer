// Retention, privacy-request execution and erasure (M13; FR-23, INV-10, NFR-06). Governed raw payloads — raw
// fulfillment-webhook bodies (M10, and their transient copies in job payloads), raw CMMS record bodies (M11) and raw
// communication bodies (M07) — are erased by a retention sweep once the tenant's effective RETENTION policy window
// has passed, or by an executed DELETION/REDACTION privacy request within its scope. Erasure is the one tombstoned
// change the database permits on those append-only rows (migration 0020): the payload goes, every digest, seal,
// ledger entry and decision stays, so historical decisions remain reproducible. An active legal hold blocks both
// paths (service and database). Each erasure leaves a non-sensitive tombstone (which row, which column, which
// digest, why, under which request or retention revision) and an audit entry. Export returns a minimized manifest by
// digest, never raw content.
import { DomainError, type TenantId } from '@uptimebuyer/contracts';
import { requireAuthorized } from './authz.js';
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { actorOf, issueWorkerContext, type TenantContext } from './context.js';
import { isoNN, type Db, type Tx } from './db.js';
import { newDataId } from './ids.js';
import { overlappingHold } from './privacy.js';

export const ERASURE_TARGETS = Object.freeze([
  'fulfillment_observations',
  'recovery_evidence',
  'provider_communication_bodies',
] as const);
export type ErasureTarget = (typeof ERASURE_TARGETS)[number];
export type ErasureCounts = Record<ErasureTarget, number>;

const FULFILLMENT_JOB = 'orders.fulfillment_observation';
const zero = (): ErasureCounts => ({
  fulfillment_observations: 0,
  recovery_evidence: 0,
  provider_communication_bodies: 0,
});

interface Basis {
  kind: 'RETENTION_EXPIRED' | 'PRIVACY_REQUEST';
  retentionPolicyRevisionId: string | null;
  privacyRequestId: string | null;
}

/** Scope filter over (site, asset, incident) columns; null = the whole tenant. */
interface Scope {
  siteId: string | null;
  assetId: string | null;
  incidentId: string | null;
}
const WHOLE_TENANT: Scope = { siteId: null, assetId: null, incidentId: null };

async function tombstone(
  c: Tx,
  ctx: TenantContext,
  basis: Basis,
  target: { table: ErasureTarget; id: string; column: string; digest: string | null },
): Promise<string> {
  const id = newDataId('redactionTombstone');
  const actor = actorOf(ctx);
  await c.query(
    `INSERT INTO redaction_tombstones (tenant_id, id, privacy_request_id, target_table, target_id, reason_code, basis,
       retention_policy_revision_id, target_column, erased_digest, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      ctx.tenantId,
      id,
      basis.privacyRequestId,
      target.table,
      target.id,
      basis.kind,
      basis.kind,
      basis.retentionPolicyRevisionId,
      target.column,
      target.digest && /^sha256:[0-9a-f]{64}$/.test(target.digest) ? target.digest : null,
      actor.kind === 'HUMAN' || actor.kind === 'SERVICE' ? actor.kind : 'WORKER',
      actor.id.slice(0, 128),
    ],
  );
  return id;
}

/** Candidate rows with their hold coverage, locked for this transaction (SKIP LOCKED: a concurrent sweep skips). */
async function candidates(
  c: Tx,
  tenantId: string,
  target: ErasureTarget,
  scope: Scope,
  maxAgeDays: number | null,
  limit: number,
): Promise<{ id: string; digest: string | null; held: boolean }[]> {
  // The retention window is a bound parameter ($6), never interpolated; a malformed window erases nothing.
  if (maxAgeDays !== null && !(Number.isInteger(maxAgeDays) && maxAgeDays >= 1 && maxAgeDays <= 36_500)) return [];
  const age = (col: string) => `($6::int IS NULL OR ${col} < clock_timestamp() - make_interval(days => $6::int))`;
  const params = [tenantId, scope.siteId, scope.assetId, scope.incidentId, limit, maxAgeDays];
  const inScope = (site: string, asset: string, inc: string) =>
    `($2::text IS NULL OR ${site} = $2) AND ($3::text IS NULL OR ${asset} = $3) AND ($4::text IS NULL OR ${inc} = $4)`;
  let sql: string;
  if (target === 'fulfillment_observations')
    sql = `SELECT o.id, o.raw_body_digest AS digest,
                  ub_legal_hold_covers(o.tenant_id, coalesce(po.site_id, sj.site_id), i.asset_id, i.id) AS held
             FROM fulfillment_observations o
             LEFT JOIN purchase_orders po ON po.tenant_id = o.tenant_id AND po.id = o.purchase_order_id
             LEFT JOIN service_jobs sj ON sj.tenant_id = o.tenant_id AND sj.id = o.service_job_id
             LEFT JOIN incidents i ON i.tenant_id = o.tenant_id AND i.id = coalesce(po.incident_id, sj.incident_id)
            WHERE o.tenant_id = $1 AND o.raw_body IS NOT NULL AND ${age('o.recorded_at')}
              AND ${inScope('coalesce(po.site_id, sj.site_id)', 'i.asset_id', 'i.id')}
            ORDER BY o.recorded_at, o.id LIMIT $5 FOR UPDATE OF o SKIP LOCKED`;
  else if (target === 'recovery_evidence')
    sql = `SELECT e.id, e.body_digest AS digest, ub_legal_hold_covers(e.tenant_id, e.site_id, e.asset_id, e.incident_id) AS held
             FROM recovery_evidence e
            WHERE e.tenant_id = $1 AND e.source_kind = 'CMMS' AND e.body_erased_at IS NULL AND ${age('e.recorded_at')}
              AND ${inScope('e.site_id', 'e.asset_id', 'e.incident_id')}
            ORDER BY e.recorded_at, e.id LIMIT $5 FOR UPDATE OF e SKIP LOCKED`;
  else
    sql = `SELECT b.id, m.content_digest AS digest, ub_legal_hold_covers(b.tenant_id, m.site_id, q.asset_id, m.incident_id) AS held
             FROM provider_communication_bodies b
             JOIN provider_communications m ON m.tenant_id = b.tenant_id AND m.id = b.communication_id
             LEFT JOIN provider_contact_requests q ON q.tenant_id = m.tenant_id AND q.id = m.contact_request_id
            WHERE b.tenant_id = $1 AND b.erased_at IS NULL
              AND (${age('m.recorded_at')}${maxAgeDays === null ? '' : ' OR (m.retain_until IS NOT NULL AND m.retain_until < clock_timestamp())'})
              AND ${inScope('m.site_id', 'q.asset_id', 'm.incident_id')}
            ORDER BY m.recorded_at, b.id LIMIT $5 FOR UPDATE OF b SKIP LOCKED`;
  return (await c.query(sql, params)).rows.map((r) => ({ id: r.id, digest: r.digest ?? null, held: r.held === true }));
}

async function eraseRow(
  c: Tx,
  ctx: TenantContext,
  basis: Basis,
  target: ErasureTarget,
  row: { id: string; digest: string | null },
) {
  const column =
    target === 'fulfillment_observations' ? 'raw_body' : target === 'recovery_evidence' ? 'body' : 'raw_text';
  const tomb = await tombstone(c, ctx, basis, { table: target, id: row.id, column, digest: row.digest });
  if (target === 'fulfillment_observations')
    await c.query(
      `UPDATE fulfillment_observations SET raw_body = NULL, raw_body_erased_at = clock_timestamp(), raw_body_erasure_id = $3
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.id, tomb],
    );
  else if (target === 'recovery_evidence')
    await c.query(
      `UPDATE recovery_evidence SET body = '{"erased": true}'::jsonb, body_erased_at = clock_timestamp(), body_erasure_id = $3
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.id, tomb],
    );
  else
    await c.query(
      `UPDATE provider_communication_bodies SET raw_text = NULL, erased_at = clock_timestamp(), erasure_reason = $3
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.id, basis.kind],
    );
}

const lockHolds = (c: Tx, tenantId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`legal-hold:${tenantId}`]);

async function eraseIn(
  c: Tx,
  ctx: TenantContext,
  basis: Basis,
  targets: readonly ErasureTarget[],
  scope: Scope,
  ageDays: (t: ErasureTarget) => number | null,
  limit: number,
): Promise<{ erased: ErasureCounts; heldSkipped: number }> {
  const erased = zero();
  let heldSkipped = 0;
  for (const target of targets) {
    for (const row of await candidates(c, ctx.tenantId, target, scope, ageDays(target), limit)) {
      if (row.held) {
        heldSkipped++;
        continue;
      }
      await eraseRow(c, ctx, basis, target, row);
      erased[target]++;
    }
  }
  return { erased, heldSkipped };
}

export interface RetentionSweepResult {
  policyRevisionId: string | null;
  erased: ErasureCounts;
  heldSkipped: number;
  scrubbedJobs: number;
}

/**
 * Erase raw payloads past the tenant's effective RETENTION windows (bounded batch per target) and scrub transient
 * raw-body copies from finished fulfillment jobs. Rows covered by an active legal hold are skipped and counted.
 * Idempotent; safe to run concurrently (rows are claimed with SKIP LOCKED).
 */
export async function runRetentionSweep(
  pool: Db,
  ctx: TenantContext,
  opts: { batchSize?: number } = {},
): Promise<RetentionSweepResult> {
  const limit = Math.max(1, Math.min(opts.batchSize ?? 500, 5_000));
  const meta = { action: 'privacy.retention_sweep', resourceType: 'tenant', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'privacy.retention_sweep', siteId: null });
    await lockHolds(c, ctx.tenantId);
    const pol = (
      await c.query<{ id: string; body: Record<string, number> }>(
        `SELECT r.id, r.body FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
          WHERE r.tenant_id = $1 AND p.policy_key = 'RETENTION' AND r.effective_at <= clock_timestamp()
          ORDER BY r.effective_at DESC, r.revision DESC LIMIT 1`,
        [ctx.tenantId],
      )
    ).rows[0];
    let erased = zero();
    let heldSkipped = 0;
    if (pol) {
      const days = (t: ErasureTarget): number => {
        const comm = Number(pol.body.communicationDays);
        if (t === 'fulfillment_observations') return Number(pol.body.fulfillmentRawDays ?? comm);
        if (t === 'recovery_evidence') return Number(pol.body.cmmsRawDays ?? comm);
        return comm;
      };
      const basis: Basis = { kind: 'RETENTION_EXPIRED', retentionPolicyRevisionId: pol.id, privacyRequestId: null };
      ({ erased, heldSkipped } = await eraseIn(c, ctx, basis, ERASURE_TARGETS, WHOLE_TENANT, days, limit));
    }
    // Transient copies: a finished job's raw body is redundant (the observation holds the governed copy); a dead
    // job's raw body is the only copy and follows the fulfillment retention window. Held orders keep theirs.
    const fulfillmentDays = pol ? Number(pol.body.fulfillmentRawDays ?? pol.body.communicationDays) : null;
    const scrub = await c.query(
      `UPDATE jobs j SET payload = (j.payload - 'rawBody') || '{"rawBodyErased": true}'::jsonb, updated_at = clock_timestamp()
        WHERE j.tenant_id = $1 AND j.kind = $2 AND j.payload ? 'rawBody'
          AND (j.state = 'SUCCEEDED'
               OR (j.state = 'DEAD' AND $3::int IS NOT NULL AND j.updated_at < clock_timestamp() - make_interval(days => $3::int)))
          AND NOT ub_legal_hold_covers(j.tenant_id,
                (SELECT coalesce(po.site_id, sj.site_id) FROM (SELECT 1) x
                   LEFT JOIN purchase_orders po ON po.tenant_id = j.tenant_id AND po.id = j.payload->>'orderId'
                   LEFT JOIN service_jobs sj ON sj.tenant_id = j.tenant_id AND sj.id = j.payload->>'orderId'),
                (SELECT i.asset_id FROM incidents i WHERE i.tenant_id = j.tenant_id AND i.id IN (
                   SELECT incident_id FROM purchase_orders WHERE tenant_id = j.tenant_id AND id = j.payload->>'orderId'
                   UNION ALL SELECT incident_id FROM service_jobs WHERE tenant_id = j.tenant_id AND id = j.payload->>'orderId')),
                (SELECT incident_id FROM purchase_orders WHERE tenant_id = j.tenant_id AND id = j.payload->>'orderId'
                   UNION ALL SELECT incident_id FROM service_jobs WHERE tenant_id = j.tenant_id AND id = j.payload->>'orderId'
                   LIMIT 1))`,
      [ctx.tenantId, FULFILLMENT_JOB, fulfillmentDays],
    );
    const scrubbedJobs = scrub.rowCount ?? 0;
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: ctx.tenantId,
      result: 'SUCCEEDED',
      reasonCode: pol ? null : 'NO_RETENTION_POLICY',
      metadata: {
        fulfillmentObservations: erased.fulfillment_observations,
        recoveryEvidence: erased.recovery_evidence,
        communicationBodies: erased.provider_communication_bodies,
        heldSkipped,
        scrubbedJobs,
        retentionPolicyRevisionId: pol?.id ?? null,
      },
    });
    return { policyRevisionId: pol?.id ?? null, erased, heldSkipped, scrubbedJobs };
  });
}

export interface PrivacyExportItem {
  targetTable: ErasureTarget;
  targetId: string;
  digest: string | null;
  erased: boolean;
  recordedAt: string;
}
export interface PrivacyRequestOutcome {
  privacyRequestId: string;
  state: 'COMPLETED' | 'BLOCKED_LEGAL_HOLD' | 'REJECTED';
  erased: ErasureCounts;
  manifest?: { items: PrivacyExportItem[] };
}

async function exportManifest(c: Tx, tenantId: string, scope: Scope): Promise<PrivacyExportItem[]> {
  const p = [tenantId, scope.siteId, scope.assetId, scope.incidentId];
  const f = (s: string, a: string, i: string) =>
    `($2::text IS NULL OR ${s} = $2) AND ($3::text IS NULL OR ${a} = $3) AND ($4::text IS NULL OR ${i} = $4)`;
  const { rows } = await c.query(
    `SELECT 'fulfillment_observations' AS target_table, o.id AS target_id, o.raw_body_digest AS digest,
            (o.raw_body_erased_at IS NOT NULL) AS erased, o.recorded_at
       FROM fulfillment_observations o
       LEFT JOIN purchase_orders po ON po.tenant_id = o.tenant_id AND po.id = o.purchase_order_id
       LEFT JOIN service_jobs sj ON sj.tenant_id = o.tenant_id AND sj.id = o.service_job_id
       LEFT JOIN incidents i ON i.tenant_id = o.tenant_id AND i.id = coalesce(po.incident_id, sj.incident_id)
      WHERE o.tenant_id = $1 AND (o.raw_body IS NOT NULL OR o.raw_body_erased_at IS NOT NULL)
        AND ${f('coalesce(po.site_id, sj.site_id)', 'i.asset_id', 'i.id')}
     UNION ALL
     SELECT 'recovery_evidence', e.id, e.body_digest, (e.body_erased_at IS NOT NULL), e.recorded_at
       FROM recovery_evidence e
      WHERE e.tenant_id = $1 AND e.source_kind = 'CMMS' AND ${f('e.site_id', 'e.asset_id', 'e.incident_id')}
     UNION ALL
     SELECT 'provider_communication_bodies', b.id, m.content_digest, (b.erased_at IS NOT NULL), m.recorded_at
       FROM provider_communication_bodies b
       JOIN provider_communications m ON m.tenant_id = b.tenant_id AND m.id = b.communication_id
       LEFT JOIN provider_contact_requests q ON q.tenant_id = m.tenant_id AND q.id = m.contact_request_id
      WHERE b.tenant_id = $1 AND ${f('m.site_id', 'q.asset_id', 'm.incident_id')}
      ORDER BY 5, 2
      LIMIT 10000`,
    p,
  );
  return rows.map((r) => ({
    targetTable: r.target_table,
    targetId: r.target_id,
    digest: r.digest ?? null,
    erased: r.erased === true,
    recordedAt: isoNN(r.recorded_at),
  }));
}

/**
 * Execute a privacy request (administrator). An active legal hold overlapping the request's scope blocks a deletion
 * or redaction at execution time (a hold placed after the request was received still wins); once released, the
 * request can be executed again. COMMUNICATION erases raw communication bodies in scope; CONTACT erases every governed
 * raw payload in scope (the system keeps no per-person index of raw payloads, so the scope bounds the erasure); USER
 * is REJECTED (identity erasure belongs to the identity provider and membership lifecycle). EXPORT returns a
 * minimized manifest by digest. A COMPLETED request is a no-op.
 */
export async function executePrivacyRequest(
  pool: Db,
  ctx: TenantContext,
  privacyRequestId: string,
): Promise<PrivacyRequestOutcome> {
  const id = String(privacyRequestId);
  const meta = { action: 'privacy_request.execute', resourceType: 'privacy_request', resourceId: id };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'privacy.execute', siteId: null }, undefined, { type: 'privacy_request', id });
    if (!/^prq_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(id)) throw unavailable(meta);
    await lockHolds(c, ctx.tenantId);
    const r = (
      await c.query(`SELECT * FROM privacy_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [ctx.tenantId, id])
    ).rows[0];
    if (!r) throw unavailable(meta);
    const out = (
      state: PrivacyRequestOutcome['state'],
      erased = zero(),
      manifest?: PrivacyExportItem[],
    ): PrivacyRequestOutcome => ({
      privacyRequestId: id,
      state,
      erased,
      ...(manifest ? { manifest: { items: manifest } } : {}),
    });
    if (r.state === 'COMPLETED' || r.state === 'REJECTED') return out(r.state);
    const scope: Scope = { siteId: r.site_id, assetId: r.asset_id, incidentId: r.incident_id };
    const setState = async (state: string, reasonCode: string | null) => {
      await c.query(
        `UPDATE privacy_requests SET state = $3, version = version + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, state],
      );
      await recordAudit(c, ctx, {
        ...meta,
        result: 'SUCCEEDED',
        reasonCode,
        metadata: { state, requestType: r.request_type },
      });
    };
    if (r.request_type === 'EXPORT') {
      const items = await exportManifest(c, ctx.tenantId, scope);
      await setState('COMPLETED', null);
      return out('COMPLETED', zero(), items);
    }
    if (await overlappingHold(c, ctx.tenantId as TenantId, scope)) {
      await setState('BLOCKED_LEGAL_HOLD', 'LEGAL_HOLD');
      return out('BLOCKED_LEGAL_HOLD');
    }
    if (r.subject_kind === 'USER') {
      await setState('REJECTED', 'SUBJECT_KIND_UNSUPPORTED');
      return out('REJECTED');
    }
    const targets: readonly ErasureTarget[] =
      r.subject_kind === 'COMMUNICATION' ? ['provider_communication_bodies'] : ERASURE_TARGETS;
    const basis: Basis = { kind: 'PRIVACY_REQUEST', retentionPolicyRevisionId: null, privacyRequestId: id };
    const erased = zero();
    // Bounded batches until the scope is drained (a held row inside the scope would have blocked above).
    for (let round = 0; round < 100; round++) {
      const r2 = await eraseIn(c, ctx, basis, targets, scope, () => null, 1_000);
      for (const t of ERASURE_TARGETS) erased[t] += r2.erased[t];
      if (ERASURE_TARGETS.every((t) => r2.erased[t] === 0)) break;
      if (r2.heldSkipped > 0)
        throw new DomainError('POLICY_HOLD', 'A legal hold covers part of this request.', {
          reasonCode: 'LEGAL_HOLD_ACTIVE',
        });
    }
    await setState('COMPLETED', null);
    return out('COMPLETED', erased);
  });
}

/**
 * Platform runner for M14 to schedule: one retention sweep per active tenant under a worker context derived from the
 * tenant row (never from input). Returns per-tenant results; a failing tenant does not stop the others.
 */
export class RetentionSweeper {
  constructor(
    private readonly pool: Db,
    private readonly opts: { workerId?: string; batchSize?: number } = {},
  ) {}

  async runOnce(): Promise<{ tenantId: string; result: RetentionSweepResult | null; error: string | null }[]> {
    const { rows } = await this.pool.query<{ id: TenantId }>(
      `SELECT id FROM tenants WHERE status = 'ACTIVE' ORDER BY id`,
    );
    const out: { tenantId: string; result: RetentionSweepResult | null; error: string | null }[] = [];
    for (const t of rows) {
      const ctx = issueWorkerContext(t.id, {
        kind: 'WORKER',
        id: this.opts.workerId ?? 'retention-sweeper',
        source: 'JOB',
        sourceId: `retention-${t.id.slice(4, 40)}`,
      });
      try {
        out.push({
          tenantId: t.id,
          result: await runRetentionSweep(this.pool, ctx, { batchSize: this.opts.batchSize ?? 500 }),
          error: null,
        });
      } catch (e) {
        out.push({ tenantId: t.id, result: null, error: e instanceof DomainError ? e.code : 'INTERNAL' });
      }
    }
    return out;
  }
}
