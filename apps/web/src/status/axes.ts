// The one mapping from every state axis to its human label, tone, icon shape and accessible description (UI-SPEC §5.2,
// §8.5; INV-11, INV-12, NFR-07). Axes are never merged: freshness, local authority, Kite session, transport, external
// outcome, adapter capability, economic intent, purchase order, service job, incident lifecycle, recovery gate and
// recovery evaluation each have their own vocabulary. Green ("healthy") is reserved for independently verified good
// states: FRESH telemetry, a CONFIRMED payment or Kite session, a PASSED recovery evaluation and the canonical
// RECOVERED state. Everything else — including ELIGIBLE capability, ACTIVE local authority, ALLOW decisions, delivered
// notifications and verified receipts — uses another tone. An unrecognized value is labelled as such, never guessed.

export type Tone = 'healthy' | 'action' | 'warning' | 'critical' | 'info' | 'unknown' | 'neutral';
export type Shape =
  'check' | 'triangle' | 'octagon' | 'circle' | 'diamond' | 'question' | 'dash' | 'clock' | 'pause' | 'square';

export const AXES = Object.freeze([
  'freshness',
  'kite-session',
  'external-outcome',
  'transport',
  'adapter-capability',
  'economic-intent',
  'local-authority',
  'purchase-order',
  'service-job',
  'incident-state',
  'recovery',
  'recovery-evaluation',
  'compatibility',
  'notification-delivery',
  'deadline',
  'plan-disposition',
  'urgency',
] as const);
export type Axis = (typeof AXES)[number];

export const AXIS_LABELS: Record<Axis, string> = {
  freshness: 'Signal freshness',
  'kite-session': 'Kite session',
  'external-outcome': 'External outcome',
  transport: 'Transport',
  'adapter-capability': 'Adapter capability',
  'economic-intent': 'Economic intent',
  'local-authority': 'Local authority',
  'purchase-order': 'Purchase order',
  'service-job': 'Service job',
  'incident-state': 'Incident state',
  recovery: 'Recovery',
  'recovery-evaluation': 'Recovery evaluation',
  compatibility: 'Compatibility decision',
  'notification-delivery': 'Delivery',
  deadline: 'Deadline',
  'plan-disposition': 'Plan disposition',
  urgency: 'Urgency',
};

type Entry = { label: string; tone: Tone; shape: Shape; description: string };
const e = (label: string, tone: Tone, shape: Shape, description: string): Entry => ({
  label,
  tone,
  shape,
  description,
});

const OUTCOME: Record<string, Entry> = {
  PROPOSED: e('Proposed', 'neutral', 'dash', 'Proposed only; nothing has been requested and nothing is confirmed.'),
  AUTHORIZED: e(
    'Authorized locally',
    'neutral',
    'dash',
    'Authorized locally; not requested externally and not confirmed.',
  ),
  REQUESTED: e('Requested', 'info', 'clock', 'Handed to the provider; the result is not confirmed yet.'),
  ACCEPTED: e(
    'Accepted, not final',
    'info',
    'clock',
    'The provider acknowledged the request; the result is not confirmed.',
  ),
  CONFIRMED: e(
    'Confirmed',
    'healthy',
    'check',
    'The provider confirmed the result through an authoritative observation.',
  ),
  UNKNOWN: e(
    'Unknown',
    'unknown',
    'question',
    'The outcome is not known. It must be reconciled by an authoritative lookup before any retry.',
  ),
  FAILED: e('Failed', 'critical', 'octagon', 'The provider reported a definite failure.'),
  CANCELLED: e('Cancelled', 'critical', 'octagon', 'The request was cancelled.'),
};
const SESSION: Record<string, Entry> = {
  ...OUTCOME,
  PROPOSED: e('Not requested', 'neutral', 'dash', 'No Kite session has been requested; the session is not confirmed.'),
  AUTHORIZED: e('Authorized locally', 'neutral', 'dash', 'Local authority exists; the Kite session is not confirmed.'),
  REQUESTED: e('Requested', 'info', 'clock', 'A Kite session was requested; it is not confirmed.'),
  ACCEPTED: e('Accepted, not final', 'info', 'clock', 'Kite acknowledged the request; the session is not confirmed.'),
  CONFIRMED: e(
    'Session confirmed',
    'healthy',
    'check',
    'Kite confirmed the bounded session through an authoritative observation.',
  ),
  UNKNOWN: e(
    'Unknown',
    'unknown',
    'question',
    'The session outcome is not known; reconcile by the original operation key before any spending.',
  ),
};

