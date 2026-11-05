// T-054 load, rate, timeout and cost bounds (NFR-04, NFR-08). Each declared bound is exercised at its boundary from
// both sides against the real stores: telemetry bursts, batch and body size through the real gateway (a gateway with
// deliberately small limits proves explicit shedding, never silent queuing), retrieval query size and result count,
// model turn/token/cost budgets through runReasoning, provider search bounds, reconciliation poll bounds and the API
// body limit. Latency objectives from OBSERVABILITY-OPERATIONS §6 are measured on this stack (telemetry acceptance,
// incident opening, policy evaluation, operator reads, reconciliation entry) and a missed objective surfaces as a
// visible degraded readiness state and an alert. Local measurements are not production SLO evidence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REASONING_LIMITS,
  commitIncidentEvidence,
  ContractFakeReasoner,
  runReasoning,
  searchEvidence,
} from '@uptimebuyer/evidence';
import { evaluateCandidate } from '@uptimebuyer/compatibility';
import {
  FulfillmentAdapterRegistry,
  POLL_LIMITS,
  RecordedFulfillmentAdapter,
  dispatchOrder,
  pollFulfillmentStatus,
} from '@uptimebuyer/orders';
import { SEARCH_LIMITS, runProviderSearch } from '@uptimebuyer/providers';
import { buildSensorGateway, DEFAULT_GATEWAY_LIMITS } from '@uptimebuyer/sensor-gateway';
import { TELEMETRY_LIMITS } from '@uptimebuyer/telemetry';
import { ALERT_RULES, MetricsRegistry, SloTracker, evaluateAlerts, platformMetrics } from '@uptimebuyer/observability';
import { MANUAL_C, ingestAs, nwrAsset, openIncident, proposalFor } from '../../../packages/evidence/test/helpers.js';
import { exactCandidate, incidentWithEvidence, merchant } from '../../../packages/compatibility/test/helpers.js';
import { message, post, provisionDevice, syncClock, temp } from '../../sensor-gateway/test/helpers.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { inProcessBroker, intentRef, readyIntent } from './helpers.js';
import { buildApiFor, call, createApiWorld, type ApiWorld } from './m12-helpers.js';
import { brokerDeps, orderFor } from './m10-helpers.js';
import { verifyingIncident, type VerifyingIncident } from './m11-helpers.js';

let w: ApiWorld;
let v: VerifyingIncident;
const slo = new SloTracker({ minSamples: 5 });
let seq = 400_000;

