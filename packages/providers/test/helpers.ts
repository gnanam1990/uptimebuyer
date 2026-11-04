// Shared fixtures for the M07 integration tests: the M05 evidence world (throwaway database, tenant, site, people,
// worker service, Northwind asset, open incident and its evidence revision) plus an AUTHORITY policy that lets the
// site's maintenance approver approve bounded paid contacts, an unpaid structured-API provider account (M07-owned),
// a paid StablePhone-candidate account (broker-owned), synthetic live-shaped sandbox transports and a counting
// wrapper around the M01 commercial-intent broker CONTRACT FAKE. Nothing here is a real provider, call, email or
// payment; synthetic keys and canaries are generated at runtime.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CommercialIntentStateChangedEventSchema,
  InMemoryCommercialIntentBrokerFake,
  type CommercialIntentAttemptView,
  type CommercialIntentBrokerPort,
  type CommercialIntentRequest,
  type CommercialIntentStateChangedEvent,
  type CreateIntentResult,
  type IntentRunResult,
  type SignedExecutionReference,
} from '@uptimebuyer/kite-contracts';
import {
  decodeWire,
  encodeWire,
  money,
  newId,
  type CommercialIntent,
  type CommercialIntentId,
  type ExecutionAuthorityId,
  type IncidentId,
  type KiteSession,
  type TenantId,
} from '@uptimebuyer/contracts';
import {
  appendOutboxEvent,
  createProviderAccount,
  publishPolicyRevision,
  recordApproval,
  withTenantTransaction,
  type AuthorityPolicy,
  type TenantContext,
} from '@uptimebuyer/data';
import { commitIncidentEvidence } from '@uptimebuyer/evidence';
import {
  canary,
  createEvidenceWorld,
  openIncident,
  rejection,
  person,
  type EvidenceWorld,
  type Person,
} from '../../evidence/test/helpers.js';
import {
  ChannelContactAdapter,
  FixtureProviderTransport,
  LocalChannelTransport,
  StaticAdapterRegistry,
  StructuredProviderApiAdapter,
  endpointPolicyDigest,
  reviewContactPoint,
  runProviderSearch,
  type EndpointPolicy,
  type ProviderHttpResponse,
} from '../src/index.js';

export { canary, rejection, person, type Person };

const here = dirname(fileURLToPath(import.meta.url));
/** Synthetic live-shaped fixture (classified SYNTHETIC_FIXTURE; not a recording of any real provider). */
export const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures', 'coldline-dispatch-api.synthetic.json'), 'utf8'));
export const fx = (name: string): ProviderHttpResponse => structuredClone(FIXTURE[name] ?? FIXTURE.searchPages[name]);

export const COLDLINE_POLICY: EndpointPolicy = {
  schema: 'provider-endpoint-policy.v1',
  origins: ['https://api.coldline.example'],
};

export const APPROVAL_LIMITS: AuthorityPolicy['approvalLimits'] = [
  {
    approvalKind: 'PLAN_ACTION',
    actionClass: 'STANDARD',
    role: 'maintenance_approver',
    currency: 'USD',
    maxAmountMinor: 500_000n,
    siteIds: null,
  },
];

export interface ProviderAccountFixture {
  providerAccountId: string;
  providerAccountRevisionId: string;
  webhookBinding: string;
  credentialRef: string;
  verifierRef: string;
}

export interface ProviderWorld extends EvidenceWorld {
  operator: Person;
  approver: Person;
  viewer: Person;
  authorityPolicyRevisionId: string;
  incident: { incidentId: IncidentId; evidenceRevisionId: string };
  unpaid: ProviderAccountFixture;
  paid: ProviderAccountFixture;
  api: FixtureProviderTransport;
  email: LocalChannelTransport;
  phone: LocalChannelTransport;
  adapters: StaticAdapterRegistry;
  verifierKey: Uint8Array;
}

