// T-005 — Contract schema round trip: every public command, event, state, money, measurement, evidence and error
// schema serializes, validates, and rejects additional or malformed critical fields.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/index.js';
import { ID_PREFIXES, decodeWire, encodeWire } from '../src/index.js';

type Fixture = {
  valid: unknown;
  /** Objects must reject an unexpected top-level key; primitives/enums have no keys. */
  object: boolean;
  malformed: Record<string, unknown>;
};

const id = (kind: keyof typeof ID_PREFIXES, body = 'fixture01') => `${ID_PREFIXES[kind]}_${body}`;
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const vdig = (domain: string, c: string) => `${domain}.v1:sha256:${c.repeat(64)}`;
const T0 = '2026-11-04T10:00:00.000Z';
const T1 = '2026-11-04T10:15:00.000Z';
const T2 = '2026-11-04T11:00:00.000Z';

/** Deep clone and set (or delete, with `undefined`) one dotted path. */
function withPath(value: unknown, dotted: string, next: unknown): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  const keys = dotted.split('.');
  let cursor: Record<string, unknown> = copy;
  for (const k of keys.slice(0, -1)) cursor = cursor[k] as Record<string, unknown>;
  const last = keys[keys.length - 1] as string;
  if (next === undefined) delete cursor[last];
  else cursor[last] = next;
  return copy;
}

