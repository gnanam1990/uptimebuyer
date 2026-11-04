// Signed, replay-protected provider webhooks for M07-owned unpaid accounts (API-EVENT-SPEC §7). The tenant comes only
// from the server-side endpoint binding; the body has a strict schema with no tenant field; the signature is an
// HMAC-SHA256 over `<timestamp>.<raw body>` with a bounded clock tolerance, verified with the binding's current
// revision verifier or a superseded one inside the bounded reconciliation window; replay identity is
// (tenant, account, provider event id). A valid webhook is not authoritative for confirmation: an acknowledgement is
// mirrored, every other status only schedules authoritative lookup. Broker-owned (paid) accounts are refused: their
// verifier belongs to the broker.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ClientOperationIdSchema, DomainError, UtcInstantSchema } from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import {
  claimJobs,
  completeJob,
  recordWebhookDelivery,
  requireAuthorized,
  resolveWebhookBinding,
  sha256Digest,
  withTenantTransaction,
  type CredentialResolver,
  type Db,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { patchAttempt, type AttemptRow } from './attempts.js';
import { CONTACT_RAW_STATUSES } from './schemas.js';

export const WEBHOOK_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  toleranceSeconds: 300,
  /** A superseded revision's verifier stays callback-valid only this long after supersession. */
  supersededVerifierWindowMs: 24 * 3_600_000,
});
export const WEBHOOK_APPLY_JOB = 'provider.webhook_apply';

const WebhookEventSchema = z.strictObject({
  eventId: z.string().regex(/^[\x21-\x7E]{1,128}$/),
  type: z.literal('contact.status'),
  clientOperationId: ClientOperationIdSchema,
  status: z.enum(CONTACT_RAW_STATUSES),
  providerRef: z
    .string()
    .regex(/^[\x21-\x7E]{1,128}$/)
    .nullable()
    .optional(),
  observedAt: UtcInstantSchema,
});

