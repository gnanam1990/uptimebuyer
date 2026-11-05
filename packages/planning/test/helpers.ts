// Shared fixtures for the M08 integration tests: the M06 compatibility world (throwaway database, tenant, site,
// people, worker service, Northwind asset, AUTHORITY policy with the compatibility section, approved vendor, signing
// keyring) plus the M07 unpaid structured-API provider account with its synthetic search fixture, a tenant-wide
// versioned risk estimate, and a scenario builder that registers ALLOW candidates with matching operator-entered
// quotes. Nothing here is a real provider, quote, inventory count or payment.
import { randomBytes } from 'node:crypto';
import { money, type AssetId, type CurrencyCode, type IncidentId } from '@uptimebuyer/contracts';
import { recordRegistryEdit, type TenantContext } from '@uptimebuyer/data';
import { evaluateCandidate } from '@uptimebuyer/compatibility';
import {
  ChannelContactAdapter,
  FixtureProviderTransport,
  LocalChannelTransport,
  StaticAdapterRegistry,
  StructuredProviderApiAdapter,
  linkApprovedVendor,
  prepareContactRequest,
  recordQuote,
  reviewContactPoint,
  runProviderSearch,
} from '@uptimebuyer/providers';
import {
  MANUFACTURER,
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  warranty,
  type CompatWorld,
} from '../../compatibility/test/helpers.js';
import { nwrAsset } from '../../evidence/test/helpers.js';
import { providerAccount, scriptSearch, type ProviderAccountFixture } from '../../providers/test/helpers.js';
import { publishTenantRiskEstimate, type PublishRiskEstimateInput } from '../src/index.js';

export { rejection, person, type Person } from '../../compatibility/test/helpers.js';
export { MANUFACTURER };

export interface PlanningWorld extends CompatWorld {
  unpaid: ProviderAccountFixture;
  api: FixtureProviderTransport;
  adapters: StaticAdapterRegistry;
  riskEstimateId: string;
}

export function riskBody(over: Partial<PublishRiskEstimateInput> = {}): PublishRiskEstimateInput {
  return {
    siteId: null,
    currency: 'USD',
    downtimeCostPerHourMinor: 6_000n,
    inventoryLossPpm: {
      withinDeadline: { estimatePpm: 50_000, lowPpm: 30_000, highPpm: 80_000 },
      pastDeadline: { estimatePpm: 600_000, lowPpm: 400_000, highPpm: 800_000 },
    },
    repeatFailure: {
      costMinor: 40_000n,
      byActionKind: [
        { actionKind: 'PART_PURCHASE', estimatePpm: 20_000, lowPpm: 10_000, highPpm: 40_000 },
        { actionKind: 'SERVICE_JOB', estimatePpm: 50_000, lowPpm: 20_000, highPpm: 90_000 },
      ],
    },
    basis: 'OPERATOR_ESTIMATE',
    informingModel: null,
    ...over,
  };
}

export async function createPlanningWorld(label: string): Promise<PlanningWorld> {
  const w = await createCompatWorld(label);
  const unpaid = await providerAccount(w, 'coldline-dispatch');
  w.creds.set(unpaid.verifierRef, new Uint8Array(randomBytes(32)));
  w.creds.set(unpaid.credentialRef, new Uint8Array(randomBytes(32)));
  const api = new FixtureProviderTransport('SYNTHETIC_FIXTURE');
  scriptSearch(api);
  const adapters = new StaticAdapterRegistry([
    new StructuredProviderApiAdapter({ providerKey: 'coldline-dispatch', transport: api }),
    new ChannelContactAdapter({
      providerKey: 'coldline-dispatch',
      channel: 'EMAIL',
      transport: new LocalChannelTransport('EMAIL'),
    }),
    new ChannelContactAdapter({
      providerKey: 'coldline-dispatch',
      channel: 'PHONE',
      transport: new LocalChannelTransport('PHONE'),
    }),
  ]);
  const risk = await publishTenantRiskEstimate(w.db.pool, w.admin, riskBody());
  return { ...w, unpaid, api, adapters, riskEstimateId: risk.riskEstimateId };
}