const money = { amountMinor: '48200', currency: 'USD' };
const temperature = {
  milliCelsius: 3556,
  source: { unit: 'FAHRENHEIT', value: '38.4' },
  conversion: 'ROUNDED_HALF_EVEN',
};
const evidenceRef = { blobId: id('blob'), digest: sha('a') };
const citation = {
  citationId: id('citation'),
  tenantId: id('tenant'),
  evidenceRevisionId: id('evidenceRevision'),
  blobId: id('blob'),
  sourceDigest: sha('a'),
  locator: { kind: 'PAGE', page: 12, pageEnd: 13 },
  quotedDigest: sha('b'),
  extractionMethod: 'PDF_TEXT',
};
const evidenceItem = { blobId: id('blob'), role: 'MANUAL', sourceDigest: sha('a'), sourceAt: T0, locator: null };
const manifest = {
  evidenceRevisionId: id('evidenceRevision'),
  tenantId: id('tenant'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  revision: 2,
  previousRevisionId: id('evidenceRevision', 'previous01'),
  state: 'COMMITTED',
  items: [evidenceItem],
  citations: [citation],
  createdAt: T1,
};
const correlation = { correlationId: id('correlation'), causationId: id('command') };
const envelope = {
  schemaVersion: 1,
  evidenceId: id('evidence'),
  tenantId: id('tenant'),
  sequence: 2,
  kind: 'POLICY_DECISION',
  trust: 'AUTHORITATIVE',
  subject: { aggregateType: 'compatibility_decision', aggregateId: id('compatibilityDecision') },
  incidentId: id('incident'),
  recordedAt: T1,
  correlation,
  payloadSchema: 'compatibility.decision.v1',
  payloadDigest: sha('c'),
  payloadRef: null,
  supersedesEvidenceId: null,
  previousEnvelopeDigest: vdig('evidence-envelope', 'd'),
  envelopeDigest: vdig('evidence-envelope', 'e'),
};
const actor = { kind: 'USER', userId: id('user') };
const command = {
  schemaVersion: 1,
  commandId: id('command'),
  commandType: 'incident.pause.v1',
  tenantId: id('tenant'),
  actor,
  idempotencyKey: 'idem-fixture-0001',
  expectedVersion: 3,
  correlationId: id('correlation'),
  causationId: null,
  issuedAt: T0,
  payload: { reasonCode: 'OPERATOR_PAUSE' },
};
const eventBase = {
  eventId: id('event'),
  occurredAt: T1,
  tenantId: id('tenant'),
  aggregateVersion: 4,
  correlationId: id('correlation'),
  causationId: id('command'),
  schemaVersion: 1,
};
const incidentChanged = {
  ...eventBase,
  eventType: 'incident.state_changed.v1',
  aggregateType: 'incident',
  aggregateId: id('incident'),
  payload: {
    incidentId: id('incident'),
    from: 'AWAITING_APPROVAL',
    to: 'PLANNING',
    reasonCode: 'PRE_EGRESS_INVALIDATION',
    pausedFromState: null,
  },
};
const sendStarted = {
  ...eventBase,
  eventType: 'external_attempt.send_started.v1',
  aggregateType: 'external_attempt',
  aggregateId: id('externalAttempt'),
  payload: {
    externalAttemptId: id('externalAttempt'),
    commercialIntentId: id('commercialIntent'),
    providerAccountRevisionId: id('providerAccountRevision'),
    clientOperationId: id('clientOperation'),
    idempotencyKey: 'idem-fixture-0002',
    requestDigest: sha('f'),
    transportState: 'SEND_STARTED',
    externalOutcomeState: 'AUTHORIZED',
    economicIntentState: 'RESERVED',
    reserved: money,
  },
};
const purchaseChanged = {
  ...eventBase,
  eventType: 'purchase_order.state_changed.v1',
  aggregateType: 'purchase_order',
  aggregateId: id('purchaseOrder'),
  payload: {
    purchaseOrderId: id('purchaseOrder'),
    from: 'ORDERED',
    to: 'PARTIALLY_FILLED',
    rawProviderStatus: 'partial',
    rawEvidence: evidenceRef,
  },
};
const serviceChanged = {
  ...eventBase,
  eventType: 'service_job.state_changed.v1',
  aggregateType: 'service_job',
  aggregateId: id('serviceJob'),
  payload: {
    serviceJobId: id('serviceJob'),
    from: 'EN_ROUTE',
    to: 'ARRIVED',
    rawProviderStatus: null,
    rawEvidence: null,
  },
};
const authorityChanged = {
  ...eventBase,
  eventType: 'execution_authority.state_changed.v1',
  aggregateType: 'execution_authority',
  aggregateId: id('executionAuthority'),
  payload: {
    executionAuthorityId: id('executionAuthority'),
    from: 'ACTIVE',
    to: 'SUSPENDED',
    reasonCode: 'OPERATOR_SUSPEND',
    effectiveAt: T1,
  },
};
const sessionChanged = {
  ...eventBase,
  eventType: 'execution_authority.session_changed.v1',
  aggregateType: 'execution_authority',
  aggregateId: id('executionAuthority'),
  payload: {
    executionAuthorityId: id('executionAuthority'),
    kiteSessionId: id('kiteSession'),
    transportState: 'UNKNOWN',
    externalOutcomeState: 'UNKNOWN',
    adapterCapability: 'ELIGIBLE',
    providerSessionRef: null,
  },
};
const recoveryAssessed = {
  ...eventBase,
  eventType: 'recovery.assessed.v1',
  aggregateType: 'recovery_evaluation',
  aggregateId: id('recoveryEvaluation'),
  payload: {
    recoveryEvaluationId: id('recoveryEvaluation'),
    incidentId: id('incident'),
    from: 'OBSERVING',
    to: 'PASSED',
    reasonCode: null,
  },
};
const genericEvent = {
  ...eventBase,
  eventType: 'telemetry.stale.v1',
  aggregateType: 'device',
  aggregateId: id('device'),
  payload: { deviceId: id('device') },
};
const action = {
  kind: 'PART_PURCHASE',
  subjectId: id('candidateAction'),
  quantity: 1,
  partNumber: 'MPN-4471-B',
  manufacturer: 'Acme Refrigeration',
};
const digestInput = {
  tenantId: id('tenant'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  evidenceRevisionId: id('evidenceRevision'),
  policyRevisionId: id('policyRevision'),
  action,
  providerAccountRevisionId: id('providerAccountRevision'),
  merchantId: id('merchant'),
  amount: money,
  purpose: 'COMPRESSOR_RELAY_REPLACEMENT',
};
const authority = {
  executionAuthorityId: id('executionAuthority'),
  tenantId: id('tenant'),
  approvalId: id('approval'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  evidenceRevisionId: id('evidenceRevision'),
  policyRevisionId: id('policyRevision'),
  planHash: vdig('plan', '1'),
  actionDigest: vdig('action', '2'),
  providerAccountRevisionId: id('providerAccountRevision'),
  merchantId: id('merchant'),
  purpose: 'COMPRESSOR_RELAY_REPLACEMENT',
  allowedActionKinds: ['PART_PURCHASE'],
  perActionLimit: money,
  baseLimit: { amountMinor: '50000', currency: 'USD' },
  issuedAt: T0,
  expiresAt: T2,
  status: 'ACTIVE',
  signatureDigest: sha('3'),
  version: 1,
};
const kiteSession = {
  kiteSessionId: id('kiteSession'),
  tenantId: id('tenant'),
  executionAuthorityId: id('executionAuthority'),
  providerAccountRevisionId: id('providerAccountRevision'),
  clientOperationId: id('clientOperation'),
  idempotencyKey: 'idem-fixture-0003',
  requestDigest: sha('4'),
  transportState: 'SEND_STARTED',
  externalOutcomeState: 'UNKNOWN',
  adapterCapability: 'ELIGIBLE',
  providerSessionRef: null,
  nextReconcileAt: T1,
};
const intent = {
  commercialIntentId: id('commercialIntent'),
  tenantId: id('tenant'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  subject: { type: 'PLAN_ACTION', id: id('candidateAction') },
  approvalId: id('approval'),
  executionAuthorityId: id('executionAuthority'),
  providerAccountRevisionId: id('providerAccountRevision'),
  actionDigest: vdig('action', '2'),
  maxAmount: money,
  state: 'CREATED',
  supersedesIntentId: null,
  version: 1,
  createdAt: T0,
};
const attempt = {
  externalAttemptId: id('externalAttempt'),
  tenantId: id('tenant'),
  commercialIntentId: id('commercialIntent'),
  providerAccountRevisionId: id('providerAccountRevision'),
  clientOperationId: id('clientOperation'),
  idempotencyKey: 'idem-fixture-0004',
  requestDigest: sha('5'),
  transportState: 'PREPARED',
  externalOutcomeState: 'AUTHORIZED',
  adapterCapability: 'ELIGIBLE',
  providerRef: null,
  rawProviderStatus: null,
  nextReconcileAt: null,
};

const enumFixture = (valid: string, wrong: string): Fixture => ({
  valid,
  object: false,
  malformed: { 'foreign word': wrong, lowercase: valid.toLowerCase(), number: 1 },
});

const fixtures: Record<string, Fixture> = {
  // Money and measurement
  CurrencyCodeSchema: enumFixture('USD', 'XYZ'),
  MinorUnitsSchema: { valid: '48200', object: false, malformed: { float: 1.5, negative: '-1', exponent: '1e3' } },
  MoneySchema: {
    valid: money,
    object: true,
    malformed: {
      'float amount': withPath(money, 'amountMinor', 482.5),
      'unknown currency': withPath(money, 'currency', 'XXX'),
      'missing currency': withPath(money, 'currency', undefined),
    },
  },
  SignedMoneySchema: {
    valid: { amountMinor: '-150', currency: 'EUR' },
    object: true,
    malformed: {
      'float amount': { amountMinor: -1.5, currency: 'EUR' },
      'padded string': { amountMinor: '-01', currency: 'EUR' },
    },
  },
  DecimalStringSchema: {
    valid: '-12.375',
    object: false,
    malformed: { exponent: '1e2', comma: '1,5', 'negative zero': '-0' },
  },
  TemperatureUnitSchema: enumFixture('CELSIUS', 'RANKINE'),
  TemperatureReadingSchema: {
    valid: temperature,
    object: true,
    malformed: {
      'unit confusion': withPath(temperature, 'milliCelsius', 38400),
      'float canonical': withPath(temperature, 'milliCelsius', 3555.6),
      'nested extra': withPath(temperature, 'source.scale', 1),
      'wrong conversion label': withPath(temperature, 'conversion', 'EXACT'),
    },
  },
  MeasurementSchema: {
    valid: { kind: 'TEMPERATURE', temperature },
    object: true,
    malformed: {
      'unknown kind': { kind: 'HUMIDITY', value: 1 },
      'current as float': { kind: 'CURRENT', milliAmperes: 1.5 },
      'power negative': { kind: 'POWER', milliWatts: -1 },
    },
  },
  // Time, probability, digests, codes
  UtcInstantSchema: {
    valid: T0,
    object: false,
    malformed: { offset: '2026-11-04T10:00:00.000+00:00', 'no millis': '2026-11-04T10:00:00Z' },
  },
  DurationMsSchema: { valid: 900_000, object: false, malformed: { float: 0.5, negative: -1, string: '1' } },
  IanaTimezoneSchema: { valid: 'Europe/London', object: false, malformed: { invalid: 'Mars/Olympus', empty: '' } },
  PpmSchema: { valid: 12_500, object: false, malformed: { float: 0.5, 'over one': 1_000_001 } },
  Sha256DigestSchema: {
    valid: sha('a'),
    object: false,
    malformed: { upper: `sha256:${'A'.repeat(64)}`, short: 'sha256:abc' },
  },
  VersionedDigestSchema: {
    valid: vdig('action', 'a'),
    object: false,
    malformed: { unversioned: sha('a'), 'version zero': `action.v0:sha256:${'a'.repeat(64)}` },
  },
  PurposeCodeSchema: {
    valid: 'COMPRESSOR_RELAY_REPLACEMENT',
    object: false,
    malformed: { lower: 'purpose', spaces: 'A B' },
  },
  ReasonCodeSchema: { valid: 'MISSING_EXACT_MPN', object: false, malformed: { lower: 'missing', empty: '' } },
  ProviderRefSchema: {
    valid: 'ord-2207',
    object: false,
    malformed: { empty: '', whitespace: 'a b', long: 'x'.repeat(257) },
  },
  OpaqueIdSchema: { valid: id('incident'), object: false, malformed: { noPrefix: 'fixture01', short: 'inc_ab' } },
  IdempotencyKeySchema: {
    valid: 'idem-fixture-0001',
    object: false,
    malformed: { short: 'k', spaces: 'idem key 0001' },
  },
  SchemaNameSchema: {
    valid: 'compatibility.decision.v1',
    object: false,
    malformed: { unversioned: 'compatibility.decision' },
  },
  CommandTypeSchema: { valid: 'incident.pause.v1', object: false, malformed: { upper: 'Incident.Pause.v1' } },
  StateNameSchema: { valid: 'AWAITING_APPROVAL', object: false, malformed: { lower: 'paused' } },
  // State vocabularies (separate axes)
  IncidentStateSchema: enumFixture('AWAITING_APPROVAL', 'CLOSED'),
  EvidenceRevisionStateSchema: enumFixture('COMMITTED', 'APPROVED'),
  CompatibilityDecisionValueSchema: enumFixture('HOLD', 'UNEVALUATED'),
  CompatibilityLifecycleSchema: enumFixture('SUPERSEDED', 'ALLOW'),
  RecoveryPlanStateSchema: enumFixture('APPROVABLE', 'PAUSED'),
  ExecutionAuthorityStateSchema: enumFixture('SUSPENDED', 'CONFIRMED'),
  KiteSessionStateSchema: enumFixture('UNKNOWN', 'ACTIVE'),
  ExternalOutcomeStateSchema: enumFixture('ACCEPTED', 'SUBMITTED'),
  AdapterCapabilitySchema: enumFixture('UNSUPPORTED', 'UNKNOWN'),
  AttemptTransportStateSchema: enumFixture('SEND_STARTED', 'REQUESTED'),
  EconomicIntentStateSchema: enumFixture('SUBMITTED', 'ACCEPTED'),
  PurchaseOrderStateSchema: enumFixture('PARTIALLY_FILLED', 'ARRIVED'),
  ServiceJobStateSchema: enumFixture('ARRIVED', 'SHIPPED'),
  RecoveryEvaluationStateSchema: enumFixture('OBSERVING', 'RECOVERED'),
  DeviceHealthStateSchema: enumFixture('STALE', 'HEALTHY'),
  ActionKindSchema: enumFixture('PART_PURCHASE', 'FREE_TEXT'),
  EventTypeSchema: enumFixture('commercial_intent.state_changed.v1', 'commercial_intent.state_changed.v2'),
  AggregateTypeSchema: enumFixture('commercial_intent', 'wallet'),
  ErrorClassSchema: enumFixture('DEPENDENCY_UNKNOWN', 'TIMEOUT'),
  ErrorCodeSchema: enumFixture('STATE_TRANSITION_INVALID', 'OOPS'),
  EvidenceRecordKindSchema: enumFixture('MODEL_PROPOSAL', 'GOSSIP'),
  EvidenceTrustSchema: enumFixture('CONTRACT_FAKE', 'TRUSTED'),
  EvidenceItemRoleSchema: enumFixture('MANUAL', 'RUMOUR'),
  ExtractionMethodSchema: enumFixture('OCR', 'GUESS'),
  // Adapter outcomes
  AdapterCapabilityAssessmentSchema: {
    valid: { kind: 'UNSUPPORTED', reasonCode: 'NO_AUTHORITATIVE_LOOKUP' },
    object: true,
    malformed: { 'missing reason': { kind: 'UNSUPPORTED' }, 'unknown kind': { kind: 'MAYBE' } },
  },
  EvidenceRefSchema: {
    valid: evidenceRef,
    object: true,
    malformed: {
      'bad digest': withPath(evidenceRef, 'digest', 'md5:x'),
      'wrong id kind': withPath(evidenceRef, 'blobId', id('tenant')),
    },
  },
  ExternalOutcomeResultSchema: {
    valid: {
      kind: 'UNKNOWN',
      clientOperationId: id('clientOperation'),
      reconcileAfter: T1,
      observedAt: T0,
      rawResponseDigest: null,
    },
    object: true,
    malformed: {
      'failed without proof': {
        kind: 'FAILED',
        clientOperationId: id('clientOperation'),
        reasonCode: 'TIMEOUT',
        effect: 'ASSUMED',
        observedAt: T0,
        rawResponseDigest: sha('a'),
      },
      'unknown without reconcile time': {
        kind: 'UNKNOWN',
        clientOperationId: id('clientOperation'),
        observedAt: T0,
        rawResponseDigest: null,
      },
      'confirmed without receipt': {
        kind: 'CONFIRMED',
        clientOperationId: id('clientOperation'),
        observedAt: T0,
        rawResponseDigest: sha('a'),
      },
    },
  },
  // Evidence
  CitationLocatorSchema: {
    valid: { kind: 'TIME_RANGE', fromAt: T0, toAt: T1 },
    object: true,
    malformed: {
      'reversed range': { kind: 'TIME_RANGE', fromAt: T1, toAt: T0 },
      'page zero': { kind: 'PAGE', page: 0, pageEnd: null },
      'page end before start': { kind: 'PAGE', page: 5, pageEnd: 4 },
    },
  },
  CitationSchema: {
    valid: citation,
    object: true,
    malformed: {
      'nested extra': withPath(citation, 'locator.confidence', 0.9),
      'missing quoted digest': withPath(citation, 'quotedDigest', undefined),
    },
  },
  EvidenceItemSchema: {
    valid: evidenceItem,
    object: true,
    malformed: {
      'bad digest': withPath(evidenceItem, 'sourceDigest', 'x'),
      'bad time': withPath(evidenceItem, 'sourceAt', 'today'),
    },
  },
  EvidenceRevisionManifestSchema: {
    valid: manifest,
    object: true,
    malformed: {
      'revision one with predecessor': withPath(manifest, 'revision', 1),
      'citation outside manifest': withPath(manifest, 'citations', [{ ...citation, blobId: id('blob', 'elsewhere1') }]),
      'citation other tenant': withPath(manifest, 'citations', [
        { ...citation, tenantId: id('tenant', 'othertenant') },
      ]),
      'citation digest mismatch': withPath(manifest, 'citations', [{ ...citation, sourceDigest: sha('9') }]),
    },
  },
  CorrelationSchema: {
    valid: correlation,
    object: true,
    malformed: { 'causation wrong kind': withPath(correlation, 'causationId', id('tenant')) },
  },
  EvidenceEnvelopeSchema: {
    valid: envelope,
    object: true,
    malformed: {
      'first entry with predecessor digest': withPath(envelope, 'sequence', 1),
      'self supersession': withPath(envelope, 'supersedesEvidenceId', id('evidence')),
      'nested extra': withPath(envelope, 'correlation.trace', 'x'),
      'float sequence': withPath(envelope, 'sequence', 1.5),
    },
  },
  // Commands
  ActorSchema: { valid: actor, object: true, malformed: { 'wrong id kind': { kind: 'USER', userId: id('device') } } },
  CommandEnvelopeSchema: {
    valid: command,
    object: true,
    malformed: {
      'missing idempotency key': withPath(command, 'idempotencyKey', undefined),
      'negative expected version': withPath(command, 'expectedVersion', -1),
      'schema major 2': withPath(command, 'schemaVersion', 2),
    },
  },
  CommandAcceptedSchema: {
    valid: {
      commandId: id('command'),
      aggregateType: 'commercial_intent',
      aggregateId: id('commercialIntent'),
      aggregateVersion: 1,
      state: 'CREATED',
      acceptedAt: T0,
    },
    object: true,
    malformed: {
      'version zero': {
        commandId: id('command'),
        aggregateType: 'commercial_intent',
        aggregateId: id('commercialIntent'),
        aggregateVersion: 0,
        state: 'CREATED',
        acceptedAt: T0,
      },
    },
  },
  // Events
  DomainEventEnvelopeSchema: {
    valid: genericEvent,
    object: true,
    malformed: {
      'unknown event type': withPath(genericEvent, 'eventType', 'telemetry.stale.v9'),
      'aggregate type mismatch': withPath(genericEvent, 'aggregateType', 'incident'),
      'unknown major schema version': withPath(genericEvent, 'schemaVersion', 2),
      'missing causation': withPath(genericEvent, 'causationId', undefined),
    },
  },
  IncidentStateChangedPayloadSchema: {
    valid: incidentChanged.payload,
    object: true,
    malformed: { 'foreign state': withPath(incidentChanged.payload, 'to', 'FAILED') },
  },
  IncidentStateChangedEventSchema: {
    valid: incidentChanged,
    object: true,
    malformed: {
      'aggregate id differs from payload': withPath(incidentChanged, 'aggregateId', id('incident', 'another01')),
      'payload extra': withPath(incidentChanged, 'payload.note', 'x'),
    },
  },
  ExternalAttemptSendStartedPayloadSchema: {
    valid: sendStarted.payload,
    object: true,
    malformed: {
      'send started claims REQUESTED': withPath(sendStarted.payload, 'externalOutcomeState', 'REQUESTED'),
      'intent not reserved': withPath(sendStarted.payload, 'economicIntentState', 'SUBMITTED'),
    },
  },
  ExternalAttemptSendStartedEventSchema: {
    valid: sendStarted,
    object: true,
    malformed: { 'float reserved amount': withPath(sendStarted, 'payload.reserved.amountMinor', 1.25) },
  },
  PurchaseOrderStateChangedPayloadSchema: {
    valid: purchaseChanged.payload,
    object: true,
    malformed: { 'service word in purchase': withPath(purchaseChanged.payload, 'to', 'ARRIVED') },
  },
  PurchaseOrderStateChangedEventSchema: {
    valid: purchaseChanged,
    object: true,
    malformed: { 'wrong aggregate type': withPath(purchaseChanged, 'aggregateType', 'service_job') },
  },
  ServiceJobStateChangedPayloadSchema: {
    valid: serviceChanged.payload,
    object: true,
    malformed: { 'purchase word in service': withPath(serviceChanged.payload, 'to', 'SHIPPED') },
  },
  ServiceJobStateChangedEventSchema: {
    valid: serviceChanged,
    object: true,
    malformed: { 'wrong event type': withPath(serviceChanged, 'eventType', 'purchase_order.state_changed.v1') },
  },
  ExecutionAuthorityStateChangedPayloadSchema: {
    valid: authorityChanged.payload,
    object: true,
    malformed: { 'session word': withPath(authorityChanged.payload, 'to', 'CONFIRMED') },
  },
  ExecutionAuthorityStateChangedEventSchema: {
    valid: authorityChanged,
    object: true,
    malformed: { 'payload extra': withPath(authorityChanged, 'payload.limit', 1) },
  },
  ExecutionAuthoritySessionChangedPayloadSchema: {
    valid: sessionChanged.payload,
    object: true,
    malformed: { 'combined status': withPath(sessionChanged.payload, 'externalOutcomeState', 'ACTIVE') },
  },
  ExecutionAuthoritySessionChangedEventSchema: {
    valid: sessionChanged,
    object: true,
    malformed: { 'missing transport axis': withPath(sessionChanged, 'payload.transportState', undefined) },
  },
  RecoveryAssessedPayloadSchema: {
    valid: recoveryAssessed.payload,
    object: true,
    malformed: { 'incident word': withPath(recoveryAssessed.payload, 'to', 'RECOVERED') },
  },
  RecoveryAssessedEventSchema: {
    valid: recoveryAssessed,
    object: true,
    malformed: { 'version zero': withPath(recoveryAssessed, 'aggregateVersion', 0) },
  },
  // Errors
  ApiErrorBodySchema: {
    valid: {
      error: {
        code: 'POLICY_HOLD',
        errorClass: 'POLICY_HOLD',
        reasonCode: 'SUBSTITUTE_REQUIRES_NAMED_APPROVAL',
        message: 'This action cannot execute under the current approval.',
        correlationId: id('correlation'),
        currentRevision: 5,
      },
    },
    object: true,
    malformed: {
      'class does not match code': {
        error: { code: 'POLICY_HOLD', errorClass: 'INTERNAL', message: 'x', correlationId: id('correlation') },
      },
      'nested extra (stack)': {
        error: {
          code: 'INTERNAL',
          errorClass: 'INTERNAL',
          message: 'x',
          correlationId: id('correlation'),
          stack: 'at ...',
        },
      },
    },
  },
  // Domain records
  ActionDescriptorSchema: {
    valid: action,
    object: true,
    malformed: {
      'zero quantity': withPath(action, 'quantity', 0),
      'float quantity': withPath(action, 'quantity', 1.5),
      'padded part number': withPath(action, 'partNumber', ' MPN-4471-B'),
    },
  },
  ActionDigestInputSchema: {
    valid: digestInput,
    object: true,
    malformed: {
      'missing provider-account revision': withPath(digestInput, 'providerAccountRevisionId', undefined),
      'unbound extra field': withPath(digestInput, 'note', 'free text'),
      'nested action extra': withPath(digestInput, 'action.colour', 'blue'),
    },
  },
  IncidentSchema: {
    valid: {
      incidentId: id('incident'),
      tenantId: id('tenant'),
      siteId: id('site'),
      assetId: id('asset'),
      assetRevisionId: id('assetRevision'),
      state: 'PAUSED',
      pausedFromState: 'EXECUTING',
      version: 7,
      openedAt: T0,
      updatedAt: T1,
    },
    object: true,
    malformed: {
      'paused without prior': {
        incidentId: id('incident'),
        tenantId: id('tenant'),
        siteId: id('site'),
        assetId: id('asset'),
        assetRevisionId: id('assetRevision'),
        state: 'PAUSED',
        pausedFromState: null,
        version: 7,
        openedAt: T0,
        updatedAt: T1,
      },
      'prior on non-paused': {
        incidentId: id('incident'),
        tenantId: id('tenant'),
        siteId: id('site'),
        assetId: id('asset'),
        assetRevisionId: id('assetRevision'),
        state: 'PLANNING',
        pausedFromState: 'EXECUTING',
        version: 7,
        openedAt: T0,
        updatedAt: T1,
      },
    },
  },
  CompatibilityDecisionSchema: {
    valid: {
      compatibilityDecisionId: id('compatibilityDecision'),
      tenantId: id('tenant'),
      candidateActionId: id('candidateAction'),
      assetRevisionId: id('assetRevision'),
      evidenceRevisionId: id('evidenceRevision'),
      policyRevisionId: id('policyRevision'),
      actionDigest: vdig('action', '2'),
      decision: 'HOLD',
      lifecycle: 'CURRENT',
      reasonCodes: ['MISSING_EXACT_MPN'],
      ruleVersion: 'compat-1.0.0',
      inputDigest: vdig('compatibility-input', '6'),
      decidedAt: T0,
    },
    object: true,
    malformed: {
      'hold without reason': {
        compatibilityDecisionId: id('compatibilityDecision'),
        tenantId: id('tenant'),
        candidateActionId: id('candidateAction'),
        assetRevisionId: id('assetRevision'),
        evidenceRevisionId: id('evidenceRevision'),
        policyRevisionId: id('policyRevision'),
        actionDigest: vdig('action', '2'),
        decision: 'HOLD',
        lifecycle: 'CURRENT',
        reasonCodes: [],
        ruleVersion: 'compat-1.0.0',
        inputDigest: vdig('compatibility-input', '6'),
        decidedAt: T0,
      },
    },
  },
  ExecutionAuthoritySchema: {
    valid: authority,
    object: true,
    malformed: {
      'per-action above base': withPath(authority, 'perActionLimit', { amountMinor: '50001', currency: 'USD' }),
      'currency split': withPath(authority, 'perActionLimit', { amountMinor: '100', currency: 'EUR' }),
      'expires before issue': withPath(authority, 'expiresAt', '2026-11-04T09:00:00.000Z'),
      'no allowed actions': withPath(authority, 'allowedActionKinds', []),
      'combined status': withPath(authority, 'status', 'CONFIRMED'),
    },
  },
  KiteSessionSchema: {
    valid: kiteSession,
    object: true,
    malformed: {
      'unknown hides next reconcile time': withPath(kiteSession, 'nextReconcileAt', null),
      'prepared but requested': withPath(
        withPath(kiteSession, 'transportState', 'PREPARED'),
        'externalOutcomeState',
        'REQUESTED',
      ),
    },
  },
  CommercialIntentSubjectSchema: {
    valid: { type: 'PROVIDER_CONTACT_REQUEST', id: 'pcr_fixture01' },
    object: true,
    malformed: { 'unknown subject type': { type: 'FREE_TEXT', id: 'pcr_fixture01' } },
  },
  CommercialIntentSchema: {
    valid: intent,
    object: true,
    malformed: {
      'external word as economic state': withPath(intent, 'state', 'ACCEPTED'),
      'float max': withPath(intent, 'maxAmount.amountMinor', 1.1),
    },
  },
  ExternalAttemptSchema: {
    valid: attempt,
    object: true,
    malformed: {
      'prepared but requested': withPath(attempt, 'externalOutcomeState', 'REQUESTED'),
      'single overloaded status': withPath(withPath(attempt, 'transportState', undefined), 'status', 'UNKNOWN'),
    },
  },
  PurchaseOrderSchema: {
    valid: {
      purchaseOrderId: id('purchaseOrder'),
      tenantId: id('tenant'),
      commercialIntentId: id('commercialIntent'),
      providerAccountRevisionId: id('providerAccountRevision'),
      providerRef: 'ord-2207',
      state: 'SHIPPED',
      quantity: 2,
      version: 3,
    },
    object: true,
    malformed: {
      'service state': {
        purchaseOrderId: id('purchaseOrder'),
        tenantId: id('tenant'),
        commercialIntentId: id('commercialIntent'),
        providerAccountRevisionId: id('providerAccountRevision'),
        providerRef: null,
        state: 'EN_ROUTE',
        quantity: 2,
        version: 3,
      },
    },
  },
  ServiceJobSchema: {
    valid: {
      serviceJobId: id('serviceJob'),
      tenantId: id('tenant'),
      commercialIntentId: id('commercialIntent'),
      providerAccountRevisionId: id('providerAccountRevision'),
      providerRef: null,
      state: 'WORK_REPORTED_COMPLETE',
      version: 9,
    },
    object: true,
    malformed: {
      'purchase state': {
        serviceJobId: id('serviceJob'),
        tenantId: id('tenant'),
        commercialIntentId: id('commercialIntent'),
        providerAccountRevisionId: id('providerAccountRevision'),
        providerRef: null,
        state: 'DELIVERED',
        version: 9,
      },
    },
  },
  RecoveryEvaluationSchema: {
    valid: {
      recoveryEvaluationId: id('recoveryEvaluation'),
      tenantId: id('tenant'),
      incidentId: id('incident'),
      assetRevisionId: id('assetRevision'),
      planId: id('plan'),
      actionDigest: vdig('action', '2'),
      evidenceRevisionId: id('evidenceRevision'),
      policyRevisionId: id('policyRevision'),
      interventionMilestoneId: id('interventionMilestone'),
      observationBoundaryAt: T0,
      state: 'PASSED',
      window: { firstSampleAt: '2026-11-04T10:00:00.001Z', lastSampleAt: T2, sampleCount: 60 },
      stableDurationMs: 3_599_999,
      decidedAt: T2,
    },
    object: true,
    malformed: {
      'boundary-equal first sample': {
        recoveryEvaluationId: id('recoveryEvaluation'),
        tenantId: id('tenant'),
        incidentId: id('incident'),
        assetRevisionId: id('assetRevision'),
        planId: id('plan'),
        actionDigest: vdig('action', '2'),
        evidenceRevisionId: id('evidenceRevision'),
        policyRevisionId: id('policyRevision'),
        interventionMilestoneId: id('interventionMilestone'),
        observationBoundaryAt: T0,
        state: 'PASSED',
        window: { firstSampleAt: T0, lastSampleAt: T2, sampleCount: 60 },
        stableDurationMs: 3_600_000,
        decidedAt: T2,
      },
      'passed without window': {
        recoveryEvaluationId: id('recoveryEvaluation'),
        tenantId: id('tenant'),
        incidentId: id('incident'),
        assetRevisionId: id('assetRevision'),
        planId: id('plan'),
        actionDigest: vdig('action', '2'),
        evidenceRevisionId: id('evidenceRevision'),
        policyRevisionId: id('policyRevision'),
        interventionMilestoneId: id('interventionMilestone'),
        observationBoundaryAt: T0,
        state: 'PASSED',
        window: null,
        stableDurationMs: 0,
        decidedAt: T2,
      },
    },
  },
};

const idSchemaName = (kind: string) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}IdSchema`;
const exportedSchemas = Object.entries(contracts).filter(([name]) => name.endsWith('Schema')) as [string, z.ZodType][];
const idSchemaNames = new Set(Object.keys(ID_PREFIXES).map(idSchemaName));

describe('T-005 contract schema round trip', () => {
  it('covers every exported public schema with a fixture (no schema escapes the round-trip gate)', () => {
    const uncovered = exportedSchemas.map(([n]) => n).filter((n) => !(n in fixtures) && !idSchemaNames.has(n));
    expect(uncovered).toEqual([]);
    const stale = Object.keys(fixtures).filter((n) => !(n in contracts));
    expect(stale).toEqual([]);
  });

  for (const [name, fx] of Object.entries(fixtures)) {
    describe(name, () => {
      const schema = () => (contracts as unknown as Record<string, z.ZodType>)[name] as z.ZodType;

      it('decodes, encodes to JSON and decodes back to an equal value', () => {
        const decoded = decodeWire(schema(), fx.valid);
        const text = JSON.stringify(encodeWire(schema(), decoded));
        expect(decodeWire(schema(), JSON.parse(text))).toEqual(decoded);
      });

      if (fx.object)
        it('rejects an additional top-level field', () => {
          const extra = { ...(fx.valid as Record<string, unknown>), unexpectedField: 'x' };
          expect(z.safeDecode(schema(), extra).success).toBe(false);
        });

      for (const [label, bad] of Object.entries(fx.malformed))
        it(`rejects malformed critical field: ${label}`, () => {
          expect(z.safeDecode(schema(), bad).success).toBe(false);
        });
    });
  }

  describe('branded identifiers', () => {
    for (const [kind, prefix] of Object.entries(ID_PREFIXES)) {
      it(`${idSchemaName(kind)} accepts its prefix and rejects other kinds and malformed ids`, () => {
        const s = (contracts as unknown as Record<string, z.ZodType>)[idSchemaName(kind)] as z.ZodType;
        expect(s.safeParse(`${prefix}_fixture01`).success).toBe(true);
        const other = Object.values(ID_PREFIXES).find((p) => p !== prefix) as string;
        expect(s.safeParse(`${other}_fixture01`).success).toBe(false);
        for (const bad of [`${prefix}_`, `${prefix}_a b c d`, `${prefix}fixture01`, 42, `${prefix}_${'x'.repeat(65)}`])
          expect(s.safeParse(bad).success).toBe(false);
      });
    }
  });

  it('encodeWire validates in-memory values too and never emits bigint into JSON', () => {
    const decoded = decodeWire(contracts.CommercialIntentSchema, intent);
    expect(typeof decoded.maxAmount.amountMinor).toBe('bigint');
    const wire = encodeWire(contracts.CommercialIntentSchema, decoded);
    expect(JSON.parse(JSON.stringify(wire)).maxAmount.amountMinor).toBe('48200');
    expect(() =>
      encodeWire(contracts.CommercialIntentSchema, {
        ...decoded,
        maxAmount: { amountMinor: 482.5, currency: 'USD' },
      } as never),
    ).toThrow(contracts.DomainError);
  });

  it('decodeWire failures are typed VALIDATION_FAILED errors that report paths without echoing values', () => {
    try {
      decodeWire(contracts.MoneySchema, { amountMinor: 'sensitive-looking-value', currency: 'USD' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(contracts.DomainError);
      const err = e as InstanceType<typeof contracts.DomainError>;
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.errorClass).toBe('VALIDATION');
      expect(err.httpStatus).toBe(400);
      expect(JSON.stringify(err.details)).not.toContain('sensitive-looking-value');
      expect(err.details.fieldErrors).toEqual([expect.objectContaining({ path: 'amountMinor' })]);
    }
  });

  it('maps every error code to its taxonomy class and HTTP behaviour', () => {
    expect(contracts.ERROR_CLASS_HTTP_STATUS).toEqual({
      VALIDATION: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      CONFLICT: 409,
      POLICY_HOLD: 422,
      RATE_LIMIT: 429,
      DEPENDENCY_DEFINITE_FAILURE: 502,
      DEPENDENCY_UNKNOWN: 202,
      INTERNAL: 500,
    });
    const transition = new contracts.DomainError('STATE_TRANSITION_INVALID', 'Transition not allowed');
    expect([transition.errorClass, transition.httpStatus]).toEqual(['CONFLICT', 409]);
    const body = contracts.toApiErrorBody(new Error('db password leaked in stack'), id('correlation'));
    expect(body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('password');
    expect(contracts.ApiErrorBodySchema.safeParse(body).success).toBe(true);
  });

  it('publishes exactly the event catalog of API-EVENT-SPEC §6 (drift tripwire), including the broker events', () => {
    const spec = readFileSync(path.join(import.meta.dirname, '../../../docs/spec/API-EVENT-SPEC.md'), 'utf8');
    const section = spec.slice(spec.indexOf('## 6. Event catalog'), spec.indexOf('## 7.'));
    const specNames = [...section.matchAll(/^\| `([a-z_.0-9]+)`/gm)].map((m) => m[1]);
    expect(specNames).toHaveLength(37);
    expect([...contracts.EVENT_TYPES].sort()).toEqual([...specNames].sort());
    expect(contracts.EVENT_TYPES).toContain('commercial_intent.state_changed.v1');
    expect(contracts.EVENT_TYPES).toContain('external_attempt.send_started.v1');
    for (const t of contracts.EVENT_TYPES)
      expect(contracts.AggregateTypeSchema.safeParse(contracts.EVENT_CATALOG[t]).success).toBe(true);
  });
});
