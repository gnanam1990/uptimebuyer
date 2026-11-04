// Shared fixtures for the M09 tests: the M08 planning world (throwaway database, tenant, site, people, worker service,
// AUTHORITY policy with the compatibility section plus a BUDGET_ADJUSTMENT rule, the paid broker-owned
// `parts-marketplace` revision), runtime-generated synthetic signing keys, a paid plan action carried through M08
// planning -> M09 approval -> execution authority, and an in-process broker over a RECORDED_CONTRACT adapter.
// Nothing here is Kite, a real provider or a real payment; every key is generated at runtime and never persisted.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { money, type TenantId } from '@uptimebuyer/contracts';
import type { TenantContext } from '@uptimebuyer/data';
import { publishCompatibilityPolicy } from '@uptimebuyer/compatibility';
import { createRecoveryPlan, prepareApprovalRequest } from '@uptimebuyer/planning';
import {
  approvePlanAction,
  authorityReference,
  createCommercialIntent,
  exportAuthorityPublicKey,
  importAuthorityPublicKey,
  intentRequestFor,
  issueExecutionAuthority,
  issueReference,
  type AuthoritySigner,
  type ExecutionAuthorityView,
  type ReferenceSigner,
} from '@uptimebuyer/commerce';
import { APPROVAL_LIMITS, compatibilityPolicy } from '../../../packages/compatibility/test/helpers.js';
import { WORK_ORDERS, ingestAs } from '../../../packages/evidence/test/helpers.js';
import { commitIncidentEvidence } from '@uptimebuyer/evidence';
import { createPlanningWorld, scenario, type PlanningWorld } from '../../../packages/planning/test/helpers.js';
import { KiteBroker, type BrokerHooks } from '../src/broker.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import type { PaidAdapter } from '../src/adapters/port.js';

export interface BrokerWorld extends PlanningWorld {
  authoritySigner: AuthoritySigner;
  referenceSigner: ReferenceSigner;
  approver: TenantContext;
  operator: TenantContext;
  financeCtx: TenantContext;
  viewerCtx: TenantContext;
  brokerPool: pg.Pool;
  close(): Promise<void>;
}

export async function createBrokerWorld(label: string, opts: { maxOfferAgeMs?: number } = {}): Promise<BrokerWorld> {
  const w = await createPlanningWorld(label);
  await publishCompatibilityPolicy(w.db.pool, w.admin, {
    body: {
      approvalLimits: [
        ...APPROVAL_LIMITS,
        {
          approvalKind: 'BUDGET_ADJUSTMENT',
          actionClass: 'STANDARD',
          role: 'finance_approver',
          currency: 'USD',
          maxAmountMinor: 500_000n,
          siteIds: null,
        },
      ],
      compatibility: opts.maxOfferAgeMs
        ? compatibilityPolicy({ freshness: { maxOfferAgeMs: opts.maxOfferAgeMs } } as never)
        : compatibilityPolicy(),
    },
    source: 'API',
  });
  const { privateKey } = generateKeyPairSync('ed25519');
  const brokerPool = new pg.Pool({ connectionString: w.db.url, max: 8 });
  brokerPool.on('error', () => {});
  return {
    ...w,
    authoritySigner: { keyId: 'authority-k1', privateKey },
    referenceSigner: { keyId: 'reference-k1', key: new Uint8Array(randomBytes(32)) },
    approver: w.people.approver!.ctx,
    operator: w.people.operator!.ctx,
    financeCtx: w.finance.ctx,
    viewerCtx: w.people.viewer!.ctx,
    brokerPool,
    async close() {
      await brokerPool.end().catch(() => {});
      await w.db.drop();
    },
  };
}

export function inProcessBroker(
  w: BrokerWorld,
  adapter: PaidAdapter = new RecordedContractAdapter(),
  opts: { hooks?: BrokerHooks; sendLeaseMs?: number; reconcileBaseMs?: number } = {},
) {
  return new KiteBroker(w.brokerPool, {
    referenceKeyring: { [w.referenceSigner.keyId]: w.referenceSigner.key },
    authorityKeys: { [w.authoritySigner.keyId]: importAuthorityPublicKey(exportAuthorityPublicKey(w.authoritySigner)) },
    compatibilitySigning: w.signing,
    adapter,
    ...opts,
  });
}

export interface PaidAction {
  assetId: string;
  incidentId: string;
  candidateActionId: string;
  planId: string;
  planHash: string;
  planActionId: string;
  approvalRequestId: string;
  approvalId: string;
}