export async function providerAccount(
  w: EvidenceWorld,
  providerKey: string,
  over: {
    paid?: boolean;
    capabilities?: string[];
    policy?: EndpointPolicy;
  } = {},
): Promise<ProviderAccountFixture> {
  const paid = over.paid ?? false;
  const suffix = randomBytes(3).toString('hex');
  const credentialRef = `secretref:provider/tenants/${w.tenant.tenantId}/${providerKey}-${suffix}`;
  const verifierRef = `secretref:webhook/tenants/${w.tenant.tenantId}/${providerKey}-${suffix}`;
  const created = await createProviderAccount(w.db.pool, w.admin, {
    providerKey,
    environment: 'SANDBOX',
    revision: {
      capabilities: (over.capabilities ?? [
        'SEARCH',
        'QUOTE',
        'CONTACT_API',
        'CONTACT_EMAIL',
        'CONTACT_PHONE',
        'WEBHOOK',
      ]) as never,
      paid,
      ownerService: paid ? 'KITE_BROKER_PAID' : 'M07_UNPAID',
      credentialRef,
      endpointPolicyDigest: endpointPolicyDigest(over.policy ?? COLDLINE_POLICY),
      webhookVerifierRef: verifierRef,
    },
    source: 'API',
  });
  return { ...created, credentialRef, verifierRef };
}

/** A paging search fixture: page 1 -> page 2 -> end. */
export function scriptSearch(api: FixtureProviderTransport) {
  api.on('GET /v1/providers', (req) => (req.query.cursor === 'page-2' ? fx('second') : fx('first')));
}

export async function createProviderWorld(label: string): Promise<ProviderWorld> {
  const w = await createEvidenceWorld(label);
  const policy = await publishPolicyRevision(w.db.pool, w.admin, {
    policyKey: 'AUTHORITY',
    body: { approvalLimits: APPROVAL_LIMITS },
    source: 'API',
  });
  await publishPolicyRevision(w.db.pool, w.admin, {
    policyKey: 'RETENTION',
    body: { telemetryDays: 90, communicationDays: 30, auditDays: 3650 },
    source: 'API',
  });
  const incidentId = await openIncident(w, w.nwr.assetId);
  const rev = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
    incidentId,
    reasonCode: 'TRIAGE_EVIDENCE',
  });
  const unpaid = await providerAccount(w, 'coldline-dispatch');
  const paid = await providerAccount(w, 'stablephone', { paid: true, capabilities: ['CONTACT_PHONE'] });
  const verifierKey = new Uint8Array(randomBytes(32));
  w.creds.set(unpaid.verifierRef, verifierKey);
  w.creds.set(unpaid.credentialRef, new Uint8Array(randomBytes(32)));
  const api = new FixtureProviderTransport('SYNTHETIC_FIXTURE');
  scriptSearch(api);
  const email = new LocalChannelTransport('EMAIL');
  const phone = new LocalChannelTransport('PHONE');
  const adapters = new StaticAdapterRegistry([
    new StructuredProviderApiAdapter({ providerKey: 'coldline-dispatch', transport: api }),
    new ChannelContactAdapter({ providerKey: 'coldline-dispatch', channel: 'EMAIL', transport: email }),
    new ChannelContactAdapter({ providerKey: 'coldline-dispatch', channel: 'PHONE', transport: phone }),
  ]);
  return {
    ...w,
    operator: w.people.operator!,
    approver: w.people.approver!,
    viewer: w.people.viewer!,
    authorityPolicyRevisionId: policy.policyRevisionId,
    incident: { incidentId, evidenceRevisionId: rev.evidenceRevisionId },
    unpaid,
    paid,
    api,
    email,
    phone,
    adapters,
    verifierKey,
  };
}

/** Discovered contact point ids by service provider and channel (contact values never leave the server). */
export const POINTS = new Map<string, string>();
export function pointOf(serviceProviderId: string, channel: string): string {
  const id = POINTS.get(`${serviceProviderId}|${channel}`);
  if (!id) throw new Error(`no ${channel} contact point discovered for ${serviceProviderId}`);
  return id;
}

/**
 * Run the bounded search against the unpaid account and return the discovered provider ids by external ref. By
 * default an admin reviews (VERIFIES) every discovered contact point, so scenarios may contact a provider through
 * another account; the injection tests pass `verify: false`.
 */