export interface Offer {
  label: string;
  priceMinor: bigint;
  etaMinutes: number | null;
  /** Quote amount when it should differ from the candidate's price (default: equal). */
  quoteAmountMinor?: bigint | null;
  quoteCurrency?: CurrencyCode;
  availability?: 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE' | 'UNKNOWN';
  /** Discovered provider external ref (cl-001 is linked to the approved vendor; fr-207 is not). */
  provider?: 'cl-001' | 'fr-207';
  validForMs?: number;
  noQuote?: boolean;
  partNumber?: string;
  /** Candidate action kind (default PART_PURCHASE); SERVICE_JOB candidates quote REPAIR_LABOR. */
  kind?: 'PART_PURCHASE' | 'SERVICE_JOB';
}

export interface ScenarioPair {
  label: string;
  candidateActionId: string;
  quoteId: string | null;
  compatibilityDecisionId: string;
  decision: string;
}

export interface Scenario {
  incidentId: IncidentId;
  assetId: AssetId;
  evidenceRevisionId: string;
  pairs: ScenarioPair[];
  refs: { candidateActionId: string; quoteId: string | null }[];
  byLabel: Record<string, ScenarioPair>;
}

const CHANNELS = ['API', 'EMAIL', 'PHONE'] as const;
const PURPOSES = ['QUOTE', 'AVAILABILITY', 'ARRIVAL_ESTIMATE', 'DIAGNOSTIC_COMMITMENT'] as const;

/** Discover providers for the incident, link cl-001 to the approved vendor and verify every contact point. */
async function discoverFor(w: PlanningWorld, incidentId: string) {
  const search = await runProviderSearch(
    w.db.pool,
    w.people.operator!.ctx,
    {
      incidentId,
      providerAccountId: w.unpaid.providerAccountId,
      query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
      bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
      idempotencyKey: w.key('search'),
    },
    { adapters: w.adapters, credentials: w.creds },
  );
  const providers: Record<string, { serviceProviderId: string; points: Record<string, string> }> = {};
  for (const r of search.results) {
    const points: Record<string, string> = {};
    for (const cp of r.contactPoints) {
      points[cp.channel] = cp.contactPointId;
      if (cp.reviewState !== 'VERIFIED')
        await reviewContactPoint(w.db.pool, w.admin, { contactPointId: cp.contactPointId, decision: 'VERIFIED' });
    }
    providers[r.discovery.externalRef ?? r.provider.serviceProviderId] = {
      serviceProviderId: r.provider.serviceProviderId,
      points,
    };
  }
  await linkApprovedVendor(w.db.pool, w.admin, {
    serviceProviderId: providers['cl-001']!.serviceProviderId,
    vendorId: w.vendorId,
  });
  return providers;
}

export async function foodAtRisk(
  w: PlanningWorld,
  assetId: AssetId,
  amountMinor: bigint,
  currency: CurrencyCode = 'USD',
) {
  return recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'FOOD_AT_RISK',
    entityId: assetId,
    body: { value: money(amountMinor, currency), basis: 'INVENTORY_COUNT' },
    source: 'API',
  });
}

/**
 * A fresh asset (with warranty and, unless `inventoryMinor` is null, a food-at-risk value), an incident on it with its
 * first evidence revision, one ALLOW candidate per offer and (unless `noQuote`) one operator-entered quote each.
 */