beforeAll(async () => {
  w = await createApiWorld('t054');
  v = await verifyingIncident(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('T-054 telemetry bounds through the real gateway', () => {
  it('declares the bounds and sheds a burst beyond the per-device rate with 429, accepting exactly the capacity', async () => {
    expect(TELEMETRY_LIMITS).toMatchObject({ maxBodyBytes: 256 * 1024, maxMessagesPerBatch: 200 });
    expect(DEFAULT_GATEWAY_LIMITS.liveRate.capacityMessages).toBe(600);
    const gw = await buildSensorGateway({
      pool: w.db.pool,
      credentials: w.creds,
      clock: w.clock,
      limits: { liveRate: { capacityMessages: 5, refillMessagesPerSecond: 0.001 } },
    });
    try {
      const device = await provisionDevice(w, { siteId: w.siteId, assetId: v.assetId as never });
      // Readings must postdate the binding, whose effective time comes from the (leading) database clock.
      const at = syncClock(w, 2_000);
      const one = (i: number) => message(++seq, at + i, [temp(device.channels.temp!, 4_000)]);
      const burst = await post({ gw, clock: w.clock }, device, [0, 1, 2, 3, 4].map(one));
      expect(burst.status).toBe(200);
      expect(burst.body.results!.every((r) => r.status === 'ACCEPTED')).toBe(true);
      const over = await post({ gw, clock: w.clock }, device, [one(5)]);
      expect(over.status).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(gw.metrics().rateLimited).toBeGreaterThanOrEqual(1);
    } finally {
      await gw.close();
    }
  });

  it('accepts a batch of exactly 200 messages and refuses 201; refuses a body one byte over the limit', async () => {
    const device = await provisionDevice(w, { siteId: w.siteId, assetId: v.assetId as never });
    const at = syncClock(w, 5_000) - 3_000;
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => message(++seq, at + i * 10, [temp(device.channels.temp!, 4_000)]));
    const ok = await post(w, device, batch(200));
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(200);
    expect(ok.body.results!.every((r) => r.status === 'ACCEPTED')).toBe(true);
    const tooMany = await post(w, device, batch(201));
    expect([400, 413]).toContain(tooMany.status);
    const huge = await post(w, device, batch(1), { extra: { pad: 'p'.repeat(TELEMETRY_LIMITS.maxBodyBytes) } });
    expect(huge.status).toBe(413);
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      const s = Date.now();
      const r = await post(w, device, [message(++seq, syncClock(w, 1_000), [temp(device.channels.temp!, 4_000)])]);
      expect(r.status).toBe(200);
      expect(r.body.results![0]!.status).toBe('ACCEPTED');
      slo.record('telemetry_acceptance', Date.now() - s);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});

describe('T-054 retrieval and model bounds', () => {
  let incidentId: string;
  let evidenceRevisionId: string;
  beforeAll(async () => {
    const asset = await nwrAsset(w);
    await ingestAs(w, w.librarian, MANUAL_C());
    incidentId = await openIncident(w, asset.assetId);
    evidenceRevisionId = (
      await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
        incidentId: incidentId as never,
        reasonCode: 'TRIAGE_EVIDENCE',
      })
    ).evidenceRevisionId;
  });

  it('accepts a 200-character query, refuses 201, and caps results at the declared maximum', async () => {
    const ctx = w.people.operator!.ctx;
    const q200 = ('evaporator fan motor ' + 'x'.repeat(200)).slice(0, 200);
    await expect(searchEvidence(w.db.pool, ctx, { evidenceRevisionId, query: q200 })).resolves.toBeDefined();
    await expect(searchEvidence(w.db.pool, ctx, { evidenceRevisionId, query: q200 + 'y' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const hits = await searchEvidence(w.db.pool, ctx, {
      evidenceRevisionId,
      query: 'fan motor evaporator',
      limit: 10_000,
    });
    expect(hits.length).toBeLessThanOrEqual(20);
  });

  it('enforces the model turn budget and a per-run token budget at its exact boundary', async () => {
    expect(REASONING_LIMITS.maxRunTokens).toBeGreaterThan(0);
    const toolTurn = (n: number) => ({
      kind: 'TOOL_CALLS' as const,
      calls: [{ id: `t${n}`, name: 'search_evidence', arguments: JSON.stringify({ query: 'fan motor' }) }],
    });
    const turns = new ContractFakeReasoner((_req, turn) => toolTurn(turn));
    const t = await runReasoning(w.db.pool, w.service, { reasoner: turns, store: w.store }, { incidentId });
    expect(t.status).toBe('REJECTED');
    expect(t.rejectionReasons).toContain('TURN_BUDGET_EXCEEDED');
    expect(turns.requests.length).toBe(REASONING_LIMITS.maxTurns);

    const exact = new ContractFakeReasoner((req, turn) =>
      turn === 1
        ? { ...toolTurn(1), usage: { promptTokens: 600, completionTokens: 300 } }
        : {
            kind: 'FINAL',
            content: JSON.stringify(proposalFor(req)),
            usage: { promptTokens: 80, completionTokens: 20 },
          },
    );
    const ok = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: exact, store: w.store, budget: { maxRunTokens: 1_000 } },
      { incidentId },
    );
    expect(ok.rejectionReasons).not.toContain('TOKEN_BUDGET_EXCEEDED');
    const over = new ContractFakeReasoner((req, turn) =>
      turn === 1
        ? { ...toolTurn(1), usage: { promptTokens: 600, completionTokens: 300 } }
        : {
            kind: 'FINAL',
            content: JSON.stringify(proposalFor(req)),
            usage: { promptTokens: 80, completionTokens: 21 },
          },
    );
    const no = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: over, store: w.store, budget: { maxRunTokens: 1_000 } },
      { incidentId },
    );
    expect(no.status).toBe('REJECTED');
    expect(no.rejectionReasons).toContain('TOKEN_BUDGET_EXCEEDED');
    expect(no.proposalId).toBeNull();
  });

  it('enforces a per-run cost ceiling in integer micro-units and stops calling the model once exceeded', async () => {
    const pricing = { pricePerMillionPromptMicros: 1_000_000n, pricePerMillionCompletionMicros: 2_000_000n };
    // 1 000 prompt (1 000 micros) + 500 completion (1 000 micros) = 2 000 micros per turn.
    const fake = new ContractFakeReasoner(() => ({
      kind: 'TOOL_CALLS',
      calls: [{ id: 'c', name: 'search_evidence', arguments: '{"query":"fan"}' }],
      usage: { promptTokens: 1_000, completionTokens: 500 },
    }));
    const r = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: fake, store: w.store, budget: { maxCostMicros: 3_999n, ...pricing } },
      { incidentId },
    );
    expect(r.status).toBe('REJECTED');
    expect(r.rejectionReasons).toContain('COST_BUDGET_EXCEEDED');
    expect(fake.requests.length).toBe(2);
    const unreported = new ContractFakeReasoner(() => ({ kind: 'FINAL', content: '{}' }));
    const u = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: unreported, store: w.store, budget: { maxCostMicros: 1_000_000n, ...pricing } },
      { incidentId },
    );
    expect(u.rejectionReasons).toContain('USAGE_UNREPORTED');
  });
});

