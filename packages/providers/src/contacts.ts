// Contact orchestration (FR-08, NFR-03, NFR-04, INV-08, INV-12). A contact request is an immutable intended contact
// pinned to the exact account revision, the incident's latest evidence revision and (for paid work) the effective
// AUTHORITY policy revision with a canonical action digest. Execution reloads the revision: unpaid M07-owned
// revisions create one idempotent M07 attempt dispatched by a worker (SEND_STARTED committed before egress, explicit
// timeout, raw status kept), paid broker-owned revisions are handed to the commercial-intent broker port. Supersession
// invalidates unexecuted work without rewriting in-flight history; an UNKNOWN effect is reconciled by authoritative
// lookup against the pinned revision and never retried blindly.
import {
  IdempotencyKeySchema,
  IncidentIdSchema,
  MerchantIdSchema,
  ProviderAccountIdSchema,
  CurrencyCodeSchema,
  newId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest, computeActionDigest } from '@uptimebuyer/domain';
import {
  claimJobs,
  completeJob,
  dbNow,
  enqueueJob,
  failJob,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  withTenantTransaction,
  type CredentialResolver,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import type { CommercialIntentBrokerPort } from '@uptimebuyer/kite-contracts';
import { z } from 'zod';
import { AmbiguousResponseError } from './adapters/structured-api.js';
import { emitAttempt, patchAttempt, toAttemptView, type AttemptRow, type AttemptView } from './attempts.js';
import { executePaidContact, validatePaidAuthority, type PaidAuthority } from './broker.js';
import { recordProviderConsentInTx } from './communications.js';
import { emitProviderEvent } from './events.js';
import { hold, invalid } from './errors.js';
import { isProviderId, newProviderId } from './ids.js';
import {
  DEFAULT_RATE_LIMITER,
  authorizeScoped,
  providerToken,
  actorFields,
  appendAttemptEvent,
  effectiveAuthorityRevisionId,
  isoOf,
  latestEvidence,
  loadCurrentRevision,
  loadIncident,
  loadRevision,
  receipts,
  requestDigestOf,
  unpaidCredential,
  withTimeout,
  type RevisionRateLimiter,
  type RevisionRow,
} from './internal.js';
import {
  ADAPTER_BOUNDS,
  NotSentError,
  type ContactResult,
  type ProviderAdapterRegistry,
  type ProviderOperation,
} from './ports.js';
import { recordQuoteInTx } from './quotes.js';
import { loadRequest, type RequestRow } from './requests.js';

export { loadRequest, type RequestRow };

export const CONTACT_PURPOSES = Object.freeze([
  'QUOTE',
  'AVAILABILITY',
  'ARRIVAL_ESTIMATE',
  'DIAGNOSTIC_COMMITMENT',
] as const);
export const CONTACT_DISPATCH_JOB = 'provider.contact_dispatch';
/** Grace after the contact timeout before a durable SEND_STARTED marker is reconstructed as UNKNOWN. */
const MARKER_GRACE_MS = 5_000;
const RECONCILE_BASE_MS = 30_000;
const RECONCILE_MAX_MS = 3_600_000;

const PrepareSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  serviceProviderId: z.string().refine((v) => isProviderId('serviceProvider', v)),
  contactPointId: z.string().refine((v) => isProviderId('contactPoint', v)),
  providerAccountId: ProviderAccountIdSchema,
  channel: z.enum(['PHONE', 'EMAIL', 'API']),
  purposeCode: z.enum(CONTACT_PURPOSES),
  processingConsent: z.enum(['REQUIRED', 'NOT_REQUIRED']).optional(),
  retentionClass: z.enum(['COMMUNICATION_SHORT', 'COMMUNICATION_STANDARD']).optional(),
  timeoutMs: z.int().min(ADAPTER_BOUNDS.minTimeoutMs).max(ADAPTER_BOUNDS.maxTimeoutMs).optional(),
  paid: z
    .strictObject({
      merchantId: MerchantIdSchema,
      maxCost: z.strictObject({
        amountMinor: z.bigint().min(1n).max(9_223_372_036_854_775_807n),
        currency: CurrencyCodeSchema,
      }),
    })
    .optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type PrepareContactInput = z.input<typeof PrepareSchema>;

export interface PreparedContactRequest {
  contactRequestId: string;
  created: boolean;
  paid: boolean;
  channel: 'PHONE' | 'EMAIL' | 'API';
  purposeCode: string;
  providerAccountId: string;
  providerAccountRevisionId: string;
  assetRevisionId: string;
  evidenceRevisionId: string;
  policyRevisionId: string | null;
  requestDigest: string;
  actionDigest: string | null;
  planHash: string | null;
  recordingDisclosure: 'REQUIRED' | 'NOT_APPLICABLE';
  processingConsent: 'REQUIRED' | 'NOT_REQUIRED';
}

function preparedOf(r: RequestRow, created: boolean): PreparedContactRequest {
  return {
    contactRequestId: r.id,
    created,
    paid: r.paid,
    channel: r.channel,
    purposeCode: r.purpose_code,
    providerAccountId: r.provider_account_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    requestDigest: r.request_digest,
    actionDigest: r.action_digest,
    planHash: r.plan_hash,
    recordingDisclosure: r.recording_disclosure,
    processingConsent: r.processing_consent,
  };
}

export async function prepareContactRequest(
  pool: Db,
  ctx: TenantContext,
  raw: PrepareContactInput,
): Promise<PreparedContactRequest> {
  const p = PrepareSchema.safeParse(raw);
  if (!p.success) throw invalid('INVALID_CONTACT_REQUEST');
  const input = p.data;
  const meta = {
    action: 'provider_contact_request.prepare',
    resourceType: 'provider_contact_request',
    resourceId: null,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const incident = await loadIncident(c, ctx, meta, input.incidentId);
    authorizeScoped(ctx, 'provider.contact', incident.site_id, meta);
    const digest = requestDigestOf({ op: 'provider.contact.prepare', ...input });
    const prior = await receipts.hit(c, ctx.tenantId, 'provider.contact.prepare', input.idempotencyKey, digest);
    if (prior) return preparedOf((await loadRequest(c, ctx.tenantId, prior))!, false);

    const sp = await c.query(`SELECT 1 FROM service_providers WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      input.serviceProviderId,
    ]);
    if (sp.rowCount !== 1) throw unavailable(meta, input.serviceProviderId, 'service_provider');
    const revision = await loadCurrentRevision(c, ctx.tenantId, input.providerAccountId);
    if (!revision) throw unavailable(meta, input.providerAccountId, 'provider_account');
    if (revision.accountStatus !== 'ACTIVE') throw hold('PROVIDER_ACCOUNT_DISABLED');
    if (revision.paid && !input.paid) throw invalid('PAID_BOUNDS_REQUIRED');
    if (!revision.paid && input.paid) throw invalid('UNPAID_ACCOUNT_TAKES_NO_PAID_BOUNDS');
    // The request names its exact destination; it must belong to this provider and channel and be usable: the latest
    // admin review is VERIFIED, or it is unreviewed, DISCOVERED (not attached to an approved provider by a later
    // search) and was discovered under this request's own pinned account revision.
    const cp = await c.query<{
      id: string;
      service_provider_id: string;
      channel: string;
      intake_state: string;
      source_provider_account_revision_id: string | null;
      decision: string | null;
    }>(
      `SELECT p.id, p.service_provider_id, p.channel, p.intake_state, p.source_provider_account_revision_id,
              (SELECT r.decision FROM service_provider_contact_point_reviews r WHERE r.tenant_id = p.tenant_id
                  AND r.contact_point_id = p.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1) AS decision
         FROM service_provider_contact_points p WHERE p.tenant_id = $1 AND p.id = $2`,
      [ctx.tenantId, input.contactPointId],
    );
    const point = cp.rows[0];
    if (!point) throw unavailable(meta, input.contactPointId, 'contact_point');
    if (point.service_provider_id !== input.serviceProviderId || point.channel !== input.channel)
      throw hold('CONTACT_POINT_NOT_OF_PROVIDER');
    const usable =
      point.decision === 'VERIFIED' ||
      (point.decision === null &&
        point.intake_state === 'DISCOVERED' &&
        point.source_provider_account_revision_id === revision.providerAccountRevisionId);
    if (!usable) throw hold('CONTACT_POINT_NOT_APPROVED');
    const evidence = await latestEvidence(c, ctx.tenantId, incident.id);
    const policyRevisionId = await effectiveAuthorityRevisionId(c, ctx.tenantId);
    if (revision.paid && policyRevisionId === null) throw hold('POLICY_REVISION_REQUIRED');

    const recordingDisclosure = input.channel === 'PHONE' ? 'REQUIRED' : 'NOT_APPLICABLE';
    const processingConsent = input.processingConsent ?? 'REQUIRED';
    const retentionClass = input.retentionClass ?? 'COMMUNICATION_STANDARD';
    const timeoutMs = input.timeoutMs ?? ADAPTER_BOUNDS.defaultContactTimeoutMs;
    const messageTemplate = `${input.purposeCode.toLowerCase().replace(/_/g, '-')}-request.v1`;
    const maxCost = input.paid?.maxCost ?? { amountMinor: 0n, currency: 'USD' as const };
    const requestDigest = canonicalDigest('provider-contact-request', 1, {
      tenantId: ctx.tenantId,
      incidentId: incident.id,
      evidenceRevisionId: evidence.evidenceRevisionId,
      assetRevisionId: evidence.assetRevisionId,
      serviceProviderId: input.serviceProviderId,
      contactPointId: point.id,
      providerAccountId: revision.providerAccountId,
      providerAccountRevisionId: revision.providerAccountRevisionId,
      channel: input.channel,
      purposeCode: input.purposeCode,
      messageTemplate,
      recordingDisclosure,
      processingConsent,
      retentionClass,
      timeoutMs,
      paid: revision.paid,
      merchantId: input.paid?.merchantId ?? null,
      maxCost,
      policyRevisionId: revision.paid ? policyRevisionId : null,
    });
    const actionDigest = revision.paid
      ? computeActionDigest({
          tenantId: ctx.tenantId as never,
          incidentId: incident.id as never,
          assetRevisionId: evidence.assetRevisionId as never,
          evidenceRevisionId: evidence.evidenceRevisionId as never,
          policyRevisionId: policyRevisionId as never,
          action: {
            kind: 'PAID_CONTACT',
            subjectId: input.serviceProviderId as never,
            quantity: 1,
            partNumber: null,
            manufacturer: null,
          },
          providerAccountRevisionId: revision.providerAccountRevisionId as never,
          merchantId: input.paid!.merchantId,
          amount: input.paid!.maxCost as never,
          purpose: input.purposeCode as never,
        })
      : null;
    const planHash = actionDigest ? canonicalDigest('provider-contact-plan', 1, { actionDigest, requestDigest }) : null;
    const actor = actorFields(ctx);
    const id = newId('providerContactRequest');
    const ins = await c.query<{ id: string }>(
      `INSERT INTO provider_contact_requests (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id,
         evidence_revision_id, policy_revision_id, service_provider_id, contact_point_id, provider_account_id,
         provider_account_revision_id, channel, purpose_code, request_digest, message_template, recording_disclosure,
         processing_consent, retention_class, paid, action_digest, plan_hash, merchant_id, max_cost_minor, currency,
         timeout_ms, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
               $24, $25, $26, $27, $28)
       ON CONFLICT (tenant_id, incident_id, service_provider_id, channel, purpose_code, request_digest) DO NOTHING
       RETURNING id`,
      [
        ctx.tenantId,
        id,
        incident.id,
        incident.site_id,
        incident.asset_id,
        evidence.assetRevisionId,
        evidence.evidenceRevisionId,
        revision.paid ? policyRevisionId : null,
        input.serviceProviderId,
        point.id,
        revision.providerAccountId,
        revision.providerAccountRevisionId,
        input.channel,
        input.purposeCode,
        requestDigest,
        messageTemplate,
        recordingDisclosure,
        processingConsent,
        retentionClass,
        revision.paid,
        actionDigest,
        planHash,
        input.paid?.merchantId ?? null,
        maxCost.amountMinor.toString(),
        maxCost.currency,
        timeoutMs,
        actor.kind,
        actor.id,
      ],
    );
    const created = ins.rowCount === 1;
    const requestId =
      ins.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `SELECT id FROM provider_contact_requests WHERE tenant_id = $1 AND incident_id = $2 AND service_provider_id = $3
              AND channel = $4 AND purpose_code = $5 AND request_digest = $6`,
          [ctx.tenantId, incident.id, input.serviceProviderId, input.channel, input.purposeCode, requestDigest],
        )
      ).rows[0]!.id;
    const row = (await loadRequest(c, ctx.tenantId, requestId))!;
    if (created) {
      await emitProviderEvent(c, ctx, 'provider.contact_requested.v1', requestId, 1, {
        contactRequestId: requestId,
        incidentId: incident.id,
        serviceProviderId: row.service_provider_id,
        providerAccountRevisionId: row.provider_account_revision_id,
        channel: row.channel,
        purposeCode: row.purpose_code,
        paid: row.paid,
        requestDigest: row.request_digest,
        actionDigest: row.action_digest,
        recordingDisclosure: row.recording_disclosure,
        processingConsent: row.processing_consent,
      });
      await recordAudit(c, ctx, { ...meta, resourceId: requestId, result: 'SUCCEEDED' });
    }
    await receipts.store(c, ctx.tenantId, 'provider.contact.prepare', input.idempotencyKey, digest, requestId);
    return preparedOf(row, created);
  });
}

async function attemptsOf(c: Tx, tenantId: string, requestId: string): Promise<AttemptRow[]> {
  const { rows } = await c.query<AttemptRow>(
    `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND contact_request_id = $2 ORDER BY attempt_number`,
    [tenantId, requestId],
  );
  return rows;
}

async function stampInvalidated(c: Tx, tenantId: string, requestId: string, reason: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE provider_contact_requests SET invalidated_at = clock_timestamp(), invalidation_reason = $3
      WHERE tenant_id = $1 AND id = $2 AND invalidated_at IS NULL`,
    [tenantId, requestId, reason],
  );
  return r.rowCount === 1;
}

const opFor = (channel: 'PHONE' | 'EMAIL' | 'API'): ProviderOperation => `CONTACT_${channel}`;

export interface ExecuteContactInput {
  idempotencyKey: string;
  /** Paid requests only: the approval and the execution authority issued for it (M09). */
  authority?: PaidAuthority;
}

export interface ExecuteDeps {
  broker?: CommercialIntentBrokerPort;
  adapters?: ProviderAdapterRegistry;
  credentials?: CredentialResolver;
}

export interface ExecuteContactResult {
  contactRequestId: string;
  route: 'M07_UNPAID' | 'KITE_BROKER';
  created: boolean;
  attempt: AttemptView;
}

/** Insert a pre-egress capability block: nothing was sent, definite no effect, capability UNSUPPORTED. */
async function insertBlocked(
  c: Tx,
  ctx: TenantContext,
  req: RequestRow,
  attemptNumber: number,
  reasonCode: string,
): Promise<AttemptRow> {
  const id = newProviderId('attempt');
  const { rows } = await c.query<AttemptRow>(
    `INSERT INTO provider_contact_attempts (tenant_id, id, contact_request_id, attempt_number, provider_account_id,
       provider_account_revision_id, paid, client_operation_id, idempotency_key, request_digest, transport_state,
       external_outcome_state, adapter_capability, capability_reason, definite_no_effect, result_origin, adapter_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PREPARED', 'PROPOSED', 'UNSUPPORTED', $11, true, 'M07_PREFLIGHT',
             $12) RETURNING *`,
    [
      ctx.tenantId,
      id,
      req.id,
      attemptNumber,
      req.provider_account_id,
      req.provider_account_revision_id,
      req.paid,
      newId('clientOperation'),
      `pc-${newId('clientOperation').slice(3)}`,
      req.request_digest,
      reasonCode,
      req.paid ? 'BROKER' : 'NONE',
    ],
  );
  const row = rows[0]!;
  await appendAttemptEvent(c, ctx.tenantId, id, {
    kind: 'PRE_EGRESS_BLOCK',
    transportState: row.transport_state,
    externalOutcomeState: row.external_outcome_state,
    adapterCapability: row.adapter_capability,
    reasonCode,
  });
  await emitAttempt(c, ctx, row, req.incident_id);
  return row;
}

type Phase1 =
  | { kind: 'DONE'; result: ExecuteContactResult }
  | { kind: 'INVALIDATED'; reason: string }
  | { kind: 'PAID'; req: RequestRow; revision: RevisionRow; authority: PaidAuthority; attemptNumber: number };

export async function executeContactRequest(
  pool: Db,
  ctx: TenantContext,
  contactRequestId: string,
  input: ExecuteContactInput,
  deps: ExecuteDeps,
): Promise<ExecuteContactResult> {
  const key = IdempotencyKeySchema.safeParse(input?.idempotencyKey);
  if (!key.success) throw invalid('INVALID_IDEMPOTENCY_KEY');
  const authority = input.authority;
  if (
    authority !== undefined &&
    (typeof authority !== 'object' ||
      !/^apr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(String(authority.approvalId)) ||
      !/^xau_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(String(authority.executionAuthorityId)))
  )
    throw invalid('INVALID_PAID_AUTHORITY');
  const meta = {
    action: 'provider_contact_request.execute',
    resourceType: 'provider_contact_request',
    resourceId: contactRequestId,
  };
  const phase1 = await tenantCommand<Phase1>(pool, ctx, meta, async (c) => {
    const req = await loadRequest(c, ctx.tenantId, String(contactRequestId), true);
    if (!req) throw unavailable(meta);
    authorizeScoped(ctx, 'provider.contact', req.site_id, meta);
    if (!req.paid && authority) throw invalid('UNPAID_REQUEST_TAKES_NO_AUTHORITY');
    const route = req.paid ? 'KITE_BROKER' : 'M07_UNPAID';
    const digest = requestDigestOf({
      op: 'provider.contact.execute',
      contactRequestId: req.id,
      authority: authority ?? null,
    });
    const prior = await receipts.hit(c, ctx.tenantId, 'provider.contact.execute', key.data, digest);
    const existing = await attemptsOf(c, ctx.tenantId, req.id);
    const replay = prior ? existing.find((a) => a.id === prior) : undefined;
    if (replay)
      return {
        kind: 'DONE',
        result: { contactRequestId: req.id, route, created: false, attempt: toAttemptView(replay) },
      };
    const live = existing.find((a) => !a.definite_no_effect);
    if (live)
      return {
        kind: 'DONE',
        result: { contactRequestId: req.id, route, created: false, attempt: toAttemptView(live) },
      };
    if (req.invalidated_at) throw hold('CONTACT_REQUEST_INVALIDATED');
    const revision = (await loadRevision(c, ctx.tenantId, req.provider_account_revision_id, true))!;
    if (revision.superseded || revision.accountStatus !== 'ACTIVE') {
      const reason = revision.superseded ? 'PROVIDER_ACCOUNT_REVISION_SUPERSEDED' : 'PROVIDER_ACCOUNT_DISABLED';
      await stampInvalidated(c, ctx.tenantId, req.id, reason);
      await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: reason });
      return { kind: 'INVALIDATED', reason };
    }
    // Paid requests: exact executable authority is required before any capability or broker work.
    if (req.paid && !authority) throw hold('PAID_AUTHORITY_REQUIRED');
    const attemptNumber = (existing.at(-1)?.attempt_number ?? 0) + 1;
    if (attemptNumber > 10) throw hold('ATTEMPT_LIMIT_REACHED');
    const lastBlocked = existing.at(-1);
    const block = async (reason: string): Promise<Phase1> => {
      if (lastBlocked && lastBlocked.transport_state === 'PREPARED' && lastBlocked.capability_reason === reason)
        return {
          kind: 'DONE',
          result: { contactRequestId: req.id, route, created: false, attempt: toAttemptView(lastBlocked) },
        };
      const row = await insertBlocked(c, ctx, req, attemptNumber, reason);
      return { kind: 'DONE', result: { contactRequestId: req.id, route, created: true, attempt: toAttemptView(row) } };
    };
    if (req.paid) {
      await validatePaidAuthority(c, ctx, req, authority!, meta);
      if (!revision.capabilities.includes(opFor(req.channel))) return block('CAPABILITY_NOT_DECLARED');
      return { kind: 'PAID', req, revision, authority: authority!, attemptNumber };
    }
    // Unpaid: pre-egress capability (revision declaration, then adapter when the caller supplies the registry).
    if (!revision.capabilities.includes(opFor(req.channel))) return block('CAPABILITY_NOT_DECLARED');
    let adapterClass = 'NONE';
    if (deps.adapters) {
      const adapter = deps.adapters.find(revision.providerKey, opFor(req.channel));
      if (!adapter?.contact) return block('ADAPTER_NOT_CONFIGURED');
      const cap = adapter.assess(revision, opFor(req.channel));
      if (cap.kind === 'UNSUPPORTED') return block(cap.reasonCode);
      adapterClass = adapter.adapterClass;
    }
    const id = newProviderId('attempt');
    const { rows } = await c.query<AttemptRow>(
      `INSERT INTO provider_contact_attempts (tenant_id, id, contact_request_id, attempt_number, provider_account_id,
         provider_account_revision_id, paid, client_operation_id, idempotency_key, request_digest, transport_state,
         external_outcome_state, adapter_capability, result_origin, adapter_class)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, 'PREPARED', 'AUTHORIZED', 'ELIGIBLE', 'M07_ADAPTER', $10)
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        req.id,
        attemptNumber,
        req.provider_account_id,
        req.provider_account_revision_id,
        newId('clientOperation'),
        `pc-${newId('clientOperation').slice(3)}`,
        req.request_digest,
        adapterClass,
      ],
    );
    const row = rows[0]!;
    await appendAttemptEvent(c, ctx.tenantId, id, {
      kind: 'PREPARED',
      transportState: row.transport_state,
      externalOutcomeState: row.external_outcome_state,
      adapterCapability: row.adapter_capability,
    });
    await enqueueJob(c, ctx, {
      kind: CONTACT_DISPATCH_JOB,
      payload: { contactAttemptId: id, correlationId: ctx.correlationId },
      dedupeKey: `contact-dispatch:${id}`,
      maxAttempts: 20,
    });
    await emitAttempt(c, ctx, row, req.incident_id);
    await receipts.store(c, ctx.tenantId, 'provider.contact.execute', key.data, digest, id);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return {
      kind: 'DONE',
      result: { contactRequestId: req.id, route: 'M07_UNPAID', created: true, attempt: toAttemptView(row) },
    };
  });
  if (phase1.kind === 'INVALIDATED') throw hold(phase1.reason);
  if (phase1.kind === 'DONE') return phase1.result;
  if (!deps.broker) throw hold('BROKER_PORT_UNAVAILABLE');
  return executePaidContact(
    pool,
    ctx,
    phase1.req,
    phase1.revision,
    phase1.authority,
    phase1.attemptNumber,
    deps.broker,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Unpaid dispatch (worker)

export interface DispatchDeps {
  adapters: ProviderAdapterRegistry;
  credentials?: CredentialResolver;
  workerId: string;
  limit?: number;
  limiter?: RevisionRateLimiter;
  /** Fault injection for restart tests: throwing simulates the worker dying at that point. */
  faults?: { afterSendStarted?: () => void };
}

const PURPOSE_LABEL: Record<string, string> = {
  QUOTE: 'quote',
  AVAILABILITY: 'availability check',
  ARRIVAL_ESTIMATE: 'arrival estimate',
  DIAGNOSTIC_COMMITMENT: 'diagnostic visit commitment',
};
export const RECORDING_DISCLOSURE_TEXT = 'This call is recorded for quality and quoting purposes.';

/** Outbound message from a versioned template: equipment identity and purpose only, no personal data. */
function renderMessage(req: RequestRow, asset: { manufacturer: string; model: string }) {
  const label = PURPOSE_LABEL[req.purpose_code] ?? 'quote';
  return {
    subject: `UptimeBuyer ${label} request ${req.id}`,
    body:
      `We are requesting a ${label} for commercial refrigeration equipment (${asset.manufacturer} ${asset.model}). ` +
      `Please reply with price including currency, earliest availability and ETA. Reference ${req.id}.`,
    disclosure: req.recording_disclosure === 'REQUIRED' ? RECORDING_DISCLOSURE_TEXT : null,
  };
}

/** Claim and dispatch queued unpaid contact attempts. */
export async function runContactDispatch(pool: Db, deps: DispatchDeps): Promise<{ dispatched: number }> {
  const jobs = await claimJobs(pool, {
    workerId: deps.workerId,
    kinds: [CONTACT_DISPATCH_JOB],
    limit: deps.limit ?? 10,
  });
  let dispatched = 0;
  for (const job of jobs) {
    let outcome: Awaited<ReturnType<typeof dispatchContactAttempt>>;
    try {
      outcome = await dispatchContactAttempt(pool, job.ctx, String(job.job.payload.contactAttemptId), deps);
    } catch (error) {
      if (deps.faults) throw error;
      await failJob(pool, job, { reasonCode: 'DISPATCH_ERROR', retryInMs: 5_000 });
      continue;
    }
    if (outcome.kind === 'DEFER')
      await failJob(pool, job, { reasonCode: 'LOCAL_RATE_LIMITED', retryInMs: outcome.retryInMs });
    else {
      await completeJob(pool, job);
      if (outcome.kind === 'SENT') dispatched++;
    }
  }
  return { dispatched };
}

type DispatchOutcome = { kind: 'NOOP' | 'BLOCKED' | 'INVALIDATED' | 'SENT' } | { kind: 'DEFER'; retryInMs: number };

export async function dispatchContactAttempt(
  pool: Db,
  ctx: TenantContext,
  attemptId: string,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const meta = {
    action: 'provider_contact_attempt.dispatch',
    resourceType: 'provider_contact_attempt',
    resourceId: attemptId,
  };
  const step1 = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    const { rows } = await c.query<AttemptRow>(
      `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, attemptId],
    );
    let a = rows[0];
    if (!a) throw unavailable(meta);
    if (a.paid || a.transport_state !== 'PREPARED' || a.definite_no_effect) return { kind: 'NOOP' as const };
    const req = (await loadRequest(c, ctx.tenantId, a.contact_request_id, true))!;
    const revision = (await loadRevision(c, ctx.tenantId, a.provider_account_revision_id, true))!;
    if (req.invalidated_at || revision.superseded || revision.accountStatus !== 'ACTIVE') {
      await stampInvalidated(
        c,
        ctx.tenantId,
        req.id,
        revision.superseded
          ? 'PROVIDER_ACCOUNT_REVISION_SUPERSEDED'
          : (req.invalidation_reason ?? 'PROVIDER_ACCOUNT_DISABLED'),
      );
      await patchAttempt(
        c,
        ctx,
        a,
        { definite_no_effect: true, capability_reason: 'REVISION_SUPERSEDED_BEFORE_SEND' },
        { kind: 'PRE_EGRESS_BLOCK', reasonCode: 'REVISION_SUPERSEDED_BEFORE_SEND' },
        req.incident_id,
      );
      return { kind: 'INVALIDATED' as const };
    }
    const op = opFor(req.channel);
    const adapter = deps.adapters.find(revision.providerKey, op);
    const cap = adapter?.contact
      ? adapter.assess(revision, op)
      : { kind: 'UNSUPPORTED' as const, reasonCode: 'ADAPTER_NOT_CONFIGURED' };
    if (!adapter || cap.kind === 'UNSUPPORTED') {
      const reason = cap.kind === 'UNSUPPORTED' ? cap.reasonCode : 'ADAPTER_NOT_CONFIGURED';
      await patchAttempt(
        c,
        ctx,
        a,
        { adapter_capability: 'UNSUPPORTED', capability_reason: reason, definite_no_effect: true },
        { kind: 'PRE_EGRESS_BLOCK', reasonCode: reason },
        req.incident_id,
      );
      return { kind: 'BLOCKED' as const };
    }
    const wait = (deps.limiter ?? DEFAULT_RATE_LIMITER).take(revision.providerAccountRevisionId);
    if (wait > 0) return { kind: 'DEFER' as const, retryInMs: wait };
    const now = await dbNow(c);
    // The durable pre-egress marker: operation id, idempotency key and request digest are already on the row.
    a = await patchAttempt(
      c,
      ctx,
      a,
      {
        transport_state: 'SEND_STARTED',
        adapter_class: a.adapter_class === 'NONE' ? adapter.adapterClass : a.adapter_class,
        next_reconcile_at: new Date(Date.parse(now) + req.timeout_ms + MARKER_GRACE_MS).toISOString(),
      },
      { kind: 'SEND_STARTED' },
      req.incident_id,
    );
    const cp = await c.query<{ value: string }>(
      `SELECT value FROM service_provider_contact_points WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, req.contact_point_id],
    );
    const asset = await c.query<{ manufacturer: string; model: string }>(
      `SELECT manufacturer, model FROM asset_revisions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, req.asset_revision_id],
    );
    return {
      kind: 'SEND' as const,
      attempt: a,
      req,
      revision,
      adapter,
      destination: cp.rows[0]!.value,
      message: renderMessage(req, asset.rows[0] ?? { manufacturer: 'unknown', model: 'unknown' }),
    };
  });
  if (step1.kind !== 'SEND') return step1;
  deps.faults?.afterSendStarted?.();

  let handedOff = false;
  const { attempt, req, revision, adapter } = step1;
  const result = await withTimeout(req.timeout_ms, (signal) =>
    adapter.contact!(
      {
        clientOperationId: attempt.client_operation_id,
        idempotencyKey: attempt.idempotency_key,
        requestDigest: attempt.request_digest,
        channel: req.channel,
        destination: step1.destination,
        purposeCode: req.purpose_code,
        message: step1.message,
      },
      { revision, signal, credential: unpaidCredential(revision, deps.credentials) },
      { handedOff: () => (handedOff = true) },
    ),
  );

  await withTenantTransaction(pool, ctx, async (c) => {
    const { rows } = await c.query<AttemptRow>(
      `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, attemptId],
    );
    let a = rows[0]!;
    if (handedOff && a.transport_state === 'SEND_STARTED' && a.external_outcome_state === 'AUTHORIZED')
      a = await patchAttempt(c, ctx, a, { external_outcome_state: 'REQUESTED' }, { kind: 'HANDOFF' }, req.incident_id);
    await applyContactResult(c, ctx, a, req, result);
  });
  return { kind: 'SENT' };
}

async function applyContactResult(
  c: Tx,
  ctx: TenantContext,
  a: AttemptRow,
  req: RequestRow,
  result: Awaited<ReturnType<typeof withTimeout<ContactResult>>>,
): Promise<void> {
  const reconstructed = a.transport_state === 'UNKNOWN';
  const now = await dbNow(c);
  if (result.kind === 'OK') {
    const r = result.value;
    if (r.kind === 'ACCEPTED' || r.kind === 'CONFIRMED') {
      a = await patchAttempt(
        c,
        ctx,
        a,
        {
          ...(reconstructed ? {} : { transport_state: 'ACKNOWLEDGED' }),
          external_outcome_state: r.kind,
          raw_provider_status: providerToken(r.rawStatus, 64),
          provider_ref: providerToken(r.providerRef, 128),
          raw_response_digest: r.rawResponseDigest,
          next_reconcile_at: null,
        },
        {
          kind: 'ADAPTER_RESULT',
          rawProviderStatus: providerToken(r.rawStatus, 64),
          rawResponseDigest: r.rawResponseDigest,
        },
        req.incident_id,
      );
      if (r.consent) await recordObservedConsent(c, ctx, req, a, r.consent);
      if (r.quote)
        await recordQuoteInTx(c, ctx, req, {
          sourceKind: 'ADAPTER_RESPONSE',
          attempt: a,
          quote: r.quote,
          digest: r.rawResponseDigest,
        });
      return;
    }
    // DECLINED (definitive) or RATE_LIMITED before acceptance: authoritative no effect.
    const raw = r.kind === 'RATE_LIMITED' ? 'rate_limited' : providerToken(r.rawStatus, 64);
    await patchAttempt(
      c,
      ctx,
      a,
      {
        ...(reconstructed
          ? {}
          : { transport_state: r.kind === 'RATE_LIMITED' ? 'DEFINITE_NO_EFFECT' : 'ACKNOWLEDGED' }),
        external_outcome_state: 'FAILED',
        definite_no_effect: true,
        raw_provider_status: raw,
        raw_response_digest: r.rawResponseDigest,
        capability_reason: r.kind === 'RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED' : null,
        next_reconcile_at: null,
      },
      {
        kind: 'ADAPTER_RESULT',
        rawProviderStatus: raw,
        rawResponseDigest: r.rawResponseDigest,
        reasonCode: r.kind === 'DECLINED' ? r.reasonCode.slice(0, 64) : 'PROVIDER_RATE_LIMITED',
      },
      req.incident_id,
    );
    return;
  }
  if (
    result.kind === 'ERROR' &&
    result.error instanceof NotSentError &&
    !reconstructed &&
    a.external_outcome_state === 'AUTHORIZED'
  ) {
    await patchAttempt(
      c,
      ctx,
      a,
      {
        transport_state: 'DEFINITE_NO_EFFECT',
        definite_no_effect: true,
        next_reconcile_at: null,
        capability_reason: result.error.reasonCode,
      },
      { kind: 'ADAPTER_RESULT', reasonCode: result.error.reasonCode },
      req.incident_id,
    );
    return;
  }
  if (reconstructed) return; // already UNKNOWN; reconciliation continues by lookup
  // Timeout or ambiguous response after possible egress: UNKNOWN with a next reconciliation time, never a guess.
  const reason =
    result.kind === 'TIMEOUT'
      ? 'TIMEOUT'
      : result.error instanceof AmbiguousResponseError
        ? result.error.reasonCode
        : 'TRANSPORT_ERROR';
  await patchAttempt(
    c,
    ctx,
    a,
    {
      transport_state: 'UNKNOWN',
      external_outcome_state: 'UNKNOWN',
      next_reconcile_at: new Date(Date.parse(now) + RECONCILE_BASE_MS).toISOString(),
    },
    { kind: result.kind === 'TIMEOUT' ? 'TIMEOUT' : 'ADAPTER_RESULT', reasonCode: reason },
    req.incident_id,
  );
}

async function recordObservedConsent(
  c: Tx,
  ctx: TenantContext,
  req: RequestRow,
  a: AttemptRow,
  consent: { recording: string; processing: string },
) {
  await recordProviderConsentInTx(c, ctx, req, {
    consentKind: 'PROCESSING',
    purpose: 'EVIDENCE_REASONING',
    status: consent.processing === 'GRANTED' ? 'GRANTED' : 'DECLINED',
    capturedVia: 'PROVIDER_API',
    disclosureText: null,
    sourceAttemptId: a.id,
  });
  if (consent.recording !== 'NOT_APPLICABLE')
    await recordProviderConsentInTx(c, ctx, req, {
      consentKind: 'RECORDING',
      purpose: 'QUOTE_RECORDING',
      status: consent.recording === 'GRANTED' ? 'GRANTED' : 'DECLINED',
      capturedVia: 'PROVIDER_API',
      disclosureText: null,
      sourceAttemptId: a.id,
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation (engine): authoritative lookup by the pre-egress client operation against the pinned revision.

export interface ReconcileDeps {
  adapters: ProviderAdapterRegistry;
  credentials?: CredentialResolver;
}

export async function reconcileContactAttempt(
  pool: Db,
  ctx: TenantContext,
  attemptId: string,
  deps: ReconcileDeps,
): Promise<AttemptView> {
  const meta = {
    action: 'provider_contact_attempt.reconcile',
    resourceType: 'provider_contact_attempt',
    resourceId: attemptId,
  };
  const loaded = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    const { rows } = await c.query<AttemptRow>(
      `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, String(attemptId)],
    );
    let a = rows[0];
    if (!a) throw unavailable(meta);
    if (a.paid) throw hold('PAID_RECONCILIATION_BROKER_ONLY');
    const req = (await loadRequest(c, ctx.tenantId, a.contact_request_id))!;
    if (a.transport_state === 'SEND_STARTED') a = await reconstructUnknown(c, ctx, a, req.incident_id);
    const revision = (await loadRevision(c, ctx.tenantId, a.provider_account_revision_id))!;
    return { a, req, revision };
  });
  const { a, req, revision } = loaded;
  const open = ['UNKNOWN', 'REQUESTED', 'ACCEPTED'].includes(a.external_outcome_state);
  if (!open || a.adapter_capability === 'UNSUPPORTED') return toAttemptView(a);
  const adapter = deps.adapters.find(revision.providerKey, opFor(req.channel));
  const lookup = adapter?.lookup
    ? await withTimeout(Math.min(req.timeout_ms, 10_000), (signal) =>
        adapter.lookup!(
          {
            clientOperationId: a.client_operation_id,
            idempotencyKey: a.idempotency_key,
            providerRef: a.provider_ref,
            channel: req.channel,
          },
          { revision, signal, credential: unpaidCredential(revision, deps.credentials) },
        ),
      )
    : ({ kind: 'OK', value: { kind: 'UNSUPPORTED', reasonCode: 'ADAPTER_NOT_CONFIGURED' } } as const);
  return withTenantTransaction(pool, ctx, async (c) => {
    const { rows } = await c.query<AttemptRow>(
      `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, a.id],
    );
    const cur = rows[0]!;
    if (cur.version !== a.version) return toAttemptView(cur);
    const now = Date.parse(await dbNow(c));
    const lookups = (
      await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM provider_contact_attempt_events WHERE tenant_id = $1 AND attempt_id = $2 AND observation_kind = 'LOOKUP'`,
        [ctx.tenantId, a.id],
      )
    ).rows[0]!.n;
    const backoff = new Date(now + Math.min(RECONCILE_BASE_MS * 2 ** lookups, RECONCILE_MAX_MS)).toISOString();
    const stillUnknown = cur.external_outcome_state === 'UNKNOWN';
    if (lookup.kind !== 'OK') {
      const next = await patchAttempt(
        c,
        ctx,
        cur,
        { next_reconcile_at: stillUnknown ? backoff : null },
        { kind: 'LOOKUP', reasonCode: lookup.kind === 'TIMEOUT' ? 'LOOKUP_TIMEOUT' : 'LOOKUP_ERROR' },
        req.incident_id,
      );
      return toAttemptView(next);
    }
    const r = lookup.value;
    if (r.kind === 'UNSUPPORTED') {
      // Post-egress loss of reconciliation: capability axis only; the effect stays as it is (UNKNOWN -> manual).
      const next = await patchAttempt(
        c,
        ctx,
        cur,
        {
          adapter_capability: 'UNSUPPORTED',
          capability_reason: r.reasonCode,
          manual_review: stillUnknown ? true : cur.manual_review,
          next_reconcile_at: null,
        },
        { kind: 'CAPABILITY_CHANGE', reasonCode: r.reasonCode },
        req.incident_id,
      );
      return toAttemptView(next);
    }
    if (r.kind === 'NOT_FOUND' || r.kind === 'PENDING') {
      const next = await patchAttempt(
        c,
        ctx,
        cur,
        { next_reconcile_at: stillUnknown ? backoff : null },
        { kind: 'LOOKUP', reasonCode: r.kind, rawResponseDigest: r.rawResponseDigest },
        req.incident_id,
      );
      return toAttemptView(next);
    }
    const target = r.state;
    const same = target === cur.external_outcome_state;
    const legal =
      same ||
      (cur.external_outcome_state === 'UNKNOWN' && ['ACCEPTED', 'CONFIRMED', 'FAILED', 'CANCELLED'].includes(target)) ||
      cur.external_outcome_state === 'REQUESTED' ||
      (cur.external_outcome_state === 'ACCEPTED' && ['CONFIRMED', 'FAILED', 'CANCELLED'].includes(target));
    const next = await patchAttempt(
      c,
      ctx,
      cur,
      legal
        ? {
            external_outcome_state: target,
            definite_no_effect: target === 'FAILED' ? true : cur.definite_no_effect,
            raw_provider_status: providerToken(r.rawStatus, 64),
            provider_ref: providerToken(r.providerRef, 128) ?? cur.provider_ref,
            raw_response_digest: r.rawResponseDigest,
            next_reconcile_at: null,
          }
        : { next_reconcile_at: null, manual_review: true },
      {
        kind: 'LOOKUP',
        rawProviderStatus: providerToken(r.rawStatus, 64),
        rawResponseDigest: r.rawResponseDigest,
        reasonCode: legal ? null : 'LOOKUP_CONFLICT',
      },
      req.incident_id,
    );
    if (legal && r.quote && !same)
      await recordQuoteInTx(c, ctx, req, {
        sourceKind: 'ADAPTER_RESPONSE',
        attempt: next,
        quote: r.quote,
        digest: r.rawResponseDigest,
      });
    return toAttemptView(next);
  });
}

