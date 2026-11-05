// Shared fixtures for the M10 order/job integration tests. They live beside the M09 broker tests because the real
// in-process KiteBroker (RECORDED_CONTRACT adapter) is importable only inside apps/kite-broker (INV-06 lint boundary);
// @uptimebuyer/orders itself only ever talks to the broker through the CommercialIntentBrokerPort shape.
// On top of the M09 broker world: a paid broker-owned `orders-marketplace` account whose revision carries an endpoint
// policy digest and a webhook verifier (runtime-generated key, never persisted) and whose opaque webhook binding is
// kept for the tests, plan actions of either kind (part purchase -> purchase order, service job -> service job), the
// incident moved to AWAITING_APPROVAL, and an issued authority with a CONFIRMED Kite session. Nothing here is a real
// merchant, technician, payment or webhook.
import { randomBytes } from 'node:crypto';
import { advanceIncident, getIncident } from '@uptimebuyer/incidents';
import { createProviderAccount, type TenantContext } from '@uptimebuyer/data';
import { approvePlanAction } from '@uptimebuyer/commerce';
import { createRecoveryPlan, prepareApprovalRequest } from '@uptimebuyer/planning';
import { endpointPolicyDigest, type EndpointPolicy } from '@uptimebuyer/providers';
import { getOrder, requestOrder, signFulfillmentWebhook, type OrderView } from '@uptimebuyer/orders';
import { scenario } from '../../../packages/planning/test/helpers.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import type { KiteBroker } from '../src/broker.js';
import { createBrokerWorld, inProcessBroker, issue, sessionRef, type BrokerWorld, type PaidAction } from './helpers.js';

export const MERCHANT_POLICY: EndpointPolicy = {
  schema: 'provider-endpoint-policy.v1',
  origins: ['https://orders.coldline-merchant.example'],
};

export interface FulfillmentAccount {
  providerAccountId: string;
  revisionId: string;
  binding: string;
  verifierRef: string;
  verifierKey: Uint8Array;
}

export interface OrdersWorld extends BrokerWorld {
  account: FulfillmentAccount;
  adapter: RecordedContractAdapter;
  broker: KiteBroker;
}

export async function paidFulfillmentAccount(
  w: BrokerWorld,
  admin: TenantContext,
  label: string,
): Promise<FulfillmentAccount> {
  const verifierRef = `secretref:webhook/tenants/${admin.tenantId}/${label}-orders-verifier`;
  const created = await createProviderAccount(w.db.pool, admin, {
    providerKey: `${label}-orders`.slice(0, 60).toLowerCase(),
    environment: 'SANDBOX',
    revision: {
      capabilities: ['PURCHASE', 'SERVICE_BOOKING', 'WEBHOOK'],
      paid: true,
      ownerService: 'KITE_BROKER_PAID',
      credentialRef: `secretref:provider/tenants/${admin.tenantId}/${label}-orders-paid`,
      endpointPolicyDigest: endpointPolicyDigest(MERCHANT_POLICY),
      webhookVerifierRef: verifierRef,
    },
    source: 'API',
  });
  const verifierKey = new Uint8Array(randomBytes(32));
  w.creds.set(verifierRef, verifierKey);
  return {
    providerAccountId: created.providerAccountId,
    revisionId: created.providerAccountRevisionId,
    binding: created.webhookBinding,
    verifierRef,
    verifierKey,
  };
}

export async function createOrdersWorld(label: string, adapter = new RecordedContractAdapter()): Promise<OrdersWorld> {
  const w = await createBrokerWorld(label);
  const account = await paidFulfillmentAccount(w, w.admin, label);
  // Candidates registered from now on pin the fulfillment account's revision.
  (w as { providerAccountRevisionId: string }).providerAccountRevisionId = account.revisionId;
  return Object.assign(w, { account, adapter, broker: inProcessBroker(w, adapter) });
}

export type PlanKind = 'PART_PURCHASE' | 'SERVICE_JOB';

/** A RANKED paid plan action of the given kind carried to a recorded, bound M09 approval. */
export async function paidActionOf(
  w: BrokerWorld,
  kind: PlanKind,
  priceMinor = 18_500n,
  opts: { etaMinutes?: number } = {},
): Promise<PaidAction> {
  const s = await scenario(w, [{ label: 'A', priceMinor, etaMinutes: opts.etaMinutes ?? 120, kind }]);
  await toAwaitingApproval(w, s.incidentId);
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
    { planId: plan.planId, planHash: plan.planHash, planActionId: action.planActionId },
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

/** TRIAGING -> PLANNING -> AWAITING_APPROVAL through M04's engine path (the M05/M08 guards are satisfied upstream). */
export async function toAwaitingApproval(w: BrokerWorld, incidentId: string): Promise<void> {
  for (const to of ['PLANNING', 'AWAITING_APPROVAL'] as const) {
    const cur = await getIncident(w.db.pool, w.viewerCtx, incidentId);
    if (cur.state === to || (to === 'PLANNING' && cur.state === 'AWAITING_APPROVAL')) continue;
    await advanceIncident(w.db.pool, w.service, incidentId, {
      expectedVersion: cur.version,
      idempotencyKey: w.key('advance'),
      to,
      reasonCode: to === 'PLANNING' ? 'EVIDENCE_SUFFICIENT' : 'ALLOWABLE_ACTION_PRICED',
      guardRef: incidentId,
    });
  }
}

export async function incidentState(w: BrokerWorld, incidentId: string): Promise<string> {
  return (await getIncident(w.db.pool, w.viewerCtx, incidentId)).state;
}

/** Issue the authority, confirm its Kite session and request the order/job (nothing is sent yet). */
export async function orderFor(w: OrdersWorld, kind: PlanKind, p?: PaidAction, approvalId?: string) {
  const action = p ?? (await paidActionOf(w, kind));
  const auth = await issue(w, action, approvalId ?? action.approvalId);
  await w.broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
  const out = await requestOrder(
    w.db.pool,
    w.operator,
    { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: w.key('order') },
    w.referenceSigner,
  );
  return { action, auth, orderId: out.order.orderId, out };
}

export const brokerDeps = (w: OrdersWorld, broker: KiteBroker = w.broker) => ({
  broker: { execute: (r: unknown) => broker.execute(r), reconcile: (r: unknown) => broker.reconcile(r) },
  referenceSigner: w.referenceSigner,
});

export async function view(w: BrokerWorld, orderId: string): Promise<OrderView> {
  return getOrder(w.db.pool, w.viewerCtx, orderId);
}

let tick = 0;
/** A signed fulfillment webhook for the given account key (timestamp now unless overridden). */
export function webhook(
  binding: string,
  key: Uint8Array,
  body: Record<string, unknown>,
  opts: { ts?: number; raw?: Uint8Array } = {},
) {
  const rawBody = opts.raw ?? new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8'));
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return { binding, signature: signFulfillmentWebhook(key, ts, rawBody), rawBody };
}

export function eventBody(
  order: OrderView,
  status: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  tick += 1;
  return {
    eventId: `evt-${randomBytes(6).toString('hex')}`,
    type: order.orderKind === 'PURCHASE_ORDER' ? 'purchase_order.status' : 'service_job.status',
    clientOperationId: order.clientOperationId,
    status,
    observedAt: new Date(Date.now() + tick).toISOString(),
    ...over,
  };
}
