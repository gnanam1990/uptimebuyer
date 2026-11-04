// State-machine transition tables AS DATA, transcribed from docs/spec/STATE-MACHINES.md. Each edge carries its
// guard text; enforcing the guard's evidence is the owning module's job, legality of the edge is this table's.
import {
  ATTEMPT_TRANSPORT_STATES,
  COMPATIBILITY_LIFECYCLES,
  DEVICE_HEALTH_STATES,
  ECONOMIC_INTENT_STATES,
  EVIDENCE_REVISION_STATES,
  EXECUTION_AUTHORITY_STATES,
  EXTERNAL_OUTCOME_STATES,
  INCIDENT_PAUSABLE_STATES,
  INCIDENT_STATES,
  KITE_SESSION_STATES,
  PURCHASE_ORDER_STATES,
  RECOVERY_EVALUATION_STATES,
  RECOVERY_PLAN_STATES,
  SERVICE_JOB_STATES,
} from '@uptimebuyer/contracts';

export type TransitionEdge<S extends string = string> = { readonly from: S; readonly to: S; readonly guard: string };
export type MachineDefinition<S extends string = string> = {
  readonly name: string;
  readonly states: readonly S[];
  readonly edges: readonly TransitionEdge<S>[];
};

function defineMachine<S extends string>(
  name: string,
  states: readonly S[],
  edges: readonly (readonly [S | readonly S[], S | readonly S[], string])[],
): MachineDefinition<S> {
  const list: TransitionEdge<S>[] = [];
  for (const [fromSpec, toSpec, guard] of edges) {
    const froms = (Array.isArray(fromSpec) ? fromSpec : [fromSpec]) as readonly S[];
    const tos = (Array.isArray(toSpec) ? toSpec : [toSpec]) as readonly S[];
    for (const from of froms)
      for (const to of tos) {
        if (!states.includes(from) || !states.includes(to))
          throw new Error(`${name}: edge ${from}->${to} uses an unknown state`);
        if (list.some((e) => e.from === from && e.to === to)) throw new Error(`${name}: duplicate edge ${from}->${to}`);
        list.push(Object.freeze({ from, to, guard }));
      }
  }
  return Object.freeze({ name, states: Object.freeze([...states]), edges: Object.freeze(list) });
}

const INCIDENT_ACTIVE = [
  'DETECTED',
  'TRIAGING',
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
] as const;

const INCIDENT = defineMachine('INCIDENT', INCIDENT_STATES, [
  ['DETECTED', 'TRIAGING', 'incident and source telemetry persisted'],
  ['TRIAGING', 'AWAITING_EVIDENCE', 'required identity/evidence is not yet sufficient'],
  [['TRIAGING', 'AWAITING_EVIDENCE'], 'PLANNING', 'current evidence revision is sufficient to evaluate candidates'],
  ['PLANNING', 'AWAITING_APPROVAL', 'at least one allowable action and valid current pricing'],
  ['AWAITING_APPROVAL', 'EXECUTING', 'signed approval covers exact plan hash and budget'],
  [
    'AWAITING_APPROVAL',
    'PLANNING',
    'plan or unexecuted approval invalidated before any reserve-plus-SEND_STARTED linearization; no possible in-flight effect',
  ],
  ['EXECUTING', 'VERIFYING', 'intended work/fulfillment reports completion; payment may still reconcile'],
  ['VERIFYING', 'RECOVERED', 'stable sensor window and configured sign-off satisfied'],
  [
    INCIDENT_ACTIVE,
    'ESCALATED',
    'safety hold, deadline, repeated failure, recovery evaluation FAILED/EXPIRED, invalidation after possible egress, no allowable action, or manual command',
  ],
  [INCIDENT_PAUSABLE_STATES, 'PAUSED', 'authorized operator pauses and records the resumable prior state'],
  [
    'ESCALATED',
    ['TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING'],
    'tenant-scoped current assignment accepted by compare-and-set and a revision-bound next path exists',
  ],
  [
    'PAUSED',
    INCIDENT_PAUSABLE_STATES,
    'resume to the recorded prior state after revalidating evidence, policy, approval, expiry, deadline and in-flight effects',
  ],
  ['RECOVERED', 'REOPENED', 'recurrence, invalid recovery evidence, or approved investigation'],
  ['REOPENED', 'TRIAGING', 'new evidence revision created'],
]);

