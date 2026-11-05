// Signed authority adjustments (INV-05; API `POST /v1/execution-authorities/{id}/adjustments`). The only way to
// change an authority's effective limit: a finance approver records a BUDGET_ADJUSTMENT approval targeting the
// authority whose action digest binds the exact direction and amount, and that approval is applied exactly once as
// an AUTHORITY_CREDIT or AUTHORITY_DEBIT ledger movement. A refund never creates this; it never issues a new authority.
import { DomainError, ExecutionAuthorityIdSchema, type Money } from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import {
  Denial,
  loadPolicyRevision,
  notPermitted,
  recordApproval,
  recordAudit,
  requireAuthorized,
  spendSeparationRequired,
  tenantCommand,
  unavailable,
  type AuthorityPolicy,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { requireSpendSeparation } from './authorities.js';
import { emitBudgetMovement } from './events.js';
import { actorFields, hold, invalid, isoNN, mapGuardError, newCommerceId } from './internal.js';
import { toBudget, type BudgetProjection } from './views.js';

const AdjustSchema = z.strictObject({
  executionAuthorityId: ExecutionAuthorityIdSchema,
  direction: z.enum(['CREDIT', 'DEBIT']),
  amount: z.strictObject({ amountMinor: z.bigint(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  /** Optional: apply an already-recorded adjustment approval (retry after a partial failure). */
  approvalId: z
    .string()
    .regex(/^apr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)
    .optional(),
});
export type AdjustBudgetInput = z.input<typeof AdjustSchema>;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The spend-separation scope of a credit: the larger of its amount and the effective limit it produces. */
async function adjustmentScope(c: Tx, tenantId: string, row: any, creditMinor: bigint) {
  const approval = (
    await c.query(`SELECT actor_user_id FROM approvals WHERE tenant_id = $1 AND id = $2`, [tenantId, row.approval_id])
  ).rows[0];
  const account = (
    await c.query(
      `SELECT effective_limit_minor FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`,
      [tenantId, row.id],
    )
  ).rows[0];
  const resulting = BigInt(account?.effective_limit_minor ?? row.base_limit_minor) + creditMinor;
  const amountMinor = resulting > creditMinor ? resulting : creditMinor;
  const involved = [approval?.actor_user_id, row.issued_by_kind === 'HUMAN' ? row.issued_by_id : null].filter(
    (v): v is string => typeof v === 'string',
  );
  const policy = await loadPolicyRevision(c, tenantId as never, row.policy_revision_id);
  const required =
    !!policy &&
    policy.policyKey === 'AUTHORITY' &&
    spendSeparationRequired(policy.body as AuthorityPolicy, { amountMinor, currency: row.currency } as never);
  return {
    approvalId: row.approval_id as string,
    siteId: row.site_id as string,
    policyRevisionId: row.policy_revision_id as string,
    amount: { amountMinor, currency: row.currency as string },
    involved,
    required,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const adjustmentDigest = (executionAuthorityId: string, direction: string, amount: Money) =>
  canonicalDigest('budget-adjustment', 1, {
    executionAuthorityId,
    direction,
    amount: { amountMinor: amount.amountMinor, currency: amount.currency },
  });

export async function adjustExecutionAuthorityBudget(
  pool: Db,
  ctx: TenantContext,
  raw: AdjustBudgetInput,
): Promise<{ approvalId: string; ledgerEntryId: string; budget: BudgetProjection; created: boolean }> {
  const parsed = AdjustSchema.safeParse(raw);
  if (!parsed.success || parsed.data.amount.amountMinor <= 0n) throw invalid('INVALID_BUDGET_ADJUSTMENT');
  const input = parsed.data;
  const meta = {
    action: 'commerce.budget_adjust',
    resourceType: 'execution_authority',
    resourceId: input.executionAuthorityId,
  };
  const digest = adjustmentDigest(input.executionAuthorityId, input.direction, input.amount as Money);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const x: any = await tenantCommand(pool, ctx, meta, async (c) => {
    const row = (
      await c.query(`SELECT * FROM execution_authorities WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        input.executionAuthorityId,
      ])
    ).rows[0];
    if (!row) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'commerce.budget_adjust', siteId: row.site_id }, undefined, {
      type: 'execution_authority',
      id: row.id,
    });
    // M13 separation of duties (security review S6): a credit is judged by what it produces — its own amount and
    // the resulting effective limit — not by the original approval; a debit only reduces authority.
    if (input.direction === 'CREDIT')
      await requireSpendSeparation(
        c,
        ctx,
        meta.action,
        await adjustmentScope(c, ctx.tenantId, row, input.amount.amountMinor),
      );
    if (row.currency !== input.amount.currency) throw hold('ADJUSTMENT_CURRENCY_MISMATCH');
    if (row.status === 'REVOKED' || row.status === 'EXPIRED') throw hold('AUTHORITY_TERMINAL');
    return row;
  });

  const approvalId =
    input.approvalId ??
    (
      await recordApproval(pool, ctx, {
        approvalKind: 'BUDGET_ADJUSTMENT',
        incidentId: x.incident_id,
        siteId: x.site_id,
        assetRevisionId: x.asset_revision_id,
        evidenceRevisionId: x.evidence_revision_id,
        policyRevisionId: x.policy_revision_id,
        planHash: null,
        actionDigest: digest,
        actionClass: 'STANDARD',
        paid: true,
        providerAccountRevisionId: x.provider_account_revision_id,
        targetExecutionAuthorityId: x.id,
        maxAmount: input.amount as Money,
        expiresAt: isoNN(
          new Date(Math.max(Date.now() + 60_000, Math.min(Date.parse(isoNN(x.expires_at)), Date.now() + 3_600_000))),
        ),
      })
    ).approvalId;

  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'commerce.budget_adjust', siteId: x.site_id });
    const a = (await c.query(`SELECT * FROM approvals WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, approvalId]))
      .rows[0];
    if (!a) throw unavailable(meta, approvalId, 'approval');
    if (
      a.approval_kind !== 'BUDGET_ADJUSTMENT' ||
      a.target_execution_authority_id !== x.id ||
      a.action_digest !== digest
    )
      throw new DomainError('DIGEST_MISMATCH', 'The adjustment approval does not sign this movement.', {
        reasonCode: 'ADJUSTMENT_NOT_SIGNED',
      });
    // The signer of a supplied adjustment approval is held to the same rule as the caller.
    if (input.direction === 'CREDIT') {
      const scope = await adjustmentScope(c, ctx.tenantId, x, input.amount.amountMinor);
      if (scope.required && scope.involved.includes(a.actor_user_id))
        throw new Denial(notPermitted('SELF_APPROVAL_DENIED'), {
          action: meta.action,
          resourceType: 'approval',
          resourceId: a.id,
          reasonCode: 'SELF_APPROVAL_DENIED',
        });
    }
    const account = (
      await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`, [
        ctx.tenantId,
        x.id,
      ])
    ).rows[0];
    const prior = (
      await c.query(`SELECT * FROM budget_ledger_entries WHERE tenant_id = $1 AND approval_id = $2`, [
        ctx.tenantId,
        approvalId,
      ])
    ).rows[0];
    if (prior) return { approvalId, ledgerEntryId: prior.id, budget: toBudget(account), created: false };
    const actor = actorFields(ctx);
    let entry: any;
    try {
      entry = (
        await c.query(
          `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, approval_id, movement_type, amount_minor,
             currency, reason_code, actor_kind, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            ctx.tenantId,
            newCommerceId('ledgerEntry'),
            account.id,
            approvalId,
            input.direction === 'CREDIT' ? 'AUTHORITY_CREDIT' : 'AUTHORITY_DEBIT',
            input.amount.amountMinor.toString(),
            input.amount.currency,
            input.reasonCode,
            actor.kind,
            actor.id,
          ],
        )
      ).rows[0];
    } catch (e) {
      mapGuardError(e);
    }
    const after = (
      await c.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, account.id])
    ).rows[0];
    await emitBudgetMovement(c, ctx, entry, after, ctx.correlationId);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
    return { approvalId, ledgerEntryId: entry.id, budget: toBudget(after), created: true };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
