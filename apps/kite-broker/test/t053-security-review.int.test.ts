// M13 security review findings on spend separation of duties (each added red before its fix).
// S6 — the budget-adjustment threshold compared the ORIGINAL approval amount: a small approval issued by a finance
// approver, followed by a large credit that same person approved for themselves, escaped the two-person rule. The
// rule now applies when the adjustment amount OR the effective limit it produces reaches the threshold (>=, as for
// approvals), and the database refuses an AUTHORITY_CREDIT whose signed adjustment approval was recorded by the
// authority's approver or issuer under such a rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@uptimebuyer/contracts';
import { recordApproval, type AuthorityPolicy, type TenantContext } from '@uptimebuyer/data';
import { publishCompatibilityPolicy } from '@uptimebuyer/compatibility';
import { adjustExecutionAuthorityBudget, adjustmentDigest, issueExecutionAuthority } from '@uptimebuyer/commerce';
import { APPROVAL_LIMITS, compatibilityPolicy } from '../../../packages/compatibility/test/helpers.js';
import { person, type Person } from '../../../packages/incidents/test/helpers.js';
import { createBrokerWorld, paidPlanAction, rowOf, type BrokerWorld } from './helpers.js';

let w: BrokerWorld;
let finance2: Person;
const THRESHOLD = 10_000n;

const POLICY: AuthorityPolicy = {
  approvalLimits: [
    ...APPROVAL_LIMITS,
    {
      approvalKind: 'BUDGET_ADJUSTMENT',
      actionClass: 'STANDARD',
      role: 'finance_approver',
      currency: 'USD' as CurrencyCode,
      maxAmountMinor: 500_000n,
      siteIds: null,
    },
  ],
  compatibility: compatibilityPolicy(),
  separationOfDuties: { spend: [{ currency: 'USD' as CurrencyCode, minAmountMinor: THRESHOLD }] },
};

const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'ALLOWED',
    (e: { code?: string; details?: { reasonCode?: string } }) => `${e.code}:${e.details?.reasonCode}`,
  );

/** A below-threshold paid action approved by the maintenance approver and issued by the finance approver. */
async function smallAuthority(price = 5_000n) {
  const p = await paidPlanAction(w, price);
  const issued = await issueExecutionAuthority(
    w.db.pool,
    w.financeCtx,
    { approvalId: p.approvalId, subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
    w.authoritySigner,
  );
  const id = issued.authority.executionAuthorityId;
  const account = (
    await w.db.pool.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`, [
      w.tenant.tenantId,
      id,
    ])
  ).rows[0];
  return { id, account, effective: BigInt(account.effective_limit_minor) };
}
const credit = (ctx: TenantContext, executionAuthorityId: string, amountMinor: bigint) =>
  adjustExecutionAuthorityBudget(w.db.pool, ctx, {
    executionAuthorityId,
    direction: 'CREDIT',
    amount: { amountMinor, currency: 'USD' },
    reasonCode: 'SCOPE_INCREASE',
  });

beforeAll(async () => {
  w = await createBrokerWorld('t053sr');
  finance2 = await person(w, 'finance-two', ['finance_approver'], w.siteId);
  await publishCompatibilityPolicy(w.db.pool, w.admin, { body: POLICY, source: 'API' });
});
afterAll(async () => {
  await w?.close();
});

describe('M13 security review S6: adjustment thresholds use the resulting authority', () => {
  it('a small approval plus a large self-approved credit is refused; another finance approver may grant it', async () => {
    const a = await smallAuthority();
    expect(a.effective).toBeLessThan(THRESHOLD);
    expect(await reason(credit(w.financeCtx, a.id, 20_000n))).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    expect(await reason(credit(finance2.ctx, a.id, 20_000n))).toBe('ALLOWED');
  });

  it('the boundary: a resulting limit exactly at the threshold needs a second person, one minor unit below does not', async () => {
    const a = await smallAuthority();
    const below = THRESHOLD - 1n - a.effective;
    expect(await reason(credit(w.financeCtx, a.id, below))).toBe('ALLOWED');
    const b = await smallAuthority();
    expect(await reason(credit(w.financeCtx, b.id, THRESHOLD - b.effective))).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
    const c = await smallAuthority();
    // The adjustment amount alone reaching the threshold also needs the second person.
    expect(await reason(credit(w.financeCtx, c.id, THRESHOLD))).toBe('FORBIDDEN:SELF_APPROVAL_DENIED');
  });

  it('the database refuses a credit whose adjustment approval the issuer signed under the rule', async () => {
    const a = await smallAuthority();
    const x = await rowOf(w, 'execution_authorities', a.id);
    const amount = { amountMinor: 20_000n, currency: 'USD' as CurrencyCode };
    const approval = await recordApproval(w.db.pool, w.financeCtx, {
      approvalKind: 'BUDGET_ADJUSTMENT',
      incidentId: x.incident_id,
      siteId: x.site_id,
      assetRevisionId: x.asset_revision_id,
      evidenceRevisionId: x.evidence_revision_id,
      policyRevisionId: x.policy_revision_id,
      planHash: null,
      actionDigest: adjustmentDigest(a.id, 'CREDIT', amount as never),
      actionClass: 'STANDARD',
      paid: true,
      providerAccountRevisionId: x.provider_account_revision_id,
      targetExecutionAuthorityId: a.id,
      maxAmount: amount as never,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    } as never);
    const code = await w.db.pool
      .query(
        `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, approval_id, movement_type, amount_minor,
           currency, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ble_' || gen_random_uuid(), $2, $3, 'AUTHORITY_CREDIT', 20000, 'USD', 'SCOPE_INCREASE', 'HUMAN', $4)`,
        [w.tenant.tenantId, a.account.id, approval.approvalId, w.finance.userId],
      )
      .then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    expect(code).toBe('UB130');
  });
});
