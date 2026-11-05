// Verified fulfillment webhooks (NFR-02, NFR-03, INV-12; ADR 0005). The tenant comes only from the server-side
// endpoint binding (/v1/fulfillment-webhooks/{binding}); the raw body is size-bounded before anything else, and its
// HMAC-SHA256 over `<timestamp>.<raw body bytes>` is compared in constant time against the verifiers of the account's
// current revision and of superseded revisions inside a bounded window, with a timestamp tolerance. ONLY
// `webhook_verifier_ref` is ever resolved: the paid revision's credential reference stays with the broker. The body
// has a strict schema with no URL, tenant or revision field. Replay identity is (tenant, provider account, provider
// event id). The target order/job is resolved inside the binding's tenant and account by the pre-egress client
// operation id (and provider reference when the order has one) in the table of the event's kind, and must be pinned to
// exactly the revision whose verifier matched (stale-revision retargeting is quarantined). A verified webhook is a
// fulfillment observation only: it never changes payment state and never proves recovery.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ClientOperationIdSchema, DomainError, UtcInstantSchema } from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import {
  claimJobs,
  completeJob,
  failJob,
  recordWebhookDelivery,
  resolveWebhookBinding,
  sha256Digest,
  tenantCommand,
  type CredentialResolver,
  type Db,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { applyObservationInTx } from './apply.js';
import { KIND, lockOrder } from './internal.js';
import type { OrderKind } from './vocabulary.js';

export const FULFILLMENT_WEBHOOK_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  toleranceSeconds: 300,
  /** A superseded revision's verifier stays valid for observations of orders pinned to it, for this long. */
  supersededVerifierWindowMs: 30 * 24 * 3_600_000,
  minVerifierKeyBytes: 32,
});
export const FULFILLMENT_OBSERVATION_JOB = 'orders.fulfillment_observation';

const Token = z.string().regex(/^[\x21-\x7E]{1,128}$/);
const DetailsSchema = z.strictObject({
  quantityFilled: z.int().min(0).max(1_000_000).optional(),
  quantityConfirmed: z.int().min(0).max(1_000_000).optional(),
  totalMinor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  etaAt: UtcInstantSchema.optional(),
  scheduledStartAt: UtcInstantSchema.optional(),
  substitutePartNumber: z
    .string()
    .regex(/^\S(?:.{0,126}\S)?$/)
    .optional(),
  substituteManufacturer: z
    .string()
    .regex(/^\S(?:.{0,126}\S)?$/)
    .optional(),
});
const FulfillmentEventSchema = z.strictObject({
  eventId: Token,
  type: z.enum(['purchase_order.status', 'service_job.status']),
  clientOperationId: ClientOperationIdSchema,
  providerRef: Token.nullable().optional(),
  status: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  observedAt: UtcInstantSchema,
  sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  details: DetailsSchema.optional(),
});
export type FulfillmentEvent = z.output<typeof FulfillmentEventSchema>;

export function signFulfillmentWebhook(key: Uint8Array, timestampSeconds: number, rawBody: Uint8Array): string {
  const mac = createHmac('sha256', key).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type SignatureCheck = { ok: true; revisionId: string; timestamp: number } | { ok: false; reasonCode: string };

/** Constant-time verification against candidate verifiers; reports which revision's verifier matched. */
export function verifyFulfillmentSignature(
  signature: unknown,
  rawBody: Uint8Array,
  nowSeconds: number,
  candidates: readonly { revisionId: string; key: Uint8Array }[],
): SignatureCheck {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(typeof signature === 'string' ? signature : '');
  if (!m) return { ok: false, reasonCode: 'SIGNATURE_INVALID' };
  const ts = Number(m[1]);
  if (Math.abs(nowSeconds - ts) > FULFILLMENT_WEBHOOK_LIMITS.toleranceSeconds)
    return { ok: false, reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  const given = Buffer.from(m[2]!, 'hex');
  let matched: string | null = null;
  for (const cand of candidates) {
    if (cand.key.byteLength < FULFILLMENT_WEBHOOK_LIMITS.minVerifierKeyBytes) continue;
    const expected = createHmac('sha256', cand.key).update(`${ts}.`).update(rawBody).digest();
    // Every candidate is compared (no early exit on a match) with timingSafeEqual over equal-length buffers.
    if (expected.length === given.length && timingSafeEqual(expected, given) && matched === null)
      matched = cand.revisionId;
  }
  return matched ? { ok: true, revisionId: matched, timestamp: ts } : { ok: false, reasonCode: 'SIGNATURE_INVALID' };
}

export function parseFulfillmentEvent(rawBody: Uint8Array): { ok: true; event: FulfillmentEvent } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    return { ok: false };
  }
  const r = FulfillmentEventSchema.safeParse(parsed);
  return r.success ? { ok: true, event: r.data } : { ok: false };
}