const EVIDENCE_REVISION = defineMachine('EVIDENCE_REVISION', EVIDENCE_REVISION_STATES, [
  ['DRAFT', 'VALIDATING', 'manifest submitted for validation'],
  ['VALIDATING', 'COMMITTED', 'every item and citation validated; revision becomes immutable'],
  [['DRAFT', 'VALIDATING'], 'REJECTED', 'invalid source, digest or citation'],
]);

const COMPATIBILITY_LIFECYCLE = defineMachine('COMPATIBILITY_LIFECYCLE', COMPATIBILITY_LIFECYCLES, [
  ['CURRENT', 'SUPERSEDED', 'a new decision row for a newer evaluated tuple exists; the old row is never edited'],
]);

const RECOVERY_PLAN = defineMachine('RECOVERY_PLAN', RECOVERY_PLAN_STATES, [
  ['DRAFT', 'EVALUATED', 'deterministic policy evaluated every candidate'],
  ['EVALUATED', 'APPROVABLE', 'at least one allowable action with current pricing'],
  ['EVALUATED', 'HELD', 'mandatory input missing or policy hold'],
  [
    'APPROVABLE',
    'APPROVED',
    'signed approval covers plan hash, revisions, action digest, scope, maximum, currency, expiry',
  ],
  ['APPROVABLE', 'REJECTED', 'approver rejected the plan'],
  ['APPROVED', 'EXECUTING', 'reserve-plus-SEND_STARTED linearization committed'],
  ['EXECUTING', 'COMPLETED', 'every planned action reached a terminal reconciled outcome'],
  [['DRAFT', 'EVALUATED', 'APPROVABLE', 'APPROVED'], 'INVALIDATED', 'revision, expiry or policy change before egress'],
  ['EXECUTING', 'INVALIDATED', 'revision, expiry or policy change after egress; requires IN_FLIGHT_RECONCILIATION'],
]);

const EXECUTION_AUTHORITY = defineMachine('EXECUTION_AUTHORITY', EXECUTION_AUTHORITY_STATES, [
  ['ACTIVE', 'SUSPENDED', 'authorized suspension; serializes with intent reservation'],
  ['SUSPENDED', 'ACTIVE', 'authorized reactivation before expiry'],
  [['ACTIVE', 'SUSPENDED'], 'REVOKED', 'authorized revocation; possible in-flight effects keep reconciling'],
  [['ACTIVE', 'SUSPENDED'], 'EXPIRED', 'expiry reached; possible in-flight effects keep reconciling'],
]);

function externalOutcomeEdges<S extends string>(): (readonly [S | readonly S[], S | readonly S[], string])[] {
  const e = (from: string | readonly string[], to: string | readonly string[], guard: string) =>
    [from, to, guard] as unknown as readonly [S | readonly S[], S | readonly S[], string];
  return [
    e('PROPOSED', 'AUTHORIZED', 'bounded authority and policy permit the action'),
    e('AUTHORIZED', 'REQUESTED', 'request observed handed to the adapter/network boundary'),
    e('REQUESTED', 'ACCEPTED', 'provider acknowledgement'),
    e('ACCEPTED', 'CONFIRMED', 'authoritative evidence for the exact action'),
    e(['REQUESTED', 'ACCEPTED'], ['FAILED', 'CANCELLED'], 'authoritative provider decline or cancellation'),
    e(
      ['AUTHORIZED', 'REQUESTED', 'ACCEPTED'],
      'UNKNOWN',
      'ambiguity: crash after SEND_STARTED before observed handoff (AUTHORIZED), timeout, or loss after acknowledgement',
    ),
    e(
      'UNKNOWN',
      ['ACCEPTED', 'CONFIRMED', 'FAILED', 'CANCELLED'],
      'authoritative lookup or proven same-key replay only',
    ),
  ];
}

