// Evidence ledger, audit, policy administration and notifications (FR-18, FR-20, FR-21). The ledger export and audit
// query are M02's tenant-wide auditor/admin reads; policy publication is M06's versioned AUTHORITY revision (draft
// validation first, effective-dated, immutable history); notifications are the caller's own M07-routed messages.
import { DomainError } from '@uptimebuyer/contracts';
import { AuditQuerySchema, PolicyDraftBodySchema } from '@uptimebuyer/contracts/api';
import { listPolicyHistory, publishCompatibilityPolicy, validatePolicyDraft } from '@uptimebuyer/compatibility';
import {
  AuthorityPolicySchema,
  authorize,
  exportEvidenceLedger,
  listAuditEntries,
  recordAudit,
} from '@uptimebuyer/data';
import { listMyNotifications } from '@uptimebuyer/providers';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctxOf, spendSensitive, type RouteDeps } from '../app.js';
import { body, idempotencyKey, query } from '../http.js';

export function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/v1/ledger', async (req) => {
    const ledger = await exportEvidenceLedger(deps.pool, ctxOf(req));
    return { tenantId: ledger.tenantId, cutoffAt: ledger.cutoffAt, entries: ledger.entries, chain: ledger.chain };
  });

  app.get('/v1/audit', async (req) => {
    const q = query(req, AuditQuerySchema);
    return { entries: await listAuditEntries(deps.pool, ctxOf(req), { limit: q.limit ? Number(q.limit) : 100 }) };
  });

  app.get('/v1/policies', async (req) => ({ revisions: await listPolicyHistory(deps.pool, ctxOf(req)) }));

  app.post('/v1/policies::validate', async (req) => {
    ctxOf(req);
    const b = body(req, PolicyDraftBodySchema);
    const r = validatePolicyDraft(b.body);
    return { valid: r.ok, issues: r.issues.map((i) => ({ path: i.path, code: i.code })) };
  });

  app.post('/v1/policies', async (req, reply) => {
    const ctx = ctxOf(req);
    idempotencyKey(req);
    spendSensitive(deps, req);
    // Authorize before looking at the draft: a non-admin learns nothing about validation (audited denial).
    const allowed = authorize(ctx, { action: 'policy.publish', siteId: null });
    if (!allowed.allowed) {
      await recordAudit(deps.pool, ctx, {
        action: 'policy.publish',
        resourceType: 'policy',
        resourceId: null,
        result: 'DENIED',
        reasonCode: allowed.reasonCode,
      });
      throw new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
        reasonCode: allowed.reasonCode,
      });
    }
    const b = body(req, PolicyDraftBodySchema);
    const check = validatePolicyDraft(b.body);
    if (!check.ok)
      throw new DomainError('VALIDATION_FAILED', 'The policy draft failed validation.', {
        reasonCode: 'POLICY_DRAFT_INVALID',
        fieldErrors: check.issues
          .slice(0, 100)
          .map((i) => ({ path: i.path.slice(0, 256), issue: i.code.slice(0, 64) })),
      });
    const decoded = z.safeDecode(AuthorityPolicySchema, b.body as never);
    if (!decoded.success)
      throw new DomainError('VALIDATION_FAILED', 'The policy draft failed validation.', {
        reasonCode: 'POLICY_DRAFT_INVALID',
      });
    const r = await publishCompatibilityPolicy(deps.pool, ctx, {
      body: decoded.data as never,
      ...(b.effectiveAt ? { effectiveAt: b.effectiveAt } : {}),
      source: 'API',
    });
    return reply.status(201).send(r);
  });

  app.get('/v1/notifications', async (req) => ({ notifications: await listMyNotifications(deps.pool, ctxOf(req)) }));
}
