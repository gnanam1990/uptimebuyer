// Structured provider API adapter (unpaid, M07-owned) over an HTTP transport port, plus the fixture transport used by
// contract tests. The adapter speaks the documented uptimebuyer-provider-api.v1 sandbox contract: cursor-paginated
// search, idempotent contact creation keyed by the pre-egress client operation and idempotency key, and authoritative
// lookup by client operation id. Results keep the raw provider status and a raw-response digest (INV-12).
import { canonicalize } from '@uptimebuyer/domain';
import { sha256Digest } from '@uptimebuyer/data';
import {
  assertSafePath,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderHttpTransport,
  type TransportCallOptions,
} from '../egress.js';
import {
  NotSentError,
  type AdapterCapabilityAssessment,
  type CallContext,
  type ContactExecution,
  type ContactObserver,
  type ContactResult,
  type LookupResult,
  type PinnedRevision,
  type ProviderOperation,
  type SearchPageRequest,
  type SearchPageResult,
  type UnpaidProviderAdapter,
} from '../ports.js';
import {
  ContactAckSchema,
  ContactStatusSchema,
  ProviderErrorBodySchema,
  ProviderSearchPageSchema,
} from '../schemas.js';

/** Raw-response digest: canonical JSON when possible, otherwise the JSON text. Never stores the body itself. */
export function rawResponseDigest(body: unknown): string {
  try {
    return sha256Digest(canonicalize(body as never));
  } catch {
    return sha256Digest(JSON.stringify(body ?? null));
  }
}

/** A response that does not prove what happened after the request may have left (5xx, malformed 2xx). */
export class AmbiguousResponseError extends Error {
  constructor(readonly reasonCode: string) {
    super('The provider response does not establish the outcome.');
    this.name = 'AmbiguousResponseError';
  }
}

const STATE_OF = { received: 'ACCEPTED', quoted: 'CONFIRMED', declined: 'FAILED', cancelled: 'CANCELLED' } as const;

export class StructuredProviderApiAdapter implements UnpaidProviderAdapter {
  readonly providerKey: string;
  readonly adapterClass;
  readonly channels = ['API'] as const;
  readonly supportsSearch = true;
  private readonly transport: ProviderHttpTransport;

  constructor(opts: { providerKey: string; transport: ProviderHttpTransport }) {
    this.providerKey = opts.providerKey;
    this.transport = opts.transport;
    this.adapterClass = opts.transport.adapterClass;
  }

  assess(_revision: PinnedRevision, op: ProviderOperation): AdapterCapabilityAssessment {
    // The sandbox contract declares authoritative lookup by client operation id, so a timeout can be reconciled.
    return op === 'SEARCH' || op === 'CONTACT_API'
      ? { kind: 'ELIGIBLE' }
      : { kind: 'UNSUPPORTED', reasonCode: 'OPERATION_NOT_SUPPORTED' };
  }

  private call(req: Omit<ProviderHttpRequest, 'context'>, ctx: CallContext, onSent: () => void) {
    assertSafePath(req.path);
    const opts: TransportCallOptions = {
      signal: ctx.signal,
      revision: ctx.revision,
      credential: ctx.credential,
      onSent,
    };
    return this.transport.request(
      {
        ...req,
        context: { providerAccountRevisionId: ctx.revision.providerAccountRevisionId, providerKey: this.providerKey },
      },
      opts,
    );
  }

  async search(req: SearchPageRequest, ctx: CallContext): Promise<SearchPageResult> {
    const query: Record<string, string> = {
      kind: [...req.query.providerKinds].sort().join(','),
      country: req.query.country,
      pageSize: String(req.pageSize),
    };
    if (req.query.postalCode) query.postalCode = req.query.postalCode;
    if (req.cursor) query.cursor = req.cursor;
    const res = await this.call(
      { method: 'GET', path: '/v1/providers', query, headers: {}, body: null },
      ctx,
      () => {},
    );
    const digest = rawResponseDigest(res.body);
    if (res.status === 200) {
      const page = ProviderSearchPageSchema.safeParse(res.body);
      return page.success
        ? { kind: 'PAGE', page: page.data, rawResponseDigest: digest }
        : { kind: 'ERROR', reasonCode: 'RESPONSE_SCHEMA_INVALID', rawResponseDigest: digest };
    }
    if (res.status === 429) return { kind: 'RATE_LIMITED', retryAfterMs: retryAfter(res), rawResponseDigest: digest };
    if (res.status === 400 || res.status === 422)
      return { kind: 'ERROR', reasonCode: 'INVALID_REQUEST', rawResponseDigest: digest };
    return { kind: 'ERROR', reasonCode: 'PROVIDER_ERROR', rawResponseDigest: digest };
  }

