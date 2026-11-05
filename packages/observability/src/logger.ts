// Structured logs (OBSERVABILITY-OPERATIONS §5, NFR-09, INV-13). One JSON object per line with timestamp, level,
// service, event and correlation fields. Only primitive field values are written (objects are dropped, never
// serialized), every value passes through redaction, and errors are reduced to their name and typed code: an error
// message can echo input or credentials, so it is never logged. IDs may appear (logs are access-controlled); contact
// values, payloads and transcripts never do — they are referenced by digest.
import { DomainError } from '@uptimebuyer/contracts';
import { DROPPED, isSensitiveKey, redactString, REDACTED, type SecretRegistry } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue | readonly (string | number)[]>>;

/** Fields that tie a line to the end-to-end workflow (OBSERVABILITY-OPERATIONS §2). */
export const CORRELATION_FIELDS = Object.freeze([
  'correlationId',
  'causationId',
  'tenantId',
  'siteId',
  'incidentId',
  'aggregateId',
  'attemptId',
  'intentId',
  'orderId',
  'traceId',
  'spanId',
] as const);

const EVENT = /^[a-z][a-z0-9_.]{0,99}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['timestamp', 'level', 'service', 'event']);

export interface LoggerOptions {
  service: string;
  sink?: (line: string) => void;
  secrets?: SecretRegistry;
  level?: LogLevel;
  clock?: () => Date;
  base?: LogFields;
}

export class StructuredLogger {
  private readonly sink: (line: string) => void;
  private readonly level: LogLevel;
  private readonly clock: () => Date;
  private readonly base: LogFields;

  constructor(private readonly opts: LoggerOptions) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(opts.service)) throw new Error('invalid service name');
    this.sink = opts.sink ?? ((l) => process.stdout.write(`${l}\n`));
    this.level = opts.level ?? 'info';
    this.clock = opts.clock ?? (() => new Date());
    this.base = opts.base ?? {};
  }

  child(fields: LogFields): StructuredLogger {
    return new StructuredLogger({ ...this.opts, base: { ...this.base, ...fields } });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }
  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }

  /** Log an error by name and typed code only (never its message, stack or details values). */
  errorFrom(event: string, err: unknown, fields: LogFields = {}): void {
    const e = err as { name?: unknown } | null;
    const extra: Record<string, LogValue> = {
      errorName: typeof e?.name === 'string' ? e.name.slice(0, 64) : 'unknown',
    };
    if (err instanceof DomainError) {
      extra.errorCode = err.code;
      const reason = err.details.reasonCode;
      if (typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) extra.reasonCode = reason;
    }
    this.write('error', event, { ...fields, ...extra });
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (!EVENT.test(event)) throw new Error('invalid log event name');
    if (ORDER[level] < ORDER[this.level]) return;
    const secrets = this.opts.secrets?.values() ?? [];
    const rec: Record<string, unknown> = {
      timestamp: this.clock().toISOString(),
      level,
      service: this.opts.service,
      event,
    };
    for (const [k, v] of Object.entries({ ...this.base, ...fields })) {
      if (!FIELD.test(k) || RESERVED.has(k) || v === undefined) continue;
      if (isSensitiveKey(k)) rec[k] = REDACTED;
      else if (v === null || typeof v === 'number' || typeof v === 'boolean') rec[k] = Number.isNaN(v) ? null : v;
      else if (typeof v === 'string') rec[k] = redactString(v, secrets);
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))
        rec[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? redactString(x, secrets) : x));
      else rec[k] = DROPPED;
    }
    let line = JSON.stringify(rec);
    for (const s of secrets) if (line.includes(s)) line = line.split(s).join(REDACTED);
    this.sink(line);
  }
}

/** In-memory sink for tests and the operations listener's recent-log view. */
export class MemorySink {
  readonly lines: string[] = [];
  readonly write = (line: string): void => {
    this.lines.push(line);
  };
  records(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
