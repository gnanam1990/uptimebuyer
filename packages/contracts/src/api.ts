// HTTP API contract for the operator surface (M12, API-EVENT-SPEC §1-2). One module shared by the API server
// (apps/api parses every request body/query/header with these schemas) and the typed client
// (packages/api-client decodes every response with them). Request schemas are strict: an unknown or extra field is
// a 400, so a client can never smuggle a tenant, site, actor or authority claim. Response schemas are loose objects
// over the fields a client relies on; state axes are closed enums, so an unrecognized value fails decoding instead of
// being rendered as a guess (INV-12). Money crosses the wire as decimal minor-unit strings.
import { z } from 'zod';
import { CitationSchema } from './evidence.js';
import { IdempotencyKeySchema, UserIdSchema } from './ids.js';
import {
  AdapterCapabilitySchema,
  AttemptTransportStateSchema,
  EconomicIntentStateSchema,
  ExecutionAuthorityStateSchema,
  ExternalOutcomeStateSchema,
  IncidentStateSchema,
} from './states.js';
import { UtcInstantSchema } from './time.js';

const BODY = '[A-Za-z0-9][A-Za-z0-9-]{3,63}';
/** A prefixed opaque id of a storage-local kind (`<prefix>_<body>`), checked at the route boundary. */
export const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${BODY}$`));
export const ReasonCodeWireSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const MinorUnitsWireSchema = z.string().regex(/^-?\d{1,19}$/);
export const MoneyWireSchema = z.looseObject({
  amountMinor: MinorUnitsWireSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const Instant = z.string().min(20).max(40);
const NullableInstant = Instant.nullable();

// ---------------------------------------------------------------------------------------------------------------
// Headers

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IF_MATCH_HEADER = 'if-match';
export const TENANT_HEADER = 'x-tenant-id';
export const CORRELATION_HEADER = 'x-correlation-id';
export const IdempotencyKeyHeaderSchema = IdempotencyKeySchema;
/** `If-Match: "<version>"` (a strong ETag carrying the aggregate version) or a bare positive integer. */
export const IfMatchHeaderSchema = z
  .string()
  .regex(/^(?:"[1-9]\d{0,9}"|[1-9]\d{0,9})$/)
  .transform((s) => Number(s.replace(/"/g, '')));

// ---------------------------------------------------------------------------------------------------------------
// Path parameters

export const PATH_IDS = Object.freeze({
  incidentId: prefixedId('inc'),
  assetId: prefixedId('ast'),
  assignmentId: prefixedId('ias'),
  citationId: prefixedId('cit'),
  planId: prefixedId('pln'),
  approvalRequestId: prefixedId('apq'),
  approvalId: prefixedId('apr'),
  executionAuthorityId: prefixedId('xau'),
  commercialIntentId: prefixedId('cin'),
  purchaseOrderId: prefixedId('pur'),
  serviceJobId: prefixedId('sjb'),
  orderId: z.string().regex(new RegExp(`^(?:pur|sjb)_${BODY}$`)),
  binding: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

// ---------------------------------------------------------------------------------------------------------------
// Request bodies (strict)

export const EmptyBodySchema = z.strictObject({});
export const AssignIncidentBodySchema = z.strictObject({
  assigneeUserId: UserIdSchema,
  reasonCode: ReasonCodeWireSchema,
  nextActionDueAt: UtcInstantSchema.optional(),
});
export const HandoffIncidentBodySchema = z.strictObject({
  nextOwnerUserId: UserIdSchema,
  reasonCode: ReasonCodeWireSchema,
  nextActionDueAt: UtcInstantSchema,
});
export const DEADLINE_EVENT_TYPES = Object.freeze(['PAUSE', 'RESUME', 'SHORTEN', 'EXTEND'] as const);
export const AdjustDeadlineBodySchema = z.strictObject({
  eventType: z.enum(DEADLINE_EVENT_TYPES),
  newDeadlineAt: UtcInstantSchema.optional(),
  reasonCode: ReasonCodeWireSchema,
});
export const EscalateIncidentBodySchema = z.strictObject({ reasonCode: ReasonCodeWireSchema });
export const ApprovePlanBodySchema = z.strictObject({
  approvalRequestId: PATH_IDS.approvalRequestId,
  planHash: z.string().min(16).max(160),
});
export const HoldPlanBodySchema = z.strictObject({
  approvalRequestId: PATH_IDS.approvalRequestId,
  reasonCode: ReasonCodeWireSchema,
});
export const IssueAuthorityBodySchema = z.strictObject({
  subject: z.strictObject({ type: z.literal('PLAN_ACTION'), id: prefixedId('cand') }),
});
export const AUTHORITY_STATUS_CHANGES = Object.freeze(['SUSPENDED', 'ACTIVE', 'REVOKED'] as const);
export const ChangeAuthorityBodySchema = z.strictObject({
  to: z.enum(AUTHORITY_STATUS_CHANGES),
  reasonCode: ReasonCodeWireSchema,
});
export const VerifyOrderBodySchema = z.strictObject({ outcome: z.enum(['VERIFIED', 'DISPUTED']) });
/** Policy bodies are re-validated server-side by the AUTHORITY policy schema; the wire bound is size only. */
export const PolicyDraftBodySchema = z.strictObject({
  body: z.record(z.string().max(64), z.unknown()),
  effectiveAt: UtcInstantSchema.optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Query strings (strict)

export const ListIncidentsQuerySchema = z.strictObject({
  siteId: prefixedId('sit').optional(),
  activeOnly: z.enum(['true', 'false']).optional(),
  states: z
    .string()
    .max(400)
    .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .optional(),
});
export const TelemetryQuerySchema = z.strictObject({
  windowMinutes: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .optional(),
});
export const AuditQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Responses (loose objects; closed enums on every state axis)

export const FRESHNESS_STATES_WIRE = Object.freeze(['FRESH', 'STALE', 'OFFLINE', 'INVALID'] as const);
export const FreshnessWireSchema = z.enum(FRESHNESS_STATES_WIRE);
/** Asset-level freshness adds NO_SIGNAL: no bound device has ever produced a usable reading. */
export const AssetFreshnessWireSchema = z.enum([...FRESHNESS_STATES_WIRE, 'NO_SIGNAL']);

export const PublicConfigSchema = z.looseObject({
  oidc: z.looseObject({
    issuer: z.string().min(1).max(500),
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
    clientId: z.string().min(1).max(200),
    audience: z.string().min(1).max(200),
    scope: z.string().min(1).max(200),
  }),
  /** Persistent environment label (e.g. NON_PRODUCTION / SEEDED_TEST_DATA); null only for production. */
  environmentLabel: z.string().max(80).nullable(),
});

export const RoleGrantWireSchema = z.looseObject({ role: z.string(), siteId: z.string().nullable() });
export const SessionSchema = z.looseObject({
  user: z.looseObject({ userId: z.string(), displayName: z.string() }),
  tenant: z.looseObject({ tenantId: z.string(), name: z.string() }),
  grants: z.array(RoleGrantWireSchema),
  sites: z.array(z.looseObject({ siteId: z.string(), name: z.string(), timezone: z.string() })),
  correlationId: z.string(),
});

const ChannelHealthWire = z.looseObject({
  channelId: z.string(),
  freshness: FreshnessWireSchema,
  statusReason: z.string().nullable().optional(),
  sourceTime: NullableInstant.optional(),
  ageMs: z.number().nullable().optional(),
});
export const DeviceHealthWireSchema = z.looseObject({
  deviceId: z.string(),
  inputClass: z.enum(['PHYSICAL_SENSOR', 'SIMULATOR']),
  freshness: FreshnessWireSchema,
  healthy: z.boolean(),
  statusReason: z.string().nullable(),
  sourceTime: NullableInstant,
  receiptTime: NullableInstant,
  ageMs: z.number().nullable(),
  freshnessThresholdMs: z.number(),
  offlineThresholdMs: z.number(),
  evaluatedAt: Instant,
  channels: z.array(ChannelHealthWire),
});
export const FleetAssetSchema = z.looseObject({
  assetId: z.string(),
  siteId: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  serial: z.string().nullable(),
  freshness: AssetFreshnessWireSchema,
  freshnessReason: z.string().nullable(),
  sourceTime: NullableInstant,
  inputOrigins: z.array(z.enum(['PHYSICAL_SENSOR', 'SIMULATOR'])),
  devices: z.array(DeviceHealthWireSchema),
  activeIncidentIds: z.array(z.string()),
});
export const FleetSchema = z.looseObject({
  asOf: Instant,
  sites: z.array(
    z.looseObject({ siteId: z.string(), name: z.string(), timezone: z.string(), assets: z.array(FleetAssetSchema) }),
  ),
  counts: z.looseObject({
    sites: z.number(),
    assetsFresh: z.number(),
    assetsStale: z.number(),
    assetsOffline: z.number(),
    assetsInvalid: z.number(),
    assetsNoSignal: z.number(),
    activeIncidents: z.number(),
    criticalIncidents: z.number(),
    unresolvedExternalOutcomes: z.number(),
  }),
});

export const TelemetrySchema = z.looseObject({
  assetId: z.string(),
  windowStart: Instant,
  asOf: Instant,
  devices: z.array(
    DeviceHealthWireSchema.extend({
      series: z.array(
        z.looseObject({
          channelId: z.string(),
          kind: z.string(),
          unit: z.string(),
          samples: z.array(
            z.looseObject({
              sampleId: z.string(),
              eventAt: Instant,
              receivedAt: Instant,
              valueInt: z.number(),
              unit: z.string(),
              qualityFlags: z.array(z.string()),
              ingestionClass: z.enum(['LIVE', 'LATE', 'BACKFILL']),
              inputOrigin: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  threshold: z
    .looseObject({ comparator: z.string(), thresholdInt: z.number(), unit: z.string(), ruleRevisionId: z.string() })
    .nullable(),
});

export const AssignmentWireSchema = z.looseObject({
  assignmentId: z.string(),
  assigneeUserId: z.string(),
  assignmentKind: z.enum(['INITIAL', 'ASSIGN', 'HANDOFF']),
  assignedBy: z.looseObject({ kind: z.string(), id: z.string() }),
  assignedAt: Instant,
  reasonCode: z.string(),
  nextActionDueAt: NullableInstant,
  acceptedAt: NullableInstant,
  supersededAt: NullableInstant,
  incidentVersion: z.number(),
});
export const IncidentWireSchema = z.looseObject({
  incidentId: z.string(),
  siteId: z.string(),
  assetId: z.string(),
  assetRevisionId: z.string(),
  procedureRevisionId: z.string(),
  triggerKind: z.enum(['TELEMETRY_RULE', 'MANUAL_REPORT']),
  triggerInputOrigin: z.enum(['PHYSICAL_SENSOR', 'SIMULATED_INPUT', 'OPERATOR_REPORT']),
  state: IncidentStateSchema,
  version: z.number().int().min(1),
  urgency: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
  faultFamily: z.string(),
  signalState: z.enum(['LIVE', 'UNCERTAIN']),
  openedAt: Instant,
  deadlineKind: z.enum(['RESPONSE', 'CONTAINMENT']),
  deadlineBasis: z.enum(['TRIGGER_EVENT_AT', 'OPENED_AT']),
  deadlineTimezoneBasis: z.string(),
  originalResponseDeadlineAt: Instant,
  currentResponseDeadlineAt: Instant,
  deadlineStatus: z.enum(['RUNNING', 'PAUSED', 'EXPIRED']),
  deadlineOverdue: z.boolean(),
  currentAssignment: AssignmentWireSchema.nullable(),
  acknowledgedAt: NullableInstant,
  recoveredAt: NullableInstant,
  reopenCount: z.number(),
  correlationId: z.string(),
});
export const IncidentListSchema = z.looseObject({ incidents: z.array(IncidentWireSchema) });
export const CommandResultSchema = z.looseObject({
  incidentId: z.string(),
  state: IncidentStateSchema,
  version: z.number().int().min(1),
});

export const DEADLINE_EVENT_KINDS = Object.freeze(['SET', 'PAUSE', 'RESUME', 'SHORTEN', 'EXTEND', 'EXPIRE'] as const);
export const TimelineSchema = z.looseObject({
  incidentId: z.string(),
  version: z.number(),
  transitions: z.array(
    z.looseObject({
      incidentVersion: z.number(),
      fromState: IncidentStateSchema.nullable(),
      toState: IncidentStateSchema,
      reasonCode: z.string(),
      actor: z.looseObject({ kind: z.string(), id: z.string() }),
      createdAt: Instant,
    }),
  ),
  assignments: z.array(AssignmentWireSchema),
  deadlineEvents: z.array(
    z.looseObject({
      sequence: z.number(),
      eventType: z.enum(DEADLINE_EVENT_KINDS),
      priorDeadlineAt: NullableInstant,
      newDeadlineAt: Instant,
      newStatus: z.enum(['RUNNING', 'PAUSED', 'EXPIRED']),
      effectiveAt: Instant,
      procedureRevisionId: z.string(),
      reasonCode: z.string(),
      authorizedBy: z.looseObject({ kind: z.string(), id: z.string() }),
      authorizedRole: z.string().nullable(),
    }),
  ),
  signals: z.array(z.looseObject({ signalId: z.string(), signalKind: z.string(), trust: z.string() })),
  acknowledgements: z.array(z.looseObject({ userId: z.string(), acknowledgedAt: Instant })),
});
export const ProcedureSchema = z.looseObject({
  procedureRevisionId: z.string(),
  procedureKey: z.string(),
  revision: z.number(),
  deadlineKind: z.enum(['RESPONSE', 'CONTAINMENT']),
  deadlineBasis: z.enum(['TRIGGER_EVENT_AT', 'OPENED_AT']),
  responseDeadlineMs: z.number(),
  pauseAllowed: z.boolean(),
  maxExtensionMs: z.number(),
  adjustRole: z.string(),
  timezoneBasis: z.string(),
  effectiveAt: Instant,
});
export const IncidentDetailSchema = z.looseObject({
  incident: IncidentWireSchema,
  procedure: ProcedureSchema,
  /** Server-computed command availability for this principal; each disabled entry names its blocking reason. */
  commands: z.record(z.string(), z.looseObject({ allowed: z.boolean(), reasonCode: z.string().nullable() })),
});
export const MembersSchema = z.looseObject({
  members: z.array(z.looseObject({ userId: z.string(), displayName: z.string(), roles: z.array(z.string()) })),
});

export const EvidenceSchema = z.looseObject({
  incidentId: z.string(),
  evidenceRevision: z
    .looseObject({ evidenceRevisionId: z.string(), revision: z.number(), current: z.boolean() })
    .nullable(),
  retrieval: z
    .looseObject({
      evidenceRevisionId: z.string(),
      revision: z.number(),
      current: z.boolean(),
      assetRevision: z.looseObject({
        assetRevisionId: z.string(),
        manufacturer: z.string(),
        model: z.string(),
        serial: z.string().nullable(),
      }),
      documents: z.array(
        z.looseObject({
          documentId: z.string(),
          role: z.string(),
          title: z.string(),
          documentRevision: z.string(),
          trustLevel: z.string(),
          sourceDigest: z.string(),
        }),
      ),
      facts: z.array(
        z.looseObject({
          factKey: z.string(),
          status: z.enum(['SINGLE_SOURCE', 'CORROBORATED', 'CONFLICT']),
          authority: z.literal('NONE'),
          values: z.array(
            z.looseObject({
              value: z.string(),
              sources: z.array(
                z.looseObject({
                  documentId: z.string(),
                  title: z.string(),
                  documentRevision: z.string(),
                  trustLevel: z.string(),
                  citation: CitationSchema,
                }),
              ),
            }),
          ),
        }),
      ),
    })
    .nullable(),
  proposals: z.array(
    z.looseObject({
      proposalId: z.string(),
      label: z.literal('MODEL PROPOSAL'),
      authority: z.literal('NONE'),
      resultOrigin: z.string(),
      lifecycle: z.enum(['CURRENT', 'SUPERSEDED']),
      createdAt: Instant,
    }),
  ),
});
export const CitationResponseSchema = z.looseObject({
  citation: CitationSchema,
  text: z.string(),
  verified: z.literal(true),
  documentId: z.string(),
  title: z.string(),
  documentRevision: z.string(),
  trustLevel: z.string(),
});

export const DecisionWireSchema = z.looseObject({
  compatibilityDecisionId: z.string(),
  candidateActionId: z.string(),
  decision: z.enum(['ALLOW', 'HOLD', 'REJECT']),
  lifecycle: z.enum(['CURRENT', 'SUPERSEDED']),
  reasonCodes: z.array(z.string()),
  blockingReasons: z.array(z.string()),
  missingFields: z.array(z.string()),
  conflictingFields: z.array(z.string()),
  recoveryPaths: z.array(z.string()),
  exactMatch: z.boolean(),
  safetyClass: z.string(),
  evidenceRevisionId: z.string(),
  policyRevisionId: z.string(),
  assetRevisionId: z.string(),
});
export const CompatibilitySchema = z.looseObject({ decisions: z.array(DecisionWireSchema) });

export const PlanActionWireSchema = z.looseObject({
  planActionId: z.string(),
  candidateActionId: z.string(),
  compatibilityDecisionId: z.string().nullable(),
  quoteId: z.string().nullable(),
  actionKind: z.string(),
  disposition: z.enum(['RANKED', 'ELIGIBLE_UNRANKED', 'INCOMPLETE', 'HELD', 'REJECTED']),
  ordinal: z.number().nullable(),
  reasonCodes: z.array(z.string()),
  amount: MoneyWireSchema.nullable(),
  merchantId: z.string().nullable(),
  expectedCostMinor: MinorUnitsWireSchema.nullable(),
  deadlineFit: z.string().nullable(),
  recoveryEtaAt: NullableInstant,
  components: z.array(
    z.looseObject({ key: z.string(), formula: z.string(), unit: z.string(), displayMinor: z.string() }),
  ),
  inputs: z.array(
    z.looseObject({ field: z.string(), value: z.string().nullable(), unit: z.string(), status: z.string() }),
  ),
  issues: z.array(z.looseObject({ field: z.string(), reason: z.string() })),
});
export const ApprovalRequestWireSchema = z.looseObject({
  approvalRequestId: z.string(),
  planId: z.string(),
  planActionId: z.string(),
  planHash: z.string(),
  state: z.enum(['PENDING', 'INVALIDATED']),
  invalidatedReason: z.string().nullable(),
  /** The bound M09 approval once recorded; null while the request awaits a decision. */
  approvalId: z.string().nullable(),
  scope: z.looseObject({
    actionKind: z.string(),
    actionClass: z.string(),
    incidentId: z.string(),
    siteId: z.string(),
    merchantId: z.string(),
    providerAccountRevisionId: z.string(),
    paid: z.boolean(),
    maxAmount: MoneyWireSchema,
    expiresAt: Instant,
    policyRevisionId: z.string(),
    evidenceRevisionId: z.string(),
    assetRevisionId: z.string(),
    actionDigest: z.string(),
  }),
  authority: z.literal('NONE'),
  executable: z.literal(false),
});
/** The effective bounds of the spending session an approval would authorize (FR-11), shown before approval. */
export const SessionBoundsSchema = z.looseObject({
  incidentId: z.string(),
  siteId: z.string(),
  merchantId: z.string(),
  actionKind: z.string(),
  actionClass: z.string(),
  amount: MoneyWireSchema,
  purpose: z.string(),
  expiresAt: Instant,
  providerAccountRevisionId: z.string(),
  policyRevisionId: z.string(),
});
export const PlanWireSchema = z.looseObject({
  planId: z.string(),
  incidentId: z.string(),
  revision: z.number(),
  planHash: z.string(),
  state: z.string(),
  outcome: z.string(),
  incomplete: z.boolean(),
  holdReasons: z.array(z.string()),
  binding: z.looseObject({
    assetRevisionId: z.string(),
    evidenceRevisionId: z.string(),
    policyRevisionId: z.string(),
  }),
  deadline: z.looseObject({ currentResponseDeadlineAt: NullableInstant, status: z.string().nullable() }),
  actions: z.array(PlanActionWireSchema),
  label: z.literal('ADVISORY RANKING'),
  approved: z.literal(false),
  approvalRequests: z.array(ApprovalRequestWireSchema.extend({ sessionBounds: SessionBoundsSchema })),
});
export const PlansSchema = z.looseObject({
  plans: z.array(PlanWireSchema),
  quotes: z.array(
    z.looseObject({
      quoteId: z.string(),
      state: z.string(),
      sourceKind: z.string(),
      scopeKind: z.string(),
      amount: MoneyWireSchema.nullable(),
      etaMinutes: z.number().nullable(),
      availabilityStatus: z.string(),
      authority: z.literal('NONE'),
    }),
  ),
});
export const ApprovalResultSchema = z.looseObject({
  approvalId: z.string(),
  approvalRequestId: z.string(),
  planId: z.string(),
  maxAmount: MoneyWireSchema,
  expiresAt: Instant,
  created: z.boolean(),
});
export const HoldResultSchema = z.looseObject({
  approvalRequestId: z.string(),
  held: z.literal(true),
  ledgerEntryId: z.string(),
  reasonCode: z.string(),
});

export const KiteSessionWireSchema = z.looseObject({
  kiteSessionId: z.string(),
  transportState: AttemptTransportStateSchema,
  externalOutcomeState: ExternalOutcomeStateSchema,
  adapterCapability: AdapterCapabilitySchema,
  providerSessionRef: z.string().nullable(),
});
export const AttemptWireSchema = z.looseObject({
  externalAttemptId: z.string(),
  transportState: AttemptTransportStateSchema,
  externalOutcomeState: ExternalOutcomeStateSchema,
  adapterCapability: AdapterCapabilitySchema,
  rawProviderStatus: z.string().nullable(),
});
export const AuthorityWireSchema = z.looseObject({
  authority: z.looseObject({
    executionAuthorityId: z.string(),
    approvalId: z.string(),
    incidentId: z.string(),
    merchantId: z.string(),
    purpose: z.string(),
    allowedActionKinds: z.array(z.string()),
    perActionLimit: MoneyWireSchema,
    baseLimit: MoneyWireSchema,
    issuedAt: Instant,
    expiresAt: Instant,
    status: ExecutionAuthorityStateSchema,
    version: z.number(),
  }),
  session: KiteSessionWireSchema,
  sessionReasonCode: z.string().nullable(),
  budget: z.looseObject({
    currency: z.string(),
    baseLimitMinor: MinorUnitsWireSchema,
    approvedAdjustmentsMinor: MinorUnitsWireSchema,
    effectiveLimitMinor: MinorUnitsWireSchema,
    openReservedMinor: MinorUnitsWireSchema,
    grossCapturedMinor: MinorUnitsWireSchema,
    refundedMinor: MinorUnitsWireSchema,
    reversedMinor: MinorUnitsWireSchema,
    netSettledMinor: MinorUnitsWireSchema,
    availableMinor: MinorUnitsWireSchema,
  }),
  unresolvedAttempts: z.array(AttemptWireSchema),
  executable: z.boolean(),
});
export const AuthoritiesSchema = z.looseObject({
  authorities: z.array(AuthorityWireSchema),
  approvals: z.array(
    z.looseObject({
      approvalId: z.string(),
      approvalRequestId: z.string(),
      planId: z.string(),
      candidateActionId: z.string(),
      executionAuthorityId: z.string().nullable(),
      approvedAt: Instant,
    }),
  ),
});
/** `202 Accepted`: the authority exists; the session's own external outcome is reported separately, never implied. */
export const IssueAuthorityResultSchema = z.looseObject({
  accepted: z.literal(true),
  sessionConfirmed: z.boolean(),
  authority: AuthorityWireSchema,
});

export const IntentWireSchema = z.looseObject({
  intent: z.looseObject({
    commercialIntentId: z.string(),
    incidentId: z.string(),
    state: EconomicIntentStateSchema,
    maxAmount: MoneyWireSchema,
    version: z.number(),
  }),
  money: z.looseObject({
    maxAmountMinor: MinorUnitsWireSchema,
    openReservedMinor: MinorUnitsWireSchema,
    capturedGrossMinor: MinorUnitsWireSchema,
    netSettledMinor: MinorUnitsWireSchema,
    currency: z.string(),
  }),
  reasonCode: z.string().nullable(),
  attempt: AttemptWireSchema.nullable(),
  transitions: z.array(z.looseObject({ from: z.string().nullable(), to: z.string(), reasonCode: z.string() })),
  receipts: z.array(z.looseObject({ kind: z.string(), resultOrigin: z.string() })),
  resultOrigin: z.string().nullable(),
});

export const OrderWireSchema = z.looseObject({
  orderKind: z.enum(['PURCHASE_ORDER', 'SERVICE_JOB']),
  orderId: z.string(),
  incidentId: z.string(),
  siteId: z.string(),
  commercialIntentId: z.string(),
  executionAuthorityId: z.string(),
  state: z.string(),
  terminal: z.boolean(),
  version: z.number(),
  approved: z.looseObject({ quantity: z.number(), amountMinor: MinorUnitsWireSchema, currency: z.string() }),
  blockedReason: z.string().nullable(),
  economic: z.looseObject({
    state: EconomicIntentStateSchema,
    reasonCode: z.string().nullable(),
    transportState: AttemptTransportStateSchema.nullable(),
    externalOutcomeState: ExternalOutcomeStateSchema.nullable(),
    adapterCapability: AdapterCapabilitySchema.nullable(),
    reconciliation: z.enum(['NONE', 'SCHEDULED', 'MANUAL_REVIEW']),
  }),
  transitions: z.array(z.looseObject({ from: z.string(), to: z.string(), source: z.string() })),
  provesRecovery: z.literal(false),
});
export const OrdersSchema = z.looseObject({ orders: z.array(OrderWireSchema) });

export const RecoverySchema = z.looseObject({
  incidentId: z.string(),
  incidentState: IncidentStateSchema,
  recoveryCycle: z.number(),
  milestones: z.array(
    z.looseObject({
      interventionMilestoneId: z.string(),
      milestoneType: z.string(),
      occurredAt: Instant,
      sourceKind: z.string(),
    }),
  ),
  evaluations: z.array(
    z.looseObject({
      recoveryEvaluationId: z.string(),
      state: z.enum(['PENDING', 'OBSERVING', 'PASSED', 'FAILED', 'EXPIRED']),
      stateReason: z.string().nullable(),
      observationBoundaryAt: Instant,
      expiresAt: Instant,
      decidedAt: NullableInstant,
    }),
  ),
  closeouts: z.array(
    z.looseObject({
      closeoutId: z.string(),
      recoveryEvaluationId: z.string(),
      manifestDigest: z.string(),
      decidedAt: Instant,
      reopenedAt: NullableInstant,
    }),
  ),
  gate: z.looseObject({
    recovered: z.boolean(),
    closeoutId: z.string().nullable(),
    reasons: z.array(z.string()),
  }),
});

export const LedgerSchema = z.looseObject({
  tenantId: z.string(),
  cutoffAt: Instant,
  entries: z.array(
    z.looseObject({
      evidenceId: z.string(),
      sequence: z.number(),
      kind: z.string(),
      trust: z.string(),
      recordedAt: Instant,
    }),
  ),
});
export const AuditSchema = z.looseObject({
  entries: z.array(
    z.looseObject({
      auditId: z.string(),
      occurredAt: Instant,
      actor: z.looseObject({ kind: z.string(), id: z.string().nullable() }),
      action: z.string(),
      result: z.enum(['SUCCEEDED', 'DENIED', 'FAILED']),
      reasonCode: z.string().nullable(),
    }),
  ),
});
export const PolicyHistorySchema = z.looseObject({
  revisions: z.array(z.looseObject({ policyRevisionId: z.string(), revision: z.number(), effectiveAt: Instant })),
});
export const PolicyValidationSchema = z.looseObject({
  valid: z.boolean(),
  issues: z.array(z.looseObject({ path: z.string(), code: z.string() })),
});
export const PolicyPublishResultSchema = z.looseObject({ policyRevisionId: z.string(), revision: z.number() });

export const NOTIFICATION_STATES_WIRE = Object.freeze(['PENDING', 'DELIVERED', 'UNKNOWN', 'FAILED'] as const);
export const NotificationsSchema = z.looseObject({
  notifications: z.array(
    z.looseObject({
      notificationId: z.string(),
      triggerKind: z.string(),
      titleCode: z.string(),
      severity: z.string(),
      deepLink: z.string(),
      context: z.record(z.string(), z.unknown()),
      state: z.enum(NOTIFICATION_STATES_WIRE),
      recipientRole: z.string(),
      createdAt: Instant,
    }),
  ),
});

export const WebhookResultSchema = z.looseObject({ status: z.string(), reasonCode: z.string().optional() });

export type PublicConfig = z.output<typeof PublicConfigSchema>;
export type Session = z.output<typeof SessionSchema>;
export type Fleet = z.output<typeof FleetSchema>;
export type FleetAsset = z.output<typeof FleetAssetSchema>;
export type DeviceHealthWire = z.output<typeof DeviceHealthWireSchema>;
export type Telemetry = z.output<typeof TelemetrySchema>;
export type IncidentWire = z.output<typeof IncidentWireSchema>;
export type IncidentDetail = z.output<typeof IncidentDetailSchema>;
export type AssignmentWire = z.output<typeof AssignmentWireSchema>;
export type Timeline = z.output<typeof TimelineSchema>;
export type Procedure = z.output<typeof ProcedureSchema>;
export type Members = z.output<typeof MembersSchema>;
export type CommandResult = z.output<typeof CommandResultSchema>;
export type EvidenceResponse = z.output<typeof EvidenceSchema>;
export type CitationResponse = z.output<typeof CitationResponseSchema>;
export type DecisionWire = z.output<typeof DecisionWireSchema>;
export type PlanWire = z.output<typeof PlanWireSchema>;
export type PlanActionWire = z.output<typeof PlanActionWireSchema>;
export type ApprovalRequestWire = z.output<typeof ApprovalRequestWireSchema>;
export type SessionBounds = z.output<typeof SessionBoundsSchema>;
export type PlansResponse = z.output<typeof PlansSchema>;
export type ApprovalResult = z.output<typeof ApprovalResultSchema>;
export type HoldResult = z.output<typeof HoldResultSchema>;
export type AuthorityWire = z.output<typeof AuthorityWireSchema>;
export type IssueAuthorityResult = z.output<typeof IssueAuthorityResultSchema>;
export type IntentWire = z.output<typeof IntentWireSchema>;
export type OrderWire = z.output<typeof OrderWireSchema>;
export type RecoveryResponse = z.output<typeof RecoverySchema>;
export type LedgerResponse = z.output<typeof LedgerSchema>;
export type AuditResponse = z.output<typeof AuditSchema>;
export type PolicyHistory = z.output<typeof PolicyHistorySchema>;
export type PolicyValidation = z.output<typeof PolicyValidationSchema>;
export type NotificationsResponse = z.output<typeof NotificationsSchema>;
export type NotificationWire = NotificationsResponse['notifications'][number];
export type FreshnessWire = z.output<typeof FreshnessWireSchema>;
export type AssetFreshnessWire = z.output<typeof AssetFreshnessWireSchema>;
