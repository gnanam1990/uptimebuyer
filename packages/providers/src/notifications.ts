// Notification delivery side of FR-20 (M07): versioned role routing, per-recipient deduplication, direct deep-link
// context and a delivery port with a LOCAL inbox adapter. Emitting modules own their triggers (M04 incident events,
// M09 spend exceptions, M11 recovery/reopen); M07 consumes those outbox events or accepts an explicit trigger from a
// server transaction. Messages carry ids, codes and in-app paths only, never contact values or transcript text.
// Delivery is never acknowledgement; a delivery timeout is UNKNOWN and is retried only under the same dedupe key.
import { decodeWire, type DomainEventEnvelope, type UtcInstant } from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import {
  Denial,
  consumeOnce,
  dbNow,
  notPermitted,
  requireAuthorized,
  tenantCommand,
  withTransaction,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { CommercialIntentStateChangedEventSchema } from '@uptimebuyer/kite-contracts';
import { invalid } from './errors.js';
import { newProviderId } from './ids.js';
import { isoOf, withTimeout } from './internal.js';

export const NOTIFICATION_CONSUMER = 'provider-notifications.v1';
export const NOTIFICATION_ROUTING_VERSION = 'notification-routing.v1';
export const NOTIFICATION_LIMITS = Object.freeze({
  maxRecipientsPerTrigger: 25,
  maxDeliveryAttempts: 5,
  defaultTimeoutMs: 5_000,
  retryAfterMs: 60_000,
});

export const TRIGGER_KINDS = Object.freeze([
  'CRITICAL_INCIDENT',
  'INCIDENT_ESCALATED',
  'INCIDENT_REOPENED',
  'ASSIGNMENT',
  'DEADLINE_EXPIRED',
  'EVIDENCE_GAP',
  'APPROVAL_REQUIRED',
  'SPEND_EXCEPTION',
  'PROVIDER_CHANGE',
  'RECOVERY',
] as const);
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Routing table v1: which roles at the incident's site receive each trigger, its severity and recovery path. */
export const ROUTING_V1: Readonly<
  Record<TriggerKind, { roles: readonly string[]; severity: 'CRITICAL' | 'HIGH' | 'NORMAL'; recoveryPath: string }>
> = Object.freeze({
  CRITICAL_INCIDENT: {
    roles: ['operator', 'maintenance_approver'],
    severity: 'CRITICAL',
    recoveryPath: 'ACKNOWLEDGE_AND_TRIAGE',
  },
  INCIDENT_ESCALATED: {
    roles: ['operator', 'maintenance_approver', 'engineer'],
    severity: 'CRITICAL',
    recoveryPath: 'ACCEPT_OWNERSHIP_AND_REVALIDATE',
  },
  INCIDENT_REOPENED: {
    roles: ['operator', 'maintenance_approver'],
    severity: 'CRITICAL',
    recoveryPath: 'TRIAGE_REOPENED_INCIDENT',
  },
  ASSIGNMENT: { roles: [], severity: 'HIGH', recoveryPath: 'ACCEPT_ASSIGNMENT' },
  DEADLINE_EXPIRED: {
    roles: ['operator', 'maintenance_approver'],
    severity: 'CRITICAL',
    recoveryPath: 'ESCALATE_OR_CONTAIN',
  },
  EVIDENCE_GAP: { roles: ['operator', 'engineer'], severity: 'HIGH', recoveryPath: 'SUPPLY_MISSING_EVIDENCE' },
  APPROVAL_REQUIRED: {
    roles: ['maintenance_approver', 'finance_approver'],
    severity: 'HIGH',
    recoveryPath: 'REVIEW_APPROVAL',
  },
  SPEND_EXCEPTION: {
    roles: ['finance_approver', 'maintenance_approver'],
    severity: 'HIGH',
    recoveryPath: 'REVIEW_SPEND_RECONCILIATION',
  },
  PROVIDER_CHANGE: { roles: ['operator'], severity: 'HIGH', recoveryPath: 'REVIEW_PROVIDER_CONTACT' },
  RECOVERY: {
    roles: ['operator', 'maintenance_approver'],
    severity: 'NORMAL',
    recoveryPath: 'REVIEW_RECOVERY_EVIDENCE',
  },
});

export interface NotificationTrigger {
  triggerKind: TriggerKind;
  sourceEventId: string;
  sourceEventType: string;
  /** Logical identity of what is being notified; the same logical key never notifies a recipient twice. */
  logicalKey: string;
  incidentId: string;
  reasonCode: string;
  titleCode?: string;
  /** Explicit recipients (e.g. the assignee); otherwise the routing table's roles at the incident site. */
  recipientUserIds?: string[];
  deepLink?: string;
  context?: Record<string, string | number | boolean | null>;
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LINK = /^\/[a-z0-9/_-]{1,200}(\?[a-zA-Z0-9=&_-]{1,200})?$/;

/** Create one deduplicated notification per routed recipient inside the caller's server transaction. */
export async function enqueueNotificationTrigger(
  c: Tx,
  ctx: TenantContext,
  t: NotificationTrigger,
): Promise<{ created: number }> {
  requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
  if (!(TRIGGER_KINDS as readonly string[]).includes(t.triggerKind)) throw invalid('UNKNOWN_TRIGGER');
  if (!CODE.test(t.reasonCode) || (t.titleCode && !CODE.test(t.titleCode))) throw invalid('INVALID_TRIGGER_CODE');
  if (
    !/^evt_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(t.sourceEventId) ||
    !/^[a-z_]+\.[a-z_]+\.v[1-9]$/.test(t.sourceEventType)
  )
    throw invalid('INVALID_TRIGGER_SOURCE');
  if (typeof t.logicalKey !== 'string' || t.logicalKey.length < 1 || t.logicalKey.length > 200)
    throw invalid('INVALID_LOGICAL_KEY');
  const inc = await c.query<{ site_id: string }>(`SELECT site_id FROM incidents WHERE tenant_id = $1 AND id = $2`, [
    ctx.tenantId,
    t.incidentId,
  ]);
  if (!inc.rows[0]) throw invalid('TRIGGER_INCIDENT_UNKNOWN');
  const siteId = inc.rows[0].site_id;
  const route = ROUTING_V1[t.triggerKind];
  let recipients: { user_id: string; role: string }[];
  if (t.recipientUserIds) {
    const { rows } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = ANY($2::text[]) AND status = 'ACTIVE'`,
      [ctx.tenantId, t.recipientUserIds.slice(0, NOTIFICATION_LIMITS.maxRecipientsPerTrigger)],
    );
    recipients = rows.map((r) => ({ user_id: r.user_id, role: 'assignee' }));
  } else {
    const { rows } = await c.query<{ user_id: string; role: string }>(
      `SELECT DISTINCT ON (ra.user_id) ra.user_id, ra.role FROM role_assignments ra
         JOIN tenant_memberships m ON m.tenant_id = ra.tenant_id AND m.user_id = ra.user_id AND m.status = 'ACTIVE'
        WHERE ra.tenant_id = $1 AND ra.principal_kind = 'HUMAN' AND ra.revoked_at IS NULL AND ra.role = ANY($2::text[])
          AND (ra.site_id IS NULL OR ra.site_id = $3)
        ORDER BY ra.user_id, array_position($2::text[], ra.role)
        LIMIT $4`,
      [ctx.tenantId, [...route.roles], siteId, NOTIFICATION_LIMITS.maxRecipientsPerTrigger],
    );
    recipients = rows;
  }
  const deepLink = t.deepLink ?? `/incidents/${t.incidentId}`;
  if (!LINK.test(deepLink)) throw invalid('INVALID_DEEP_LINK');
  const context = {
    incidentId: t.incidentId,
    siteId,
    recoveryPath: route.recoveryPath,
    reasonCode: t.reasonCode,
    sourceEventType: t.sourceEventType,
    ...(t.context ?? {}),
  };
  let created = 0;
  for (const r of recipients) {
    const dedupeKey = canonicalDigest('notification', 1, {
      tenantId: ctx.tenantId,
      triggerKind: t.triggerKind,
      logicalKey: t.logicalKey,
      recipientUserId: r.user_id,
      channel: 'LOCAL_INBOX',
    });
    const ins = await c.query(
      `INSERT INTO notifications (tenant_id, id, dedupe_key, trigger_kind, routing_version, source_event_id, source_event_type,
         incident_id, site_id, recipient_user_id, recipient_role, channel, severity, title_code, deep_link, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'LOCAL_INBOX', $12, $13, $14, $15)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [
        ctx.tenantId,
        newProviderId('notification'),
        dedupeKey,
        t.triggerKind,
        NOTIFICATION_ROUTING_VERSION,
        t.sourceEventId,
        t.sourceEventType,
        t.incidentId,
        siteId,
        r.user_id,
        r.role,
        route.severity,
        t.titleCode ?? t.triggerKind,
        deepLink,
        JSON.stringify(context),
      ],
    );
    created += ins.rowCount ?? 0;
  }
  return { created };
}

type Env = DomainEventEnvelope & { payload: Record<string, unknown> };

/** Map one emitting module's event to a trigger (or nothing). */
async function triggerFor(c: Tx, ctx: TenantContext, e: Env): Promise<NotificationTrigger | null> {
  const p = e.payload;
  const base = { sourceEventId: e.eventId, sourceEventType: e.eventType };
  switch (e.eventType) {
    case 'incident.opened.v1': {
      const n = p.notification as { required: boolean; reasonCode: string } | undefined;
      if (!n?.required) return null;
      return {
        ...base,
        triggerKind: 'CRITICAL_INCIDENT',
        titleCode: 'CRITICAL_INCIDENT_OPENED',
        logicalKey: `incident-opened:${String(p.incidentId)}`,
        incidentId: String(p.incidentId),
        reasonCode: n.reasonCode,
      };
    }
    case 'incident.reopened.v1': {
      const n = p.notification as { required: boolean; reasonCode: string } | undefined;
      if (!n?.required) return null;
      return {
        ...base,
        triggerKind: 'INCIDENT_REOPENED',
        logicalKey: `incident-reopened:${String(p.incidentId)}:${String(p.reopenCount)}`,
        incidentId: String(p.incidentId),
        reasonCode: n.reasonCode,
      };
    }
    case 'incident.state_changed.v1':
      if (p.to !== 'ESCALATED') return null;
      return {
        ...base,
        triggerKind: 'INCIDENT_ESCALATED',
        logicalKey: `incident-escalated:${String(p.incidentId)}:${e.aggregateVersion}`,
        incidentId: String(p.incidentId),
        reasonCode: String(p.reasonCode),
      };
    case 'incident.assignment_changed.v1':
      return {
        ...base,
        triggerKind: 'ASSIGNMENT',
        logicalKey: `assignment:${String(p.assignmentId)}`,
        incidentId: String(p.incidentId),
        reasonCode: String(p.reasonCode),
        recipientUserIds: [String(p.assigneeUserId)],
      };
    case 'incident.deadline_changed.v1':
      if (p.eventType !== 'EXPIRE') return null;
      return {
        ...base,
        triggerKind: 'DEADLINE_EXPIRED',
        logicalKey: `deadline-expired:${String(p.incidentId)}:${String(p.sequence)}`,
        incidentId: String(p.incidentId),
        reasonCode: String(p.reasonCode),
      };
    case 'provider.contact_attempted.v1': {
      const outcome = String(p.externalOutcomeState);
      const notable =
        outcome === 'UNKNOWN' || p.manualReview === true || outcome === 'FAILED' || outcome === 'CANCELLED';
      if (!notable) return null;
      const title =
        outcome === 'UNKNOWN'
          ? 'PROVIDER_OUTCOME_UNKNOWN'
          : outcome === 'CANCELLED'
            ? 'PROVIDER_CANCELLED'
            : 'PROVIDER_DECLINED';
      return {
        ...base,
        triggerKind: 'PROVIDER_CHANGE',
        titleCode: p.manualReview === true ? 'PROVIDER_OUTCOME_MANUAL_REVIEW' : title,
        logicalKey: `provider-change:${String(p.contactAttemptId)}:${String(p.displayStatus)}`,
        incidentId: String(p.incidentId),
        reasonCode: String(p.displayStatus),
        deepLink: `/incidents/${String(p.incidentId)}/providers/contacts/${String(p.contactRequestId)}`,
        context: { contactRequestId: String(p.contactRequestId), contactAttemptId: String(p.contactAttemptId) },
      };
    }
    case 'commercial_intent.state_changed.v1': {
      const ev = decodeWire(CommercialIntentStateChangedEventSchema, e as never);
      const state = ev.payload.state;
      if (state !== 'UNKNOWN' && state !== 'FAILED' && state !== 'REVERSED') return null;
      const { rows } = await c.query<{ incident_id: string; id: string }>(
        `SELECT q.incident_id, q.id FROM provider_contact_attempts a
           JOIN provider_contact_requests q ON q.tenant_id = a.tenant_id AND q.id = a.contact_request_id
          WHERE a.tenant_id = $1 AND a.commercial_intent_id = $2`,
        [ctx.tenantId, ev.payload.commercialIntentId],
      );
      if (!rows[0]) return null; // plan-action intents are routed by their owning module (M09/M10)
      return {
        ...base,
        triggerKind: 'SPEND_EXCEPTION',
        titleCode: `SPEND_${state}`,
        logicalKey: `spend-exception:${ev.payload.commercialIntentId}:${state}`,
        incidentId: rows[0].incident_id,
        reasonCode: `INTENT_${state}`,
        deepLink: `/incidents/${rows[0].incident_id}/providers/contacts/${rows[0].id}`,
        context: { commercialIntentId: ev.payload.commercialIntentId, resultOrigin: ev.payload.resultOrigin },
      };
    }
    default:
      return null;
  }
}

/** Outbox consumer (consumeOnce): routes durable events from the emitting modules. */
export async function handleNotificationEvent(
  pool: Db,
  envelope: DomainEventEnvelope,
): Promise<'PROCESSED' | 'DUPLICATE'> {
  return consumeOnce(pool, NOTIFICATION_CONSUMER, envelope, async (c, ctx) => {
    const t = await triggerFor(c, ctx, envelope as Env);
    if (t) await enqueueNotificationTrigger(c, ctx, t);
  });
}

export interface NotificationMessage {
  dedupeKey: string;
  recipientUserId: string;
  titleCode: string;
  severity: string;
  deepLink: string;
  context: Record<string, unknown>;
}

export interface NotificationDeliveryPort {
  readonly channel: 'LOCAL_INBOX';
  /** Must be idempotent on `dedupeKey` (same-key replay returns the original delivery reference). */
  deliver(msg: NotificationMessage, opts: { signal: AbortSignal }): Promise<{ ref: string }>;
}

/** LOCAL delivery adapter: an in-memory inbox, idempotent on the dedupe key. Not an email/SMS/push provider. */
export class LocalNotificationInbox implements NotificationDeliveryPort {
  readonly channel = 'LOCAL_INBOX' as const;
  private readonly byKey = new Map<string, { ref: string; msg: NotificationMessage }>();
  private readonly hangs = new Map<string, number>();
  constructor(private readonly opts: { hangFirst?: number } = {}) {}

  async deliver(msg: NotificationMessage, o: { signal: AbortSignal }): Promise<{ ref: string }> {
    let rec = this.byKey.get(msg.dedupeKey);
    if (!rec) {
      rec = { ref: `inbox-${this.byKey.size + 1}`, msg: structuredClone(msg) };
      this.byKey.set(msg.dedupeKey, rec);
    }
    const hung = this.hangs.get(msg.dedupeKey) ?? 0;
    if (hung < (this.opts.hangFirst ?? 0)) {
      // Stored, but the acknowledgement is lost: the caller must treat the delivery as UNKNOWN.
      this.hangs.set(msg.dedupeKey, hung + 1);
      return new Promise((_, reject) =>
        o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    }
    return { ref: rec.ref };
  }

  messagesFor(userId: string): NotificationMessage[] {
    return [...this.byKey.values()].filter((r) => r.msg.recipientUserId === userId).map((r) => r.msg);
  }
}

/** Platform delivery worker (bounded batch, row lease via next_attempt_at, no transaction held across delivery). */
export async function dispatchNotifications(
  pool: Db,
  port: NotificationDeliveryPort,
  opts: { limit?: number; timeoutMs?: number; asOf?: string } = {},
): Promise<{ delivered: number; unknown: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const timeoutMs = Math.max(50, Math.min(opts.timeoutMs ?? NOTIFICATION_LIMITS.defaultTimeoutMs, 30_000));
  const claimed = await withTransaction(pool, async (c) => {
    const now = await dbNow(c);
    const asOf = opts.asOf && Date.parse(opts.asOf) > Date.parse(now) ? new Date(opts.asOf).toISOString() : now;
    const { rows } = await c.query(
      `SELECT * FROM notifications WHERE state IN ('PENDING', 'UNKNOWN') AND delivery_attempts < $1
          AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
        ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [NOTIFICATION_LIMITS.maxDeliveryAttempts, asOf, limit],
    );
    for (const r of rows)
      await c.query(
        `UPDATE notifications SET state = 'UNKNOWN', delivery_attempts = delivery_attempts + 1,
                next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
                version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [r.tenant_id, r.id, NOTIFICATION_LIMITS.retryAfterMs],
      );
    return rows;
  });
  let delivered = 0;
  let unknown = 0;
  for (const r of claimed) {
    const res = await withTimeout(timeoutMs, (signal) =>
      port.deliver(
        {
          dedupeKey: r.dedupe_key,
          recipientUserId: r.recipient_user_id,
          titleCode: r.title_code,
          severity: r.severity,
          deepLink: r.deep_link,
          context: r.context,
        },
        { signal },
      ),
    );
    if (res.kind === 'OK') {
      await pool.query(
        `UPDATE notifications SET state = 'DELIVERED', delivered_at = clock_timestamp(), provider_ref = $3, next_attempt_at = NULL,
                version = version + 1, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND state = 'UNKNOWN'`,
        [r.tenant_id, r.id, res.value.ref.slice(0, 128)],
      );
      delivered++;
    } else unknown++;
  }
  return { delivered, unknown };
}

export interface NotificationView {
  notificationId: string;
  triggerKind: TriggerKind;
  titleCode: string;
  severity: string;
  deepLink: string;
  context: Record<string, unknown>;
  state: 'PENDING' | 'DELIVERED' | 'UNKNOWN' | 'FAILED';
  recipientUserId: string;
  recipientRole: string;
  createdAt: UtcInstant;
  deliveredAt: UtcInstant | null;
}

/** The authenticated human's own notifications in their tenant (identity-scoped, newest first, bounded). */
export async function listMyNotifications(pool: Db, ctx: TenantContext): Promise<NotificationView[]> {
  const meta = { action: 'notification.read', resourceType: 'notification', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (ctx.principal.kind !== 'HUMAN')
      throw new Denial(notPermitted('PRINCIPAL_KIND_NOT_PERMITTED'), {
        action: meta.action,
        resourceType: meta.resourceType,
        reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
      });
    const { rows } = await c.query(
      `SELECT * FROM notifications WHERE tenant_id = $1 AND recipient_user_id = $2 ORDER BY created_at DESC, id LIMIT 200`,
      [ctx.tenantId, ctx.principal.id],
    );
    return rows.map((r) => ({
      notificationId: r.id,
      triggerKind: r.trigger_kind,
      titleCode: r.title_code,
      severity: r.severity,
      deepLink: r.deep_link,
      context: r.context,
      state: r.state,
      recipientUserId: r.recipient_user_id,
      recipientRole: r.recipient_role,
      createdAt: isoOf(r.created_at)!,
      deliveredAt: isoOf(r.delivered_at),
    }));
  });
}
