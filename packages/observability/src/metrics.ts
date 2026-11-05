// Metrics with closed label enumerations (OBSERVABILITY-OPERATIONS §3: "Metrics must not use unbounded
// tenant/site/incident/provider-reference labels"). Every label of every metric is declared with its complete value
// set when the metric is registered; any other value is refused, so an identifier can never become a label and the
// series count is bounded by construction. Rendered in the Prometheus text exposition format.
import { DomainError } from '@uptimebuyer/contracts';

export type LabelSpec = Readonly<Record<string, readonly string[]>>;
export type Labels = Readonly<Record<string, string>>;

type Kind = 'counter' | 'gauge' | 'histogram';
interface Series {
  labels: Labels;
  value: number;
  buckets?: number[];
  count?: number;
  sum?: number;
}
interface Metric {
  name: string;
  help: string;
  kind: Kind;
  spec: LabelSpec;
  bounds?: number[];
  series: Map<string, Series>;
}

const NAME = /^ub_[a-z0-9_]{1,80}$/;
const LABEL = /^[a-z][a-z0-9_]{0,40}$/;
const VALUE = /^[A-Za-z0-9_.+-]{1,64}$/;
const MAX_VALUES_PER_LABEL = 64;

const unbounded = (detail: string) =>
  new DomainError('VALIDATION_FAILED', 'Metric label value is not declared.', {
    reasonCode: 'METRIC_LABEL_UNBOUNDED',
    detail,
  });

export interface MetricSnapshot {
  name: string;
  kind: Kind;
  help: string;
  series: { labels: Labels; value: number; count?: number; sum?: number; buckets?: { le: number; count: number }[] }[];
}

class Handle {
  constructor(
    protected readonly registry: MetricsRegistry,
    protected readonly metric: Metric,
  ) {}
  protected series(labels: Labels): Series {
    return this.registry.seriesFor(this.metric, labels);
  }
}

export class Counter extends Handle {
  inc(labels: Labels = {}, n = 1): void {
    if (!Number.isFinite(n) || n < 0) throw new DomainError('VALIDATION_FAILED', 'Counters only increase.');
    this.series(labels).value += n;
  }
}
export class Gauge extends Handle {
  set(labels: Labels, v: number): void {
    if (!Number.isFinite(v)) throw new DomainError('VALIDATION_FAILED', 'Gauge value must be finite.');
    this.series(labels).value = v;
  }
}
export class Histogram extends Handle {
  observe(labels: Labels, v: number): void {
    if (!Number.isFinite(v)) return;
    const s = this.series(labels);
    s.count = (s.count ?? 0) + 1;
    s.sum = (s.sum ?? 0) + v;
    this.metric.bounds!.forEach((b, i) => {
      if (v <= b) s.buckets![i]! += 1;
    });
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  private register(name: string, help: string, kind: Kind, spec: LabelSpec, bounds?: number[]): Metric {
    if (!NAME.test(name)) throw new DomainError('VALIDATION_FAILED', 'Invalid metric name.');
    if (this.metrics.has(name)) throw new DomainError('VALIDATION_FAILED', 'Metric already registered.');
    for (const [label, values] of Object.entries(spec)) {
      if (!LABEL.test(label) || label === 'le') throw new DomainError('VALIDATION_FAILED', 'Invalid label name.');
      if (/tenant|site|incident|asset|user|device|order|intent|attempt|ref$|_id$/.test(label))
        throw unbounded(`label ${label} names an identifier`);
      if (values.length === 0 || values.length > MAX_VALUES_PER_LABEL || values.some((v) => !VALUE.test(v)))
        throw unbounded(`label ${label} needs a closed value set`);
    }
    const m: Metric = { name, help: help.replace(/\s+/g, ' ').slice(0, 200), kind, spec, series: new Map() };
    if (bounds) m.bounds = [...bounds].sort((a, b) => a - b);
    this.metrics.set(name, m);
    return m;
  }

  counter(name: string, help: string, labels: LabelSpec = {}): Counter {
    return new Counter(this, this.register(name, help, 'counter', labels));
  }
  gauge(name: string, help: string, labels: LabelSpec = {}): Gauge {
    return new Gauge(this, this.register(name, help, 'gauge', labels));
  }
  histogram(name: string, help: string, buckets: readonly number[], labels: LabelSpec = {}): Histogram {
    if (buckets.length === 0 || buckets.length > 30 || buckets.some((b) => !Number.isFinite(b)))
      throw new DomainError('VALIDATION_FAILED', 'Invalid histogram buckets.');
    return new Histogram(this, this.register(name, help, 'histogram', labels, [...buckets]));
  }

  /** @internal */
  seriesFor(m: Metric, labels: Labels): Series {
    const keys = Object.keys(m.spec).sort();
    const given = Object.keys(labels).sort();
    if (keys.join(',') !== given.join(',')) throw unbounded(`labels of ${m.name} must be exactly ${keys.join(',')}`);
    for (const k of keys) if (!m.spec[k]!.includes(labels[k]!)) throw unbounded(`${m.name}.${k}`);
    const id = keys.map((k) => `${k}=${labels[k]}`).join(',');
    let s = m.series.get(id);
    if (!s) {
      s = { labels: Object.freeze({ ...labels }), value: 0 };
      if (m.kind === 'histogram') {
        s.buckets = m.bounds!.map(() => 0);
        s.count = 0;
        s.sum = 0;
      }
      m.series.set(id, s);
    }
    return s;
  }

  names(): string[] {
    return [...this.metrics.keys()];
  }

  /** Sum of a metric across series matching `labels` (all series when omitted); undefined when never recorded. */
  value(name: string, labels: Labels = {}): number | undefined {
    const m = this.metrics.get(name);
    if (!m) return undefined;
    let total: number | undefined;
    for (const s of m.series.values()) {
      if (Object.entries(labels).some(([k, v]) => s.labels[k] !== v)) continue;
      total = (total ?? 0) + (m.kind === 'histogram' ? (s.count ?? 0) : s.value);
    }
    return total;
  }

  snapshot(): MetricSnapshot[] {
    return [...this.metrics.values()].map((m) => ({
      name: m.name,
      kind: m.kind,
      help: m.help,
      series: [...m.series.values()].map((s) =>
        m.kind === 'histogram'
          ? {
              labels: s.labels,
              value: s.count ?? 0,
              count: s.count ?? 0,
              sum: s.sum ?? 0,
              buckets: m.bounds!.map((le, i) => ({ le, count: s.buckets![i]! })),
            }
          : { labels: s.labels, value: s.value },
      ),
    }));
  }

  exposition(): string {
    const fmt = (labels: Labels, extra: [string, string][] = []) => {
      const pairs = [
        ...Object.keys(labels)
          .sort()
          .map((k) => [k, labels[k]!] as [string, string]),
        ...extra,
      ];
      return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
    };
    const lines: string[] = [];
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.kind}`);
      for (const s of m.series.values()) {
        if (m.kind !== 'histogram') {
          lines.push(`${m.name}${fmt(s.labels)} ${s.value}`);
          continue;
        }
        m.bounds!.forEach((le, i) =>
          lines.push(`${m.name}_bucket${fmt(s.labels, [['le', String(le)]])} ${s.buckets![i]}`),
        );
        lines.push(`${m.name}_bucket${fmt(s.labels, [['le', '+Inf']])} ${s.count}`);
        lines.push(`${m.name}_sum${fmt(s.labels)} ${s.sum}`, `${m.name}_count${fmt(s.labels)} ${s.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