/** A durable SEND_STARTED marker whose worker did not report back: reconstruct UNKNOWN (never REQUESTED). */
async function reconstructUnknown(c: Tx, ctx: TenantContext, a: AttemptRow, incidentId: string): Promise<AttemptRow> {
  const now = await dbNow(c);
  return patchAttempt(
    c,
    ctx,
    a,
    {
      transport_state: 'UNKNOWN',
      external_outcome_state: 'UNKNOWN',
      next_reconcile_at: new Date(Date.parse(now)).toISOString(),
    },
    { kind: 'TIMEOUT', reasonCode: 'RECONSTRUCTED_AFTER_MARKER' },
    incidentId,
  );
}

/** Engine sweep: reconstruct stale SEND_STARTED markers, then reconcile due UNKNOWN unpaid attempts (bounded). */
export async function sweepContactAttempts(
  pool: Db,
  ctx: TenantContext,
  deps: ReconcileDeps,
  opts: { asOf?: string; limit?: number } = {},
): Promise<{ reconstructed: number; reconciled: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const meta = { action: 'provider_contact_attempt.sweep', resourceType: 'provider_contact_attempt', resourceId: null };
  const due = await tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    const now = await dbNow(c);
    const asOf = opts.asOf && Date.parse(opts.asOf) > Date.parse(now) ? new Date(opts.asOf).toISOString() : now;
    const stale = await c.query<AttemptRow & { incident_id: string }>(
      `SELECT a.*, q.incident_id FROM provider_contact_attempts a
         JOIN provider_contact_requests q ON q.tenant_id = a.tenant_id AND q.id = a.contact_request_id
        WHERE a.tenant_id = $1 AND NOT a.paid AND a.transport_state = 'SEND_STARTED' AND a.next_reconcile_at <= $2
        ORDER BY a.next_reconcile_at LIMIT $3 FOR UPDATE OF a SKIP LOCKED`,
      [ctx.tenantId, asOf, limit],
    );
    for (const a of stale.rows) await reconstructUnknown(c, ctx, a, a.incident_id);
    const ready = await c.query<{ id: string }>(
      `SELECT id FROM provider_contact_attempts
        WHERE tenant_id = $1 AND NOT paid AND external_outcome_state = 'UNKNOWN' AND adapter_capability = 'ELIGIBLE'
          AND next_reconcile_at <= $2 ORDER BY next_reconcile_at LIMIT $3`,
      [ctx.tenantId, asOf, limit],
    );
    return { reconstructed: stale.rowCount ?? 0, ids: ready.rows.map((r) => r.id) };
  });
  let reconciled = 0;
  for (const id of due.ids) {
    await reconcileContactAttempt(pool, ctx, id, deps);
    reconciled++;
  }
  return { reconstructed: due.reconstructed, reconciled };
}

