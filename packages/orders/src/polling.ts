// Bounded fulfillment polling (NFR-02, NFR-04 shape, NFR-11; ADR 0005). Due orders/jobs are claimed with
// FOR NO KEY UPDATE SKIP LOCKED (one poller per order at a time, any number of workers) and leased forward with an
// exponential, capped backoff and a per-order poll budget; terminal orders are never polled. The lookup target is
// built ONLY from the order's pinned provider-account revision (provider key, environment, endpoint policy digest)
// plus its provider reference or pre-egress client operation id: no URL ever comes from a webhook, a provider body or
// the caller. Results are applied as POLL observations through the same dedupe/staleness/legality path as webhooks.
// A "not found" is recorded as evidence and is never proof of no effect.
import {
  ProviderEgressError,
  assertSafePath,
  endpointPolicyDigest,
  type EndpointPolicy,
  type PinnedRevision,
  type ProviderHttpTransport,
  type UnpaidCredential,
} from '@uptimebuyer/providers';
import type { AdapterCapabilityAssessment } from '@uptimebuyer/contracts';
import { requireAuthorized, tenantCommand, type Db, type TenantContext } from '@uptimebuyer/data';
import { z } from 'zod';
import { applyObservationInTx, type IncomingObservation } from './apply.js';
import { KIND, lockOrder } from './internal.js';
import { TERMINAL_STATES, type ObservationDetails, type OrderKind } from './vocabulary.js';

export const POLL_LIMITS = Object.freeze({
  maxBatch: 50,
  maxPollsPerOrder: 48,
  baseIntervalMs: 60_000,
  maxIntervalMs: 3_600_000,
  timeoutMs: 10_000,
  maxObservationsPerLookup: 50,
});

export interface FulfillmentTarget {
  orderKind: OrderKind;
  orderId: string;
  clientOperationId: string;
  providerRef: string | null;
  /** The order's pinned revision, never the account's current one. */
  revision: PinnedRevision;
}

export interface PolledObservation {
  eventId: string;
  rawStatus: string;
  observedAt: string;
  sequence?: number | null;
  providerRef?: string | null;
  details?: ObservationDetails;
}

export type FulfillmentLookupResult =
  | { status: 'FOUND'; observations: PolledObservation[] }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reasonCode: string };

export interface FulfillmentStatusAdapter {
  readonly providerKey: string;
  readonly adapterClass: 'LIVE' | 'RECORDED_CONTRACT';
  assess(revision: PinnedRevision): AdapterCapabilityAssessment;
  lookup(target: FulfillmentTarget, opts: { signal: AbortSignal }): Promise<FulfillmentLookupResult>;
}

export class FulfillmentAdapterRegistry {
  private readonly byKey = new Map<string, FulfillmentStatusAdapter>();
  constructor(adapters: readonly FulfillmentStatusAdapter[]) {
    for (const a of adapters) this.byKey.set(a.providerKey, a);
  }
  get(providerKey: string): FulfillmentStatusAdapter | undefined {
    return this.byKey.get(providerKey);
  }
}

/** Contract fake (RECORDED_CONTRACT): scripted provider observations by client operation id. Not a real provider. */
export class RecordedFulfillmentAdapter implements FulfillmentStatusAdapter {
  readonly adapterClass = 'RECORDED_CONTRACT' as const;
  readonly providerKey: string;
  readonly targets: FulfillmentTarget[] = [];
  calls = 0;
  private readonly scripts = new Map<string, PolledObservation[]>();
  constructor(opts: { providerKey: string }) {
    this.providerKey = opts.providerKey;
  }
  script(clientOperationId: string, observations: PolledObservation[]): void {
    this.scripts.set(clientOperationId, observations);
  }
  assess(): AdapterCapabilityAssessment {
    return { kind: 'ELIGIBLE' };
  }
  async lookup(target: FulfillmentTarget): Promise<FulfillmentLookupResult> {
    this.calls++;
    this.targets.push(target);
    const s = this.scripts.get(target.clientOperationId);
    return s ? { status: 'FOUND', observations: s } : { status: 'NOT_FOUND' };
  }
}

const RefToken = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const LookupBodySchema = z.object({
  observations: z
    .array(
      z.object({
        eventId: z.string().regex(/^[\x21-\x7E]{1,128}$/),
        status: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        observedAt: z.iso.datetime(),
        sequence: z.int().min(0).optional(),
      }),
    )
    .max(POLL_LIMITS.maxObservationsPerLookup),
});

