// FR-20 — Actionable notifications, delivery side (M07): channel, role routing, deduplication and deep-link context
// with a local delivery adapter. Triggers come from the emitting modules' outbox events (M04 incident events here,
// M07's own provider changes, and the broker-port spend exception that M09 will emit); M12's T-051 owns the
// end-to-end check. Delivery is never acknowledgement.
import { money } from '@uptimebuyer/contracts';
import { seedTenant } from '../../data/test/helpers.js';
import { assignIncident, getIncident, escalateIncident } from '@uptimebuyer/incidents';
import { createSite, withTenantTransaction } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalNotificationInbox,
  NOTIFICATION_CONSUMER,
  dispatchNotifications,
  enqueueNotificationTrigger,
  handleNotificationEvent,
  listMyNotifications,
  prepareContactRequest,
  executeContactRequest,
  runContactDispatch,
} from '../src/index.js';
import {
  CountingBroker,
  approvePaidContact,
  brokerAttempt,
  brokerEvent,
  count,
  createProviderWorld,
  discover,
  outboxEvents,
  person,
  publishBrokerEvents,
  rejection,
  type Person,
  type ProviderWorld,
} from './helpers.js';

let w: ProviderWorld;
let finance: Person;
let farOperator: Person;
const inbox = new LocalNotificationInbox();

async function consumeAll(eventType: string) {
  for (const e of await outboxEvents(w, eventType)) await handleNotificationEvent(w.db.pool, e as never);
}

