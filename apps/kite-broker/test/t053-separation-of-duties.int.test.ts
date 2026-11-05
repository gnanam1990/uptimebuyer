// T-053 approval tampering / policy bypass — separation of duties (SECURITY.md §4 "High-risk execution may require both
// maintenance and finance authority when policy declares separation of duties"; UI-SPEC §10 "dual approval when
// configured"; INV-15; M06 and M12 residuals). Self-approval is refused wherever two people are required:
// - spend: under a policy SoD rule, the execution authority for an approved paid action is issued only by a different
//   human holding finance_approver (the approver, an operator or a worker cannot), and its budget is adjusted only by a
//   finance approver who neither approved nor issued it; the database refuses an issuer equal to the approver;
// - compatibility authority: the person who registered a candidate cannot record its engineer exception;
// - high-risk policy: when the effective AUTHORITY policy names a policy key for dual approval, a direct publish is
//   refused, the proposer cannot approve their own proposal, a second administrator publishes it, and the database
//   refuses a revision inserted without an approved proposal.
// Every refusal is audited (DENIED) and changes nothing.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@uptimebuyer/contracts';
import {
  approvePolicyProposal,
  getEffectivePolicyRevision,
  proposePolicyRevision,
  publishPolicyRevision,
  type AuthorityPolicy,
} from '@uptimebuyer/data';
import {
  approveCompatibilityPolicyProposal,
  evaluateCandidate,
  publishCompatibilityPolicy,
  recordAuthority,
} from '@uptimebuyer/compatibility';
import { adjustExecutionAuthorityBudget, issueExecutionAuthority } from '@uptimebuyer/commerce';
import {
  APPROVAL_LIMITS,
  compatibilityPolicy,
  exactCandidate,
  incidentWithEvidence,
  merchant,
} from '../../../packages/compatibility/test/helpers.js';
import { person, type Person } from '../../../packages/incidents/test/helpers.js';
import { createBrokerWorld, paidPlanAction, rowOf, type BrokerWorld } from './helpers.js';

let w: BrokerWorld;
let finance2: Person;
let engineer2: Person;
let admin2: Person;

const BUDGET_RULE = {
  approvalKind: 'BUDGET_ADJUSTMENT',
  actionClass: 'STANDARD',
  role: 'finance_approver',
  currency: 'USD',
  maxAmountMinor: 500_000n,
  siteIds: null,
} as const;
const sodPolicy = (extra: Partial<NonNullable<AuthorityPolicy['separationOfDuties']>> = {}): AuthorityPolicy => ({
  approvalLimits: [...APPROVAL_LIMITS, BUDGET_RULE],
  compatibility: compatibilityPolicy(),
  separationOfDuties: { spend: [{ currency: 'USD' as CurrencyCode, minAmountMinor: 10_000n }], ...extra },
});

