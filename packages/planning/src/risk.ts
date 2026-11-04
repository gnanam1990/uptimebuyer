// The versioned tenant risk estimate (FR-09, PRD §3.4): the mandatory economic input behind the downtime cost rate,
// the deadline-conditioned inventory-loss probability and repeat-failure risk. An administrator publishes immutable
// revisions per scope (tenant-wide or one site); planning selects the most specific estimate effective now (a site
// estimate overrides the tenant-wide one). An optional model may inform it (basis MODEL_INFORMED, with the model's
// version, calibration population, input revisions and as-of recorded as evidence) but is never required, and a
// model can never move a deadline. Publication revalidates open plans of the affected scope.
import {
  CurrencyCodeSchema,
  SiteIdSchema,
  UtcInstantSchema,
  type CurrencyCode,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest, type PlanEconomics, type PpmInput } from '@uptimebuyer/domain';
import {
  dbNow,
  lockKey,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { actorFields, invalid, isoOf, newPlanningId } from './internal.js';
import { revalidateIncidentPlans } from './lifecycle.js';

const MAX_MINOR = 9_223_372_036_854_775_807n;
const Ppm = z.int().min(0).max(1_000_000);
const Bounded = z
  .strictObject({ estimatePpm: Ppm, lowPpm: Ppm, highPpm: Ppm })
  .refine((b) => b.lowPpm <= b.estimatePpm && b.estimatePpm <= b.highPpm, 'Bounds must bracket the estimate.');
const ACTION_KINDS = [
  'PART_PURCHASE',
  'SERVICE_JOB',
  'DIAGNOSTIC_SERVICE',
  'PAID_CONTACT',
  'CONTAINMENT_PURCHASE',
] as const;

const PublishSchema = z
  .strictObject({
    siteId: SiteIdSchema.nullable(),
    currency: CurrencyCodeSchema,
    downtimeCostPerHourMinor: z.bigint().min(0n).max(MAX_MINOR),
    inventoryLossPpm: z.strictObject({ withinDeadline: Bounded, pastDeadline: Bounded }),
    repeatFailure: z.strictObject({
      costMinor: z.bigint().min(0n).max(MAX_MINOR),
      byActionKind: z
        .array(z.strictObject({ actionKind: z.enum(ACTION_KINDS), estimatePpm: Ppm, lowPpm: Ppm, highPpm: Ppm }))
        .max(ACTION_KINDS.length)
        .refine((xs) => new Set(xs.map((x) => x.actionKind)).size === xs.length, 'Duplicate action kind.')
        .refine((xs) => xs.every((b) => b.lowPpm <= b.estimatePpm && b.estimatePpm <= b.highPpm), 'Bounds.'),
    }),
    basis: z.enum(['OPERATOR_ESTIMATE', 'HISTORICAL_ANALYSIS', 'MODEL_INFORMED']),
    informingModel: z
      .strictObject({
        modelVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        calibrationPopulation: z.string().min(1).max(200),
        inputRevisions: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(50),
        uncertaintyNote: z.string().max(500).nullable(),
        asOf: UtcInstantSchema,
      })
      .nullable(),
    effectiveAt: UtcInstantSchema.optional(),
  })
  .refine((b) => (b.basis === 'MODEL_INFORMED') === (b.informingModel !== null), {
    message: 'A model-informed estimate must record its model, and only then.',
  });
export type PublishRiskEstimateInput = z.input<typeof PublishSchema>;
type Body = Omit<z.output<typeof PublishSchema>, 'siteId' | 'effectiveAt'>;

export interface PublishedRiskEstimate {
  riskEstimateId: string;
  siteId: string | null;
  revision: number;
  bodyDigest: string;
  effectiveAt: UtcInstant;
  invalidatedPlanIds: string[];
}

const toWireBody = (b: Body) => ({
  currency: b.currency,
  downtimeCostPerHourMinor: b.downtimeCostPerHourMinor.toString(),
  inventoryLossPpm: b.inventoryLossPpm,
  repeatFailure: {
    costMinor: b.repeatFailure.costMinor.toString(),
    byActionKind: [...b.repeatFailure.byActionKind].sort((x, y) => (x.actionKind < y.actionKind ? -1 : 1)),
  },
  basis: b.basis,
  informingModel: b.informingModel,
});

export async function publishTenantRiskEstimate(
  pool: Db,
  ctx: TenantContext,
  raw: PublishRiskEstimateInput,
): Promise<PublishedRiskEstimate> {
  const parsed = PublishSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid('INVALID_RISK_ESTIMATE', {
      fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), issue: i.code })),
    });
  const { siteId, effectiveAt, ...body } = parsed.data;
  const meta = { action: 'planning.risk_publish', resourceType: 'tenant_risk_estimate', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (siteId !== null) {
      const s = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, siteId]);
      if (s.rowCount !== 1) throw unavailable(meta, siteId, 'site');
    }
    requireAuthorized(ctx, { action: 'planning.risk_publish', siteId: siteId as never }, undefined, {
      type: meta.resourceType,
    });
    const scopeKey = siteId ?? '*';
    await lockKey(c, `planning-risk:${ctx.tenantId}:${scopeKey}`);
    const next = await c.query<{ n: number }>(
      `SELECT coalesce(max(revision), 0) + 1 AS n FROM tenant_risk_estimates WHERE tenant_id = $1 AND scope_key = $2`,
      [ctx.tenantId, scopeKey],
    );
    const revision = next.rows[0]!.n;
    const now = await dbNow(c);
    const eff = effectiveAt && Date.parse(effectiveAt) > Date.parse(now) ? effectiveAt : now;
    const wire = toWireBody(body);
    const bodyDigest = canonicalDigest('tenant-risk-estimate', 1, {
      tenantId: ctx.tenantId,
      siteId,
      revision,
      body: wire,
    });
    const id = newPlanningId('riskEstimate');
    const actor = actorFields(ctx);
    await c.query(
      `INSERT INTO tenant_risk_estimates (tenant_id, id, site_id, revision, currency, body, body_digest, basis, effective_at,
         published_by_kind, published_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ctx.tenantId,
        id,
        siteId,
        revision,
        body.currency,
        JSON.stringify(wire),
        bodyDigest,
        body.basis,
        eff,
        actor.kind,
        actor.id,
      ],
    );
    // Open plans priced under another estimate are stale once this one is selected.
    const incidents = await c.query<{ incident_id: string }>(
      `SELECT DISTINCT incident_id FROM recovery_plans
        WHERE tenant_id = $1 AND state IN ('DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED', 'EXECUTING')
          AND ($2::text IS NULL OR site_id = $2) ORDER BY incident_id`,
      [ctx.tenantId, siteId],
    );
    const invalidatedPlanIds: string[] = [];
    for (const r of incidents.rows)
      invalidatedPlanIds.push(
        ...(await revalidateIncidentPlans(c, ctx, r.incident_id, { engine: false })).invalidatedPlanIds,
      );
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: id,
      result: 'SUCCEEDED',
      metadata: { revision, scope: scopeKey },
    });
    return {
      riskEstimateId: id,
      siteId,
      revision,
      bodyDigest,
      effectiveAt: isoOf(eff)!,
      invalidatedPlanIds: invalidatedPlanIds.sort(),
    };
  });
}

export interface RiskEstimateRow {
  id: string;
  site_id: string | null;
  revision: number;
  currency: string;
  body: ReturnType<typeof toWireBody>;
  effective_at: Date;
  created_at: Date;
}

/** The estimate planning uses now for `siteId`: the latest effective site estimate, else the tenant-wide one. */
export async function selectRiskEstimate(
  c: Tx,
  tenantId: string,
  siteId: string,
): Promise<RiskEstimateRow | undefined> {
  const { rows } = await c.query<RiskEstimateRow>(
    `SELECT id, site_id, revision, currency, body, effective_at, created_at FROM tenant_risk_estimates
      WHERE tenant_id = $1 AND (site_id = $2 OR site_id IS NULL) AND effective_at <= clock_timestamp()
      ORDER BY (site_id IS NULL), effective_at DESC, revision DESC LIMIT 1`,
    [tenantId, siteId],
  );
  return rows[0];
}

const ppmInput = (
  b: { estimatePpm: number; lowPpm: number; highPpm: number },
  prov: PpmInput['provenance'],
): PpmInput => ({
  estimatePpm: b.estimatePpm,
  lowPpm: b.lowPpm,
  highPpm: b.highPpm,
  provenance: prov,
});

/** Domain economics from a stored estimate (every value carries the estimate's provenance and revision). */
export function economicsOf(r: RiskEstimateRow): PlanEconomics {
  const provenance = {
    source: 'TENANT_RISK_ESTIMATE' as const,
    ref: r.id,
    revision: r.revision,
    asOf: isoOf(r.effective_at)!,
  };
  const currency = r.currency as CurrencyCode;
  return {
    riskEstimateId: r.id,
    revision: r.revision,
    currency,
    downtimeCostPerHour: { amountMinor: BigInt(r.body.downtimeCostPerHourMinor), currency, provenance },
    inventoryLossWithinDeadline: ppmInput(r.body.inventoryLossPpm.withinDeadline, provenance),
    inventoryLossPastDeadline: ppmInput(r.body.inventoryLossPpm.pastDeadline, provenance),
    repeatFailureCost: { amountMinor: BigInt(r.body.repeatFailure.costMinor), currency, provenance },
  };
}

export function repeatFailureFor(r: RiskEstimateRow, actionKind: string): PpmInput | null {
  const b = r.body.repeatFailure.byActionKind.find((x) => x.actionKind === actionKind);
  return b
    ? ppmInput(b, { source: 'TENANT_RISK_ESTIMATE', ref: r.id, revision: r.revision, asOf: isoOf(r.effective_at)! })
    : null;
}
