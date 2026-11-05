// T-055 / T-054 (NFR-08, NFR-09) — actionable alert definitions as configuration, health/readiness aggregation and SLO
// tracking. Every alert in OBSERVABILITY-OPERATIONS §7 exists with its severity, immediate action and runbook; the
// evaluator fires exactly at its threshold (not below); alert identities and payloads carry no tenant content. A
// missed SLO target surfaces as a visible degraded readiness state, never as a hidden metric (NFR-08).
import { describe, expect, it } from 'vitest';
import {
  ALERT_RULES,
  HealthRegistry,
  MetricsRegistry,
  SLO_TARGETS,
  SloTracker,
  evaluateAlerts,
  platformMetrics,
  validateAlertRules,
} from '../src/index.js';

const SPEC_ALERTS: [string, string][] = [
  ['broker_budget_invariant_violation', 'critical'],
  ['incident_closed_without_evidence', 'critical'],
  ['credential_or_tenant_isolation_signal', 'critical'],
  ['external_outcome_past_deadline', 'high'],
  ['sensor_stale_active_incident', 'high'],
  ['outbox_or_queue_age', 'high'],
  ['provider_circuit_open', 'medium'],
  ['model_rejection_spike', 'medium'],
  ['backup_restore_verification_failed', 'high'],
];

