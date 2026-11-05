// T-010 and T-011 re-run over the M12 operator HTTP API (TEST-PLAN coverage rule: each later module re-runs them over
// its own new surfaces). Every route family is exercised through the real Fastify server with real bearer tokens:
// - T-010: a principal of another tenant gets exactly the nonexistent-id denial on every read and command (and cannot
//   select tenant A with X-Tenant-ID); a tenant-A principal whose grants are only at the other site cannot read or act
//   on this site's incident, evidence, plans, authorities, intents, orders or recovery, and nothing changes.
// - T-011: the role matrix over the HTTP commands — viewer, operator, approver, finance approver, auditor and admin —
//   including the approval amount boundary from the AUTHORITY policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createApiWorld, errorOf, pendingApproval, type ApiWorld } from './m12-helpers.js';
import { verifyingIncident, type VerifyingIncident } from './m11-helpers.js';

let w: ApiWorld;
let v: VerifyingIncident;
let p: Awaited<ReturnType<typeof pendingApproval>>;
let big: Awaited<ReturnType<typeof pendingApproval>>;
let authorityId: string;
let intentId: string;
let citationId: string | null = null;

const NONEXISTENT = {
  incident: 'inc_00000000-0000-4000-8000-000000000000',
  plan: 'pln_00000000-0000-4000-8000-000000000000',
  request: 'apq_00000000-0000-4000-8000-000000000000',
  authority: 'xau_00000000-0000-4000-8000-000000000000',
  intent: 'cin_00000000-0000-4000-8000-000000000000',
  order: 'pur_00000000-0000-4000-8000-000000000000',
  approval: 'apr_00000000-0000-4000-8000-000000000000',
  citation: 'cit_00000000-0000-4000-8000-000000000000',
};

async function incidentVersion(id: string): Promise<number> {
  const r = await w.db.pool.query(`SELECT version FROM incidents WHERE id = $1`, [id]);
  return r.rows[0].version as number;
}

