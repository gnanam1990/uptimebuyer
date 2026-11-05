// Evidence, citations, compatibility and plan comparison (FR-19, UI-SPEC §8.2-8.3). Retrieval never decides: facts carry
// authority NONE and model proposals are labelled MODEL PROPOSAL; compatibility decisions are M06's deterministic
// ALLOW/HOLD/REJECT; plans are M08's ADVISORY RANKING. Each approval request is returned with the effective bounds of
// the spending session it would authorize (incident, merchant, action, amount, currency, purpose, expiry — FR-11), so
// a client can display and announce them before any approval.
import { PATH_IDS } from '@uptimebuyer/contracts/api';
import { getCandidateAction, listDecisions } from '@uptimebuyer/compatibility';
import {
  getCurrentIncidentEvidenceRevision,
  listIncidentProposals,
  reopenCitation,
  retrieveEvidence,
} from '@uptimebuyer/evidence';
import { getIncident } from '@uptimebuyer/incidents';
import { listIncidentCommerce } from '@uptimebuyer/commerce';
import { listIncidentPlans, listPlanApprovalRequests, type ApprovalRequestView } from '@uptimebuyer/planning';
import { listIncidentQuotes } from '@uptimebuyer/providers';
import type { TenantContext } from '@uptimebuyer/data';
import type { FastifyInstance } from 'fastify';
import { ctxOf, type RouteDeps } from '../app.js';
import { pathId } from '../http.js';

async function sessionBoundsOf(
  deps: RouteDeps,
  ctx: TenantContext,
  req: ApprovalRequestView,
  candidateActionId: string,
) {
  const cand = await getCandidateAction(deps.pool, ctx, candidateActionId);
  return {
    incidentId: req.scope.incidentId,
    siteId: req.scope.siteId,
    merchantId: req.scope.merchantId,
    actionKind: req.scope.actionKind,
    actionClass: req.scope.actionClass,
    amount: req.scope.maxAmount,
    purpose: cand.purpose,
    expiresAt: req.scope.expiresAt,
    providerAccountRevisionId: req.scope.providerAccountRevisionId,
    policyRevisionId: req.scope.policyRevisionId,
  };
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/evidence', async (req) => {
    const ctx = ctxOf(req);
    const incident = await getIncident(deps.pool, ctx, req.params.incidentId);
    const current = await getCurrentIncidentEvidenceRevision(deps.pool, ctx, incident.incidentId);
    const retrieval = current
      ? await retrieveEvidence(deps.pool, ctx, { evidenceRevisionId: current.evidenceRevisionId })
      : null;
    const proposals = await listIncidentProposals(deps.pool, ctx, incident.incidentId);
    return {
      incidentId: incident.incidentId,
      evidenceRevision: current ? { ...current, current: retrieval?.current ?? false } : null,
      retrieval,
      proposals,
    };
  });

  app.get<{ Params: { citationId: string } }>('/v1/citations/:citationId', async (req) =>
    reopenCitation(deps.pool, ctxOf(req), deps.store, req.params.citationId),
  );

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/compatibility', async (req) => ({
    decisions: await listDecisions(deps.pool, ctxOf(req), { incidentId: req.params.incidentId }),
  }));

  app.get<{ Params: { incidentId: string } }>('/v1/incidents/:incidentId/plans', async (req) => {
    const ctx = ctxOf(req);
    const incidentId = pathId(req.params.incidentId, PATH_IDS.incidentId);
    const plans = await listIncidentPlans(deps.pool, ctx, incidentId);
    const commerce = await listIncidentCommerce(deps.pool, ctx, incidentId);
    const out = [];
    for (const p of plans) {
      const requests = await listPlanApprovalRequests(deps.pool, ctx, p.planId);
      const approvalRequests = [];
      for (const r of requests) {
        const action = p.actions.find((a) => a.planActionId === r.planActionId);
        approvalRequests.push({
          ...r,
          approvalId: commerce.approvals.find((a) => a.approvalRequestId === r.approvalRequestId)?.approvalId ?? null,
          sessionBounds: await sessionBoundsOf(deps, ctx, r, action!.candidateActionId),
        });
      }
      out.push({ ...p, approvalRequests });
    }
    return { plans: out, quotes: await listIncidentQuotes(deps.pool, ctx, incidentId) };
  });
}