const KITE_SESSION = defineMachine('KITE_SESSION', KITE_SESSION_STATES, externalOutcomeEdges());
const EXTERNAL_ACTION = defineMachine('EXTERNAL_ACTION', EXTERNAL_OUTCOME_STATES, externalOutcomeEdges());

const ATTEMPT_TRANSPORT = defineMachine('ATTEMPT_TRANSPORT', ATTEMPT_TRANSPORT_STATES, [
  ['PREPARED', 'SEND_STARTED', 'operation id, idempotency key, request digest and reserve committed before egress'],
  ['SEND_STARTED', 'ACKNOWLEDGED', 'provider acknowledged the request'],
  ['SEND_STARTED', 'UNKNOWN', 'timeout, disconnect or crash after the durable marker'],
  ['SEND_STARTED', 'DEFINITE_NO_EFFECT', 'definite proof the request had no effect'],
]);

const ECONOMIC_INTENT = defineMachine('ECONOMIC_INTENT', ECONOMIC_INTENT_STATES, [
  [
    'CREATED',
    'RESERVED',
    'authority ACTIVE, session CONFIRMED, budget reserved and SEND_STARTED committed in one transaction',
  ],
  ['CREATED', 'FAILED', 'broker revalidation proved approval/revision/price/policy invalid before reserve or egress'],
  ['RESERVED', 'SUBMITTED', 'provider/Kite boundary authoritatively acknowledged the request'],
  ['RESERVED', 'UNKNOWN', 'response lost or process died after SEND_STARTED'],
  ['RESERVED', 'FAILED', 'atomic RELEASE plus definite proof that no external effect began'],
  ['SUBMITTED', 'CONFIRMED', 'authoritative confirmation; captured amount within reservation'],
  ['SUBMITTED', 'UNKNOWN', 'ambiguity after acknowledgement'],
  ['SUBMITTED', 'FAILED', 'authoritative proof of no economic effect plus atomic RELEASE'],
  ['UNKNOWN', 'SUBMITTED', 'authoritative accepted-but-not-confirmed observation'],
  ['UNKNOWN', 'CONFIRMED', 'authoritative confirmation by provider reference or pre-egress operation key'],
  ['UNKNOWN', 'FAILED', 'authoritative proof of no economic effect plus atomic RELEASE'],
  [
    'UNKNOWN',
    ['REFUNDED', 'REVERSED'],
    'same transaction appends the proved CAPTURE first, then the REFUND/REVERSAL referencing it',
  ],
  ['CONFIRMED', ['REFUNDED', 'REVERSED'], 'full refund/reversal ledger movement; partial refund stays CONFIRMED'],
]);