/** A RANKED paid part purchase carried to a recorded, bound M09 plan-action approval. */
export async function paidPlanAction(
  w: BrokerWorld,
  priceMinor = 18_500n,
  opts: { expiresAt?: string } = {},
): Promise<PaidAction> {
  const s = await scenario(w, [{ label: 'A', priceMinor, etaMinutes: 120 }]);
  const plan = await createRecoveryPlan(
    w.db.pool,
    w.service,
    { incidentId: s.incidentId, candidates: s.refs },
    w.signing,
  );
  const action = plan.actions.find((a) => a.ordinal === 1)!;
  const req = await prepareApprovalRequest(
    w.db.pool,
    w.service,
    {
      planId: plan.planId,
      planHash: plan.planHash,
      planActionId: action.planActionId,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    },
    w.signing,
  );
  const appr = await approvePlanAction(w.db.pool, w.approver, {
    approvalRequestId: req.approvalRequestId,
    planHash: plan.planHash,
    idempotencyKey: w.key('approve'),
  });
  return {
    assetId: s.assetId,
    incidentId: s.incidentId,
    candidateActionId: action.candidateActionId,
    planId: plan.planId,
    planHash: plan.planHash,
    planActionId: action.planActionId,
    approvalRequestId: req.approvalRequestId,
    approvalId: appr.approvalId,
  };
}

export async function freshApproval(w: BrokerWorld, p: PaidAction): Promise<string> {
  return (
    await approvePlanAction(w.db.pool, w.approver, {
      approvalRequestId: p.approvalRequestId,
      planHash: p.planHash,
      idempotencyKey: w.key('approve'),
    })
  ).approvalId;
}

