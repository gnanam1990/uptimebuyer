// T-039 — Credential and paid-egress isolation (ownership and the real broker port). Immutable provider-account-revision
// ownership pins paid work to the broker: a superseding or owner-changing revision cannot keep a stale execution
// authority alive, explicitly unpaid M07 revisions can never carry paid authority, and M07's paid contact hand-off —
// verified until now only against the M01 CONTRACT FAKE (T-029) — runs against the real M09 broker port over its unix
// socket: the authority must be bound to the approval, results are KITE_BROKER-origin and mirror into M07. Provider
// effects come from the RECORDED_CONTRACT adapter (not Kite, not StablePhone).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@uptimebuyer/contracts';
import { appendProviderAccountRevision, recordApproval } from '@uptimebuyer/data';
import {
  KiteBrokerPort,
  authorityReference,
  exportAuthorityPublicKey,
  importAuthorityPublicKey,
  issueExecutionAuthority,
} from '@uptimebuyer/commerce';
import {
  executeContactRequest,
  getContactRequest,
  handleBrokerResultEvent,
  prepareContactRequest,
} from '@uptimebuyer/providers';
import { KiteBroker } from '../src/broker.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { BrokerLog } from '../src/log.js';
import { brokerRequestHandler, listenOnUnixSocket } from '../src/server.js';
import {
  createBrokerWorld,
  createIntentFor,
  inProcessBroker,
  intentRef,
  issue,
  paidPlanAction,
  rejection,
  rowOf,
  sessionRef,
  type BrokerWorld,
} from './helpers.js';
import {
  approvePaidContact,
  createProviderWorld,
  discover,
  outboxEvents,
  pointOf,
  type ProviderWorld,
} from '../../../packages/providers/test/helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t039o');
});
afterAll(async () => w?.close());

async function partsAccountId(): Promise<string> {
  return (await rowOf(w, 'provider_account_revisions', w.providerAccountRevisionId)).provider_account_id;
}