const PURCHASE_ORDER = defineMachine('PURCHASE_ORDER', PURCHASE_ORDER_STATES, [
  ['REQUESTED', ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'], 'provider response or ambiguity'],
  [
    'UNKNOWN',
    ['ACCEPTED', 'REJECTED', 'ORDERED', 'PARTIALLY_FILLED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED'],
    'reconciliation evidence only',
  ],
  [
    'ACCEPTED',
    ['ORDERED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    'provider update',
  ],
  [
    'ORDERED',
    ['PARTIALLY_FILLED', 'SHIPPED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    'provider update',
  ],
  [
    'PARTIALLY_FILLED',
    ['SHIPPED', 'DELIVERED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    'provider update',
  ],
  ['SHIPPED', ['DELIVERED', 'PARTIALLY_FILLED', 'CHANGE_REVIEW', 'FAILED', 'UNKNOWN'], 'carrier/provider update'],
  ['DELIVERED', ['VERIFIED', 'DISPUTED'], 'fulfillment evidence; not equipment recovery'],
  [
    ['SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW'],
    'CANCELLED',
    'an accepted change creates a new revision/action lineage instead of mutating this order',
  ],
]);

const SERVICE_JOB = defineMachine('SERVICE_JOB', SERVICE_JOB_STATES, [
  ['REQUESTED', ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'], 'provider response or ambiguity'],
  [
    'UNKNOWN',
    [
      'ACCEPTED',
      'REJECTED',
      'SCHEDULED',
      'RESCHEDULED',
      'NO_SHOW',
      'EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
      'WORK_REPORTED_COMPLETE',
      'CANCELLED',
      'FAILED',
    ],
    'reconciliation evidence only',
  ],
  ['ACCEPTED', ['SCHEDULED', 'RESCHEDULED', 'CANCELLED', 'FAILED', 'UNKNOWN'], 'provider update'],
  [
    ['SCHEDULED', 'RESCHEDULED'],
    ['SCHEDULED', 'EN_ROUTE', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    'provider schedule update (table lists SCHEDULED/RESCHEDULED -> SCHEDULED and RESCHEDULED literally)',
  ],
  ['EN_ROUTE', ['ARRIVED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'FAILED', 'UNKNOWN'], 'technician/provider update'],
  ['ARRIVED', ['IN_PROGRESS', 'SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'FAILED'], 'onsite update'],
  [
    'IN_PROGRESS',
    ['WORK_REPORTED_COMPLETE', 'SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    'onsite update',
  ],
  ['WORK_REPORTED_COMPLETE', ['VERIFIED', 'DISPUTED'], 'work evidence; not recovery proof'],
  ['SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'an accepted scope creates a new revision/action lineage'],
]);

const RECOVERY_EVALUATION = defineMachine('RECOVERY_EVALUATION', RECOVERY_EVALUATION_STATES, [
  ['PENDING', 'OBSERVING', 'verified intervention milestone froze the observation boundary'],
  ['OBSERVING', 'PASSED', 'complete configured evidence set over a continuous LIVE window strictly after the boundary'],
  ['OBSERVING', 'FAILED', 'regression, invalid evidence or missing mandatory signal'],
  ['OBSERVING', 'EXPIRED', 'policy deadline passed without a passing window'],
]);

const DEVICE_HEALTH = defineMachine('DEVICE_HEALTH', DEVICE_HEALTH_STATES, [
  ['PROVISIONED', 'ONLINE', 'first authenticated sample'],
  ['ONLINE', 'STALE', 'freshness threshold exceeded'],
  ['STALE', 'OFFLINE', 'offline threshold exceeded'],
  [['STALE', 'OFFLINE'], 'ONLINE', 'fresh authenticated sample; reconnection never backdates freshness'],
  [
    ['PROVISIONED', 'ONLINE', 'STALE', 'OFFLINE'],
    'REVOKED',
    'credential revoked; device can no longer contribute proof',
  ],
]);

export const MACHINES = Object.freeze({
  INCIDENT,
  EVIDENCE_REVISION,
  COMPATIBILITY_LIFECYCLE,
  RECOVERY_PLAN,
  EXECUTION_AUTHORITY,
  KITE_SESSION,
  EXTERNAL_ACTION,
  ATTEMPT_TRANSPORT,
  ECONOMIC_INTENT,
  PURCHASE_ORDER,
  SERVICE_JOB,
  RECOVERY_EVALUATION,
  DEVICE_HEALTH,
});
export type MachineName = keyof typeof MACHINES;
export type MachineState<M extends MachineName> = (typeof MACHINES)[M]['states'][number];
export const MACHINE_NAMES = Object.freeze(Object.keys(MACHINES)) as readonly MachineName[];