/**
 * Supersession sweep for one account: every request pinned to a non-current revision whose work never left the
 * process is invalidated (queued attempts become definite no-effect). In-flight history is never touched.
 */
export async function invalidateSupersededContactWork(
  pool: Db,
  ctx: TenantContext,
  providerAccountId: string,
): Promise<{ invalidatedRequestIds: string[] }> {
  const meta = {
    action: 'provider_contact_request.invalidate',
    resourceType: 'provider_account',
    resourceId: providerAccountId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    const acct = await c.query<{ current_revision_id: string; status: string }>(
      `SELECT current_revision_id, status FROM provider_accounts WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, String(providerAccountId)],
    );
    if (!acct.rows[0]) throw unavailable(meta);
    const { rows } = await c.query<RequestRow>(
      `SELECT q.* FROM provider_contact_requests q
        WHERE q.tenant_id = $1 AND q.provider_account_id = $2 AND q.invalidated_at IS NULL
          AND (q.provider_account_revision_id <> $3 OR $4 <> 'ACTIVE')
          AND NOT EXISTS (SELECT 1 FROM provider_contact_attempts a WHERE a.tenant_id = q.tenant_id
                            AND a.contact_request_id = q.id AND NOT a.definite_no_effect AND a.transport_state <> 'PREPARED')
        ORDER BY q.created_at LIMIT 1000 FOR UPDATE OF q`,
      [ctx.tenantId, providerAccountId, acct.rows[0].current_revision_id, acct.rows[0].status],
    );
    const ids: string[] = [];
    for (const q of rows) {
      const queued = await c.query<AttemptRow>(
        `SELECT * FROM provider_contact_attempts WHERE tenant_id = $1 AND contact_request_id = $2
            AND transport_state = 'PREPARED' AND NOT definite_no_effect FOR UPDATE`,
        [ctx.tenantId, q.id],
      );
      for (const a of queued.rows)
        await patchAttempt(
          c,
          ctx,
          a,
          { definite_no_effect: true, capability_reason: 'REVISION_SUPERSEDED_BEFORE_SEND' },
          { kind: 'PRE_EGRESS_BLOCK', reasonCode: 'REVISION_SUPERSEDED_BEFORE_SEND' },
          q.incident_id,
        );
      if (await stampInvalidated(c, ctx.tenantId, q.id, 'PROVIDER_ACCOUNT_REVISION_SUPERSEDED')) ids.push(q.id);
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { invalidated: ids.length } });
    return { invalidatedRequestIds: ids };
  });
}

// ---------------------------------------------------------------------------------------------------------------

export interface ContactRequestView extends Omit<PreparedContactRequest, 'created'> {
  incidentId: string;
  serviceProviderId: string;
  retentionClass: string;
  maxCost: { amountMinor: bigint; currency: string };
  timeoutMs: number;
  state: 'PREPARED' | 'EXECUTION_RECORDED' | 'INVALIDATED';
  invalidationReason: string | null;
  attempts: AttemptView[];
  consents: {
    consentId: string;
    consentKind: string;
    purpose: string;
    status: string;
    capturedVia: string;
    recordedAt: UtcInstant;
  }[];
  communicationIds: string[];
  quoteIds: string[];
}

export async function getContactRequest(
  pool: Db,
  ctx: TenantContext,
  contactRequestId: string,
): Promise<ContactRequestView> {
  const meta = {
    action: 'provider_contact_request.read',
    resourceType: 'provider_contact_request',
    resourceId: contactRequestId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRequest(c, ctx.tenantId, String(contactRequestId));
    if (!r) throw unavailable(meta);
    authorizeScoped(ctx, 'provider.read', r.site_id, meta);
    const attempts = await attemptsOf(c, ctx.tenantId, r.id);
    const consents = await c.query(
      `SELECT id, consent_kind, purpose, status, captured_via, recorded_at FROM provider_consents
        WHERE tenant_id = $1 AND contact_request_id = $2 ORDER BY recorded_at, id`,
      [ctx.tenantId, r.id],
    );
    const comms = await c.query<{ id: string }>(
      `SELECT id FROM provider_communications WHERE tenant_id = $1 AND contact_request_id = $2 ORDER BY recorded_at, id`,
      [ctx.tenantId, r.id],
    );
    const quotes = await c.query<{ id: string }>(
      `SELECT id FROM provider_quotes WHERE tenant_id = $1 AND contact_request_id = $2 ORDER BY revision`,
      [ctx.tenantId, r.id],
    );
    const { created: _c, ...base } = preparedOf(r, false);
    return {
      ...base,
      incidentId: r.incident_id,
      serviceProviderId: r.service_provider_id,
      retentionClass: r.retention_class,
      maxCost: { amountMinor: BigInt(r.max_cost_minor), currency: r.currency },
      timeoutMs: r.timeout_ms,
      state: r.invalidated_at ? 'INVALIDATED' : attempts.length > 0 ? 'EXECUTION_RECORDED' : 'PREPARED',
      invalidationReason: r.invalidation_reason,
      attempts: attempts.map(toAttemptView),
      consents: consents.rows.map((x) => ({
        consentId: x.id,
        consentKind: x.consent_kind,
        purpose: x.purpose,
        status: x.status,
        capturedVia: x.captured_via,
        recordedAt: isoOf(x.recorded_at)!,
      })),
      communicationIds: comms.rows.map((x) => x.id),
      quoteIds: quotes.rows.map((x) => x.id),
    };
  });
}