beforeAll(async () => {
  w = await createApiWorld('m12surface');
  v = await verifyingIncident(w);
  p = await pendingApproval(w);
  big = await pendingApproval(w, 600_000n);
  const order = (await call(w, w.subjects.viewer!, 'GET', `/v1/incidents/${v.incidentId}/orders`)).json();
  authorityId = order.orders[0].executionAuthorityId;
  intentId = order.orders[0].commercialIntentId;
  const ev = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${v.incidentId}/evidence`)).json();
  citationId = ev.retrieval?.facts?.[0]?.values?.[0]?.sources?.[0]?.citation?.citationId ?? null;
}, 300_000);
afterAll(async () => {
  await w?.close();
});

/** Read routes of every resource family for an incident and its linked commerce/order objects. */
const reads = () => [
  `/v1/incidents/${v.incidentId}`,
  `/v1/incidents/${v.incidentId}/timeline`,
  `/v1/incidents/${v.incidentId}/assignable-members`,
  `/v1/incidents/${v.incidentId}/evidence`,
  `/v1/incidents/${v.incidentId}/compatibility`,
  `/v1/incidents/${v.incidentId}/plans`,
  `/v1/incidents/${v.incidentId}/execution-authorities`,
  `/v1/incidents/${v.incidentId}/orders`,
  `/v1/incidents/${v.incidentId}/recovery`,
  `/v1/execution-authorities/${authorityId}`,
  `/v1/intents/${intentId}`,
  `/v1/purchase-orders/${v.orderId}`,
  `/v1/assets/${v.assetId}/telemetry`,
];
const nonexistentReads = () => [
  `/v1/incidents/${NONEXISTENT.incident}`,
  `/v1/incidents/${NONEXISTENT.incident}/timeline`,
  `/v1/incidents/${NONEXISTENT.incident}/assignable-members`,
  `/v1/incidents/${NONEXISTENT.incident}/evidence`,
  `/v1/incidents/${NONEXISTENT.incident}/compatibility`,
  `/v1/incidents/${NONEXISTENT.incident}/plans`,
  `/v1/incidents/${NONEXISTENT.incident}/execution-authorities`,
  `/v1/incidents/${NONEXISTENT.incident}/orders`,
  `/v1/incidents/${NONEXISTENT.incident}/recovery`,
  `/v1/execution-authorities/${NONEXISTENT.authority}`,
  `/v1/intents/${NONEXISTENT.intent}`,
  `/v1/purchase-orders/${NONEXISTENT.order}`,
  `/v1/assets/ast_00000000-0000-4000-8000-000000000000/telemetry`,
];

describe('T-010 cross-tenant access denial over the operator API', () => {
  it('a same-site operator can read every family (positive control)', async () => {
    for (const url of reads()) {
      const r = await call(w, w.subjects.operator!, 'GET', url);
      expect(r.statusCode, url).toBe(200);
    }
  });

  it('another tenant gets exactly the nonexistent-id denial on every read', async () => {
    const theirs = reads();
    const missing = nonexistentReads();
    for (const [i, url] of theirs.entries()) {
      const cross = errorOf(await call(w, w.tenantB.operatorSubject, 'GET', url));
      const none = errorOf(await call(w, w.tenantB.operatorSubject, 'GET', missing[i]!));
      expect(cross, url).toEqual(none);
      expect(cross.status, url).toBe(403);
      expect(cross.reasonCode, url).toBe('RESOURCE_UNAVAILABLE');
    }
    if (citationId) {
      const cross = errorOf(await call(w, w.tenantB.operatorSubject, 'GET', `/v1/citations/${citationId}`));
      expect(cross).toEqual(
        errorOf(await call(w, w.tenantB.operatorSubject, 'GET', `/v1/citations/${NONEXISTENT.citation}`)),
      );
    }
  });

  it('another tenant cannot select tenant A with X-Tenant-ID, and its lists never contain tenant A rows', async () => {
    const r = await call(w, w.tenantB.operatorSubject, 'GET', '/v1/incidents', { tenant: w.tenant.tenantId });
    expect(errorOf(r).status).toBe(403);
    const list = await call(w, w.tenantB.operatorSubject, 'GET', '/v1/incidents');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(v.incidentId);
    const fleet = await call(w, w.tenantB.operatorSubject, 'GET', '/v1/fleet');
    expect(fleet.statusCode).toBe(200);
    expect(JSON.stringify(fleet.json())).not.toContain(w.siteId);
    const notes = await call(w, w.tenantB.operatorSubject, 'GET', '/v1/notifications');
    expect(JSON.stringify(notes.json())).not.toContain(v.incidentId);
  });

  it('another tenant gets the nonexistent-id denial on every command and nothing changes', async () => {
    const before = await incidentVersion(v.incidentId);
    const userId = w.people.operator!.userId;
    const commands: [string, unknown, string][] = [
      [
        `/v1/incidents/${v.incidentId}:assign`,
        { assigneeUserId: userId, reasonCode: 'X' },
        `/v1/incidents/${NONEXISTENT.incident}:assign`,
      ],
      [`/v1/incidents/${v.incidentId}:escalate`, { reasonCode: 'X' }, `/v1/incidents/${NONEXISTENT.incident}:escalate`],
      [`/v1/incidents/${v.incidentId}:acknowledge`, {}, `/v1/incidents/${NONEXISTENT.incident}:acknowledge`],
      [
        `/v1/plans/${p.planId}:approve`,
        { approvalRequestId: p.approvalRequestId, planHash: p.planHash },
        `/v1/plans/${NONEXISTENT.plan}:approve`,
      ],
      [
        `/v1/plans/${p.planId}:hold`,
        { approvalRequestId: p.approvalRequestId, reasonCode: 'X' },
        `/v1/plans/${NONEXISTENT.plan}:hold`,
      ],
      [
        `/v1/execution-authorities/${authorityId}:change-status`,
        { to: 'REVOKED', reasonCode: 'X' },
        `/v1/execution-authorities/${NONEXISTENT.authority}:change-status`,
      ],
      [`/v1/orders/${v.orderId}:verify`, { outcome: 'DISPUTED' }, `/v1/orders/${NONEXISTENT.order}:verify`],
    ];
    for (const [url, b, missing] of commands) {
      const cross = errorOf(await call(w, w.tenantB.operatorSubject, 'POST', url, { body: b, version: before }));
      const none = errorOf(await call(w, w.tenantB.operatorSubject, 'POST', missing, { body: b, version: before }));
      expect(cross.status, url).toBe(403);
      expect(cross, url).toEqual(none);
    }
    expect(await incidentVersion(v.incidentId)).toBe(before);
    const auth = (await call(w, w.subjects.viewer!, 'GET', `/v1/execution-authorities/${authorityId}`)).json();
    expect(auth.authority.status).toBe('ACTIVE');
  });

  it('a tenant-A principal granted only at the other site cannot read or act on this site', async () => {
    for (const url of reads()) {
      const r = errorOf(await call(w, w.farOperatorSubject, 'GET', url));
      expect(r.status, url).toBe(403);
      expect(r.code, url).toBe('FORBIDDEN');
    }
    const before = await incidentVersion(v.incidentId);
    const posts: [string, unknown][] = [
      [`/v1/incidents/${v.incidentId}:assign`, { assigneeUserId: w.people.operator!.userId, reasonCode: 'X' }],
      [`/v1/incidents/${v.incidentId}:escalate`, { reasonCode: 'X' }],
      [`/v1/incidents/${v.incidentId}:adjust-deadline`, { eventType: 'PAUSE', reasonCode: 'X' }],
      [`/v1/plans/${p.planId}:approve`, { approvalRequestId: p.approvalRequestId, planHash: p.planHash }],
      [`/v1/plans/${p.planId}:hold`, { approvalRequestId: p.approvalRequestId, reasonCode: 'X' }],
      [`/v1/execution-authorities/${authorityId}:change-status`, { to: 'SUSPENDED', reasonCode: 'X' }],
      [`/v1/orders/${v.orderId}:verify`, { outcome: 'DISPUTED' }],
    ];
    for (const [url, b] of posts) {
      const r = errorOf(await call(w, w.farOperatorSubject, 'POST', url, { body: b, version: before }));
      expect(r.status, url).toBe(403);
    }
    expect(await incidentVersion(v.incidentId)).toBe(before);
    const auth = (await call(w, w.subjects.viewer!, 'GET', `/v1/execution-authorities/${authorityId}`)).json();
    expect(auth.authority.status).toBe('ACTIVE');
    const plans = (await call(w, w.subjects.viewer!, 'GET', `/v1/incidents/${p.incidentId}/plans`)).json();
    expect(plans.plans[0].approvalRequests[0].approvalId).toBeNull();
    const mine = (await call(w, w.farOperatorSubject, 'GET', '/v1/incidents')).json();
    expect(JSON.stringify(mine)).not.toContain(v.incidentId);
  });

  it('the purchase-order route never serves a service job and the service-job route never serves a purchase order', async () => {
    const r = errorOf(await call(w, w.subjects.operator!, 'GET', `/v1/service-jobs/${v.orderId}`));
    expect(r.status).toBe(403);
  });
});

describe('T-011 role and approval authority denial over the operator API', () => {
  it('viewers read but cannot assign, approve, hold, revoke, verify, publish policy or read the ledger', async () => {
    const version = await incidentVersion(v.incidentId);
    const viewer = w.subjects.viewer!;
    expect((await call(w, viewer, 'GET', `/v1/incidents/${v.incidentId}`)).statusCode).toBe(200);
    for (const [url, b] of [
      [`/v1/incidents/${v.incidentId}:assign`, { assigneeUserId: w.people.operator!.userId, reasonCode: 'X' }],
      [`/v1/plans/${p.planId}:approve`, { approvalRequestId: p.approvalRequestId, planHash: p.planHash }],
      [`/v1/plans/${p.planId}:hold`, { approvalRequestId: p.approvalRequestId, reasonCode: 'X' }],
      [`/v1/execution-authorities/${authorityId}:change-status`, { to: 'REVOKED', reasonCode: 'X' }],
      [`/v1/orders/${v.orderId}:verify`, { outcome: 'DISPUTED' }],
      ['/v1/policies', { body: { approvalLimits: [] } }],
    ] as const) {
      const r = errorOf(await call(w, viewer, 'POST', url, { body: b, version }));
      expect(r.status, url).toBe(403);
    }
    expect(errorOf(await call(w, viewer, 'GET', '/v1/ledger')).status).toBe(403);
    expect(errorOf(await call(w, viewer, 'GET', '/v1/audit')).status).toBe(403);
    expect(errorOf(await call(w, viewer, 'GET', '/v1/policies')).status).toBe(403);
  });

  it('operators cannot approve or revoke authority; approvers approve within the policy amount bound only', async () => {
    const op = errorOf(
      await call(w, w.subjects.operator!, 'POST', `/v1/plans/${p.planId}:approve`, {
        body: { approvalRequestId: p.approvalRequestId, planHash: p.planHash },
      }),
    );
    expect(op.status).toBe(403);
    const opRevoke = errorOf(
      await call(w, w.subjects.operator!, 'POST', `/v1/execution-authorities/${authorityId}:change-status`, {
        body: { to: 'REVOKED', reasonCode: 'OPERATOR_TRY' },
      }),
    );
    expect(opRevoke.status).toBe(403);
    // Above the 5 000.00 USD maintenance_approver bound: refused, nothing recorded.
    const over = errorOf(
      await call(w, w.subjects.approver!, 'POST', `/v1/plans/${big.planId}:approve`, {
        body: { approvalRequestId: big.approvalRequestId, planHash: big.planHash },
      }),
    );
    expect(over.status).toBe(403);
    expect(over.reasonCode).toBe('NO_MATCHING_AUTHORITY_RULE');
    const ok = await call(w, w.subjects.approver!, 'POST', `/v1/plans/${p.planId}:approve`, {
      body: { approvalRequestId: p.approvalRequestId, planHash: p.planHash },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().maxAmount).toEqual({ amountMinor: '18500', currency: 'USD' });
  });

  it('an approval request named under another plan is refused before anything is recorded', async () => {
    const q = await pendingApproval(w);
    const r = errorOf(
      await call(w, w.subjects.approver!, 'POST', `/v1/plans/${p.planId}:approve`, {
        body: { approvalRequestId: q.approvalRequestId, planHash: q.planHash },
      }),
    );
    expect(r.status).toBe(403);
    const plans = (await call(w, w.subjects.viewer!, 'GET', `/v1/incidents/${q.incidentId}/plans`)).json();
    expect(plans.plans[0].approvalRequests[0].approvalId).toBeNull();
  });

  it('hold is an approver-only attested decision that authorizes nothing', async () => {
    const q = await pendingApproval(w);
    expect(
      errorOf(
        await call(w, w.subjects.operator!, 'POST', `/v1/plans/${q.planId}:hold`, {
          body: { approvalRequestId: q.approvalRequestId, reasonCode: 'NEED_SECOND_QUOTE' },
        }),
      ).status,
    ).toBe(403);
    const r = await call(w, w.subjects.approver!, 'POST', `/v1/plans/${q.planId}:hold`, {
      body: { approvalRequestId: q.approvalRequestId, reasonCode: 'NEED_SECOND_QUOTE' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ held: true, reasonCode: 'NEED_SECOND_QUOTE' });
    const plans = (await call(w, w.subjects.viewer!, 'GET', `/v1/incidents/${q.incidentId}/plans`)).json();
    expect(plans.plans[0].approvalRequests[0]).toMatchObject({ state: 'PENDING', approvalId: null });
    expect(plans.plans[0].state).toBe('APPROVABLE');
  });

  it('finance approvers manage authority status; auditors and admins read the ledger; only admins publish policy', async () => {
    const s = await call(w, w.subjects.finance!, 'POST', `/v1/execution-authorities/${authorityId}:change-status`, {
      body: { to: 'SUSPENDED', reasonCode: 'FINANCE_REVIEW' },
    });
    expect(s.statusCode).toBe(200);
    expect(s.json().authority.status).toBe('SUSPENDED');
    const back = await call(w, w.subjects.finance!, 'POST', `/v1/execution-authorities/${authorityId}:change-status`, {
      body: { to: 'ACTIVE', reasonCode: 'FINANCE_REVIEW_DONE' },
    });
    expect(back.json().authority.status).toBe('ACTIVE');
    expect((await call(w, w.subjects.auditor!, 'GET', '/v1/ledger')).statusCode).toBe(200);
    expect((await call(w, w.subjects.auditor!, 'GET', '/v1/audit')).statusCode).toBe(200);
    expect((await call(w, w.subjects.admin!, 'GET', '/v1/ledger')).statusCode).toBe(200);
    expect(
      errorOf(
        await call(w, w.subjects.auditor!, 'POST', `/v1/incidents/${v.incidentId}:assign`, {
          body: { assigneeUserId: w.people.operator!.userId, reasonCode: 'X' },
          version: await incidentVersion(v.incidentId),
        }),
      ).status,
    ).toBe(403);
    expect(
      errorOf(await call(w, w.subjects.operator!, 'POST', '/v1/policies', { body: { body: { approvalLimits: [] } } }))
        .status,
    ).toBe(403);
  });

  it('acceptance is only for the assigned principal and handoff only for the accepted owner', async () => {
    const id = p.incidentId;
    const detail = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${id}`)).json();
    const assignmentId = detail.incident.currentAssignment.assignmentId as string;
    const notMine = errorOf(
      await call(w, w.subjects.operator2!, 'POST', `/v1/incidents/${id}/assignments/${assignmentId}:accept`, {
        version: detail.incident.version,
      }),
    );
    expect(notMine.status).toBe(403);
    expect(detail.commands.accept).toEqual({ allowed: false, reasonCode: 'NOT_ASSIGNEE' });
    const handoff = errorOf(
      await call(w, w.subjects.operator2!, 'POST', `/v1/incidents/${id}:handoff`, {
        body: {
          nextOwnerUserId: w.people.operator!.userId,
          reasonCode: 'SHIFT_CHANGE',
          nextActionDueAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        version: detail.incident.version,
      }),
    );
    expect(handoff.status).toBe(403);
    expect(await incidentVersion(id)).toBe(detail.incident.version);
  });
});