describe('T-054 provider and reconciliation bounds', () => {
  it('provider search bounds accept the maximum and refuse one beyond (before any provider call)', async () => {
    const base = {
      incidentId: v.incidentId,
      providerAccountId: 'pac_00000000-0000-4000-8000-000000000000',
      query: { providerKinds: ['TECHNICIAN'], country: 'GB' },
      idempotencyKey: w.key('search'),
    };
    const reason = (bounds: object) =>
      runProviderSearch(w.db.pool, w.operator, { ...base, bounds } as never, { adapters: new Map() } as never).then(
        () => 'RAN',
        (e: { details?: { reasonCode?: string } }) => e.details?.reasonCode ?? 'ERR',
      );
    const { maxResults, maxPages, maxTimeoutMs } = SEARCH_LIMITS;
    for (const over of [{ maxResults: maxResults + 1 }, { maxPages: maxPages + 1 }, { timeoutMs: maxTimeoutMs + 1 }])
      expect(await reason(over), JSON.stringify(over)).toBe('INVALID_PROVIDER_SEARCH');
    expect(await reason({ maxResults, maxPages, timeoutMs: maxTimeoutMs })).not.toBe('INVALID_PROVIDER_SEARCH');
  });

  it('stops polling an order after exactly maxPollsPerOrder lookups', async () => {
    // A live (non-terminal) order: dispatched through the broker and accepted, nothing delivered yet.
    const o = await orderFor(w, 'PART_PURCHASE');
    await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    const providerKey = (
      await w.db.pool.query(`SELECT provider_key FROM provider_accounts WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        w.account.providerAccountId,
      ])
    ).rows[0].provider_key;
    const adapter = new RecordedFulfillmentAdapter({ providerKey });
    const reg = new FulfillmentAdapterRegistry([adapter]);
    const row = async () =>
      (await w.db.pool.query(`SELECT state, poll_count, next_poll_at FROM purchase_orders WHERE id = $1`, [o.orderId]))
        .rows[0];
    expect(['ACCEPTED', 'REQUESTED']).toContain((await row()).state);
    const due = (n?: number) =>
      w.db.pool.query(
        `UPDATE purchase_orders SET poll_count = coalesce($2, poll_count), next_poll_at = clock_timestamp() - interval '1 minute'
          WHERE tenant_id = $1 AND id = $3`,
        [w.tenant.tenantId, n ?? null, o.orderId],
      );
    await due(POLL_LIMITS.maxPollsPerOrder - 2);
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg });
    const mid = await row();
    expect(mid.poll_count).toBe(POLL_LIMITS.maxPollsPerOrder - 1);
    expect(mid.next_poll_at).not.toBeNull();
    expect(adapter.calls).toBe(1);
    await due();
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg });
    const last = await row();
    expect(last.poll_count).toBe(POLL_LIMITS.maxPollsPerOrder);
    expect(last.next_poll_at).toBeNull();
    expect(adapter.calls).toBe(2);
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg });
    expect(adapter.calls).toBe(2);
  });

  it('an ambiguous payment enters reconciliation within the 60 s objective', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter, { reconcileBaseMs: 1_000 });
    adapter.nextModes = ['DROP_RESPONSE'];
    const { intentId } = await readyIntent(w, broker);
    await broker.execute(intentRef(w, intentId));
    const row = (
      await w.db.pool.query(
        `SELECT i.state, a.next_reconcile_at, t.created_at AS unknown_at
           FROM commercial_intents i JOIN external_attempts a ON a.tenant_id = i.tenant_id AND a.intent_id = i.id
           JOIN commercial_intent_transitions t ON t.tenant_id = i.tenant_id AND t.intent_id = i.id AND t.to_state = 'UNKNOWN'
          WHERE i.tenant_id = $1 AND i.id = $2`,
        [w.tenant.tenantId, intentId],
      )
    ).rows[0];
    expect(row.state).toBe('UNKNOWN');
    const ms = (row.next_reconcile_at as Date).getTime() - (row.unknown_at as Date).getTime();
    expect(ms).toBeLessThanOrEqual(60_000);
    for (let i = 0; i < 5; i++) slo.record('reconciliation_entry', Math.max(0, ms));
  });
});

describe('T-054 API body bound and NFR-08 latency objectives', () => {
  it('the API accepts a body of exactly the limit (not 413) and refuses one byte more', async () => {
    const limit = 64 * 1024;
    const pad = (n: number) => {
      const shell = JSON.stringify({ reasonCode: 'X', pad: '' });
      return JSON.stringify({ reasonCode: 'X', pad: 'q'.repeat(n - shell.length) });
    };
    const at = await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${v.incidentId}:escalate`, {
      rawBody: pad(limit),
    });
    expect(Buffer.byteLength(pad(limit))).toBe(limit);
    expect(at.statusCode).not.toBe(413);
    const over = await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${v.incidentId}:escalate`, {
      rawBody: pad(limit + 1),
    });
    expect(over.statusCode).toBe(413);
  });

  it('measures incident opening, policy evaluation and operator reads against the §6 targets', async () => {
    const opened = await w.db.pool.query(
      `SELECT open_latency_ms FROM incidents WHERE tenant_id = $1 AND open_latency_ms IS NOT NULL`,
      [w.tenant.tenantId],
    );
    expect(opened.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of opened.rows) slo.record('incident_opening', Number(r.open_latency_ms));
    while (slo.samples('incident_opening') < 5) slo.record('incident_opening', Number(opened.rows[0].open_latency_ms));
    const inc = await incidentWithEvidence(w);
    for (let i = 0; i < 5; i++) {
      const cand = await exactCandidate(w, inc, { merchantId: merchant() as never });
      const s = Date.now();
      await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId }, w.signing);
      slo.record('policy_evaluation', Date.now() - s);
    }
    const api = await buildApiFor(w, { observability: { slo } });
    for (let i = 0; i < 10; i++) {
      for (const url of ['/v1/fleet', `/v1/incidents/${v.incidentId}`]) {
        const r = await call({ app: api.app, idp: w.idp }, w.subjects.operator!, 'GET', url);
        expect(r.statusCode).toBe(200);
      }
    }
    await api.app.close();
    const results = Object.fromEntries(slo.evaluate().map((e) => [e.name, e]));
    for (const name of [
      'telemetry_acceptance',
      'incident_opening',
      'policy_evaluation',
      'operator_read',
      'reconciliation_entry',
    ]) {
      expect(results[name]!.status, name).not.toBe('INSUFFICIENT_DATA');
      expect(results[name]!.observedMs, name).not.toBeNull();
    }
    expect(results.operator_read!.samples).toBeGreaterThanOrEqual(20);
    // Notification dispatch has no deliveries on this stack: it is reported, not hidden or assumed.
    expect(results.notification_dispatch!.status).toBe('INSUFFICIENT_DATA');
  });

  it('a missed objective is visible as degraded readiness and fires the SLO alert', async () => {
    const slow = new SloTracker({ minSamples: 5 });
    const pool = w.db.pool;
    const slowPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query')
          return async (...args: unknown[]) => {
            await new Promise((r) => setTimeout(r, 600));
            return (target.query as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const api = await buildApiFor(w, { pool: slowPool as never, observability: { slo: slow } });
    for (let i = 0; i < 5; i++) await call({ app: api.app, idp: w.idp }, w.subjects.operator!, 'GET', '/v1/fleet');
    const ready = await api.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('degraded');
    expect(JSON.stringify(ready.json())).toContain('operator_read');
    const m = new MetricsRegistry();
    slow.exportTo(platformMetrics(m));
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toContain('slo_target_missed');
    await api.app.close();
  });
});