describe('FR-20 notification routing, dedupe and deep-link context (delivery side)', () => {
  beforeAll(async () => {
    w = await createProviderWorld('fr20');
    finance = await person(w, 'finance', ['finance_approver'], w.siteId);
    const depot = await createSite(w.db.pool, w.admin, { name: 'Depot', timezone: 'Europe/London', source: 'API' });
    farOperator = await person(w, 'far-operator', ['operator'], depot.siteId);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('routes a critical incident to the site operators and approvers once, with direct context', async () => {
    await consumeAll('incident.opened.v1');
    const opened = (await outboxEvents(w, 'incident.opened.v1'))[0]!;
    // Re-delivery of the same event is a no-op.
    expect(await handleNotificationEvent(w.db.pool, opened as never)).toBe('DUPLICATE');
    const rows = (
      await w.db.pool.query(
        `SELECT * FROM notifications WHERE tenant_id = $1 AND trigger_kind = 'CRITICAL_INCIDENT' AND incident_id = $2`,
        [w.tenant.tenantId, w.incident.incidentId],
      )
    ).rows;
    const recipients = new Set(rows.map((r) => r.recipient_user_id));
    expect(recipients.has(w.operator.userId)).toBe(true);
    expect(recipients.has(w.people.oncall!.userId)).toBe(true);
    expect(recipients.has(w.approver.userId)).toBe(true);
    expect(recipients.has(w.viewer.userId)).toBe(false);
    expect(recipients.has(finance.userId)).toBe(false);
    expect(recipients.has(farOperator.userId)).toBe(false);
    expect(rows.length).toBe(recipients.size);
    const r = rows[0]!;
    expect(r.deep_link).toBe(`/incidents/${w.incident.incidentId}`);
    expect(r.severity).toBe('CRITICAL');
    expect(r.routing_version).toBe('notification-routing.v1');
    expect(r.context).toMatchObject({
      incidentId: w.incident.incidentId,
      siteId: w.siteId,
      recoveryPath: 'ACKNOWLEDGE_AND_TRIAGE',
    });
    expect(JSON.stringify(r.context)).not.toMatch(/@|\+44/);
    expect(NOTIFICATION_CONSUMER).toBe('provider-notifications.v1');
  });

  it('delivers through the local adapter idempotently; delivery is not acknowledgement', async () => {
    const before = await getIncident(w.db.pool, w.operator.ctx, w.incident.incidentId);
    const first = await dispatchNotifications(w.db.pool, inbox, { limit: 50 });
    expect(first.delivered).toBeGreaterThan(0);
    const second = await dispatchNotifications(w.db.pool, inbox, { limit: 50 });
    expect(second.delivered).toBe(0);
    const mine = await listMyNotifications(w.db.pool, w.operator.ctx);
    const critical = mine.filter((n) => n.triggerKind === 'CRITICAL_INCIDENT');
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ state: 'DELIVERED', deepLink: `/incidents/${w.incident.incidentId}` });
    expect(inbox.messagesFor(w.operator.userId).filter((m) => m.titleCode === 'CRITICAL_INCIDENT_OPENED')).toHaveLength(
      1,
    );
    const after = await getIncident(w.db.pool, w.operator.ctx, w.incident.incidentId);
    expect(after.acknowledgedAt).toBe(before.acknowledgedAt);
    expect(after.acknowledgedAt).toBeNull();
  });

  it('a delivery timeout is UNKNOWN and retried only with the same dedupe key (no duplicate message)', async () => {
    const flaky = new LocalNotificationInbox({ hangFirst: 1 });
    await withTenantTransaction(w.db.pool, w.service, (c) =>
      enqueueNotificationTrigger(c, w.service, {
        triggerKind: 'EVIDENCE_GAP',
        sourceEventId: 'evt_fixture-gap-0001',
        sourceEventType: 'evidence.revision_committed.v1',
        logicalKey: 'evidence-gap:fixture',
        incidentId: w.incident.incidentId,
        reasonCode: 'MANUAL_MISSING',
      }),
    );
    const r1 = await dispatchNotifications(w.db.pool, flaky, { limit: 50, timeoutMs: 100 });
    expect(r1.unknown).toBeGreaterThan(0);
    const unk = await listMyNotifications(w.db.pool, w.operator.ctx);
    expect(unk.find((n) => n.triggerKind === 'EVIDENCE_GAP')!.state).toBe('UNKNOWN');
    const r2 = await dispatchNotifications(w.db.pool, flaky, {
      limit: 50,
      timeoutMs: 100,
      asOf: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(r2.delivered).toBeGreaterThan(0);
    expect(flaky.messagesFor(w.operator.userId).filter((m) => m.titleCode === 'EVIDENCE_GAP')).toHaveLength(1);
    // Enqueuing the same logical trigger again is deduplicated.
    await withTenantTransaction(w.db.pool, w.service, (c) =>
      enqueueNotificationTrigger(c, w.service, {
        triggerKind: 'EVIDENCE_GAP',
        sourceEventId: 'evt_fixture-gap-0002',
        sourceEventType: 'evidence.revision_committed.v1',
        logicalKey: 'evidence-gap:fixture',
        incidentId: w.incident.incidentId,
        reasonCode: 'MANUAL_MISSING',
      }),
    );
    expect(
      await count(w, 'notifications', `trigger_kind = 'EVIDENCE_GAP' AND recipient_user_id = $1`, [w.operator.userId]),
    ).toBe(1);
  });

  it('assignment notifies only the assignee; escalation reaches operators, approvers and engineers', async () => {
    const inc = await getIncident(w.db.pool, w.operator.ctx, w.incident.incidentId);
    await assignIncident(w.db.pool, w.operator.ctx, w.incident.incidentId, {
      expectedVersion: inc.version,
      idempotencyKey: w.key('assign'),
      assigneeUserId: w.people.operator2!.userId,
      reasonCode: 'SHIFT_CHANGE',
    });
    await consumeAll('incident.assignment_changed.v1');
    const assign = (
      await w.db.pool.query(
        `SELECT recipient_user_id, recipient_role FROM notifications WHERE tenant_id = $1 AND trigger_kind = 'ASSIGNMENT'`,
        [w.tenant.tenantId],
      )
    ).rows;
    expect(assign.map((r) => r.recipient_user_id)).toContain(w.people.operator2!.userId);
    expect(assign.every((r) => r.recipient_role === 'assignee')).toBe(true);
    const inc2 = await getIncident(w.db.pool, w.operator.ctx, w.incident.incidentId);
    await escalateIncident(w.db.pool, w.operator.ctx, w.incident.incidentId, {
      expectedVersion: inc2.version,
      idempotencyKey: w.key('esc'),
      reasonCode: 'PROVIDER_UNAVAILABLE',
    });
    await consumeAll('incident.state_changed.v1');
    const esc = (
      await w.db.pool.query(
        `SELECT recipient_user_id FROM notifications WHERE tenant_id = $1 AND trigger_kind = 'INCIDENT_ESCALATED'`,
        [w.tenant.tenantId],
      )
    ).rows.map((r) => r.recipient_user_id);
    expect(esc).toContain(w.approver.userId);
    expect(esc).not.toContain(w.viewer.userId);
  });

  it('provider outcome changes and spend exceptions route to the right roles', async () => {
    const { byRef } = await discover(w);
    w.api.on('POST /v1/contact-requests', () => 'HANG');
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      providerAccountId: w.unpaid.providerAccountId,
      channel: 'API',
      purposeCode: 'QUOTE',
      timeoutMs: 150,
      idempotencyKey: w.key('prep'),
    });
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e') },
      {},
    );
    await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 'fr20' });
    await consumeAll('provider.contact_attempted.v1');
    const pc = (
      await w.db.pool.query(
        `SELECT recipient_user_id, title_code, deep_link FROM notifications WHERE tenant_id = $1 AND trigger_kind = 'PROVIDER_CHANGE'`,
        [w.tenant.tenantId],
      )
    ).rows;
    expect(pc.map((r) => r.recipient_user_id)).toContain(w.operator.userId);
    expect(pc[0]!.title_code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(pc[0]!.deep_link).toBe(
      `/incidents/${w.incident.incidentId}/providers/contacts/${prepared.contactRequestId}`,
    );

    // Spend exception (M09 owns the trigger; the broker-port event is what M07 routes).
    const broker = new CountingBroker();
    broker.outcome = 'UNKNOWN';
    const paid = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'QUOTE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(500n, 'USD') },
      idempotencyKey: w.key('pp'),
    });
    const approval = await approvePaidContact(w, paid);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const r = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      paid.contactRequestId,
      { idempotencyKey: w.key('e'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
      { broker },
    );
    const intent = (await broker.getIntent(w.tenant.tenantId, r.attempt.commercialIntentId as never))!;
    const [evt] = await publishBrokerEvents(w, [
      brokerEvent(
        intent,
        'RESERVED',
        'UNKNOWN',
        brokerAttempt({ transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN' }),
        {
          version: 9,
          nextReconcileAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ),
    ]);
    await handleNotificationEvent(w.db.pool, evt as never);
    const spend = (
      await w.db.pool.query(
        `SELECT recipient_user_id, recipient_role FROM notifications WHERE tenant_id = $1 AND trigger_kind = 'SPEND_EXCEPTION'`,
        [w.tenant.tenantId],
      )
    ).rows;
    expect(spend.map((x) => x.recipient_user_id)).toContain(finance.userId);
    expect(spend.map((x) => x.recipient_user_id)).not.toContain(w.viewer.userId);
  });

  it('recipients never cross tenants and a user only lists their own notifications', async () => {
    const other = await seedTenant(w.db.pool, w.idp, 'fr20-beta');
    expect(await listMyNotifications(w.db.pool, other.admin)).toEqual([]);
    const mine = await listMyNotifications(w.db.pool, w.viewer.ctx);
    expect(mine.every((n) => n.recipientUserId === w.viewer.userId)).toBe(true);
    const all = (await w.db.pool.query(`SELECT DISTINCT tenant_id FROM notifications`)).rows;
    expect(all.map((r) => r.tenant_id)).toEqual([w.tenant.tenantId]);
    // A forged envelope that is not a durable outbox row is refused.
    const opened = (await outboxEvents(w, 'incident.opened.v1'))[0]!;
    expect(
      (await rejection(handleNotificationEvent(w.db.pool, { ...opened, tenantId: other.tenantId } as never))).code,
    ).toBe('FORBIDDEN');
    // Services cannot read inboxes.
    expect((await rejection(listMyNotifications(w.db.pool, w.service))).code).toBe('FORBIDDEN');
  });
});