export async function discover(w: ProviderWorld, ctx: TenantContext = w.operator.ctx, opts: { verify?: boolean } = {}) {
  const search = await runProviderSearch(
    w.db.pool,
    ctx,
    {
      incidentId: w.incident.incidentId,
      providerAccountId: w.unpaid.providerAccountId,
      query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
      bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
      idempotencyKey: w.key('search'),
    },
    { adapters: w.adapters, credentials: w.creds },
  );
  const byRef = Object.fromEntries(search.results.map((r) => [r.discovery.externalRef, r.provider.serviceProviderId]));
  for (const r of search.results)
    for (const cp of r.contactPoints) {
      POINTS.set(`${r.provider.serviceProviderId}|${cp.channel}`, cp.contactPointId);
      if ((opts.verify ?? true) && cp.reviewState !== 'VERIFIED')
        await reviewContactPoint(w.db.pool, w.admin, { contactPointId: cp.contactPointId, decision: 'VERIFIED' });
    }
  return { search, byRef: byRef as Record<string, string> };
}

/** A maintenance approver's PLAN_ACTION approval for a prepared paid contact request. */
export async function approvePaidContact(
  w: ProviderWorld,
  prepared: {
    actionDigest: string | null;
    planHash: string | null;
    policyRevisionId: string | null;
    assetRevisionId: string;
    evidenceRevisionId: string;
    providerAccountRevisionId: string;
  },
  maxAmountMinor = 2_500n,
) {
  return recordApproval(w.db.pool, w.approver.ctx, {
    approvalKind: 'PLAN_ACTION',
    incidentId: w.incident.incidentId,
    siteId: w.siteId,
    assetRevisionId: prepared.assetRevisionId,
    evidenceRevisionId: prepared.evidenceRevisionId,
    policyRevisionId: prepared.policyRevisionId!,
    planHash: prepared.planHash,
    actionDigest: prepared.actionDigest,
    actionClass: 'STANDARD',
    paid: true,
    providerAccountRevisionId: prepared.providerAccountRevisionId,
    targetExecutionAuthorityId: null,
    maxAmount: money(maxAmountMinor, 'USD'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

type ExecuteOverride = (
  fake: InMemoryCommercialIntentBrokerFake,
  intent: CommercialIntent,
  reference: SignedExecutionReference,
) => Promise<IntentRunResult>;

/**
 * Counting wrapper around the M01 CONTRACT FAKE broker (it is not Kite and not the M09 broker). It records every
 * port call M07 makes, can inject the fake's execution outcome right after intent creation, and can replace the
 * execution result with crafted broker-port events (for capability loss after possible egress).
 */
export class CountingBroker implements CommercialIntentBrokerPort {
  readonly fake = new InMemoryCommercialIntentBrokerFake();
  readonly calls: { createIntent: CommercialIntentRequest[]; execute: number; reconcile: number; activate: number } = {
    createIntent: [],
    execute: 0,
    reconcile: 0,
    activate: 0,
  };
  outcome: 'ACCEPTED' | 'UNKNOWN' | 'DEFINITE_DECLINE' = 'ACCEPTED';
  executeOverride: ExecuteOverride | null = null;
  readonly references = new Map<string, SignedExecutionReference>();

  async createIntent(request: CommercialIntentRequest): Promise<CreateIntentResult> {
    this.calls.createIntent.push(structuredClone(request));
    const r = await this.fake.createIntent(request);
    if (r.created) this.fake.injectExecutionOutcome(r.intent.commercialIntentId, this.outcome);
    this.references.set(r.intent.commercialIntentId, r.executionReference);
    return r;
  }
  async activateSession(reference: SignedExecutionReference): Promise<KiteSession> {
    this.calls.activate++;
    return this.fake.activateSession(reference);
  }
  async execute(reference: SignedExecutionReference): Promise<IntentRunResult> {
    this.calls.execute++;
    if (this.executeOverride && reference.target.kind === 'COMMERCIAL_INTENT') {
      const intent = (await this.fake.getIntent(reference.tenantId, reference.target.commercialIntentId))!;
      return this.executeOverride(this.fake, intent, reference);
    }
    return this.fake.execute(reference);
  }
  async reconcile(reference: SignedExecutionReference): Promise<IntentRunResult> {
    this.calls.reconcile++;
    return this.fake.reconcile(reference);
  }
  async getIntent(tenantId: TenantId, id: CommercialIntentId) {
    return this.fake.getIntent(tenantId, id);
  }
  /** Stand-in for the M09 authority service: issue the authority and CONFIRM its Kite session on the fake. */
  async confirmedAuthority(tenantId: TenantId): Promise<ExecutionAuthorityId> {
    const xau = newId('executionAuthority');
    await this.fake.activateSession(this.fake.issueAuthorityReference(tenantId, xau));
    return xau;
  }
  /** The broker (not M07) reconciling an intent, as M09 would; returns the broker's events. */
  async brokerReconciles(intentId: CommercialIntentId, outcome: 'CONFIRMED' | 'ACCEPTED' | 'FAILED_NO_EFFECT') {
    this.fake.injectReconciliation(intentId, outcome);
    return this.fake.reconcile(this.references.get(intentId)!);
  }
}

/** A broker-port event exactly as the M01 contract defines it (used where the fake has no injection hook). */
export function brokerEvent(
  intent: CommercialIntent,
  priorState: CommercialIntent['state'],
  state: CommercialIntentStateChangedEvent['payload']['state'],
  attempt: CommercialIntentAttemptView | null,
  opts: { version: number; nextReconcileAt?: string | null; reasonCode?: string | null; causationId?: string },
): CommercialIntentStateChangedEvent {
  return decodeWire(
    CommercialIntentStateChangedEventSchema,
    encodeWire(CommercialIntentStateChangedEventSchema, {
      eventId: newId('event'),
      eventType: 'commercial_intent.state_changed.v1',
      occurredAt: new Date().toISOString(),
      tenantId: intent.tenantId,
      aggregateType: 'commercial_intent',
      aggregateId: intent.commercialIntentId,
      aggregateVersion: opts.version,
      correlationId: newId('correlation'),
      causationId: opts.causationId ?? newId('command'),
      schemaVersion: 1,
      payload: {
        commercialIntentId: intent.commercialIntentId,
        actionDigest: intent.actionDigest,
        executionAuthorityId: intent.executionAuthorityId,
        priorState,
        state,
        attempt,
        reasonCode: opts.reasonCode ?? null,
        nextReconcileAt: opts.nextReconcileAt ?? null,
        resultOrigin: 'CONTRACT_FAKE',
      },
    } as never),
  );
}

export function brokerAttempt(over: Partial<CommercialIntentAttemptView> = {}): CommercialIntentAttemptView {
  return {
    externalAttemptId: newId('externalAttempt'),
    clientOperationId: newId('clientOperation'),
    idempotencyKey: `idem-${randomBytes(8).toString('hex')}` as CommercialIntentAttemptView['idempotencyKey'],
    transportState: 'SEND_STARTED',
    externalOutcomeState: 'AUTHORIZED',
    adapterCapability: 'ELIGIBLE',
    providerRef: null,
    ...over,
  };
}

/**
 * Deliver broker events the way M09 will: durably in the outbox (appended here by the test on the broker's behalf),
 * then consumed by the named consumer through consumeOnce. Returns the durable envelopes.
 */
export async function publishBrokerEvents(
  w: ProviderWorld,
  events: readonly CommercialIntentStateChangedEvent[],
  ctx: TenantContext = w.service,
) {
  const out = [];
  for (const e of events) {
    const eventId = await withTenantTransaction(w.db.pool, ctx, (c) =>
      appendOutboxEvent(c, ctx, {
        eventType: 'commercial_intent.state_changed.v1',
        aggregateType: 'commercial_intent',
        aggregateId: e.aggregateId,
        aggregateVersion: e.aggregateVersion,
        payload: e.payload as unknown as Record<string, unknown>,
        correlationId: e.correlationId,
        causationId: e.causationId,
      }),
    );
    out.push({ ...e, eventId, tenantId: ctx.tenantId });
  }
  return out;
}

export async function outboxEvents(w: EvidenceWorld, eventType: string, aggregateId?: string) {
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

export async function count(w: EvidenceWorld, table: string, where = 'TRUE', params: unknown[] = []) {
  const { rows } = await w.db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return rows[0].n as number;
}

/** Every text column of every row in `tables`, for canary sweeps. */
export async function dumpTables(w: EvidenceWorld, tables: string[]): Promise<string> {
  const parts: string[] = [];
  for (const t of tables) {
    const { rows } = await w.db.pool.query(`SELECT to_jsonb(x)::text AS j FROM ${t} x`);
    parts.push(...rows.map((r) => r.j as string));
  }
  return parts.join('\n');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
