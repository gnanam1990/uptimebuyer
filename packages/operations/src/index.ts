// @uptimebuyer/operations — database-backed operations signals (M13; NFR-06, NFR-08, NFR-09, FR-18, INV-16):
// - buildIncidentTrace: one incident's correlation-linked trace reconstructed from durable records (incident,
//   telemetry, evidence, decision, plan, approval/authority, payment, provider attempt, order, recovery, closeout).
//   Durable records are the cross-process source of truth (the broker runs as its own workload), so the trace survives
//   restarts and needs no collector. Tenant-scoped and restricted to auditors/administrators;
// - collectPlatformSignals: platform gauges for the alert rules (outbox/job age, overdue UNKNOWN outcomes, recovered
//   incidents without a closeout, stale sensors on active incidents) — aggregate counts only, never tenant labels;
// - readinessChecks: database, schema version and outbox backlog checks for a HealthRegistry;
// - checkEncryptionPosture: what can honestly be verified from SQL about encryption (transport only).
import { DomainError } from '@uptimebuyer/contracts';
import { requireAuthorized, tenantCommand, unavailable, type Db, type TenantContext } from '@uptimebuyer/data';
import type { HealthRegistry, PlatformMetrics } from '@uptimebuyer/observability';

export const TRACE_STAGES = Object.freeze([
  'telemetry',
  'evidence',
  'decision',
  'plan',
  'approval',
  'payment',
  'provider',
  'order',
  'recovery',
] as const);
export type TraceStage = (typeof TRACE_STAGES)[number];

