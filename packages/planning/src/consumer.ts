// Plan invalidation inputs (INV-03, STATE-MACHINES §4). The planning consumer revalidates the open plans of the
// event's incident once per event id on: plan.invalidated.v1 (evidence/asset/policy and M08's own), evidence
// revisions, compatibility re-evaluations, new quote revisions (price/stock) and authorized deadline events. The
// plan.revalidate_for_asset_revision job (enqueued by M02 when an asset identity is revised) revalidates every
// incident with an open plan bound to the superseded asset revision. A publication of a later SOP emits nothing
// here: an open incident keeps its pinned deadline projection.
import {
  DomainEventEnvelopeSchema,
  IncidentIdSchema,
  decodeWire,
  type DomainEventEnvelope,
} from '@uptimebuyer/contracts';
import {
  claimJobs,
  completeJob,
  consumeOnce,
  failJob,
  requireAuthorized,
  tenantCommand,
  type ClaimedJob,
  type Db,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { revalidateIncidentPlans } from './lifecycle.js';

export const PLANNING_CONSUMER = 'planning-revalidation.v1';
export const PLAN_REVALIDATION_JOB = 'plan.revalidate_for_asset_revision';

export const PLANNING_EVENT_TYPES = Object.freeze([
  'plan.invalidated.v1',
  'evidence.revision_committed.v1',
  'compatibility.evaluated.v1',
  'provider.quote_recorded.v1',
  'incident.deadline_changed.v1',
] as const);

export async function handlePlanningEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED'> {
  const e = decodeWire(DomainEventEnvelopeSchema, envelope);
  if (!(PLANNING_EVENT_TYPES as readonly string[]).includes(e.eventType)) return 'IGNORED';
  const incident = IncidentIdSchema.safeParse((e.payload as { incidentId?: unknown }).incidentId);
  if (!incident.success) return 'IGNORED';
  return consumeOnce(pool, PLANNING_CONSUMER, e, async (c, ctx) => {
    requireAuthorized(ctx, { action: 'planning.engine', siteId: null });
    // The incident id comes from the durable event row of this tenant; a foreign id simply has no plans here.
    await revalidateIncidentPlans(c, ctx, incident.data);
  });
}

const JobPayloadSchema = z.strictObject({
  assetId: z.string().regex(/^ast_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  supersededAssetRevisionId: z.string().regex(/^arv_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  currentAssetRevisionId: z.string().regex(/^arv_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
});

/** Process one claimed asset-revision job inside its worker context; returns the plans it invalidated. */
export async function handlePlanRevalidationJob(pool: Db, claimed: ClaimedJob): Promise<string[]> {
  const parsed = JobPayloadSchema.safeParse(claimed.job.payload);
  if (!parsed.success) {
    await failJob(pool, claimed, { reasonCode: 'INVALID_JOB_PAYLOAD', retryInMs: 0 });
    return [];
  }
  const p = parsed.data;
  const meta = { action: 'planning.revalidate', resourceType: 'asset', resourceId: p.assetId };
  const invalidated = await tenantCommand(pool, claimed.ctx, meta, async (c) => {
    requireAuthorized(claimed.ctx, { action: 'planning.engine', siteId: null });
    const { rows } = await c.query<{ incident_id: string }>(
      `SELECT DISTINCT incident_id FROM recovery_plans
        WHERE tenant_id = $1 AND asset_id = $2 AND asset_revision_id = $3
          AND state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING')
        ORDER BY incident_id`,
      [claimed.ctx.tenantId, p.assetId, p.supersededAssetRevisionId],
    );
    const out: string[] = [];
    for (const r of rows)
      out.push(...(await revalidateIncidentPlans(c, claimed.ctx, r.incident_id)).invalidatedPlanIds);
    return out;
  });
  await completeJob(pool, claimed);
  return invalidated;
}

/** Claim and run pending plan.revalidate_for_asset_revision jobs (to be scheduled by the deployed worker, M14). */
export async function runPlanRevalidationJobs(
  pool: Db,
  opts: { workerId: string; limit?: number; leaseMs?: number },
): Promise<{ processed: number; invalidatedPlanIds: string[] }> {
  const claimed = await claimJobs(pool, {
    workerId: opts.workerId,
    kinds: [PLAN_REVALIDATION_JOB],
    limit: opts.limit ?? 50,
    leaseMs: opts.leaseMs ?? 60_000,
  });
  const invalidatedPlanIds: string[] = [];
  let processed = 0;
  for (const job of claimed) {
    try {
      invalidatedPlanIds.push(...(await handlePlanRevalidationJob(pool, job)));
      processed++;
    } catch (e) {
      await failJob(pool, job, { reasonCode: 'PLAN_REVALIDATION_FAILED', retryInMs: 5_000 }).catch(() => undefined);
      void e;
    }
  }
  return { processed, invalidatedPlanIds: invalidatedPlanIds.sort() };
}