describe('T-055 alert definitions (OBSERVABILITY-OPERATIONS §7)', () => {
  it('defines every specified alert with severity, immediate action, runbook and a tenant-free dedupe key', () => {
    expect(validateAlertRules(ALERT_RULES)).toEqual([]);
    for (const [id, severity] of SPEC_ALERTS) {
      const r = ALERT_RULES.find((x) => x.id === id);
      expect(r, id).toBeDefined();
      expect(r!.severity).toBe(severity);
      expect(r!.immediateAction.length).toBeGreaterThan(10);
      expect(r!.runbook).toMatch(/^docs\/spec\/OBSERVABILITY-OPERATIONS\.md#/);
      expect(r!.dedupeKey).toBe(id);
    }
    expect(ALERT_RULES.find((r) => r.id === 'slo_target_missed')?.severity).toBe('medium');
    // Every metric a rule reads is a declared platform metric with closed labels.
    const names = new Set(platformMetrics(new MetricsRegistry()).names());
    for (const r of ALERT_RULES)
      for (const c of r.conditions) expect(names.has(c.metric), `${r.id}:${c.metric}`).toBe(true);
  });

  it('rejects malformed rules (unknown severity, missing runbook, unbounded dedupe template)', () => {
    const bad = [
      { ...ALERT_RULES[0]!, id: 'x', severity: 'urgent' },
      { ...ALERT_RULES[0]!, id: 'y', runbook: '' },
      { ...ALERT_RULES[0]!, id: 'z', dedupeKey: 'z:{tenantId}' },
    ];
    expect(validateAlertRules(bad as never).length).toBe(3);
  });

  it('fires exactly at the threshold and not below, and the payload carries no tenant content', () => {
    const m = new MetricsRegistry();
    const p = platformMetrics(m);
    expect(evaluateAlerts(ALERT_RULES, m)).toEqual([]);
    p.outboxOldestAgeSeconds.set({}, 60);
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toEqual([]);
    p.outboxOldestAgeSeconds.set({}, 61);
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toEqual(['outbox_or_queue_age']);
    p.outboxOldestAgeSeconds.set({}, 0);
    p.jobsOldestAgeSeconds.set({}, 301);
    p.brokerInvariantViolations.inc({ invariant: 'GROSS_EQUATION' });
    p.isolationSignals.inc({ surface: 'API' });
    const firing = evaluateAlerts(ALERT_RULES, m);
    expect(firing.map((a) => a.id).sort()).toEqual(
      ['broker_budget_invariant_violation', 'credential_or_tenant_isolation_signal', 'outbox_or_queue_age'].sort(),
    );
    expect(JSON.stringify(firing)).not.toMatch(/ten_|inc_|usr_|site_/);
    expect(firing.find((a) => a.id === 'broker_budget_invariant_violation')?.severity).toBe('critical');
  });

  it('evaluates ratio rules only above the minimum sample count', () => {
    const m = new MetricsRegistry();
    const p = platformMetrics(m);
    p.modelRuns.inc({ outcome: 'REJECTED' }, 3);
    p.modelRejections.inc({ reason_class: 'SCHEMA' }, 3);
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toEqual([]);
    p.modelRuns.inc({ outcome: 'COMPLETED' }, 3);
    p.modelRejections.inc({ reason_class: 'CITATION' }, 1);
    // 4 rejections / 6 runs = 0.67 > 0.5 with 6 >= 5 runs.
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toEqual(['model_rejection_spike']);
  });
});

describe('T-055 health and readiness', () => {
  it('is ready when every check passes, degraded on a warning or non-critical failure, unavailable on a critical failure', async () => {
    const h = new HealthRegistry({ timeoutMs: 50 });
    let db: 'pass' | 'fail' = 'pass';
    let slo: 'pass' | 'warn' = 'pass';
    h.register('database', async () => ({ status: db }), { critical: true });
    h.register('slo', async () => ({ status: slo, detail: 'operator_read p95 over target' }), { critical: false });
    h.register('slow', () => new Promise((r) => setTimeout(() => r({ status: 'pass' }), 500)), { critical: false });
    const first = await h.ready();
    expect(first.status).toBe('degraded');
    expect(first.checks.find((c) => c.name === 'slow')).toMatchObject({ status: 'fail', detail: 'TIMEOUT' });
    h.unregister('slow');
    expect((await h.ready()).status).toBe('ready');
    slo = 'warn';
    expect((await h.ready()).status).toBe('degraded');
    db = 'fail';
    expect((await h.ready()).status).toBe('unavailable');
    expect(h.live()).toEqual({ status: 'live' });
  });

  it('converts a throwing check into a failure without leaking the error message', async () => {
    const h = new HealthRegistry();
    h.register(
      'database',
      async () => {
        throw new Error('password authentication failed for user "svc" secret=hunter2hunter2');
      },
      { critical: true },
    );
    const r = await h.ready();
    expect(r.status).toBe('unavailable');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('T-054 SLO tracking against OBSERVABILITY-OPERATIONS §6 (NFR-08)', () => {
  it('declares the specified latency and availability targets', () => {
    const byName = Object.fromEntries(SLO_TARGETS.map((t) => [t.name, t]));
    expect(byName.telemetry_acceptance).toMatchObject({ quantile: 0.95, targetMs: 1_000 });
    expect(byName.incident_opening).toMatchObject({ quantile: 0.95, targetMs: 30_000 });
    expect(byName.operator_read).toMatchObject({ quantile: 0.95, targetMs: 500 });
    expect(byName.policy_evaluation).toMatchObject({ quantile: 0.95, targetMs: 1_000 });
    expect(byName.notification_dispatch).toMatchObject({ quantile: 0.95, targetMs: 60_000 });
    expect(byName.outbox_enqueue).toMatchObject({ quantile: 0.99, targetMs: 10_000 });
    expect(byName.reconciliation_entry).toMatchObject({ quantile: 0.99, targetMs: 60_000 });
    expect(byName.api_availability).toMatchObject({ kind: 'AVAILABILITY', targetRatio: 0.999 });
  });

  it('reports MET at the target, MISSED just above it, INSUFFICIENT_DATA below the sample floor, and degrades readiness', async () => {
    const t = new SloTracker({ minSamples: 20 });
    for (let i = 0; i < 19; i++) t.record('operator_read', 100);
    expect(t.evaluate().find((e) => e.name === 'operator_read')!.status).toBe('INSUFFICIENT_DATA');
    t.record('operator_read', 500);
    // 20 samples; p95 (nearest rank 19) = 100 <= 500.
    expect(t.evaluate().find((e) => e.name === 'operator_read')).toMatchObject({ status: 'MET', samples: 20 });
    for (let i = 0; i < 2; i++) t.record('operator_read', 500);
    expect(t.evaluate().find((e) => e.name === 'operator_read')).toMatchObject({ status: 'MET', observedMs: 500 });
    t.record('operator_read', 501);
    t.record('operator_read', 501);
    expect(t.evaluate().find((e) => e.name === 'operator_read')).toMatchObject({ status: 'MISSED', observedMs: 501 });
    const h = new HealthRegistry();
    h.register('slo', t.healthCheck(), { critical: false });
    const ready = await h.ready();
    expect(ready.status).toBe('degraded');
    expect(ready.checks[0]!.detail).toContain('operator_read');
    const m = new MetricsRegistry();
    const p = platformMetrics(m);
    t.exportTo(p);
    expect(m.value('ub_slo_target_missed', { slo: 'operator_read' })).toBe(1);
    expect(evaluateAlerts(ALERT_RULES, m).map((a) => a.id)).toEqual(['slo_target_missed']);
  });

  it('tracks availability as a ratio of good outcomes', () => {
    const t = new SloTracker({ minSamples: 10 });
    for (let i = 0; i < 999; i++) t.recordOutcome('api_availability', true);
    t.recordOutcome('api_availability', false);
    expect(t.evaluate().find((e) => e.name === 'api_availability')).toMatchObject({ status: 'MET' });
    t.recordOutcome('api_availability', false);
    expect(t.evaluate().find((e) => e.name === 'api_availability')).toMatchObject({ status: 'MISSED' });
    expect(() => t.record('nonexistent_slo', 1)).toThrow();
  });
});