export async function scenario(
  w: PlanningWorld,
  offers: Offer[],
  opts: { inventoryMinor?: bigint | null; inventoryCurrency?: CurrencyCode } = {},
): Promise<Scenario> {
  const asset = await nwrAsset(w);
  await warranty(w, asset.assetId);
  const inventory = opts.inventoryMinor === undefined ? 500_000n : opts.inventoryMinor;
  if (inventory !== null) await foodAtRisk(w, asset.assetId, inventory, opts.inventoryCurrency);
  const inc = await incidentWithEvidence(w, { assetId: asset.assetId });
  const providers = await discoverFor(w, inc.incidentId);
  const pairs: ScenarioPair[] = [];
  let slot = 0;
  for (const o of offers) {
    const cand = await exactCandidate(w, inc, {
      merchantId: merchant(),
      amount: money(o.priceMinor, 'USD'),
      ...(o.kind ? { kind: o.kind, purpose: o.kind } : {}),
    });
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId }, w.signing);
    let quoteId: string | null = null;
    if (!o.noQuote) {
      const p = providers[o.provider ?? 'cl-001']!;
      const channel = CHANNELS[slot % 3]!;
      const purposeCode = PURPOSES[Math.floor(slot / 3) % 4]!;
      slot++;
      const contactPointId = p.points[channel] ?? Object.values(p.points)[0]!;
      const req = await prepareContactRequest(w.db.pool, w.people.operator!.ctx, {
        incidentId: inc.incidentId,
        serviceProviderId: p.serviceProviderId,
        contactPointId,
        providerAccountId: w.unpaid.providerAccountId,
        channel: p.points[channel] ? channel : (Object.keys(p.points)[0] as (typeof CHANNELS)[number]),
        purposeCode,
        idempotencyKey: w.key('prep'),
      });
      const amount = o.quoteAmountMinor === undefined ? o.priceMinor : o.quoteAmountMinor;
      const q = await recordQuote(w.db.pool, w.people.operator!.ctx, {
        contactRequestId: req.contactRequestId,
        sourceKind: 'OPERATOR_ENTRY',
        scopeKind: o.kind === 'SERVICE_JOB' ? 'REPAIR_LABOR' : 'PART_SUPPLY',
        partNumber: o.partNumber ?? '5A1-0402',
        manufacturer: MANUFACTURER,
        amount: amount === null ? null : money(amount, o.quoteCurrency ?? 'USD'),
        taxMinor: amount === null ? null : 0n,
        etaMinutes: o.etaMinutes,
        availabilityStatus: o.availability ?? 'AVAILABLE',
        validUntil: new Date(Date.now() + (o.validForMs ?? 4 * 3_600_000)).toISOString(),
        sourceEvidence: { note: `synthetic call note ${o.label}` },
      });
      quoteId = q.quoteId;
    }
    pairs.push({
      label: o.label,
      candidateActionId: cand.candidateActionId,
      quoteId,
      compatibilityDecisionId: d.compatibilityDecisionId,
      decision: d.decision,
    });
  }
  return {
    incidentId: inc.incidentId,
    assetId: asset.assetId,
    evidenceRevisionId: inc.evidenceRevisionId,
    pairs,
    refs: pairs.map((p) => ({ candidateActionId: p.candidateActionId, quoteId: p.quoteId })),
    byLabel: Object.fromEntries(pairs.map((p) => [p.label, p])),
  };
}

export async function outboxEvents(w: PlanningWorld, eventType: string, aggregateId?: string) {
  const { rows } = await w.db.pool.query(
    `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = $2 AND ($3::text IS NULL OR aggregate_id = $3)
      ORDER BY seq`,
    [w.tenant.tenantId, eventType, aggregateId ?? null],
  );
  return rows.map((r) => ({
    eventId: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at.toISOString(),
    tenantId: r.tenant_id,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    schemaVersion: 1,
    payload: r.payload,
  }));
}

/** Deliver every outbox event of `eventType` for this tenant to `handler` (idempotent consumers). */
export async function deliver(
  w: PlanningWorld,
  eventType: string,
  handler: (pool: PlanningWorld['db']['pool'], e: never) => Promise<unknown>,
) {
  const out: unknown[] = [];
  for (const e of await outboxEvents(w, eventType)) out.push(await handler(w.db.pool, e as never));
  return out;
}

export const labelsInOrder = (
  plan: { actions: { ordinal: number | null; candidateActionId: string }[] },
  s: Scenario,
) =>
  plan.actions
    .filter((a) => a.ordinal !== null)
    .sort((a, b) => a.ordinal! - b.ordinal!)
    .map((a) => s.pairs.find((p) => p.candidateActionId === a.candidateActionId)!.label);

export const ctxOf = (w: PlanningWorld, name: string): TenantContext => w.people[name]!.ctx;