/**
 * LIVE-shaped HTTPS status adapter over M07's guarded transport (exact allowlisted HTTPS origin bound to the revision
 * by its endpoint-policy digest, DNS pre-check + guarded connect, no redirects, bounded response). It needs its own
 * provisioned status credential; without one it is UNSUPPORTED. Never run against a real provider here (NOT_RUN).
 */
export class HttpsFulfillmentStatusAdapter implements FulfillmentStatusAdapter {
  readonly adapterClass = 'LIVE' as const;
  readonly providerKey: string;
  private readonly digest: string;
  constructor(
    private readonly opts: {
      providerKey: string;
      policy: EndpointPolicy;
      transport: ProviderHttpTransport;
      statusCredential?: UnpaidCredential;
    },
  ) {
    this.providerKey = opts.providerKey;
    this.digest = endpointPolicyDigest(opts.policy);
  }
  assess(revision: PinnedRevision): AdapterCapabilityAssessment {
    if (this.digest !== revision.endpointPolicyDigest)
      return {
        kind: 'UNSUPPORTED',
        reasonCode: 'ENDPOINT_POLICY_NOT_BOUND_TO_REVISION',
      } as AdapterCapabilityAssessment;
    if (!this.opts.statusCredential)
      return { kind: 'UNSUPPORTED', reasonCode: 'STATUS_CREDENTIAL_NOT_PROVISIONED' } as AdapterCapabilityAssessment;
    return { kind: 'ELIGIBLE' };
  }
  async lookup(target: FulfillmentTarget, opts: { signal: AbortSignal }): Promise<FulfillmentLookupResult> {
    const cap = this.assess(target.revision);
    if (cap.kind !== 'ELIGIBLE') throw new ProviderEgressError(cap.reasonCode);
    if (target.providerRef !== null && !RefToken.test(target.providerRef))
      throw new ProviderEgressError('PATH_REFUSED');
    const path = target.providerRef === null ? '/v1/orders/status' : `/v1/orders/${target.providerRef}/status`;
    assertSafePath(path);
    const res = await this.opts.transport.request(
      {
        method: 'GET',
        path,
        query: target.providerRef === null ? { client_operation_id: target.clientOperationId } : {},
        headers: {},
        body: null,
        context: {
          providerAccountRevisionId: target.revision.providerAccountRevisionId,
          providerKey: this.providerKey,
        },
      },
      {
        signal: opts.signal,
        revision: target.revision,
        credential: this.opts.statusCredential!,
        onSent: () => {},
      },
    );
    if (res.status === 404) return { status: 'NOT_FOUND' };
    if (res.status !== 200) return { status: 'UNAVAILABLE', reasonCode: `HTTP_${res.status}` };
    const body = LookupBodySchema.safeParse(res.body);
    if (!body.success) return { status: 'UNAVAILABLE', reasonCode: 'RESPONSE_SCHEMA_INVALID' };
    return {
      status: 'FOUND',
      observations: body.data.observations.map((o) => ({
        eventId: o.eventId,
        rawStatus: o.status,
        observedAt: new Date(o.observedAt).toISOString(),
        sequence: o.sequence ?? null,
      })),
    };
  }
}

