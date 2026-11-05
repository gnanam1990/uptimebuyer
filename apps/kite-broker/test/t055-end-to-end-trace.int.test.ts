// T-055 end-to-end trace correlation (FR-18, NFR-09, INV-13, INV-16). One incident is carried through decision,
// approval and authority issuance over the real operator API, a payment through the real broker request handler on a
// unix socket (in this process, RECORDED_CONTRACT adapter), order fulfillment by signed webhooks, and recovery by LIVE
// telemetry plus a signed CMMS milestone. Proven:
// - API -> packages -> outbox: the X-Correlation-ID of each API command is the correlation id on every ledger entry,
//   audit entry and outbox event that command wrote, and on its log line and span;
// - packages -> outbox -> broker: the correlation id of the command that created the commercial intent is on the
//   intent, every intent/attempt outbox event the broker wrote, and the broker's structured log lines;
// - the incident trace reconstructed from durable records covers telemetry, evidence, decision, plan, approval,
//   payment, provider, order and recovery stages in order, every span carrying a correlation id;
// - the evidence-ledger export is complete for the incident and correlation-linked, the hash chain verifies;
// - nothing in logs, spans, broker lines, trace or export carries secrets or another tenant's identifiers, and another
//   tenant cannot read the trace.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KiteBrokerPort, authorityReference } from '@uptimebuyer/commerce';
import { authenticateHuman, exportEvidenceLedger, resolveTenantContext, type TenantContext } from '@uptimebuyer/data';
import { dispatchOrder, recordFulfillmentVerification, requestOrder, syncIncidentForOrder } from '@uptimebuyer/orders';
import { MemoryExporter, MemorySink, MetricsRegistry, StructuredLogger, Tracer } from '@uptimebuyer/observability';
import { buildIncidentTrace, TRACE_STAGES } from '@uptimebuyer/operations';
import { newId, type CorrelationId } from '@uptimebuyer/contracts';
import { provisionDevice } from '../../sensor-gateway/test/helpers.js';
import { humanContext } from '../../../packages/data/test/helpers.js';
import { BrokerLog } from '../src/log.js';
import { brokerRequestHandler, listenOnUnixSocket } from '../src/server.js';
import { assess, dbNowMs, fulfil, milestoneAt, readings, steady } from './m11-helpers.js';
import { buildApiFor, call, createApiWorld, pendingApproval, type ApiWorld } from './m12-helpers.js';

let w: ApiWorld;
let server: http.Server;
let port: KiteBrokerPort;
const brokerLines: string[] = [];
const sink = new MemorySink();
const spans = new MemoryExporter();
let api: Awaited<ReturnType<typeof buildApiFor>>;
const trail: {
  approveCorr: string;
  issueCorr: string;
  orderCorr: CorrelationId;
  incidentId: string;
  orderId: string;
  intentId: string;
} = {
  approveCorr: '',
  issueCorr: '',
  orderCorr: '' as CorrelationId,
  incidentId: '',
  orderId: '',
  intentId: '',
};

async function ctxWithCorrelation(subject: string, correlationId: CorrelationId): Promise<TenantContext> {
  const principal = await authenticateHuman(w.db.pool, w.idp.verifier(), `Bearer ${await w.idp.mint(subject)}`);
  return resolveTenantContext(w.db.pool, principal, w.tenant.tenantId, { correlationId });
}