const deniedReason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ALLOWED';
  } catch (e) {
    const err = e as { code?: string; details?: { reasonCode?: string } };
    return `${err.code}:${err.details?.reasonCode}`;
  }
};
const lastAudit = async (action: string) =>
  (
    await w.db.pool.query(
      `SELECT result, reason_code FROM audit_entries WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [w.tenant.tenantId, action],
    )
  ).rows[0];
const issueAs = (ctx: BrokerWorld['operator'], approvalId: string, candidateActionId: string) =>
  issueExecutionAuthority(
    w.db.pool,
    ctx,
    { approvalId, subject: { type: 'PLAN_ACTION', id: candidateActionId } },
    w.authoritySigner,
  );

beforeAll(async () => {
  w = await createBrokerWorld('t053sod');
  finance2 = await person(w, 'finance-two', ['finance_approver'], w.siteId);
  engineer2 = await person(w, 'engineer-two', ['engineer'], w.siteId);
  admin2 = await person(w, 'admin-two', ['admin'], null);
  // The spend rule is published before any incident exists, so every approval below pins it (INV-03).
  await publishCompatibilityPolicy(w.db.pool, w.admin, { body: sodPolicy(), source: 'API' });
});
afterAll(async () => {
  await w?.close();
});

describe('T-053 separation of duties: spend', () => {
  it('refuses the approver, an operator and a worker as issuer; a different finance approver issues', async () => {
    const p = await paidPlanAction(w, 18_500n);
    const approval = await rowOf(w, 'approvals', p.approvalId);
    expect(approval.actor_user_id).toBe(w.people.approver!.userId);
    expect(await deniedReason(issueAs(w.approver, p.approvalId, p.candidateActionId))).toBe(
      'FORBIDDEN:SELF_APPROVAL_DENIED',
    );
    expect(await lastAudit('commerce.authority_issue')).toMatchObject({
      result: 'DENIED',
      reason_code: 'SELF_APPROVAL_DENIED',
    });
    expect(await deniedReason(issueAs(w.operator, p.approvalId, p.candidateActionId))).toBe(
      'FORBIDDEN:SEPARATION_OF_DUTIES_ROLE_REQUIRED',
    );
    expect(await deniedReason(issueAs(w.service, p.approvalId, p.candidateActionId))).toBe(
      'FORBIDDEN:SEPARATION_OF_DUTIES_ROLE_REQUIRED',
    );
    const none = await w.db.pool.query(
      `SELECT 1 FROM execution_authorities WHERE tenant_id = $1 AND approval_id = $2`,
      [w.tenant.tenantId, p.approvalId],
    );
    expect(none.rowCount).toBe(0);
    const ok = await issueAs(w.financeCtx, p.approvalId, p.candidateActionId);
    const row = await rowOf(w, 'execution_authorities', ok.authority.executionAuthorityId);
    expect(row).toMatchObject({ issued_by_kind: 'HUMAN', issued_by_id: w.finance.userId });
  });

  it('does not require a second person below the policy threshold', async () => {
    const p = await paidPlanAction(w, 5_000n);
    const ok = await issueAs(w.operator, p.approvalId, p.candidateActionId);
    expect(ok.created).toBe(true);
  });

  it('the database refuses an authority whose issuer is its approver under a SoD rule', async () => {
    const p = await paidPlanAction(w, 18_500n);
    const issued = await issueAs(w.financeCtx, p.approvalId, p.candidateActionId);
    // A copy of the valid row (every other guard passes) whose issuer is the approval's own actor, as a service-layer
    // bypass would write it. The BEFORE INSERT SoD guard refuses it before any uniqueness check.
    const insertCopy = (issuedBy: string, kind = 'HUMAN') =>
      w.db.pool
        .query(
          `INSERT INTO execution_authorities
             SELECT (r).* FROM (
               SELECT jsonb_populate_record(a, jsonb_build_object(
                 'id', 'xau_' || gen_random_uuid(), 'issued_by_id', $3::text, 'issued_by_kind', $4::text)) AS r
                 FROM execution_authorities a WHERE a.tenant_id = $1 AND a.id = $2) s`,
          [w.tenant.tenantId, issued.authority.executionAuthorityId, issuedBy, kind],
        )
        .then(
          () => null,
          (e: { code?: string }) => e,
        );
    expect((await insertCopy(w.people.approver!.userId))?.code).toBe('UB130');
    expect((await insertCopy('svc_worker-0001', 'SERVICE'))?.code).toBe('UB130');
    // Control: the same copy with a different human issuer passes the SoD guard and stops at the one-per-approval key.
    expect((await insertCopy(finance2.userId))?.code).toBe('23505');
  });

  it('a budget adjustment is refused for the issuer and allowed for an uninvolved finance approver', async () => {
    const p = await paidPlanAction(w, 18_500n);
    const issued = await issueAs(w.financeCtx, p.approvalId, p.candidateActionId);
    const adjust = (ctx: BrokerWorld['operator']) =>
      adjustExecutionAuthorityBudget(w.db.pool, ctx, {
        executionAuthorityId: issued.authority.executionAuthorityId,
        direction: 'CREDIT',
        amount: { amountMinor: 1_000n, currency: 'USD' },
        reasonCode: 'SHIPPING_SURCHARGE',
      });
    expect(await deniedReason(adjust(w.financeCtx))).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    const ok = await adjust(finance2.ctx);
    expect(ok.created).toBe(true);
  });
});

describe('T-053 separation of duties: compatibility authority', () => {
  it('the registrant of a candidate cannot record its engineer exception; another named engineer can', async () => {
    const inc = await incidentWithEvidence(w, { warrantyExpiresOn: '2025-01-31' });
    const cand = await exactCandidate(w, inc, { partNumber: '5A1-0398', merchantId: merchant() as never }, w.engineer);
    const held = await evaluateCandidate(
      w.db.pool,
      w.service,
      { candidateActionId: cand.candidateActionId },
      w.signing,
    );
    expect(held.decision).toBe('HOLD');
    const exception = (who: Person) =>
      recordAuthority(
        w.db.pool,
        who.ctx,
        {
          compatibilityDecisionId: held.compatibilityDecisionId,
          kind: 'ENGINEER_EXCEPTION',
          reasonCode: 'OEM_PART_BACKORDERED',
          reasonText: 'Superseded OEM motor with identical mounting and rating; checked on site by a second engineer.',
          expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        } as never,
        w.signing,
      );
    expect(await deniedReason(exception(w.engineer))).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    const ok = await exception(engineer2);
    expect(ok.authorityRecordId).toMatch(/^cau_/);
  });
});

describe('T-053 separation of duties: high-risk policy dual approval', () => {
  it('direct publication works until dual approval is configured, then requires a second administrator', async () => {
    // Configure dual approval for AUTHORITY and RETENTION (the last single-admin AUTHORITY change).
    await publishCompatibilityPolicy(w.db.pool, w.admin, {
      body: sodPolicy({ dualApprovalPolicyKeys: ['AUTHORITY', 'RETENTION'] }),
      source: 'API',
    });
    const retention = { telemetryDays: 30, communicationDays: 30, auditDays: 365 };
    expect(
      await deniedReason(
        publishPolicyRevision(w.db.pool, w.admin, { policyKey: 'RETENTION', body: retention, source: 'API' }),
      ),
    ).toBe('POLICY_HOLD:DUAL_APPROVAL_REQUIRED');
    expect(
      await deniedReason(publishCompatibilityPolicy(w.db.pool, w.admin, { body: sodPolicy(), source: 'API' })),
    ).toBe('POLICY_HOLD:DUAL_APPROVAL_REQUIRED');
    const proposal = await proposePolicyRevision(w.db.pool, w.admin, {
      policyKey: 'RETENTION',
      body: retention,
      source: 'API',
    });
    expect(
      await deniedReason(
        approvePolicyProposal(w.db.pool, w.admin, { policyChangeProposalId: proposal.policyChangeProposalId }),
      ),
    ).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    expect(
      await deniedReason(
        approvePolicyProposal(w.db.pool, w.approver, { policyChangeProposalId: proposal.policyChangeProposalId }),
      ),
    ).toMatch(/^FORBIDDEN:/);
    const pub = await approvePolicyProposal(w.db.pool, admin2.ctx, {
      policyChangeProposalId: proposal.policyChangeProposalId,
    });
    const eff = await getEffectivePolicyRevision(w.db.pool, w.admin, 'RETENTION');
    expect(eff.policyRevisionId).toBe(pub.policyRevisionId);
    const row = await rowOf(w, 'policy_revisions', pub.policyRevisionId);
    expect(row).toMatchObject({ published_by_user_id: w.tenant.adminUserId, approved_by_user_id: admin2.userId });
    // A decided proposal cannot be approved again.
    expect(
      await deniedReason(
        approvePolicyProposal(w.db.pool, admin2.ctx, { policyChangeProposalId: proposal.policyChangeProposalId }),
      ),
    ).toBe('POLICY_HOLD:PROPOSAL_ALREADY_DECIDED');
  });

  it('an AUTHORITY change (which could switch dual approval off) also needs the second administrator', async () => {
    const proposal = await proposePolicyRevision(w.db.pool, admin2.ctx, {
      policyKey: 'AUTHORITY',
      body: sodPolicy({ dualApprovalPolicyKeys: [] }),
      source: 'API',
    });
    expect(
      await deniedReason(approveCompatibilityPolicyProposal(w.db.pool, admin2.ctx, proposal.policyChangeProposalId)),
    ).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    const pub = await approveCompatibilityPolicyProposal(w.db.pool, w.admin, proposal.policyChangeProposalId);
    expect(pub.policyRevisionId).toMatch(/^pol_/);
  });

  it('the database refuses a revision of a dual-approval key inserted without an approved proposal', async () => {
    // Re-enable dual approval through the proper two-person path.
    const p = await proposePolicyRevision(w.db.pool, w.admin, {
      policyKey: 'AUTHORITY',
      body: sodPolicy({ dualApprovalPolicyKeys: ['RETENTION'] }),
      source: 'API',
    });
    await approveCompatibilityPolicyProposal(w.db.pool, admin2.ctx, p.policyChangeProposalId);
    const pol = (
      await w.db.pool.query(`SELECT id FROM policies WHERE tenant_id = $1 AND policy_key = 'RETENTION'`, [
        w.tenant.tenantId,
      ])
    ).rows[0].id;
    const err = await w.db.pool
      .query(
        `INSERT INTO policy_revisions (tenant_id, id, policy_id, revision, schema_name, body, body_digest, effective_at,
           published_by_user_id, source)
         VALUES ($1, 'pol_' || $2, $3, 99, 'policy.retention.v1', '{"telemetryDays":1,"communicationDays":1,"auditDays":1}',
           'policy.v1:sha256:' || repeat('a', 64), clock_timestamp(), $4, 'API')`,
        [w.tenant.tenantId, randomBytes(8).toString('hex'), pol, w.tenant.adminUserId],
      )
      .then(
        () => null,
        (e: { code?: string }) => e,
      );
    expect(err?.code).toBe('UB131');
  });
});