const backoffMs = (count: number) =>
  Math.min(POLL_LIMITS.maxIntervalMs, POLL_LIMITS.baseIntervalMs * 2 ** Math.min(count, 10));

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Poll due orders/jobs of the caller's tenant once (engine principals). */
export async function pollFulfillmentStatus(
  pool: Db,
  ctx: TenantContext,
  deps: { adapters: FulfillmentAdapterRegistry },
  opts: { limit?: number; dueBefore?: string } = {},
): Promise<{ polled: number; applied: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? POLL_LIMITS.maxBatch, POLL_LIMITS.maxBatch));
  const meta = { action: 'orders.engine', resourceType: 'order' };
  // Claim: lease due rows forward (scheduling-only update) so concurrent pollers never poll the same order at once.
  const claimed: { kind: OrderKind; row: any }[] = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'orders.engine', siteId: null });
    const out: { kind: OrderKind; row: any }[] = [];
    for (const kind of ['PURCHASE_ORDER', 'SERVICE_JOB'] as const) {
      const t = KIND[kind].table;
      const { rows } = await c.query(
        `SELECT o.*, r.endpoint_policy_digest, r.capabilities, a.provider_key, a.environment
           FROM ${t} o
           JOIN provider_account_revisions r ON r.tenant_id = o.tenant_id AND r.id = o.provider_account_revision_id
           JOIN provider_accounts a ON a.tenant_id = o.tenant_id AND a.id = o.provider_account_id
          WHERE o.tenant_id = $1 AND o.next_poll_at IS NOT NULL
            AND o.next_poll_at <= coalesce($2::timestamptz, clock_timestamp())
          ORDER BY o.next_poll_at, o.id LIMIT $3 FOR NO KEY UPDATE OF o SKIP LOCKED`,
        [ctx.tenantId, opts.dueBefore ?? null, limit],
      );
      for (const r of rows) {
        const exhausted = r.poll_count + 1 >= POLL_LIMITS.maxPollsPerOrder || TERMINAL_STATES[kind].includes(r.state);
        await c.query(
          `UPDATE ${t} SET poll_count = poll_count + 1,
                  next_poll_at = CASE WHEN $3 THEN NULL ELSE clock_timestamp() + make_interval(secs => $4::double precision / 1000) END,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, r.id, exhausted, backoffMs(r.poll_count)],
        );
        if (!TERMINAL_STATES[kind].includes(r.state)) out.push({ kind, row: r });
      }
    }
    return out;
  });
  let applied = 0;
  for (const { kind, row } of claimed) {
    const revision: PinnedRevision = {
      providerAccountId: row.provider_account_id,
      providerAccountRevisionId: row.provider_account_revision_id,
      providerKey: row.provider_key,
      environment: row.environment,
      capabilities: row.capabilities,
      endpointPolicyDigest: row.endpoint_policy_digest,
    };
    const adapter = deps.adapters.get(row.provider_key);
    if (!adapter || adapter.assess(revision).kind !== 'ELIGIBLE') continue;
    let result: FulfillmentLookupResult;
    try {
      result = await adapter.lookup(
        {
          orderKind: kind,
          orderId: row.id,
          clientOperationId: row.client_operation_id,
          providerRef: row.provider_ref,
          revision,
        },
        { signal: AbortSignal.timeout(POLL_LIMITS.timeoutMs) },
      );
    } catch {
      continue; // transport failure: the lease already scheduled the next bounded poll
    }
    const incoming: IncomingObservation[] =
      result.status === 'FOUND'
        ? result.observations.slice(0, POLL_LIMITS.maxObservationsPerLookup).map((o) => ({
            source: 'POLL',
            providerEventKey: `poll:${o.eventId}`.slice(0, 300),
            rawStatus: o.rawStatus,
            observedAt: o.observedAt,
            sequence: o.sequence ?? null,
            details: o.details ?? {},
            providerRef: o.providerRef ?? null,
            providerAccountRevisionId: row.provider_account_revision_id,
          }))
        : result.status === 'NOT_FOUND'
          ? [
              {
                source: 'POLL',
                providerEventKey: `poll:not-found:${row.id}:${row.poll_count + 1}`,
                rawStatus: 'not_found',
                observedAt: new Date().toISOString(),
                sequence: null,
                details: {},
                providerAccountRevisionId: row.provider_account_revision_id,
              },
            ]
          : [];
    for (const obs of incoming) {
      const r = await tenantCommand(pool, ctx, meta, async (c) => {
        const locked = await lockOrder(c, ctx, meta, row.id);
        if (obs.rawStatus === 'not_found') return recordNotFound(c, ctx, locked.kind, locked.row, obs);
        return (await applyObservationInTx(c, ctx, locked.kind, locked.row, obs)).transitioned;
      });
      if (r) applied++;
    }
  }
  return { polled: claimed.length, applied };
}

/** A lookup "not found" is evidence only: recorded with disposition NOT_FOUND, never a transition or no-effect proof. */
async function recordNotFound(
  c: any,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
  obs: IncomingObservation,
): Promise<boolean> {
  await c.query(
    `INSERT INTO fulfillment_observations (tenant_id, id, order_kind, purchase_order_id, service_job_id, provider_account_id,
       provider_account_revision_id, source, provider_event_key, raw_status, observed_at, disposition, reason_code,
       actor_kind, actor_id)
     VALUES ($1, 'fob_' || gen_random_uuid(), $2, $3, $4, $5, $6, 'POLL', $7, 'not_found', $8, 'NOT_FOUND',
             'LOOKUP_NOT_FOUND_IS_NOT_NO_EFFECT', $9, $10)
     ON CONFLICT (tenant_id, provider_account_id, provider_event_key) DO NOTHING`,
    [
      ctx.tenantId,
      kind,
      kind === 'PURCHASE_ORDER' ? o.id : null,
      kind === 'SERVICE_JOB' ? o.id : null,
      o.provider_account_id,
      o.provider_account_revision_id,
      obs.providerEventKey,
      obs.observedAt,
      ctx.principal.kind === 'WORKER' ? 'WORKER' : ctx.principal.kind === 'HUMAN' ? 'HUMAN' : 'SERVICE',
      String(ctx.principal.id).slice(0, 128),
    ],
  );
  return false;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
