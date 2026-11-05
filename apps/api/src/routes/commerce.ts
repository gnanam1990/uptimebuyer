// Approvals, execution authority / Kite session, commercial intents, purchase orders and service jobs, and recovery
// proof (FR-19, INV-12, UI-SPEC §8.5-8.6). Each axis stays a separate field: local authority status, Kite-session
// transport / external outcome / capability, attempt transport / outcome / capability, economic intent, order or job
// lifecycle and recovery gate. Issuance answers 202 with the session's stored external outcome: `202` is never session
// confirmation and `sessionConfirmed` is true only when that outcome is CONFIRMED. Purchase orders and service jobs
// are served from distinct routes and never satisfy each other's lookups.
import {
  ApprovePlanBodySchema,
  ChangeAuthorityBodySchema,
  HoldPlanBodySchema,
  IssueAuthorityBodySchema,
  PATH_IDS,
  VerifyOrderBodySchema,
} from '@uptimebuyer/contracts/api';
import { DomainError } from '@uptimebuyer/contracts';
import {
  approvePlanAction,
  changeExecutionAuthorityStatus,
  getCommercialIntent,
  getExecutionAuthority,
  issueExecutionAuthority,
  listIncidentCommerce,
  recordApprovalHold,
} from '@uptimebuyer/commerce';
import { getApprovalRequest } from '@uptimebuyer/planning';
import { getOrder, listIncidentOrders, recordFulfillmentVerification } from '@uptimebuyer/orders';
import { getRecoveryStatus } from '@uptimebuyer/recovery';
import type { FastifyInstance } from 'fastify';
import { ctxOf, spendSensitive, type RouteDeps } from '../app.js';
import { body, commandTarget, idempotencyKey, notFound, pathId } from '../http.js';

const unavailable = () =>
  new DomainError('FORBIDDEN', 'The requested resource is not available.', { reasonCode: 'RESOURCE_UNAVAILABLE' });

export function registerCommerceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // POST /v1/plans/{planId}:approve | :hold
  app.post<{ Params: { target: string } }>('/v1/plans/:target', async (req, reply) => {
    const t = commandTarget(req.params.target, ['approve', 'hold'] as const);
    if (!t) throw notFound();
    const ctx = ctxOf(req);
    const key = idempotencyKey(req);
    spendSensitive(deps, req);
    const planId = pathId(t.id, PATH_IDS.planId);
    if (t.verb === 'approve') {
      const b = body(req, ApprovePlanBodySchema);
      // The request must belong to the plan named in the path (checked before anything is recorded).
      if ((await getApprovalRequest(deps.pool, ctx, b.approvalRequestId)).planId !== planId) throw unavailable();
      const r = await approvePlanAction(deps.pool, ctx, { ...b, idempotencyKey: key });
      return reply.status(r.created ? 201 : 200).send(r);
    }
    const b = body(req, HoldPlanBodySchema);
    if ((await getApprovalRequest(deps.pool, ctx, b.approvalRequestId)).planId !== planId) throw unavailable();
    return recordApprovalHold(deps.pool, ctx, b);
  });

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/execution-authorities', async (req) => {
    const r = await listIncidentCommerce(deps.pool, ctxOf(req), req.params.incidentId);
    return { authorities: r.authorities, approvals: r.approvals };
  });

  app.get<{ Params: { authorityId: string } }>('/v1/execution-authorities/:authorityId', async (req) =>
    getExecutionAuthority(deps.pool, ctxOf(req), req.params.authorityId),
  );

  // POST /v1/approvals/{approvalId}/execution-authorities
  app.post<{ Params: { approvalId: string } }>(
    '/v1/approvals/:approvalId/execution-authorities',
    async (req, reply) => {
      const ctx = ctxOf(req);
      idempotencyKey(req);
      spendSensitive(deps, req);
      const b = body(req, IssueAuthorityBodySchema);
      if (!deps.authority)
        throw new DomainError('DEPENDENCY_FAILED', 'Authority issuance is not configured in this environment.', {
          reasonCode: 'AUTHORITY_SIGNER_UNAVAILABLE',
        });
      const issued = await issueExecutionAuthority(
        deps.pool,
        ctx,
        { approvalId: req.params.approvalId, subject: b.subject },
        deps.authority.signer,
      );
      const id = issued.authority.executionAuthorityId;
      if (deps.authority.sessions && issued.session.transportState === 'PREPARED')
        // The broker owns the outcome; failure to reach it leaves the stored session as it is (never confirmed here).
        await deps.authority.sessions.activate({ tenantId: ctx.tenantId, executionAuthorityId: id }).catch(() => {});
      const view = await getExecutionAuthority(deps.pool, ctx, id);
      return reply.status(202).send({
        accepted: true,
        sessionConfirmed: view.session.externalOutcomeState === 'CONFIRMED',
        authority: view,
      });
    },
  );

  // POST /v1/execution-authorities/{authorityId}:change-status
  app.post<{ Params: { target: string } }>('/v1/execution-authorities/:target', async (req) => {
    const t = commandTarget(req.params.target, ['change-status'] as const);
    if (!t) throw notFound();
    const ctx = ctxOf(req);
    idempotencyKey(req);
    spendSensitive(deps, req);
    const b = body(req, ChangeAuthorityBodySchema);
    return changeExecutionAuthorityStatus(deps.pool, ctx, {
      executionAuthorityId: t.id,
      to: b.to,
      reasonCode: b.reasonCode,
    });
  });

  app.get<{ Params: { intentId: string } }>('/v1/intents/:intentId', async (req) =>
    getCommercialIntent(deps.pool, ctxOf(req), req.params.intentId),
  );

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/orders', async (req) => ({
    orders: await listIncidentOrders(deps.pool, ctxOf(req), req.params.incidentId),
  }));

  for (const [path, kind, schema] of [
    ['/v1/purchase-orders/:orderId', 'PURCHASE_ORDER', PATH_IDS.purchaseOrderId],
    ['/v1/service-jobs/:orderId', 'SERVICE_JOB', PATH_IDS.serviceJobId],
  ] as const) {
    app.get<{ Params: { orderId: string } }>(path, async (req) => {
      const ctx = ctxOf(req);
      const id = pathId(req.params.orderId, schema);
      const order = await getOrder(deps.pool, ctx, id);
      if (order.orderKind !== kind) throw unavailable();
      return order;
    });
  }

  // POST /v1/orders/{orderId}:verify (receiving inspection / work verification; VERIFIED or DISPUTED)
  app.post<{ Params: { target: string } }>('/v1/orders/:target', async (req) => {
    const t = commandTarget(req.params.target, ['verify'] as const);
    if (!t) throw notFound();
    const ctx = ctxOf(req);
    const b = body(req, VerifyOrderBodySchema);
    return recordFulfillmentVerification(deps.pool, ctx, {
      orderId: t.id,
      outcome: b.outcome,
      idempotencyKey: idempotencyKey(req),
    });
  });

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/recovery', async (req) =>
    getRecoveryStatus(deps.pool, ctxOf(req), req.params.incidentId),
  );
}
