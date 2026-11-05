// Actionable alerts as configuration (OBSERVABILITY-OPERATIONS §7). Rules live in alert-rules.json, are validated
// here and evaluated deterministically against the metric registry. A firing alert carries only its rule identity,
// severity, action, runbook and the aggregate value — never tenant, site, incident or provider identifiers — and is
// deduplicated by a static key; routing to tenant/site on-call happens downstream without tenant content.
import { z } from 'zod';
import raw from './alert-rules.json' with { type: 'json' };
import type { MetricsRegistry } from './metrics.js';

const ConditionSchema = z.strictObject({
  metric: z.string().regex(/^ub_[a-z0-9_]+$/),
  op: z.enum(['>', '>=']),
  threshold: z.number(),
  ratioTo: z
    .string()
    .regex(/^ub_[a-z0-9_]+$/)
    .optional(),
  minDenominator: z.number().int().min(1).optional(),
});
export const AlertRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  summary: z.string().min(5).max(200),
  immediateAction: z.string().min(10).max(300),
  runbook: z.string().regex(/^docs\/spec\/[A-Z-]+\.md#[a-z0-9-]+$/),
  conditions: z.array(ConditionSchema).min(1).max(5),
  match: z.enum(['any', 'all']),
  dedupeKey: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  routing: z.string().regex(/^[a-z][a-z-]{2,40}$/),
});
export type AlertRule = z.output<typeof AlertRuleSchema>;

/** Problems with a rule set (empty = valid): schema, duplicate ids, a dedupe key that is not the rule id. */
export function validateAlertRules(rules: readonly unknown[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    const p = AlertRuleSchema.safeParse(r);
    if (!p.success) return void problems.push(`rule ${i}: ${p.error.issues[0]?.path.join('.')}`);
    if (ids.has(p.data.id)) problems.push(`rule ${p.data.id}: duplicate id`);
    ids.add(p.data.id);
    if (p.data.dedupeKey !== p.data.id) problems.push(`rule ${p.data.id}: dedupe key must be the static rule id`);
  });
  return problems;
}

export const ALERT_RULES: readonly AlertRule[] = Object.freeze(
  (raw as { rules: unknown[] }).rules.map((r) => Object.freeze(AlertRuleSchema.parse(r))),
);

export interface FiringAlert {
  id: string;
  severity: AlertRule['severity'];
  summary: string;
  immediateAction: string;
  runbook: string;
  dedupeKey: string;
  routing: string;
  value: number;
}

export function evaluateAlerts(rules: readonly AlertRule[], metrics: MetricsRegistry): FiringAlert[] {
  const out: FiringAlert[] = [];
  for (const r of rules) {
    const results = r.conditions.map((c) => {
      const num = metrics.value(c.metric) ?? 0;
      let v = num;
      if (c.ratioTo) {
        const den = metrics.value(c.ratioTo) ?? 0;
        if (den < (c.minDenominator ?? 1)) return { fired: false, v: 0 };
        v = num / den;
      }
      return { fired: c.op === '>' ? v > c.threshold : v >= c.threshold, v };
    });
    const fired = r.match === 'any' ? results.some((x) => x.fired) : results.every((x) => x.fired);
    if (!fired) continue;
    out.push({
      id: r.id,
      severity: r.severity,
      summary: r.summary,
      immediateAction: r.immediateAction,
      runbook: r.runbook,
      dedupeKey: r.dedupeKey,
      routing: r.routing,
      value: Math.max(...results.filter((x) => x.fired).map((x) => x.v)),
    });
  }
  return out;
}
