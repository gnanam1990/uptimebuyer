// T-010 / T-011 re-run over the M09 tables, commands and broker ingress (INV-16, FR-24, INV-15). Every new table is
// tenant-leading with composite tenant foreign keys; another tenant (human, worker service or a signed reference)
// gets the same RESOURCE_UNAVAILABLE / EXECUTION_REFERENCE_INVALID as a nonexistent id on every read and write path;
// members of another site cannot read or act; and the role matrix holds: approvers approve, operators/approvers issue
// and create intents, approvers suspend/revoke, only a finance approver adjusts budget, viewers only read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adjustExecutionAuthorityBudget,
  approvePlanAction,
  changeExecutionAuthorityStatus,
  createCommercialIntent,
  getCommercialIntent,
  getExecutionAuthority,
  intentRequestFor,
  issueExecutionAuthority,
  issueReference,
} from '@uptimebuyer/commerce';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import { person, workerService } from '../../../packages/incidents/test/helpers.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import {
  createBrokerWorld,
  inProcessBroker,
  issue,
  paidPlanAction,
  readyIntent,
  rejection,
  usd,
  type BrokerWorld,
  type PaidAction,
} from './helpers.js';

const M09_TABLES = [
  'plan_approval_bindings',
  'execution_authorities',
  'execution_authority_events',
  'execution_authority_sessions',
  'budget_accounts',
  'budget_ledger_entries',
  'commercial_intents',
  'commercial_intent_transitions',
  'external_attempts',
  'external_receipts',
  'broker_reference_uses',
];

let w: BrokerWorld;
let foreign: Awaited<ReturnType<typeof seedTenant>>;
let ready: Awaited<ReturnType<typeof readyIntent>>;
let spare: PaidAction;

beforeAll(async () => {
  w = await createBrokerWorld('t010k');
  const broker = inProcessBroker(w, new RecordedContractAdapter());
  ready = await readyIntent(w, broker);
  spare = await paidPlanAction(w);
  foreign = await seedTenant(w.db.pool, w.idp, 't010k-beta');
});
afterAll(async () => w?.close());