export type FulfillmentWebhookResult =
  | { status: 'ACCEPTED'; deliveryId: string; providerEventId: string }
  | { status: 'DUPLICATE'; deliveryId: string; providerEventId: string }
  | { status: 'QUARANTINED'; reasonCode: string; deliveryId: string }
  | { status: 'REJECTED'; reasonCode: string };

export async function ingestFulfillmentWebhook(
  pool: Db,
  req: { binding: string; signature: string; rawBody: Uint8Array },
  deps: { credentials: CredentialResolver; nowSeconds?: () => number },
): Promise<FulfillmentWebhookResult> {
  if (!(req.rawBody instanceof Uint8Array) || req.rawBody.byteLength > FULFILLMENT_WEBHOOK_LIMITS.maxBodyBytes)
    return { status: 'REJECTED', reasonCode: 'PAYLOAD_TOO_LARGE' };
  if (typeof req.binding !== 'string' || req.binding.length < 16 || req.binding.length > 128)
    return { status: 'REJECTED', reasonCode: 'UNKNOWN_BINDING' };
  let binding;
  try {
    binding = await resolveWebhookBinding(pool, req.binding);
  } catch (e) {
    if (e instanceof DomainError) return { status: 'REJECTED', reasonCode: 'UNKNOWN_BINDING' };
    throw e;
  }
  const bodyDigest = sha256Digest(Buffer.from(req.rawBody).toString('latin1'));
  const reject = async (reasonCode: string): Promise<FulfillmentWebhookResult> => {
    await recordWebhookDelivery(pool, binding, {
      providerEventId: `unverified:${bodyDigest.slice(7, 39)}`,
      signatureValid: false,
      bodyDigest,
    });
    return { status: 'REJECTED', reasonCode };
  };
  const { rows: revs } = await pool.query<{ id: string; owner_service: string; webhook_verifier_ref: string | null }>(
    `SELECT id, owner_service, webhook_verifier_ref FROM provider_account_revisions
      WHERE tenant_id = $1 AND provider_account_id = $2
        AND (id = $3 OR (superseded_at IS NOT NULL
             AND superseded_at > clock_timestamp() - make_interval(secs => $4::double precision / 1000)))
      ORDER BY revision DESC LIMIT 8`,
    [
      binding.tenantId,
      binding.providerAccountId,
      binding.providerAccountRevisionId,
      FULFILLMENT_WEBHOOK_LIMITS.supersededVerifierWindowMs,
    ],
  );
  // Fulfillment callbacks belong to broker-paid order accounts; M07 owns unpaid contact webhooks.
  if (!revs.some((r) => r.id === binding.providerAccountRevisionId && r.owner_service === 'KITE_BROKER_PAID'))
    return reject('NOT_A_FULFILLMENT_ACCOUNT');
  const candidates: { revisionId: string; key: Uint8Array }[] = [];
  for (const r of revs) {
    if (r.owner_service !== 'KITE_BROKER_PAID' || !r.webhook_verifier_ref) continue;
    const key = await deps.credentials.resolveSigningKey(r.webhook_verifier_ref);
    if (key) candidates.push({ revisionId: r.id, key });
  }
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const sig = verifyFulfillmentSignature(req.signature, req.rawBody, now, candidates);
  if (!sig.ok) return reject(sig.reasonCode);
  const ev = parseFulfillmentEvent(req.rawBody);
  if (!ev.ok) return reject('PAYLOAD_SCHEMA_INVALID');
  const e = ev.event;
  const delivery = await recordWebhookDelivery(pool, binding, {
    providerEventId: e.eventId,
    signatureValid: true,
    bodyDigest,
  });
  if (delivery.duplicate) return { status: 'DUPLICATE', deliveryId: delivery.deliveryId, providerEventId: e.eventId };
  const kind: OrderKind = e.type === 'purchase_order.status' ? 'PURCHASE_ORDER' : 'SERVICE_JOB';
  const { rows } = await pool.query<{ id: string; provider_account_revision_id: string; provider_ref: string | null }>(
    `SELECT id, provider_account_revision_id, provider_ref FROM ${KIND[kind].table}
      WHERE tenant_id = $1 AND provider_account_id = $2 AND client_operation_id = $3`,
    [binding.tenantId, binding.providerAccountId, e.clientOperationId],
  );
  const target = rows[0];
  const quarantine = async (reasonCode: string): Promise<FulfillmentWebhookResult> => {
    await pool.query(
      `INSERT INTO audit_entries (tenant_id, id, actor_kind, actor_id, action, resource_type, resource_id, result, reason_code, correlation_id)
       VALUES ($1, 'aud_' || gen_random_uuid(), 'WEBHOOK', $2, 'orders.fulfillment_webhook', 'webhook_delivery', $3, 'DENIED', $4,
               'corr_' || gen_random_uuid())`,
      [binding.tenantId, binding.providerAccountId, delivery.deliveryId, reasonCode],
    );
    return { status: 'QUARANTINED', reasonCode, deliveryId: delivery.deliveryId };
  };
  if (!target) return quarantine('TARGET_NOT_FOUND');
  if (target.provider_account_revision_id !== sig.revisionId) return quarantine('REVISION_MISMATCH');
  if (e.providerRef && target.provider_ref && e.providerRef !== target.provider_ref)
    return quarantine('PROVIDER_REF_MISMATCH');
  const payload = {
    deliveryId: delivery.deliveryId,
    orderId: target.id,
    revisionId: sig.revisionId,
    eventId: e.eventId,
    status: e.status,
    observedAt: e.observedAt,
    sequence: e.sequence ?? null,
    providerRef: e.providerRef ?? null,
    details: e.details ?? {},
    rawBody: Buffer.from(req.rawBody).toString('base64'),
    rawBodyDigest: bodyDigest,
  };
  await pool.query(
    `INSERT INTO jobs (tenant_id, id, kind, payload, dedupe_key, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 5) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [
      binding.tenantId,
      `job_${randomUUID()}`,
      FULFILLMENT_OBSERVATION_JOB,
      canonicalize(payload),
      `fulfillment:${delivery.deliveryId}`,
    ],
  );
  return { status: 'ACCEPTED', deliveryId: delivery.deliveryId, providerEventId: e.eventId };
}

/** Worker: apply queued verified webhook observations under the job's worker context (orders.engine). */
export async function runFulfillmentObservationJobs(
  pool: Db,
  opts: { workerId: string; limit?: number },
): Promise<{ applied: number }> {
  const jobs = await claimJobs(pool, {
    workerId: opts.workerId,
    kinds: [FULFILLMENT_OBSERVATION_JOB],
    limit: opts.limit ?? 50,
  });
  let applied = 0;
  for (const job of jobs) {
    const p = job.job.payload as {
      deliveryId: string;
      orderId: string;
      revisionId: string;
      eventId: string;
      status: string;
      observedAt: string;
      sequence: number | null;
      providerRef: string | null;
      details: Record<string, unknown>;
      rawBody: string;
      rawBodyDigest: string;
    };
    try {
      const meta = { action: 'orders.engine', resourceType: 'webhook_delivery', resourceId: p.deliveryId };
      const did = await tenantCommand(pool, job.ctx, meta, async (c) => {
        const { kind, row } = await lockOrder(c, job.ctx, meta, p.orderId);
        const r = await applyObservationInTx(c, job.ctx, kind, row, {
          source: 'WEBHOOK',
          providerEventKey: `wh:${p.eventId}`,
          webhookDeliveryId: p.deliveryId,
          rawStatus: p.status,
          observedAt: p.observedAt,
          sequence: p.sequence,
          details: p.details,
          providerRef: p.providerRef,
          rawBody: new Uint8Array(Buffer.from(p.rawBody, 'base64')),
          rawBodyDigest: p.rawBodyDigest,
          providerAccountRevisionId: p.revisionId,
        });
        await c.query(
          `UPDATE webhook_deliveries SET processed_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 AND processed_at IS NULL`,
          [job.ctx.tenantId, p.deliveryId],
        );
        return r.observationId !== null;
      });
      if (did) applied++;
      await completeJob(pool, job);
    } catch {
      await failJob(pool, job, { reasonCode: 'OBSERVATION_APPLY_FAILED', retryInMs: 1_000 });
    }
  }
  return { applied };
}