export async function issue(w: BrokerWorld, p: PaidAction, approvalId = p.approvalId) {
  return issueExecutionAuthority(
    w.db.pool,
    w.operator,
    { approvalId, subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
    w.authoritySigner,
  );
}

export const sessionRef = (w: BrokerWorld, authorityId: string) =>
  authorityReference(w.referenceSigner, w.tenant.tenantId, authorityId);
export const intentRef = (w: BrokerWorld, intentId: string) =>
  issueReference(w.referenceSigner, w.tenant.tenantId, {
    kind: 'COMMERCIAL_INTENT',
    commercialIntentId: intentId,
  } as never);

export async function createIntentFor(w: BrokerWorld, view: ExecutionAuthorityView, ctx: TenantContext = w.operator) {
  return createCommercialIntent(w.db.pool, ctx, intentRequestFor(view, ctx, w.key('intent')), w.referenceSigner);
}

/** Issue + confirm the Kite session + create the intent: the state right before execution. */
export async function readyIntent(w: BrokerWorld, broker: KiteBroker, p?: PaidAction) {
  const action = p ?? (await paidPlanAction(w));
  const auth = await issue(w, action);
  await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
  const created = await createIntentFor(w, auth);
  return { action, auth, intentId: created.intent.commercialIntentId as string, created };
}

/** Recompute every projection from the append-only ledger and compare it at account, intent and capture level. */
export async function conservation(w: { db: { pool: pg.Pool }; tenant: { tenantId: TenantId | string } }) {
  const t = w.tenant.tenantId;
  const accounts = await w.db.pool.query(
    `SELECT b.*,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'AUTHORITY_CREDIT'), 0)
         - coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'AUTHORITY_DEBIT'), 0) AS l_adj,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'RESERVE'), 0)
         - coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type IN ('RELEASE', 'CAPTURE')), 0) AS l_open,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'CAPTURE'), 0) AS l_cap,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'REFUND'), 0) AS l_ref,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'REVERSAL'), 0) AS l_rev
     FROM budget_accounts b LEFT JOIN budget_ledger_entries l ON l.tenant_id = b.tenant_id AND l.budget_account_id = b.id
     WHERE b.tenant_id = $1 GROUP BY b.tenant_id, b.id`,
    [t],
  );
  const problems: string[] = [];
  for (const a of accounts.rows) {
    const n = (v: unknown) => BigInt(String(v));
    if (n(a.approved_adjustments_minor) !== n(a.l_adj)) problems.push(`${a.id} adjustments`);
    if (n(a.open_reserved_minor) !== n(a.l_open)) problems.push(`${a.id} open`);
    if (n(a.gross_captured_minor) !== n(a.l_cap)) problems.push(`${a.id} captured`);
    if (n(a.refunded_minor) !== n(a.l_ref) || n(a.reversed_minor) !== n(a.l_rev)) problems.push(`${a.id} returns`);
    // Gross authority: base + adjustments = available + reserved + captured_gross.
    if (
      n(a.base_limit_minor) + n(a.approved_adjustments_minor) !==
      n(a.available_minor) + n(a.open_reserved_minor) + n(a.gross_captured_minor)
    )
      problems.push(`${a.id} gross equation`);
    // Settlement: captured_gross = net + refunded + reversed.
    if (n(a.gross_captured_minor) !== n(a.net_settled_minor) + n(a.refunded_minor) + n(a.reversed_minor))
      problems.push(`${a.id} settlement equation`);
    if (n(a.available_minor) < 0n || n(a.net_settled_minor) < 0n) problems.push(`${a.id} negative`);
  }
  const intents = await w.db.pool.query(
    `SELECT i.*,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'RESERVE'), 0)
         - coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type IN ('RELEASE', 'CAPTURE')), 0) AS l_open,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'CAPTURE'), 0) AS l_cap,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'REFUND'), 0) AS l_ref,
       coalesce(sum(l.amount_minor) FILTER (WHERE l.movement_type = 'REVERSAL'), 0) AS l_rev
     FROM commercial_intents i LEFT JOIN budget_ledger_entries l ON l.tenant_id = i.tenant_id AND l.intent_id = i.id
     WHERE i.tenant_id = $1 GROUP BY i.tenant_id, i.id`,
    [t],
  );
  for (const i of intents.rows) {
    const n = (v: unknown) => BigInt(String(v));
    if (n(i.open_reserved_minor) !== n(i.l_open) || n(i.captured_gross_minor) !== n(i.l_cap))
      problems.push(`${i.id} intent`);
    if (n(i.refunded_minor) !== n(i.l_ref) || n(i.reversed_minor) !== n(i.l_rev))
      problems.push(`${i.id} intent returns`);
    if (n(i.captured_gross_minor) !== n(i.net_settled_minor) + n(i.refunded_minor) + n(i.reversed_minor))
      problems.push(`${i.id} intent settlement`);
    if (n(i.open_reserved_minor) + n(i.captured_gross_minor) > n(i.max_amount_minor))
      problems.push(`${i.id} intent cap`);
  }
  const captures = await w.db.pool.query(
    `SELECT c.id, c.amount_minor, c.returned_against_minor, coalesce(sum(r.amount_minor), 0) AS returned
       FROM budget_ledger_entries c LEFT JOIN budget_ledger_entries r ON r.tenant_id = c.tenant_id AND r.capture_entry_id = c.id
      WHERE c.tenant_id = $1 AND c.movement_type = 'CAPTURE' GROUP BY c.tenant_id, c.id`,
    [t],
  );
  for (const c of captures.rows) {
    const n = (v: unknown) => BigInt(String(v));
    if (n(c.returned) !== n(c.returned_against_minor) || n(c.returned) > n(c.amount_minor))
      problems.push(`${c.id} capture`);
  }
  return { problems, accounts: accounts.rows.length, intents: intents.rows.length, captures: captures.rows.length };
}

export const usd = (n: bigint) => money(n, 'USD');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function rowOf(w: BrokerWorld, table: string, id: string) {
  return (await w.db.pool.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`, [w.tenant.tenantId, id]))
    .rows[0];
}
export async function attemptOf(w: BrokerWorld, intentId: string) {
  return (
    await w.db.pool.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [
      w.tenant.tenantId,
      intentId,
    ])
  ).rows[0];
}
export async function transitionsOf(w: BrokerWorld, intentId: string) {
  return (
    await w.db.pool.query(
      `SELECT from_state, to_state FROM commercial_intent_transitions WHERE tenant_id = $1 AND intent_id = $2 ORDER BY sequence`,
      [w.tenant.tenantId, intentId],
    )
  ).rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`);
}
export async function attemptOutcomeHistory(w: BrokerWorld, intentId: string) {
  // external_attempt.* events record each outcome the attempt passed through.
  return (
    await w.db.pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE tenant_id = $1 AND aggregate_type = 'external_attempt'
         AND payload->>'commercialIntentId' = $2 ORDER BY seq`,
      [w.tenant.tenantId, intentId],
    )
  ).rows.map((r) => `${r.event_type}:${r.payload.externalOutcomeState}`);
}

/** Commit a materially new evidence revision for the incident (a bound-revision change). */
export async function newEvidenceRevision(w: BrokerWorld, p: PaidAction) {
  await ingestAs(w, w.people.operator!, WORK_ORDERS(p.assetId as never));
  const rev = await commitIncidentEvidence(w.db.pool, w.operator, w.store, {
    incidentId: p.incidentId,
    reasonCode: 'WORK_ORDERS',
  });
  if (!rev.changed) throw new Error('evidence revision did not change');
  return rev.evidenceRevisionId;
}

export { rejection } from '../../../packages/incidents/test/helpers.js';