const MAP: Record<Axis, Record<string, Entry>> = {
  freshness: {
    FRESH: e('Fresh', 'healthy', 'check', 'A live, authenticated reading arrived within the freshness threshold.'),
    STALE: e(
      'Stale',
      'warning',
      'clock',
      'The newest live reading is older than the freshness threshold; it is never counted as up to date.',
    ),
    OFFLINE: e(
      'Offline',
      'critical',
      'octagon',
      'No live reading within the offline threshold; it is never counted as up to date.',
    ),
    INVALID: e(
      'Invalid',
      'critical',
      'triangle',
      'The newest reading is flagged (sensor fault, out of range or uncalibrated) or the device is revoked.',
    ),
    NO_SIGNAL: e(
      'No signal',
      'unknown',
      'question',
      'No bound device has ever produced a usable reading; health cannot be shown.',
    ),
  },
  'kite-session': SESSION,
  'external-outcome': OUTCOME,
  transport: {
    PREPARED: e('Prepared, not sent', 'neutral', 'dash', 'Prepared locally; nothing has left the broker.'),
    SEND_STARTED: e(
      'Send started',
      'info',
      'clock',
      'The pre-egress record is durable; the provider result is not known yet.',
    ),
    ACKNOWLEDGED: e(
      'Acknowledged',
      'info',
      'circle',
      'The provider acknowledged receipt; the business result is a separate axis.',
    ),
    UNKNOWN: e('Unknown', 'unknown', 'question', 'The network result is not known; reconciliation is required.'),
    DEFINITE_NO_EFFECT: e('No effect', 'neutral', 'square', 'Proven not to have reached the provider.'),
  },
  'adapter-capability': {
    ELIGIBLE: e(
      'Reconcilable',
      'info',
      'circle',
      'The adapter can look the result up authoritatively; this is not an outcome.',
    ),
    UNSUPPORTED: e(
      'Unsupported',
      'warning',
      'triangle',
      'The adapter cannot reconcile this automatically; a finance approver resolves it from evidence. This is not an outcome.',
    ),
  },
  'economic-intent': {
    CREATED: e('Created', 'neutral', 'dash', 'The intent exists; no money is reserved or sent.'),
    RESERVED: e('Reserved', 'info', 'clock', 'Budget is reserved; the provider result is not known yet.'),
    SUBMITTED: e(
      'Submitted',
      'info',
      'clock',
      'The provider acknowledged the payment request; settlement is not confirmed.',
    ),
    CONFIRMED: e(
      'Payment confirmed',
      'healthy',
      'check',
      'Settlement was observed authoritatively. A payment is not fulfillment or recovery.',
    ),
    UNKNOWN: e(
      'Unknown',
      'unknown',
      'question',
      'The payment outcome is not known; it stays reserved until reconciled.',
    ),
    FAILED: e('Failed', 'critical', 'octagon', 'Definite failure; no money moved.'),
    REFUNDED: e(
      'Refunded',
      'warning',
      'diamond',
      'A refund was observed; it never restores spending authority by itself.',
    ),
    REVERSED: e(
      'Reversed',
      'warning',
      'diamond',
      'A reversal was observed; it never restores spending authority by itself.',
    ),
  },
  'local-authority': {
    ACTIVE: e(
      'Active (local)',
      'info',
      'circle',
      'Local bounded authority is active; this alone never means Kite created a session.',
    ),
    SUSPENDED: e(
      'Suspended',
      'warning',
      'pause',
      'New spending is blocked while suspended; in-flight effects keep reconciling.',
    ),
    REVOKED: e(
      'Revoked',
      'critical',
      'octagon',
      'New spending is blocked permanently; in-flight effects keep reconciling.',
    ),
    EXPIRED: e('Expired', 'neutral', 'dash', 'The authority passed its expiry; new spending is blocked.'),
  },
  'purchase-order': {
    REQUESTED: e('Requested', 'neutral', 'dash', 'Requested by UptimeBuyer; not yet accepted by the supplier.'),
    ACCEPTED: e('Accepted by supplier', 'info', 'circle', 'The supplier accepted; nothing has shipped.'),
    ORDERED: e('Ordered', 'info', 'circle', 'The supplier placed the order.'),
    PARTIALLY_FILLED: e('Partially filled', 'warning', 'triangle', 'Only part of the quantity is available.'),
    SHIPPED: e('Shipped', 'info', 'circle', 'The supplier reports shipment.'),
    DELIVERED: e(
      'Delivered (supplier report)',
      'info',
      'circle',
      'The supplier reports delivery; receiving inspection is still required.',
    ),
    VERIFIED: e(
      'Receipt verified',
      'info',
      'diamond',
      'An operator verified the received part; delivery never proves recovery.',
    ),
    DISPUTED: e('Disputed', 'warning', 'triangle', 'An operator disputed the delivery.'),
    SUBSTITUTION_PROPOSED: e(
      'Substitution proposed',
      'warning',
      'triangle',
      'The supplier proposed a different part; re-approval is required.',
    ),
    CHANGE_REVIEW: e(
      'Change review',
      'warning',
      'triangle',
      'A material change blocks the next action until reviewed.',
    ),
    REJECTED: e('Rejected', 'critical', 'octagon', 'The supplier rejected the order.'),
    CANCELLED: e('Cancelled', 'critical', 'octagon', 'The order was cancelled.'),
    FAILED: e('Failed', 'critical', 'octagon', 'The order failed.'),
    UNKNOWN: e('Unknown', 'unknown', 'question', 'The order outcome is not known; reconciliation is required.'),
  },
  'service-job': {
    REQUESTED: e('Requested', 'neutral', 'dash', 'Requested by UptimeBuyer; not yet accepted by the technician.'),
    ACCEPTED: e(
      'Accepted by technician',
      'info',
      'circle',
      'The service provider accepted; no visit is scheduled yet.',
    ),
    SCHEDULED: e('Scheduled', 'info', 'clock', 'A visit is scheduled.'),
    RESCHEDULED: e('Rescheduled', 'warning', 'clock', 'The visit moved.'),
    EN_ROUTE: e('En route', 'info', 'circle', 'The technician reports travelling to site.'),
    ARRIVED: e('Arrived', 'info', 'circle', 'The technician reports arrival.'),
    IN_PROGRESS: e('In progress', 'info', 'circle', 'Work is in progress.'),
    WORK_REPORTED_COMPLETE: e(
      'Work reported complete',
      'info',
      'diamond',
      'The provider reports completion; this never proves recovery.',
    ),
    SCOPE_CHANGE_PROPOSED: e('Scope change proposed', 'warning', 'triangle', 'A scope change requires re-approval.'),
    NO_SHOW: e('No-show', 'critical', 'octagon', 'The technician did not arrive.'),
    VERIFIED: e(
      'Work verified',
      'info',
      'diamond',
      'An operator verified the work; recovery still needs telemetry evidence.',
    ),
    DISPUTED: e('Disputed', 'warning', 'triangle', 'An operator disputed the work.'),
    REJECTED: e('Rejected', 'critical', 'octagon', 'The provider rejected the job.'),
    CANCELLED: e('Cancelled', 'critical', 'octagon', 'The job was cancelled.'),
    FAILED: e('Failed', 'critical', 'octagon', 'The job failed.'),
    UNKNOWN: e('Unknown', 'unknown', 'question', 'The job outcome is not known; reconciliation is required.'),
  },
  'incident-state': {
    DETECTED: e('Detected', 'warning', 'triangle', 'A fault was detected.'),
    TRIAGING: e('Triaging', 'warning', 'triangle', 'The incident is being triaged.'),
    AWAITING_EVIDENCE: e('Awaiting evidence', 'warning', 'clock', 'Evidence is required before planning.'),
    PLANNING: e('Planning', 'info', 'circle', 'Recovery options are being evaluated.'),
    AWAITING_APPROVAL: e('Awaiting approval', 'action', 'clock', 'A bounded action awaits an authorized approval.'),
    EXECUTING: e('Executing', 'info', 'circle', 'An approved action is in progress.'),
    VERIFYING: e('Verifying', 'info', 'clock', 'Waiting for independent recovery evidence.'),
    RECOVERED: e(
      'Recovered',
      'healthy',
      'check',
      'The canonical closeout passed the telemetry window and required signoffs.',
    ),
    ESCALATED: e(
      'Escalated',
      'critical',
      'octagon',
      'Escalated; accept ownership and revalidate before work continues.',
    ),
    PAUSED: e('Paused', 'warning', 'pause', 'Paused by an authorized owner.'),
    REOPENED: e('Reopened', 'critical', 'triangle', 'Reopened after recovery; prior evidence is intact.'),
  },
  recovery: {
    RECOVERED: e('Recovered', 'healthy', 'check', 'A current closeout passed every configured recovery check.'),
    NOT_RECOVERED: e('Not recovered', 'neutral', 'dash', 'No current closeout proves recovery.'),
  },
  'recovery-evaluation': {
    PENDING: e('Pending', 'neutral', 'dash', 'Observation has not started.'),
    OBSERVING: e('Observing', 'info', 'clock', 'Collecting a continuous fresh window after the observation boundary.'),
    PASSED: e('Passed', 'healthy', 'check', 'The deterministic stable-window evaluation passed.'),
    FAILED: e('Failed', 'critical', 'octagon', 'The window failed; the incident escalates with evidence intact.'),
    EXPIRED: e('Expired', 'critical', 'octagon', 'The observation period ran out without a passing window.'),
  },
  compatibility: {
    ALLOW: e('Allow', 'info', 'circle', 'Deterministic policy allows this exact action at the pinned revisions.'),
    HOLD: e('Hold', 'warning', 'pause', 'Evidence is missing, conflicting or stale; the action is held.'),
    REJECT: e('Reject', 'critical', 'octagon', 'Deterministic policy rejects this action.'),
  },
  'notification-delivery': {
    PENDING: e('Pending delivery', 'neutral', 'dash', 'Not delivered yet.'),
    DELIVERED: e('Delivered', 'info', 'circle', 'Delivered to the inbox; delivery is not acknowledgement.'),
    UNKNOWN: e(
      'Delivery unknown',
      'unknown',
      'question',
      'The delivery outcome is not known; it is retried with the same key.',
    ),
    FAILED: e('Delivery failed', 'critical', 'octagon', 'Delivery failed.'),
  },
  deadline: {
    RUNNING: e('Running', 'info', 'clock', 'The response deadline is running.'),
    PAUSED: e('Paused', 'warning', 'pause', 'The deadline is paused under the pinned procedure.'),
    EXPIRED: e('Expired', 'critical', 'octagon', 'The response deadline passed.'),
  },
  'plan-disposition': {
    RANKED: e('Ranked', 'info', 'circle', 'Eligible and ranked by expected cost (advisory).'),
    ELIGIBLE_UNRANKED: e('Eligible, unranked', 'neutral', 'dash', 'Eligible but not ranked.'),
    INCOMPLETE: e('Incomplete', 'warning', 'triangle', 'A required input is missing; no deterministic winner.'),
    HELD: e('Held', 'warning', 'pause', 'Held by policy.'),
    REJECTED: e('Rejected', 'critical', 'octagon', 'Rejected by policy.'),
  },
  urgency: {
    CRITICAL: e('Critical', 'critical', 'octagon', 'Critical urgency.'),
    HIGH: e('High', 'warning', 'triangle', 'High urgency.'),
    NORMAL: e('Normal', 'neutral', 'dash', 'Normal urgency.'),
  },
};

export interface AxisView extends Entry {
  axis: Axis;
  value: string;
  axisLabel: string;
}

export function describeAxis(axis: Axis, value: string | null | undefined): AxisView {
  const v = typeof value === 'string' ? value : '';
  const entry = v ? MAP[axis][v] : undefined;
  if (!entry)
    return {
      axis,
      value: v || 'NOT_REPORTED',
      axisLabel: AXIS_LABELS[axis],
      label: v ? 'Unrecognized value' : 'Not reported',
      tone: 'unknown',
      shape: 'question',
      description: v
        ? 'The server reported a value this console does not recognize; it is not interpreted.'
        : 'The server did not report this state.',
    };
  return { axis, value: v, axisLabel: AXIS_LABELS[axis], ...entry };
}