  async contact(req: ContactExecution, ctx: CallContext, observer: ContactObserver): Promise<ContactResult> {
    const res = await this.call(
      {
        method: 'POST',
        path: '/v1/contact-requests',
        query: {},
        headers: { 'idempotency-key': req.idempotencyKey },
        body: {
          clientOperationId: req.clientOperationId,
          requestDigest: req.requestDigest,
          purpose: req.purposeCode,
          destination: req.destination,
          message: { subject: req.message.subject, body: req.message.body },
          recordingDisclosure: req.message.disclosure,
        },
      },
      ctx,
      () => observer.handedOff(),
    );
    const digest = rawResponseDigest(res.body);
    if (res.status === 429) return { kind: 'RATE_LIMITED', retryAfterMs: retryAfter(res), rawResponseDigest: digest };
    const ack = ContactAckSchema.safeParse(res.body);
    if (!ack.success) throw new AmbiguousResponseError('RESPONSE_SCHEMA_INVALID');
    const a = ack.data;
    if (a.status === 'declined' && res.status >= 400 && res.status < 500)
      return {
        kind: 'DECLINED',
        rawStatus: a.status,
        reasonCode: a.reason ?? 'PROVIDER_DECLINED',
        rawResponseDigest: digest,
      };
    if (
      (res.status === 200 || res.status === 201 || res.status === 202) &&
      (a.status === 'received' || a.status === 'quoted')
    )
      return {
        kind: a.status === 'quoted' ? 'CONFIRMED' : 'ACCEPTED',
        providerRef: a.requestRef,
        rawStatus: a.status,
        rawResponseDigest: digest,
        quote: a.quote ?? null,
        consent: a.consent ?? null,
      };
    throw new AmbiguousResponseError('UNEXPECTED_STATUS');
  }

  async lookup(
    loc: { clientOperationId: string; idempotencyKey: string; providerRef: string | null },
    ctx: CallContext,
  ): Promise<LookupResult> {
    const res = await this.call(
      {
        method: 'GET',
        path: `/v1/contact-requests/by-operation/${loc.clientOperationId}`,
        query: {},
        headers: { 'idempotency-key': loc.idempotencyKey },
        body: null,
      },
      ctx,
      () => {},
    );
    const digest = rawResponseDigest(res.body);
    if (res.status === 501) return { kind: 'UNSUPPORTED', reasonCode: 'LOOKUP_UNSUPPORTED' };
    if (res.status === 404) return { kind: 'NOT_FOUND', rawResponseDigest: digest };
    if (res.status === 200) {
      const s = ContactStatusSchema.safeParse(res.body);
      if (!s.success) return { kind: 'PENDING', rawResponseDigest: digest };
      return {
        kind: 'FOUND',
        state: STATE_OF[s.data.status],
        providerRef: s.data.requestRef,
        rawStatus: s.data.status,
        rawResponseDigest: digest,
        quote: s.data.quote ?? null,
      };
    }
    return { kind: 'PENDING', rawResponseDigest: digest };
  }
}

function retryAfter(res: ProviderHttpResponse): number {
  const parsed = ProviderErrorBodySchema.safeParse(res.body);
  if (parsed.success && parsed.data.error.kind === 'RATE_LIMITED') return parsed.data.error.retryAfterMs;
  const h = Number(res.headers?.['retry-after']);
  return Number.isFinite(h) && h >= 0 ? Math.min(h * 1000, 86_400_000) : 60_000;
}

// ---------------------------------------------------------------------------------------------------------------

export type FixtureReply = ProviderHttpResponse | 'HANG' | 'NOT_SENT';
export type FixtureHandler = (req: ProviderHttpRequest) => FixtureReply | Promise<FixtureReply>;

/**
 * Scripted in-memory transport for contract tests. Its class (SYNTHETIC_FIXTURE, RECORDED_FIXTURE or SANDBOX) is
 * carried onto every attempt and quote it produces, so fixture results can never be presented as live evidence.
 * 'HANG' waits until the caller's timeout aborts; 'NOT_SENT' proves the request never left.
 */
export class FixtureProviderTransport implements ProviderHttpTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly routes = new Map<string, FixtureHandler>();
  constructor(readonly adapterClass: 'SYNTHETIC_FIXTURE' | 'RECORDED_FIXTURE' | 'SANDBOX') {}

  on(route: string, handler: FixtureHandler): void {
    this.routes.set(route, handler);
  }

  private handlerFor(method: string, path: string): FixtureHandler | undefined {
    const exact = this.routes.get(`${method} ${path}`);
    if (exact) return exact;
    for (const [k, h] of this.routes) if (k.endsWith('/*') && `${method} ${path}`.startsWith(k.slice(0, -1))) return h;
    return undefined;
  }

  async request(req: ProviderHttpRequest, opts: TransportCallOptions): Promise<ProviderHttpResponse> {
    const handler = this.handlerFor(req.method, req.path);
    if (!handler) throw new NotSentError('NO_FIXTURE_ROUTE');
    const reply = await handler(structuredClone(req));
    if (reply === 'NOT_SENT') throw new NotSentError('CONNECTION_REFUSED');
    opts.onSent();
    this.requests.push(structuredClone(req));
    if (reply === 'HANG')
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts.signal.aborted) fail();
        else opts.signal.addEventListener('abort', fail, { once: true });
      });
    return structuredClone(reply);
  }
}
