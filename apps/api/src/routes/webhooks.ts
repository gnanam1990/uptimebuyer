// M10 fulfillment webhooks (API-EVENT-SPEC §7): POST /v1/fulfillment-webhooks/{binding}. No bearer token: the opaque
// binding resolves exactly one provider-account revision and the HMAC over the exact raw body bytes (header
// `x-ub-signature: t=<unix>,v1=<hex>`, bounded clock skew, replay identity per account) is verified by
// ingestFulfillmentWebhook before anything is stored. The tenant comes only from that server-side binding. An unknown
// binding and a bad signature are the same uniform 401 (no binding-existence oracle) and spend a per-source budget.
import { DomainError } from '@uptimebuyer/contracts';
import { PATH_IDS } from '@uptimebuyer/contracts/api';
import { ingestFulfillmentWebhook } from '@uptimebuyer/orders';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app.js';

export const FULFILLMENT_SIGNATURE_HEADER = 'x-ub-signature';

export function registerWebhookRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post<{ Params: { binding: string } }>(
    '/v1/fulfillment-webhooks/:binding',
    { bodyLimit: deps.limits.webhookBodyLimitBytes },
    async (req, reply) => {
      const source = req.ip || 'unknown';
      if (!deps.webhookFailures.has(source))
        throw new DomainError('RATE_LIMITED', 'Too many rejected deliveries; retry later.', {
          reasonCode: 'WEBHOOK_RATE_EXCEEDED',
          retryAfterMs: deps.webhookFailures.retryAfterSeconds() * 1000,
        });
      const reject = () => {
        deps.webhookFailures.take(source);
        return new DomainError('UNAUTHENTICATED', 'Authentication failed.');
      };
      const binding = PATH_IDS.binding.safeParse(req.params.binding);
      const sig = req.headers[FULFILLMENT_SIGNATURE_HEADER];
      if (!binding.success || typeof sig !== 'string' || !Buffer.isBuffer(req.body)) throw reject();
      const r = await ingestFulfillmentWebhook(
        deps.pool,
        { binding: binding.data, signature: sig, rawBody: new Uint8Array(req.body) },
        { credentials: deps.credentials },
      );
      switch (r.status) {
        case 'ACCEPTED':
        case 'DUPLICATE':
          return reply.status(200).send({ status: r.status });
        case 'QUARANTINED':
          // Stored and audited but not applied: the provider gets an acknowledgement, the claim is not authoritative.
          return reply.status(202).send({ status: r.status });
        case 'REJECTED':
          if (r.reasonCode === 'PAYLOAD_TOO_LARGE')
            throw Object.assign(new Error('too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
          throw reject();
      }
    },
  );
}
