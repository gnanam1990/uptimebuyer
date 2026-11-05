// T-055 (NFR-09, INV-16) — metrics use closed label enumerations only (no tenant/site/incident/provider-reference
// labels), and traces carry correlation ids across process boundaries through W3C traceparent while span attributes
// are redacted. Span status distinguishes a rejection or hold from a system error (OBSERVABILITY-OPERATIONS §4).
import { describe, expect, it } from 'vitest';
import { DomainError } from '@uptimebuyer/contracts';
import { MemoryExporter, MetricsRegistry, REDACTED, SPAN_NAMES, Tracer, parseTraceparent } from '../src/index.js';

describe('T-055 metrics with bounded labels', () => {
  it('counts, gauges and histograms by declared label values and renders Prometheus text', () => {
    const m = new MetricsRegistry();
    const req = m.counter('ub_http_requests_total', 'HTTP requests', {
      route_class: ['read', 'command', 'webhook', 'health'],
      status_class: ['2xx', '4xx', '5xx'],
    });
    const lat = m.histogram('ub_http_request_duration_ms', 'HTTP latency', [5, 50, 500], { route_class: ['read'] });
    const backlog = m.gauge('ub_outbox_unpublished', 'Unpublished outbox events');
    req.inc({ route_class: 'read', status_class: '2xx' });
    req.inc({ route_class: 'read', status_class: '2xx' }, 2);
    lat.observe({ route_class: 'read' }, 3);
    lat.observe({ route_class: 'read' }, 70);
    backlog.set({}, 7);
    expect(m.value('ub_http_requests_total', { route_class: 'read', status_class: '2xx' })).toBe(3);
    expect(m.value('ub_outbox_unpublished')).toBe(7);
    const text = m.exposition();
    expect(text).toContain('# TYPE ub_http_requests_total counter');
    expect(text).toContain('ub_http_requests_total{route_class="read",status_class="2xx"} 3');
    expect(text).toContain('ub_http_request_duration_ms_bucket{route_class="read",le="5"} 1');
    expect(text).toContain('ub_http_request_duration_ms_bucket{route_class="read",le="+Inf"} 2');
    expect(text).toContain('ub_http_request_duration_ms_count{route_class="read"} 2');
  });

  it('refuses an undeclared label value (a tenant, incident or provider reference can never become a label)', () => {
    const m = new MetricsRegistry();
    const c = m.counter('ub_webhook_rejections_total', 'Rejected webhooks', { reason: ['SIGNATURE', 'REPLAY'] });
    for (const bad of ['ten_alpha-0001', 'inc_fixture-0001', 'prov-ref-1234', 'SIGNATURE '])
      expect(() => c.inc({ reason: bad })).toThrowError(
        expect.objectContaining({ details: expect.objectContaining({ reasonCode: 'METRIC_LABEL_UNBOUNDED' }) }),
      );
    expect(() => c.inc({ tenant: 'ten_alpha-0001' } as never)).toThrow();
    expect(() => m.counter('Bad-Name', 'x')).toThrow();
    expect(() => m.counter('ub_webhook_rejections_total', 'dup')).toThrow();
    expect(() => m.counter('ub_free_labels_total', 'x', { tenant_id: [] })).toThrow();
  });
});

describe('T-055 traces with correlation and redaction', () => {
  it('nests spans through async work and propagates trace and correlation ids via traceparent', async () => {
    const exp = new MemoryExporter();
    const api = new Tracer({ service: 'api', exporter: exp.export });
    let header = '';
    await api.withSpan(
      'approval.record',
      { correlationId: 'corr_req-0001', attributes: { incidentId: 'inc_a-0001' } },
      async (s) => {
        await api.withSpan('commercial.reserve', {}, async (child) => {
          header = child.traceparent();
          expect(api.active()?.context.spanId).toBe(child.context.spanId);
        });
        expect(api.active()?.context.spanId).toBe(s.context.spanId);
      },
    );
    const ctx = parseTraceparent(header);
    expect(ctx).not.toBeNull();
    const broker = new Tracer({ service: 'kite-broker', exporter: exp.export });
    await broker.withSpan('provider.execute', { parent: header, correlationId: 'corr_req-0001' }, async () => {});
    const [reserve, approval, execute] = exp.spans;
    expect(approval!.parentSpanId).toBeNull();
    expect(reserve!.parentSpanId).toBe(approval!.spanId);
    expect(execute!.parentSpanId).toBe(reserve!.spanId);
    expect(new Set(exp.spans.map((s) => s.traceId)).size).toBe(1);
    expect(exp.spans.map((s) => s.correlationId)).toEqual(['corr_req-0001', 'corr_req-0001', 'corr_req-0001']);
    expect(exp.spans.map((s) => s.service)).toEqual(['api', 'api', 'kite-broker']);
  });

  it('maps a policy hold to HELD, a validation/conflict to REJECTED and anything else to ERROR', async () => {
    const exp = new MemoryExporter();
    const t = new Tracer({ service: 'worker', exporter: exp.export });
    await expect(
      t.withSpan('compatibility.evaluate', {}, async () => {
        throw new DomainError('POLICY_HOLD', 'Held.', { reasonCode: 'MISSING_EVIDENCE' });
      }),
    ).rejects.toThrow();
    await expect(
      t.withSpan('approval.record', {}, async () => {
        throw new DomainError('DIGEST_MISMATCH', 'No.', { reasonCode: 'PLAN_HASH_MISMATCH' });
      }),
    ).rejects.toThrow();
    await expect(
      t.withSpan('provider.execute', {}, async () => {
        throw new Error('socket hang up');
      }),
    ).rejects.toThrow();
    expect(exp.spans.map((s) => [s.status, s.statusReason])).toEqual([
      ['HELD', 'MISSING_EVIDENCE'],
      ['REJECTED', 'PLAN_HASH_MISMATCH'],
      ['ERROR', 'Error'],
    ]);
  });

  it('redacts span attributes and refuses raw payload attributes', async () => {
    const exp = new MemoryExporter();
    const t = new Tracer({ service: 'worker', exporter: exp.export });
    const token = `Bearer ${'q'.repeat(24)}`;
    await t.withSpan(
      'serv.reason',
      { attributes: { authorization: token, note: `x ${token}`, promptTokens: 9 } },
      async () => {},
    );
    const s = exp.spans[0]!;
    expect(s.attributes.authorization).toBe(REDACTED);
    expect(String(s.attributes.note)).not.toContain('q'.repeat(24));
    expect(s.attributes.promptTokens).toBe(9);
    expect(parseTraceparent('00-zz-yy-01')).toBeNull();
    expect(SPAN_NAMES).toEqual(
      expect.arrayContaining([
        'incident.detect',
        'evidence.build',
        'serv.reason',
        'compatibility.evaluate',
        'plan.rank',
        'approval.record',
        'commercial.reserve',
        'provider.execute',
        'provider.reconcile',
        'recovery.assess',
        'incident.close',
      ]),
    );
  });
});