export function signProviderWebhook(key: Uint8Array, timestampSeconds: number, rawBody: Uint8Array): string {
  const mac = createHmac('sha256', key).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type WebhookResult =
  | { status: 'ACCEPTED'; deliveryId: string; providerEventId: string }
  | { status: 'DUPLICATE'; deliveryId: string; providerEventId: string }
  | { status: 'QUARANTINED'; reasonCode: string; deliveryId: string }
  | { status: 'REJECTED'; reasonCode: string };

export async function ingestProviderWebhook(
  pool: Db,
  req: { binding: string; signature: string; rawBody: Uint8Array },
  deps: { credentials: CredentialResolver; nowSeconds?: () => number },
): Promise<WebhookResult> {
  if (!(req.rawBody instanceof Uint8Array) || req.rawBody.byteLength > WEBHOOK_LIMITS.maxBodyBytes)
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
  const unverifiedId = `unverified:${bodyDigest.slice(7, 39)}`;
  const reject = async (reasonCode: string): Promise<WebhookResult> => {
    await recordWebhookDelivery(pool, binding, { providerEventId: unverifiedId, signatureValid: false, bodyDigest });
    return { status: 'REJECTED', reasonCode };
  };
  // Candidate verifiers: the current revision, plus superseded ones inside the bounded reconciliation window.
  const { rows: revs } = await pool.query<{ id: string; owner_service: string; webhook_verifier_ref: string | null }>(
    `SELECT id, owner_service, webhook_verifier_ref FROM provider_account_revisions
      WHERE tenant_id = $1 AND provider_account_id = $2
        AND (id = $3 OR (superseded_at IS NOT NULL AND superseded_at > clock_timestamp() - make_interval(secs => $4::double precision / 1000)))
      ORDER BY revision DESC LIMIT 3`,
    [
      binding.tenantId,
      binding.providerAccountId,
      binding.providerAccountRevisionId,
      WEBHOOK_LIMITS.supersededVerifierWindowMs,
    ],
  );
  if (revs.some((r) => r.id === binding.providerAccountRevisionId && r.owner_service !== 'M07_UNPAID'))
    return reject('BROKER_OWNED_WEBHOOK');
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(req.signature ?? ''));
  if (!m) return reject('SIGNATURE_INVALID');
  const ts = Number(m[1]);
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_LIMITS.toleranceSeconds) return reject('TIMESTAMP_OUT_OF_TOLERANCE');
  const given = Buffer.from(m[2]!, 'hex');
  let verifiedRevisionId: string | null = null;
  for (const r of revs) {
    if (r.owner_service !== 'M07_UNPAID' || !r.webhook_verifier_ref) continue;
    const key = await deps.credentials.resolveSigningKey(r.webhook_verifier_ref);
    if (!key || key.byteLength < 32) continue;
    const expected = createHmac('sha256', key).update(`${ts}.`).update(req.rawBody).digest();
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      verifiedRevisionId = r.id;
      break;
    }
  }
  if (!verifiedRevisionId) return reject('SIGNATURE_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(req.rawBody).toString('utf8'));
  } catch {
    parsed = null;
  }
  const ev = WebhookEventSchema.safeParse(parsed);
  if (!ev.success) {
    await recordWebhookDelivery(pool, binding, { providerEventId: unverifiedId, signatureValid: false, bodyDigest });
    return { status: 'REJECTED', reasonCode: 'PAYLOAD_SCHEMA_INVALID' };
  }
  const delivery = await recordWebhookDelivery(pool, binding, {
    providerEventId: ev.data.eventId,
    signatureValid: true,
    bodyDigest,
  });
  if (delivery.duplicate)
    return { status: 'DUPLICATE', deliveryId: delivery.deliveryId, providerEventId: ev.data.eventId };
  // Target resolution is namespaced to the binding's tenant and account; the pinned revision must match.
  const { rows } = await pool.query<{ id: string; provider_account_revision_id: string; paid: boolean }>(
    `SELECT id, provider_account_revision_id, paid FROM provider_contact_attempts
      WHERE tenant_id = $1 AND provider_account_id = $2 AND client_operation_id = $3`,
    [binding.tenantId, binding.providerAccountId, ev.data.clientOperationId],
  );
  const target = rows[0];
  const quarantine = async (reasonCode: string): Promise<WebhookResult> => {
    await pool.query(
      `INSERT INTO audit_entries (tenant_id, id, actor_kind, actor_id, action, resource_type, resource_id, result, reason_code, correlation_id)
       VALUES ($1, 'aud_' || gen_random_uuid(), 'WEBHOOK', $2, 'provider_webhook.apply', 'webhook_delivery', $3, 'DENIED', $4,
               'corr_' || gen_random_uuid())`,
      [binding.tenantId, binding.providerAccountId, delivery.deliveryId, reasonCode],
    );
    return { status: 'QUARANTINED', reasonCode, deliveryId: delivery.deliveryId };
  };
  if (!target) return quarantine('TARGET_NOT_FOUND');
  if (target.paid) return quarantine('BROKER_OWNED_TARGET');
  if (target.provider_account_revision_id !== verifiedRevisionId) return quarantine('REVISION_MISMATCH');
  const payload = {
    deliveryId: delivery.deliveryId,
    contactAttemptId: target.id,
    status: ev.data.status,
    providerRef: ev.data.providerRef ?? null,
  };
  await pool.query(
    `INSERT INTO jobs (tenant_id, id, kind, payload, dedupe_key, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 5) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [
      binding.tenantId,
      `job_${randomUUID()}`,
      WEBHOOK_APPLY_JOB,
      canonicalize(payload),
      `webhook:${delivery.deliveryId}`,
    ],
  );
  return { status: 'ACCEPTED', deliveryId: delivery.deliveryId, providerEventId: ev.data.eventId };
}

/**
 * Apply queued verified webhook observations (worker). `received` mirrors provider acknowledgement; any other status
 * records the raw status and schedules authoritative lookup instead of trusting the callback.
 */
export async function runWebhookApply(
  pool: Db,
  opts: { workerId: string; limit?: number },
): Promise<{ applied: number }> {
  const jobs = await claimJobs(pool, { workerId: opts.workerId, kinds: [WEBHOOK_APPLY_JOB], limit: opts.limit ?? 20 });
  let applied = 0;
  for (const job of jobs) {
    const p = job.job.payload as {
      deliveryId: string;
      contactAttemptId: string;
      status: string;
      providerRef: string | null;
    };
    await withTenantTransaction(pool, job.ctx, async (c) => {
      requireAuthorized(job.ctx, { action: 'provider.engine', siteId: null });
      const { rows } = await c.query<AttemptRow & { incident_id: string }>(
        `SELECT a.*, q.incident_id FROM provider_contact_attempts a
           JOIN provider_contact_requests q ON q.tenant_id = a.tenant_id AND q.id = a.contact_request_id
          WHERE a.tenant_id = $1 AND a.id = $2 FOR UPDATE OF a`,
        [job.ctx.tenantId, p.contactAttemptId],
      );
      const a = rows[0];
      if (a && !a.paid) {
        const ack =
          p.status === 'received' && ['AUTHORIZED', 'REQUESTED', 'UNKNOWN'].includes(a.external_outcome_state);
        await patchAttempt(
          c,
          job.ctx,
          a,
          ack
            ? {
                external_outcome_state: 'ACCEPTED',
                provider_ref: p.providerRef ?? a.provider_ref,
                raw_provider_status: p.status,
                next_reconcile_at: null,
              }
            : {
                raw_provider_status: p.status,
                next_reconcile_at: a.adapter_capability === 'ELIGIBLE' ? new Date().toISOString() : a.next_reconcile_at,
              },
          { kind: 'WEBHOOK', rawProviderStatus: p.status, reasonCode: ack ? null : 'LOOKUP_REQUIRED' },
          a.incident_id,
        );
        applied++;
      }
      await c.query(
        `UPDATE webhook_deliveries SET processed_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 AND processed_at IS NULL`,
        [job.ctx.tenantId, p.deliveryId],
      );
    });
    await completeJob(pool, job);
  }
  return { applied };
}
