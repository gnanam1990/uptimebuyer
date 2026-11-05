// Request-boundary helpers: strict JSON body/query/header parsing with the shared @uptimebuyer/contracts API schemas,
// `Idempotency-Key` and `If-Match` handling, `{id}:{verb}` command targets and bigint-safe serialization.
import { DomainError, decodeWire } from '@uptimebuyer/contracts';
import {
  IDEMPOTENCY_KEY_HEADER,
  IF_MATCH_HEADER,
  IdempotencyKeyHeaderSchema,
  IfMatchHeaderSchema,
} from '@uptimebuyer/contracts/api';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

const malformed = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'The request is malformed.', { reasonCode });

/** Parse the raw JSON body (buffered by the content parser) strictly against `schema`; never echoes values. */
export function body<S extends z.ZodType>(req: FastifyRequest, schema: S): z.output<S> {
  const raw = req.body;
  let parsed: unknown = {};
  if (Buffer.isBuffer(raw) && raw.byteLength > 0) {
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw malformed('BODY_NOT_JSON');
    }
  } else if (raw !== undefined && raw !== null && !Buffer.isBuffer(raw)) throw malformed('BODY_NOT_JSON');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformed('BODY_NOT_OBJECT');
  return decodeWire(schema, parsed);
}

export function query<S extends z.ZodType>(req: FastifyRequest, schema: S): z.output<S> {
  const q = { ...(req.query as Record<string, unknown>) };
  for (const [k, v] of Object.entries(q))
    if (Array.isArray(v))
      throw malformed(
        `DUPLICATE_QUERY_PARAMETER_${k
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '_')
          .slice(0, 40)}`,
      );
  return decodeWire(schema, q);
}

export function pathId<S extends z.ZodType>(value: unknown, schema: S): z.output<S> {
  const r = schema.safeParse(value);
  // A malformed id is indistinguishable from a missing resource (no existence or format oracle).
  if (!r.success)
    throw new DomainError('FORBIDDEN', 'The requested resource is not available.', {
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
  return r.data;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  if (Array.isArray(v)) throw malformed('DUPLICATE_HEADER');
  return typeof v === 'string' ? v : undefined;
};

/** Every mutating request carries an `Idempotency-Key` (API-EVENT-SPEC §1). */
export function idempotencyKey(req: FastifyRequest): string {
  const v = header(req, IDEMPOTENCY_KEY_HEADER);
  if (v === undefined)
    throw new DomainError('VALIDATION_FAILED', 'An Idempotency-Key header is required.', {
      reasonCode: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  const r = IdempotencyKeyHeaderSchema.safeParse(v);
  if (!r.success) throw malformed('IDEMPOTENCY_KEY_INVALID');
  return r.data;
}

/** Aggregate commands carry `If-Match` with the expected aggregate version; a stale one is a 409 from the command. */
export function expectedVersion(req: FastifyRequest): number {
  const v = header(req, IF_MATCH_HEADER);
  if (v === undefined)
    throw new DomainError('VALIDATION_FAILED', 'An If-Match header with the expected version is required.', {
      reasonCode: 'IF_MATCH_REQUIRED',
    });
  const r = IfMatchHeaderSchema.safeParse(v);
  if (!r.success) throw malformed('IF_MATCH_INVALID');
  return r.data;
}

/** Split an `{id}:{verb}` path target (API-EVENT-SPEC custom methods); an unknown verb is a 404. */
export function commandTarget<V extends string>(target: unknown, verbs: readonly V[]): { id: string; verb: V } | null {
  if (typeof target !== 'string') return null;
  const i = target.lastIndexOf(':');
  if (i <= 0) return null;
  const verb = target.slice(i + 1) as V;
  return verbs.includes(verb) ? { id: target.slice(0, i), verb } : null;
}

export const notFound = () => Object.assign(new Error('not found'), { statusCode: 404, code: 'FST_ERR_NOT_FOUND' });

/** JSON with bigint as decimal strings (money minor units), the same wire form as the contract money codecs. */
export const serialize = (payload: unknown): string =>
  JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