describe('T-010/T-011 commercial authority tenant, site and role scope', () => {
  it('every M09 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M09_TABLES) {
      const col = await w.db.pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(col.rows[0]?.is_nullable, table).toBe('NO');
      const keys = await w.db.pool.query(
        `SELECT conname, contype, (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype IN ('f', 'p', 'u')`,
        [table],
      );
      expect(
        keys.rows.some((k) => k.contype === 'p'),
        table,
      ).toBe(true);
      for (const k of keys.rows) expect(k.first, `${table}.${k.conname}`).toBe('tenant_id');
    }
  });

  it('the database refuses an intent, ledger row or attempt that points at another tenant’s authority or intent', async () => {
    const i = (
      await w.db.pool.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        ready.intentId,
      ])
    ).rows[0];
    const ledger = await w.db.pool
      .query(
        `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, intent_id, movement_type, amount_minor, currency,
           provider_account_id, provider_account_revision_id, provider_event_key, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ble_cross-tenant-1', $2, $3, 'RELEASE', 1, 'USD', $4, $5, 'x-tenant', 'X', 'WORKER', 'x')`,
        [foreign.tenantId, i.budget_account_id, i.id, i.provider_account_id, i.provider_account_revision_id],
      )
      .catch((e) => e);
    expect(ledger.code).toBe('23503');
    const auth = await w.db.pool
      .query(
        `INSERT INTO execution_authority_events (tenant_id, id, execution_authority_id, sequence, event_type, prior_status,
           new_status, reason_code, actor_kind, actor_id, effective_at)
         VALUES ($1, 'xae_cross-tenant-1', $2, 9, 'REVOKED', 'ACTIVE', 'REVOKED', 'X', 'WORKER', 'x', now())`,
        [foreign.tenantId, i.execution_authority_id],
      )
      .catch((e) => e);
    expect(auth.code).toBe('23503');
  });

  it('another tenant gets the nonexistent-id denial on every read, write and broker path', async () => {
    const svc = await workerService(w, foreign.admin);
    const xau = ready.auth.authority.executionAuthorityId;
    const probes: [string, () => Promise<unknown>][] = [
      ['authority', () => getExecutionAuthority(w.db.pool, foreign.admin, xau)],
      ['intent', () => getCommercialIntent(w.db.pool, foreign.admin, ready.intentId)],
      [
        'issue',
        () =>
          issueExecutionAuthority(
            w.db.pool,
            svc,
            { approvalId: spare.approvalId, subject: { type: 'PLAN_ACTION', id: spare.candidateActionId } },
            w.authoritySigner,
          ),
      ],
      [
        'revoke',
        () =>
          changeExecutionAuthorityStatus(w.db.pool, foreign.admin, {
            executionAuthorityId: xau,
            to: 'REVOKED',
            reasonCode: 'X',
          }),
      ],
      [
        'adjust',
        () =>
          adjustExecutionAuthorityBudget(w.db.pool, foreign.admin, {
            executionAuthorityId: xau,
            direction: 'CREDIT',
            amount: usd(1n),
            reasonCode: 'X',
          }),
      ],
      [
        'intent-create',
        () =>
          createCommercialIntent(
            w.db.pool,
            svc,
            { ...intentRequestFor(ready.auth, svc, w.key('i')), tenantId: foreign.tenantId as never },
            w.referenceSigner,
          ),
      ],
      ['service-read', () => getExecutionAuthority(w.db.pool, svc, xau)],
    ];
    for (const [name, probe] of probes) {
      const r = await rejection(probe());
      expect([name, r.code, r.reasonCode]).toEqual([name, 'FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
    // A broker reference signed for the other tenant resolves nothing (the tenant comes only from the signature).
    const broker = inProcessBroker(w, new RecordedContractAdapter());
    const foreignRef = issueReference(w.referenceSigner, foreign.tenantId, {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: ready.intentId,
    } as never);
    expect((await rejection(broker.execute(foreignRef))).code).toBe('EXECUTION_REFERENCE_INVALID');
    const audit = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND result = 'DENIED' AND action LIKE 'commerce.%'`,
      [foreign.tenantId],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('members of another site cannot read or act on this site’s authorities and intents', async () => {
    const outsider = await person(
      w,
      'outsider',
      ['viewer', 'operator', 'maintenance_approver', 'finance_approver'],
      w.otherSiteId as never,
    );
    const xau = ready.auth.authority.executionAuthorityId;
    for (const probe of [
      () => getExecutionAuthority(w.db.pool, outsider.ctx, xau),
      () => getCommercialIntent(w.db.pool, outsider.ctx, ready.intentId),
      () =>
        changeExecutionAuthorityStatus(w.db.pool, outsider.ctx, {
          executionAuthorityId: xau,
          to: 'SUSPENDED',
          reasonCode: 'X',
        }),
      () =>
        adjustExecutionAuthorityBudget(w.db.pool, outsider.ctx, {
          executionAuthorityId: xau,
          direction: 'CREDIT',
          amount: usd(1n),
          reasonCode: 'X',
        }),
      () =>
        issueExecutionAuthority(
          w.db.pool,
          outsider.ctx,
          { approvalId: spare.approvalId, subject: { type: 'PLAN_ACTION', id: spare.candidateActionId } },
          w.authoritySigner,
        ),
    ])
      expect((await rejection(probe())).code).toBe('FORBIDDEN');
  });

  it('role matrix over the M09 commands, including the approval amount boundary', async () => {
    const xau = ready.auth.authority.executionAuthorityId;
    for (const who of ['viewer', 'operator', 'approver', 'auditor'])
      expect((await getExecutionAuthority(w.db.pool, w.people[who]!.ctx, xau)).authority.executionAuthorityId).toBe(
        xau,
      );
    // Only a maintenance approver signs the plan-action approval.
    const p = await paidPlanAction(w);
    for (const ctx of [w.viewerCtx, w.operator, w.financeCtx, w.engineer.ctx, w.admin, w.service]) {
      const r = await rejection(
        approvePlanAction(w.db.pool, ctx, {
          approvalRequestId: p.approvalRequestId,
          planHash: p.planHash,
          idempotencyKey: w.key('a'),
        }),
      );
      expect(r.code).toBe('FORBIDDEN');
    }
    // Viewers and auditors cannot issue authority; operators can (it only materializes a signed approval).
    for (const ctx of [w.viewerCtx, w.people.auditor!.ctx])
      expect(
        (
          await rejection(
            issueExecutionAuthority(
              w.db.pool,
              ctx,
              { approvalId: p.approvalId, subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
              w.authoritySigner,
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
    expect((await issue(w, p)).created).toBe(true);
    // Only operators (and the intent engine) create intents; viewers and auditors cannot.
    for (const ctx of [w.viewerCtx, w.people.auditor!.ctx])
      expect(
        (
          await rejection(
            createCommercialIntent(w.db.pool, ctx, intentRequestFor(ready.auth, ctx, w.key('i')), w.referenceSigner),
          )
        ).code,
      ).toBe('FORBIDDEN');
    // Operators and viewers cannot suspend/revoke; only a finance approver adjusts, within the policy amount bound.
    for (const ctx of [w.viewerCtx, w.operator])
      expect(
        (
          await rejection(
            changeExecutionAuthorityStatus(w.db.pool, ctx, {
              executionAuthorityId: xau,
              to: 'SUSPENDED',
              reasonCode: 'X',
            }),
          )
        ).code,
      ).toBe('FORBIDDEN');
    for (const ctx of [w.approver, w.operator, w.admin])
      expect(
        (
          await rejection(
            adjustExecutionAuthorityBudget(w.db.pool, ctx, {
              executionAuthorityId: xau,
              direction: 'CREDIT',
              amount: usd(1n),
              reasonCode: 'X',
            }),
          )
        ).code,
      ).toBe('FORBIDDEN');
    const over = await rejection(
      adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
        executionAuthorityId: xau,
        direction: 'CREDIT',
        amount: usd(500_001n),
        reasonCode: 'X',
      }),
    );
    expect([over.code, over.reasonCode]).toEqual(['FORBIDDEN', 'NO_MATCHING_AUTHORITY_RULE']);
  });
});
