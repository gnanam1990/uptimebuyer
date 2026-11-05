// Traces (OBSERVABILITY-OPERATIONS §4). Spans carry a W3C trace context and the workflow correlation id; the active
// span flows through async work (AsyncLocalStorage) and crosses process boundaries as a `traceparent` header (the API
// returns it; a worker or the broker can continue it). Span status separates a deterministic rejection or hold from a
// system error. Attributes are primitives only and redacted; raw model/provider payloads are referenced by digest.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { DomainError } from '@uptimebuyer/contracts';
import { isSensitiveKey, redactString, REDACTED, type SecretRegistry } from './redact.js';

export const SPAN_NAMES = Object.freeze([
  'http.request',
  'incident.detect',
  'evidence.build',
  'evidence.retrieve',
  'serv.reason',
  'citation.validate',
  'compatibility.evaluate',
  'plan.rank',
  'approval.record',
  'commercial.reserve',
  'provider.execute',
  'provider.reconcile',
  'fulfillment.observe',
  'recovery.assess',
  'incident.close',
  'telemetry.ingest',
] as const);

export type SpanStatus = 'OK' | 'REJECTED' | 'HELD' | 'ERROR';
export type AttributeValue = string | number | boolean;

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanRecord {
  service: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  correlationId: string | null;
  attributes: Record<string, AttributeValue>;
  status: SpanStatus;
  statusReason: string | null;
  startedAt: number;
  endedAt: number;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | undefined | null): SpanContext | null {
  if (typeof header !== 'string') return null;
  const m = TRACEPARENT.exec(header.trim());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]! };
}

const REJECT_CODES = new Set([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_MISMATCH',
  'EXECUTION_REFERENCE_INVALID',
  'STATE_TRANSITION_INVALID',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'INTENT_SUCCESSOR_BLOCKED',
  'DIGEST_MISMATCH',
  'EVIDENCE_APPEND_INVALID',
  'RATE_LIMITED',
  'PRECISION_LOSS',
  'CURRENCY_MISMATCH',
  'UNIT_MISMATCH',
  'MONEY_OUT_OF_RANGE',
]);

/** Map an error to span status: holds are HELD, deterministic refusals REJECTED, anything else ERROR. */
export function statusOf(err: unknown): { status: SpanStatus; reason: string } {
  if (err instanceof DomainError) {
    const reason =
      typeof err.details.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(err.details.reasonCode)
        ? err.details.reasonCode
        : err.code;
    if (err.code === 'POLICY_HOLD') return { status: 'HELD', reason };
    if (REJECT_CODES.has(err.code)) return { status: 'REJECTED', reason };
    return { status: 'ERROR', reason };
  }
  const name = (err as { name?: unknown } | null)?.name;
  return { status: 'ERROR', reason: typeof name === 'string' ? name.slice(0, 64) : 'Error' };
}

export class Span {
  readonly context: SpanContext;
  private status: SpanStatus = 'OK';
  private reason: string | null = null;
  private readonly attributes: Record<string, AttributeValue> = {};
  private readonly startedAt = Date.now();
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    readonly name: string,
    readonly parentSpanId: string | null,
    traceId: string,
    readonly correlationId: string | null,
  ) {
    this.context = { traceId, spanId: randomBytes(8).toString('hex') };
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(key) || Object.keys(this.attributes).length >= 64) return this;
    this.attributes[key] = isSensitiveKey(key)
      ? REDACTED
      : typeof value === 'string'
        ? redactString(value, this.tracer.secretValues())
        : value;
    return this;
  }

  setStatus(status: SpanStatus, reason: string | null = null): this {
    this.status = status;
    this.reason = reason;
    return this;
  }

  traceparent(): string {
    return `00-${this.context.traceId}-${this.context.spanId}-01`;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.export({
      service: this.tracer.service,
      name: this.name,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      correlationId: this.correlationId,
      attributes: { ...this.attributes },
      status: this.status,
      statusReason: this.reason,
      startedAt: this.startedAt,
      endedAt: Date.now(),
    });
  }
}

export interface SpanOptions {
  attributes?: Record<string, AttributeValue>;
  /** A parent span context or an inbound `traceparent` header (defaults to the active span). */
  parent?: SpanContext | string | null;
  correlationId?: string | null;
}

export class Tracer {
  readonly service: string;
  private readonly storage = new AsyncLocalStorage<Span>();
  private readonly exporter: (s: SpanRecord) => void;

  constructor(
    private readonly opts: { service: string; exporter?: (s: SpanRecord) => void; secrets?: SecretRegistry },
  ) {
    this.service = opts.service;
    this.exporter = opts.exporter ?? (() => {});
  }

  /** @internal */
  secretValues(): readonly string[] {
    return this.opts.secrets?.values() ?? [];
  }

  /** @internal */
  export(s: SpanRecord): void {
    try {
      this.exporter(s);
    } catch {
      // An exporter failure never breaks the traced operation.
    }
  }

  active(): Span | undefined {
    return this.storage.getStore();
  }

  startSpan(name: string, opts: SpanOptions = {}): Span {
    const active = this.active();
    const parent =
      typeof opts.parent === 'string'
        ? parseTraceparent(opts.parent)
        : opts.parent === undefined
          ? (active?.context ?? null)
          : opts.parent;
    const span = new Span(
      this,
      name,
      parent?.spanId ?? null,
      parent?.traceId ?? randomBytes(16).toString('hex'),
      opts.correlationId ?? active?.correlationId ?? null,
    );
    for (const [k, v] of Object.entries(opts.attributes ?? {})) span.setAttribute(k, v);
    return span;
  }

  async withSpan<T>(name: string, opts: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.startSpan(name, opts);
    try {
      return await this.storage.run(span, () => fn(span));
    } catch (e) {
      const s = statusOf(e);
      span.setStatus(s.status, s.reason);
      throw e;
    } finally {
      span.end();
    }
  }
}

export class MemoryExporter {
  readonly spans: SpanRecord[] = [];
  readonly export = (s: SpanRecord): void => {
    this.spans.push(s);
  };
  byTrace(traceId: string): SpanRecord[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }
}
