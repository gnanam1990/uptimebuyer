// FR-20 presentation rules: deep links are accepted only as allowlisted same-origin application paths (no open
// redirect), repeats of the same trigger/incident/reason collapse into one item with a count, and titles/recovery paths
// for unknown outcomes are never phrased as success. Delivery state is a separate axis (never acknowledgement).
import type { NotificationWire } from '@uptimebuyer/api-client';

const ID = '[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}';
const ROUTES = [
  new RegExp(`^/incidents/${ID}$`),
  new RegExp(`^/incidents/${ID}/(overview|evidence|plan|spend|verification|timeline)$`),
  new RegExp(`^/incidents/${ID}/providers/contacts/${ID}$`),
  /^\/(notifications|ledger|policies|incidents)?$/,
];

/** The internal path for a server-supplied deep link, or null when it is not an allowlisted application route. */
export function safeDeepLink(link: unknown): string | null {
  if (typeof link !== 'string' || link.length === 0 || link.length > 300) return null;
  if (!link.startsWith('/') || link.startsWith('//') || /[\\\s?#%]|\.\./.test(link)) return null;
  return ROUTES.some((r) => r.test(link)) ? link : null;
}

export interface NotificationGroup {
  key: string;
  latest: NotificationWire;
  count: number;
  items: NotificationWire[];
}

/** Deduplicate by id, then collapse same trigger + incident + reason into one group, newest group first. */
export function collapseNotifications(list: readonly NotificationWire[]): NotificationGroup[] {
  const byId = new Map<string, NotificationWire>();
  for (const n of list) if (!byId.has(n.notificationId)) byId.set(n.notificationId, n);
  const groups = new Map<string, NotificationGroup>();
  for (const n of byId.values()) {
    const ctx = n.context as Record<string, unknown>;
    const key = `${n.triggerKind}|${String(ctx.incidentId ?? '')}|${String(ctx.reasonCode ?? '')}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, latest: n, count: 1, items: [n] });
    else {
      g.items.push(n);
      g.count = g.items.length;
      if (Date.parse(n.createdAt) > Date.parse(g.latest.createdAt)) g.latest = n;
    }
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}

const TITLES: Record<string, string> = {
  CRITICAL_INCIDENT_OPENED: 'Critical incident opened',
  INCIDENT_OPENED: 'Incident opened',
  INCIDENT_REOPENED: 'Incident reopened',
  INCIDENT_ESCALATED: 'Incident escalated',
  ASSIGNMENT: 'Incident assigned to you',
  DEADLINE_EXPIRED: 'Response deadline expired',
  EVIDENCE_GAP: 'Evidence gap',
  APPROVAL_REQUIRED: 'Approval required',
  SPEND_UNKNOWN: 'Spend outcome unknown',
  SPEND_FAILED: 'Spend failed',
  SPEND_REVERSED: 'Spend reversed',
  SPEND_EXCEPTION: 'Spend exception',
  PROVIDER_OUTCOME_UNKNOWN: 'Provider outcome unknown',
  PROVIDER_OUTCOME_MANUAL_REVIEW: 'Provider outcome needs manual review',
  PROVIDER_DECLINED: 'Provider declined',
  PROVIDER_CANCELLED: 'Provider cancelled',
  PROVIDER_CHANGE: 'Provider change',
  INCIDENT_RECOVERED: 'Recovery verified by closeout',
  RECOVERY: 'Recovery update',
};

export function notificationTitle(titleCode: string, triggerKind: string): string {
  return TITLES[titleCode] ?? TITLES[triggerKind] ?? 'Notification';
}

const PATHS: Record<string, string> = {
  ACKNOWLEDGE_AND_TRIAGE: 'Acknowledge and triage',
  ACCEPT_OWNERSHIP_AND_REVALIDATE: 'Accept ownership and revalidate',
  TRIAGE_REOPENED_INCIDENT: 'Triage the reopened incident',
  ACCEPT_ASSIGNMENT: 'Accept the assignment',
  ESCALATE_OR_CONTAIN: 'Escalate or contain',
  SUPPLY_MISSING_EVIDENCE: 'Supply the missing evidence',
  REVIEW_APPROVAL: 'Review approval',
  REVIEW_SPEND_RECONCILIATION: 'Review spend reconciliation',
  REVIEW_PROVIDER_CONTACT: 'Review the provider contact',
  REVIEW_RECOVERY_EVIDENCE: 'Review the recovery evidence',
};

export function recoveryPathText(code: unknown): string {
  return (typeof code === 'string' && PATHS[code]) || 'Open the incident to decide the next step';
}