describe('T-039 credential and paid-egress isolation (revision ownership and the real broker port)', () => {
  it('an owner- or revision-changing provider account revision cannot keep a stale execution authority', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    // Authority + intent issued under the current broker-owned paid revision.
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    const p2 = await paidPlanAction(w);
    const auth2 = await issue(w, p2);
    await broker.activateSession(sessionRef(w, auth2.authority.executionAuthorityId));
    const intent2 = await createIntentFor(w, auth2);
    // The owner moves the paid capability to an M07-owned unpaid revision.
    await appendProviderAccountRevision(w.db.pool, w.admin, (await partsAccountId()) as never, {
      revision: {
        capabilities: ['PURCHASE', 'QUOTE'],
        paid: false,
        ownerService: 'M07_UNPAID',
        credentialRef: `secretref:provider/tenants/${w.tenant.tenantId}/parts-unpaid-${randomBytes(3).toString('hex')}`,
        endpointPolicyDigest: `sha256:${'d'.repeat(64)}`,
        webhookVerifierRef: null,
      },
      source: 'API',
    });
    // The stale authority can no longer activate a session...
    const act = await rejection(broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId)));
    expect(act.reasonCode).toMatch(/^(APPROVAL_NOT_EXECUTABLE|PROVIDER_ACCOUNT_REVISION_NOT_CURRENT)$/);
    // ...and an intent created before the change fails definite-no-effect at linearization, nothing sent.
    const out = await broker.execute(intentRef(w, intent2.intent.commercialIntentId));
    expect(out.intent.state).toBe('FAILED');
    expect(out.events[0]!.payload.reasonCode).toMatch(
      /^(APPROVAL_NOT_EXECUTABLE|PROVIDER_ACCOUNT_REVISION_NOT_CURRENT)$/,
    );
    expect(adapter.executeCalls).toBe(0);
    const current = (
      await w.db.pool.query(`SELECT current_revision_id FROM provider_accounts WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        await partsAccountId(),
      ])
    ).rows[0].current_revision_id;

    // Explicitly unpaid M07 revisions stay separate: no paid approval, authority, attempt or ledger row can pin one.
    const unpaid = await rejection(
      recordApproval(w.db.pool, w.approver, {
        approvalKind: 'PLAN_ACTION',
        incidentId: p.incidentId,
        siteId: w.siteId,
        assetRevisionId: auth.authority.assetRevisionId,
        evidenceRevisionId: auth.authority.evidenceRevisionId,
        policyRevisionId: auth.authority.policyRevisionId,
        planHash: auth.authority.planHash,
        actionDigest: auth.authority.actionDigest,
        actionClass: 'STANDARD',
        paid: true,
        providerAccountRevisionId: current,
        targetExecutionAuthorityId: null,
        maxAmount: money(18_500n, 'USD'),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
    expect(unpaid.reasonCode).toBe('PROVIDER_ACCOUNT_PAID_MISMATCH');
    await expect(
      w.db.pool.query(
        `UPDATE execution_authorities SET provider_account_revision_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, auth.authority.executionAuthorityId, current],
      ),
    ).rejects.toMatchObject({ code: 'UB001' });
  });

  describe('M07 paid contact through the real broker port (replaces the contract fake)', () => {
    let pw: ProviderWorld;
    let server: http.Server;
    let socketPath: string;
    let adapter: RecordedContractAdapter;
    let brokerPool: pg.Pool;
    const signer = { keyId: 'authority-k1', privateKey: generateKeyPairSync('ed25519').privateKey };
    const referenceSigner = { keyId: 'reference-k1', key: new Uint8Array(randomBytes(32)) };

    beforeAll(async () => {
      pw = await createProviderWorld('t039m7');
      adapter = new RecordedContractAdapter();
      brokerPool = new pg.Pool({ connectionString: pw.db.url, max: 6 });
      brokerPool.on('error', () => {});
      const broker = new KiteBroker(brokerPool, {
        referenceKeyring: { [referenceSigner.keyId]: referenceSigner.key },
        authorityKeys: { [signer.keyId]: importAuthorityPublicKey(exportAuthorityPublicKey(signer)) },
        compatibilitySigning: { keyId: 'unused', keyring: { unused: new Uint8Array(randomBytes(32)) } },
        adapter,
      });
      server = http.createServer(brokerRequestHandler(broker, new BrokerLog(() => {})));
      socketPath = join(mkdtempSync(join(tmpdir(), 'm09-m07-')), 'broker.sock');
      await listenOnUnixSocket(server, socketPath);
    });
    afterAll(async () => {
      await new Promise((r) => server?.close(r));
      await brokerPool?.end();
      await pw?.db.drop();
    });

    it('creates one bound intent, executes once, mirrors KITE_BROKER results into M07 and refuses an unbound authority', async () => {
      const { byRef } = await discover(pw);
      const sp = byRef['cl-001']!;
      const port = new KiteBrokerPort(pw.db.pool, { socketPath, referenceSigner, contextFor: () => pw.operator.ctx });
      const prepare = (purposeCode: 'QUOTE' | 'AVAILABILITY', maxMinor: bigint) =>
        prepareContactRequest(pw.db.pool, pw.operator.ctx, {
          incidentId: pw.incident.incidentId,
          serviceProviderId: sp,
          contactPointId: pointOf(sp, 'PHONE'),
          providerAccountId: pw.paid.providerAccountId,
          channel: 'PHONE',
          purposeCode,
          paid: { merchantId: 'mer_stablephone-0001', maxCost: money(maxMinor, 'USD') },
          idempotencyKey: pw.key('prep'),
        });
      const prepared = await prepare('QUOTE', 400n);
      const approval = await approvePaidContact(pw, prepared);
      const auth = await issueExecutionAuthority(
        pw.db.pool,
        pw.operator.ctx,
        {
          approvalId: approval.approvalId,
          subject: { type: 'PROVIDER_CONTACT_REQUEST', id: prepared.contactRequestId },
        },
        signer,
      );
      expect(auth.authority.allowedActionKinds).toEqual(['PAID_CONTACT']);
      expect(auth.authority.perActionLimit).toEqual({ amountMinor: 400n, currency: 'USD' });
      const session = await port.activateSession(
        authorityReference(referenceSigner, pw.tenant.tenantId, auth.authority.executionAuthorityId),
      );
      expect(session.externalOutcomeState).toBe('CONFIRMED');

      const authority = { approvalId: approval.approvalId, executionAuthorityId: auth.authority.executionAuthorityId };
      const r = await executeContactRequest(
        pw.db.pool,
        pw.operator.ctx,
        prepared.contactRequestId,
        { idempotencyKey: pw.key('e'), authority },
        { broker: port },
      );
      expect(r.route).toBe('KITE_BROKER');
      expect(adapter.executeCalls).toBe(1);
      // A retried command never re-sends a started intent.
      await executeContactRequest(
        pw.db.pool,
        pw.operator.ctx,
        prepared.contactRequestId,
        { idempotencyKey: pw.key('e'), authority },
        { broker: port },
      );
      expect(adapter.executeCalls).toBe(1);
      const intents = await pw.db.pool.query(
        `SELECT * FROM commercial_intents WHERE tenant_id = $1 AND subject_id = $2`,
        [pw.tenant.tenantId, prepared.contactRequestId],
      );
      expect(intents.rows).toHaveLength(1);
      expect(intents.rows[0].state).toBe('CONFIRMED');
      // Outbox delivery of the broker's own events into M07's consumer: processed once, never quarantined.
      for (const e of await outboxEvents(pw, 'commercial_intent.state_changed.v1', intents.rows[0].id)) {
        expect((e.payload as { resultOrigin: string }).resultOrigin).toBe('KITE_BROKER');
        expect(await handleBrokerResultEvent(pw.db.pool, e as never)).toBe('PROCESSED');
        expect(await handleBrokerResultEvent(pw.db.pool, e as never)).toBe('DUPLICATE');
      }
      const view = await getContactRequest(pw.db.pool, pw.operator.ctx, prepared.contactRequestId);
      expect(view.attempts[0]).toMatchObject({ economicState: 'CONFIRMED', resultOrigin: 'KITE_BROKER' });
      const quarantined = await pw.db.pool.query(
        `SELECT count(*)::int AS n FROM provider_broker_event_receipts WHERE tenant_id = $1 AND disposition = 'QUARANTINED'`,
        [pw.tenant.tenantId],
      );
      expect(quarantined.rows[0].n).toBe(0);

      // An authority that belongs to a different approval is refused by the broker port (M07 contract).
      const other = await prepare('AVAILABILITY', 500n);
      const otherApproval = await approvePaidContact(pw, other);
      const bad = await executeContactRequest(
        pw.db.pool,
        pw.operator.ctx,
        other.contactRequestId,
        {
          idempotencyKey: pw.key('e'),
          authority: {
            approvalId: otherApproval.approvalId,
            executionAuthorityId: auth.authority.executionAuthorityId,
          },
        },
        { broker: port },
      ).catch((e: { details?: { reasonCode?: string } }) => e);
      expect((bad as { details?: { reasonCode?: string } }).details?.reasonCode).toBe(
        'AUTHORITY_NOT_BOUND_TO_APPROVAL',
      );
      expect(adapter.executeCalls).toBe(1);
    });
  });
});