beforeAll(async () => {
  w = await createApiWorld('t055');
  server = http.createServer(brokerRequestHandler(w.broker, new BrokerLog((l) => brokerLines.push(l))));
  const socketPath = join(mkdtempSync(join(tmpdir(), 'ub-t055-')), 'broker.sock');
  await listenOnUnixSocket(server, socketPath);
  port = new KiteBrokerPort(w.db.pool, {
    socketPath,
    referenceSigner: w.referenceSigner,
    contextFor: () => w.operator,
  });
  api = await buildApiFor(w, {
    observability: {
      logger: new StructuredLogger({ service: 'api', sink: sink.write }),
      tracer: new Tracer({ service: 'api', exporter: spans.export }),
      metrics: new MetricsRegistry(),
    },
  });

  const p = await pendingApproval(w);
  trail.incidentId = p.incidentId;
  const appr = await call({ app: api.app, idp: w.idp }, w.subjects.approver!, 'POST', `/v1/plans/${p.planId}:approve`, {
    body: { approvalRequestId: p.approvalRequestId, planHash: p.planHash },
  });
  expect(appr.statusCode).toBeLessThan(300);
  trail.approveCorr = appr.headers['x-correlation-id'] as string;
  const issued = await call(
    { app: api.app, idp: w.idp },
    w.subjects.finance!,
    'POST',
    `/v1/approvals/${appr.json().approvalId}/execution-authorities`,
    {
      body: { subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
    },
  );
  expect(issued.statusCode).toBe(202);
  trail.issueCorr = issued.headers['x-correlation-id'] as string;
  const authorityId = issued.json().authority.authority.executionAuthorityId as string;
  await port.activateSession(authorityReference(w.referenceSigner, w.tenant.tenantId, authorityId));

  trail.orderCorr = newId('correlation');
  const operator = await ctxWithCorrelation(w.subjects.operator!, trail.orderCorr);
  const order = await requestOrder(
    w.db.pool,
    operator,
    { executionAuthorityId: authorityId, idempotencyKey: w.key('order') },
    w.referenceSigner,
  );
  trail.orderId = order.order.orderId;
  trail.intentId = order.order.commercialIntentId as string;
  const device = await provisionDevice(w, { siteId: w.siteId, assetId: p.assetId as never });
  await dispatchOrder(w.db.pool, operator, trail.orderId, {
    broker: {
      execute: (r: unknown) => port.execute(r as never),
      reconcile: (r: unknown) => port.reconcile(r as never),
    },
    referenceSigner: w.referenceSigner,
  });
  await syncIncidentForOrder(w.db.pool, w.service, trail.orderId);
  await fulfil(w, trail.orderId, ['ordered', 'shipped', 'delivered']);
  await syncIncidentForOrder(w.db.pool, w.service, trail.orderId);
  await recordFulfillmentVerification(w.db.pool, w.operator, {
    orderId: trail.orderId,
    outcome: 'VERIFIED',
    idempotencyKey: w.key('verify'),
  });
  await syncIncidentForOrder(w.db.pool, w.service, trail.orderId);
  const inc = (await w.db.pool.query(`SELECT asset_revision_id FROM incidents WHERE id = $1`, [p.incidentId])).rows[0];
  const plan = (await w.db.pool.query(`SELECT action_digest FROM purchase_orders WHERE id = $1`, [trail.orderId]))
    .rows[0];
  const v = {
    incidentId: p.incidentId,
    assetId: p.assetId,
    assetRevisionId: inc.asset_revision_id,
    planId: p.planId,
    planActionId: p.planActionId,
    actionDigest: plan.action_digest,
    orderId: trail.orderId,
    device,
    readyAt: await dbNowMs(w),
  };
  const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
  await readings(w, device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
  const r = await assess(w, v, m.boundaryMs + 61_500);
  expect(r).toMatchObject({ outcome: 'PASSED', incidentState: 'RECOVERED' });
}, 400_000);
afterAll(async () => {
  await api?.app.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await w?.close();
});

describe('T-055 correlation flows API -> packages -> outbox -> broker', () => {
  it('each API command correlation id is on its ledger, audit and outbox rows, its log line and its span', async () => {
    for (const corr of [trail.approveCorr, trail.issueCorr]) {
      expect(corr).toMatch(/^corr_/);
      const audit = await w.db.pool.query(
        `SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND correlation_id = $2`,
        [w.tenant.tenantId, corr],
      );
      expect(audit.rows[0].n, corr).toBeGreaterThanOrEqual(1);
      expect(
        sink.records().some((r) => r.event === 'http.request' && r.correlationId === corr && r.status !== 500),
      ).toBe(true);
      expect(spans.spans.some((s) => s.name === 'http.request' && s.correlationId === corr)).toBe(true);
    }
    const ledger = await w.db.pool.query(
      `SELECT kind FROM evidence_ledger_entries WHERE tenant_id = $1 AND correlation_id = $2`,
      [w.tenant.tenantId, trail.approveCorr],
    );
    expect(ledger.rows.map((r) => r.kind)).toContain('APPROVAL');
    const outbox = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND correlation_id = $2`,
      [w.tenant.tenantId, trail.issueCorr],
    );
    expect(outbox.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('the intent-creating command correlation id is on the intent, every broker outbox event and the broker log', async () => {
    const intent = await w.db.pool.query(`SELECT correlation_id, state FROM commercial_intents WHERE id = $1`, [
      trail.intentId,
    ]);
    expect(intent.rows[0]).toMatchObject({ correlation_id: trail.orderCorr, state: 'CONFIRMED' });
    const events = await w.db.pool.query(
      `SELECT event_type, correlation_id FROM outbox_events WHERE tenant_id = $1
         AND (aggregate_id = $2 OR payload->>'commercialIntentId' = $2) ORDER BY seq`,
      [w.tenant.tenantId, trail.intentId],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(events.rows.map((e) => e.correlation_id))).toEqual(new Set([trail.orderCorr]));
    const lines = brokerLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const exec = lines.filter((l) => l.event === 'intent.execute');
    expect(exec.length).toBeGreaterThanOrEqual(1);
    expect(exec.every((l) => l.correlationId === trail.orderCorr && l.intentId === trail.intentId)).toBe(true);
    expect(lines.some((l) => l.event === 'session.activate')).toBe(true);
  });
});

describe('T-055 the incident trace and ledger export', () => {
  it('reconstructs every stage in order with correlation ids', async () => {
    const t = await buildIncidentTrace(w.db.pool, w.admin, trail.incidentId);
    expect(TRACE_STAGES).toEqual([
      'telemetry',
      'evidence',
      'decision',
      'plan',
      'approval',
      'payment',
      'provider',
      'order',
      'recovery',
    ]);
    expect(t.missing).toEqual([]);
    expect(t.complete).toBe(true);
    for (const s of t.spans) expect(s.correlationId, `${s.name}:${s.source.table}`).toMatch(/^corr_/);
    const firstAt = (stage: string) =>
      Math.min(...t.spans.filter((s) => s.stage === stage).map((s) => Date.parse(s.at)));
    const order = ['evidence', 'decision', 'plan', 'approval', 'payment', 'provider', 'order', 'recovery'];
    for (let i = 1; i < order.length; i++)
      expect(firstAt(order[i]!), order[i]).toBeGreaterThanOrEqual(firstAt(order[i - 1]!));
    expect(t.spans.find((s) => s.name === 'incident.close')).toBeDefined();
    expect(t.correlationIds).toEqual(expect.arrayContaining([trail.approveCorr, trail.issueCorr, trail.orderCorr]));
  });

  it('the evidence-ledger export is complete for the incident, correlation-linked and chain-verified', async () => {
    const exp = await exportEvidenceLedger(w.db.pool, w.admin);
    expect(exp.chain).toEqual({ ok: true });
    const mine = exp.entries.filter((e) => e.incidentId === trail.incidentId);
    const db = await w.db.pool.query(
      `SELECT id FROM evidence_ledger_entries WHERE tenant_id = $1 AND incident_id = $2`,
      [w.tenant.tenantId, trail.incidentId],
    );
    expect(mine.map((e) => e.evidenceId).sort()).toEqual(db.rows.map((r) => r.id).sort());
    const kinds = new Set(mine.map((e) => e.kind));
    for (const k of ['MATERIAL_INPUT', 'POLICY_DECISION', 'APPROVAL', 'PAYMENT_STATE', 'RECOVERY_DECISION'])
      expect(kinds.has(k as never), k).toBe(true);
    for (const e of mine) expect(e.correlation.correlationId).toMatch(/^corr_/);
  });

  it('carries no secrets or other-tenant data, and another tenant cannot read the trace', async () => {
    const t = await buildIncidentTrace(w.db.pool, w.admin, trail.incidentId);
    const everything = JSON.stringify([t, sink.lines, spans.spans, brokerLines]);
    expect(everything).not.toContain(w.tenantB.tenantId);
    expect(everything).not.toMatch(/secretref:|Bearer [A-Za-z0-9]|-----BEGIN|"rawBody"/);
    expect(everything).not.toContain(Buffer.from(w.referenceSigner.key).toString('base64url'));
    const b = await humanContext(w.db.pool, w.idp, w.tenantB.adminSubject, w.tenantB.tenantId);
    await expect(buildIncidentTrace(w.db.pool, b, trail.incidentId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(buildIncidentTrace(w.db.pool, w.viewerCtx, trail.incidentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