export interface TraceSpan {
  stage: TraceStage;
  name: string;
  source: { table: string; id: string };
  at: string;
  correlationId: string | null;
  causationId: string | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface IncidentTrace {
  incidentId: string;
  spans: TraceSpan[];
  correlationIds: string[];
  missing: TraceStage[];
  complete: boolean;
}

interface SourceRow {
  stage: TraceStage;
  name: string;
  table: string;
  id: string;
  /** The aggregate whose events/ledger/audit carry this row's correlation, when it is not the row itself. */
  ref: string;
  at: Date;
  correlation_id: string | null;
  state: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function buildIncidentTrace(pool: Db, ctx: TenantContext, incidentId: string): Promise<IncidentTrace> {
  const meta = { action: 'operations.incident_trace', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'audit.read', siteId: null }, undefined, { type: 'incident', id: incidentId });
    if (!/^inc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(String(incidentId))) throw unavailable(meta);
    const inc = (
      await c.query(
        `SELECT id, asset_id, opened_at, correlation_id, state FROM incidents WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, incidentId],
      )
    ).rows[0];
    if (!inc) throw unavailable(meta);
    const t = ctx.tenantId;
    const q = async (sql: string, params: unknown[] = []) =>
      (await c.query(sql, [t, incidentId, ...params])).rows as any[];
    const rows: SourceRow[] = [];
    const push = (stage: TraceStage, name: string, table: string, list: any[]) =>
      list.forEach((r) =>
        rows.push({
          stage,
          name,
          table,
          id: r.id,
          ref: r.ref ?? r.id,
          at: r.at,
          correlation_id: r.correlation_id ?? null,
          state: r.state ?? null,
        }),
      );

    push('telemetry', 'incident.detect', 'incidents', [
      { id: inc.id, at: inc.opened_at, correlation_id: inc.correlation_id, state: inc.state },
    ]);
    push(
      'telemetry',
      'telemetry.ingest',
      'telemetry_batches',
      await q(
        `SELECT b.id, min(s.event_at) AS at, b.correlation_id, NULL AS state
           FROM telemetry_samples s JOIN telemetry_batches b ON b.tenant_id = s.tenant_id AND b.id = s.batch_id
          WHERE s.tenant_id = $1 AND s.asset_id = $3
            AND s.event_at >= (SELECT opened_at - interval '1 hour' FROM incidents WHERE tenant_id = $1 AND id = $2)
          GROUP BY b.id, b.correlation_id ORDER BY min(s.event_at) LIMIT 200`,
        [inc.asset_id],
      ),
    );
    push(
      'evidence',
      'evidence.build',
      'evidence_revisions',
      await q(
        `SELECT id, created_at AS at, NULL AS state FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'decision',
      'compatibility.evaluate',
      'compatibility_decisions',
      await q(
        `SELECT id, decided_at AS at, decision AS state FROM compatibility_decisions WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'plan',
      'plan.rank',
      'recovery_plans',
      await q(`SELECT id, created_at AS at, state FROM recovery_plans WHERE tenant_id = $1 AND incident_id = $2`),
    );
    push(
      'approval',
      'approval.record',
      'approvals',
      await q(
        `SELECT id, created_at AS at, approval_kind AS state FROM approvals WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'approval',
      'approval.record',
      'execution_authorities',
      await q(
        `SELECT id, issued_at AS at, status AS state FROM execution_authorities WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'payment',
      'commercial.reserve',
      'commercial_intents',
      await q(
        `SELECT id, created_at AS at, correlation_id, state FROM commercial_intents WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'provider',
      'provider.execute',
      'external_attempts',
      await q(
        `SELECT a.id, a.created_at AS at, i.correlation_id, a.external_outcome_state AS state
           FROM external_attempts a JOIN commercial_intents i ON i.tenant_id = a.tenant_id AND i.id = a.intent_id
          WHERE a.tenant_id = $1 AND i.incident_id = $2`,
      ),
    );
    push(
      'order',
      'fulfillment.observe',
      'purchase_orders',
      await q(
        `SELECT id, created_at AS at, correlation_id, state FROM purchase_orders WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'order',
      'fulfillment.observe',
      'service_jobs',
      await q(
        `SELECT id, created_at AS at, correlation_id, state FROM service_jobs WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );
    push(
      'recovery',
      'recovery.assess',
      'recovery_evaluations',
      await q(`SELECT id, created_at AS at, state FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2`),
    );
    push(
      'recovery',
      'incident.close',
      'recovery_closeouts',
      // A closeout is written with (and correlated through) its passing evaluation's RECOVERY_DECISION.
      await q(
        `SELECT id, evaluation_id AS ref, decided_at AS at, NULL AS state FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`,
      ),
    );

    // Correlation for rows without their own column: the earliest outbox event, ledger entry or audit entry that
    // names the row (all written in the row's own transaction with the command's correlation id).
    const needs = rows.filter((r) => r.correlation_id === null).map((r) => r.ref);
    const found = new Map<string, { correlationId: string; causationId: string | null }>();
    if (needs.length) {
      const look = await c.query(
        `SELECT DISTINCT ON (ref) ref, correlation_id, causation_id FROM (
           SELECT aggregate_id AS ref, correlation_id, causation_id, occurred_at AS at, 1 AS pri FROM outbox_events
            WHERE tenant_id = $1 AND aggregate_id = ANY($2)
           UNION ALL
           SELECT subject_aggregate_id, correlation_id, causation_id, recorded_at, 2 FROM evidence_ledger_entries
            WHERE tenant_id = $1 AND subject_aggregate_id = ANY($2)
           UNION ALL
           SELECT resource_id, correlation_id, NULL, occurred_at, 3 FROM audit_entries
            WHERE tenant_id = $1 AND resource_id = ANY($2) AND result = 'SUCCEEDED') x
         ORDER BY ref, pri, at`,
        [t, needs],
      );
      for (const r of look.rows)
        found.set(r.ref, { correlationId: r.correlation_id, causationId: r.causation_id ?? null });
    }
    const spans: TraceSpan[] = rows
      .filter((r) => r.at instanceof Date)
      .map((r) => ({
        stage: r.stage,
        name: r.name,
        source: { table: r.table, id: r.id },
        at: r.at.toISOString(),
        correlationId: r.correlation_id ?? found.get(r.ref)?.correlationId ?? null,
        causationId: found.get(r.ref)?.causationId ?? null,
        attributes: { state: r.state },
      }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const correlationIds = [...new Set(spans.map((s) => s.correlationId).filter((x): x is string => x !== null))];
    // Commands on the incident itself (assignment, approval routes, issuance) also count as linked correlations.
    const audit = await c.query(
      `SELECT DISTINCT correlation_id FROM audit_entries WHERE tenant_id = $1 AND result = 'SUCCEEDED'
          AND resource_id = ANY($2)`,
      [t, [incidentId, ...rows.map((r) => r.id)]],
    );
    for (const r of audit.rows) if (!correlationIds.includes(r.correlation_id)) correlationIds.push(r.correlation_id);
    const missing = TRACE_STAGES.filter((s) => !spans.some((x) => x.stage === s));
    return {
      incidentId,
      spans,
      correlationIds,
      missing,
      complete: missing.length === 0 && spans.every((s) => s.correlationId !== null),
    };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Refresh the database-derived platform gauges (platform scope: aggregate counts across tenants, never labelled by
 * tenant). The operations listener calls this before each scrape.
 */
export async function collectPlatformSignals(pool: Db, p: PlatformMetrics): Promise<void> {
  const one = async (sql: string) => (await pool.query(sql)).rows[0] as Record<string, unknown>;
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const outbox = await one(
    `SELECT count(*) AS n, coalesce(extract(epoch FROM clock_timestamp() - min(occurred_at)), 0) AS age
       FROM outbox_events WHERE published_at IS NULL`,
  );
  p.outboxUnpublished.set({}, n(outbox.n));
  p.outboxOldestAgeSeconds.set({}, Math.max(0, Math.floor(n(outbox.age))));
  const jobs = await one(
    `SELECT coalesce(extract(epoch FROM clock_timestamp()
              - min(run_after) FILTER (WHERE state = 'PENDING' AND run_after <= clock_timestamp())), 0) AS age,
            count(*) FILTER (WHERE state = 'DEAD') AS dead
       FROM jobs`,
  );
  p.jobsOldestAgeSeconds.set({}, Math.max(0, Math.floor(n(jobs.age))));
  p.jobsDead.set({}, n(jobs.dead));
  const unknown = await one(
    `SELECT count(*) AS n FROM external_attempts
      WHERE external_outcome_state = 'UNKNOWN'
        AND ((next_reconcile_at IS NOT NULL AND next_reconcile_at < clock_timestamp() - interval '60 seconds')
             OR (next_reconcile_at IS NULL AND adapter_capability = 'UNSUPPORTED'))`,
  );
  p.externalUnknownOverdue.set({}, n(unknown.n));
  const closed = await one(
    `SELECT count(*) AS n FROM incidents i
      WHERE i.state = 'RECOVERED' AND NOT EXISTS (
        SELECT 1 FROM recovery_closeouts co JOIN recovery_evaluations e ON e.tenant_id = co.tenant_id AND e.id = co.evaluation_id
         WHERE co.tenant_id = i.tenant_id AND co.incident_id = i.id AND co.recovery_cycle = i.reopen_count AND e.state = 'PASSED')`,
  );
  p.incidentsClosedWithoutEvidence.set({}, n(closed.n));
  const stale = await one(
    `SELECT count(DISTINCT i.id) AS n FROM incidents i
       JOIN device_asset_assignments a ON a.tenant_id = i.tenant_id AND a.asset_id = i.asset_id AND a.valid_to IS NULL
       JOIN telemetry_channel_health h ON h.tenant_id = a.tenant_id AND h.device_id = a.device_id
      WHERE i.state NOT IN ('RECOVERED') AND h.freshness IN ('STALE', 'OFFLINE')`,
  );
  p.sensorStaleActiveIncidents.set({}, n(stale.n));
}

/** Register the database-backed readiness checks. */
export function readinessChecks(
  health: HealthRegistry,
  pool: Db,
  opts: { expectedLatestMigration?: string; outboxWarnSeconds?: number } = {},
): void {
  health.register(
    'database',
    async () => {
      await pool.query('SELECT 1');
      return { status: 'pass' };
    },
    { critical: true },
  );
  if (opts.expectedLatestMigration) {
    const expected = opts.expectedLatestMigration;
    health.register(
      'schema',
      async () => {
        const r = await pool.query(`SELECT max(name) AS latest FROM schema_migrations`);
        const latest = r.rows[0]?.latest as string | null;
        return latest === expected ? { status: 'pass' } : { status: 'fail', detail: 'SCHEMA_VERSION_MISMATCH' };
      },
      { critical: true },
    );
  }
  const warn = opts.outboxWarnSeconds ?? 60;
  health.register(
    'outbox_backlog',
    async () => {
      const r = await pool.query(
        `SELECT coalesce(extract(epoch FROM clock_timestamp() - min(occurred_at)), 0) AS age FROM outbox_events WHERE published_at IS NULL`,
      );
      return Number(r.rows[0]?.age ?? 0) > warn ? { status: 'warn', detail: 'OUTBOX_BACKLOG' } : { status: 'pass' };
    },
    { critical: false },
  );
}

export interface EncryptionPosture {
  database: { inTransit: 'TLS' | 'PLAINTEXT' | 'UNKNOWN'; atRest: 'NOT_VERIFIABLE_FROM_SQL' };
  objectStore: 'NOT_RUN';
  backups: 'NOT_RUN';
}

/**
 * NFR-06 posture as far as SQL can prove it: the current connection's transport. Storage and backup encryption are
 * properties of the deployment (disk/KMS/object-store settings) and stay NOT_RUN until M14 verifies them there.
 */
export async function checkEncryptionPosture(pool: Db): Promise<EncryptionPosture> {
  let inTransit: EncryptionPosture['database']['inTransit'] = 'UNKNOWN';
  try {
    const r = await pool.query(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`);
    if (r.rows[0]) inTransit = r.rows[0].ssl === true ? 'TLS' : 'PLAINTEXT';
  } catch (e) {
    if (!(e instanceof Error)) throw new DomainError('INTERNAL', 'Encryption posture check failed.');
  }
  return { database: { inTransit, atRest: 'NOT_VERIFIABLE_FROM_SQL' }, objectStore: 'NOT_RUN', backups: 'NOT_RUN' };
}
