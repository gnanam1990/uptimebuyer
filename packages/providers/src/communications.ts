// Consent-bound communications and transcripts (FR-08, FR-23, NFR-06, INV-02, INV-13). Identity is server-derived
// from the contact attempt (request, provider, incident, site); a recorded transcript requires the disclosure and a
// granted recording consent where the request requires it; raw content is isolated in an erasable body table; the
// stored communication carries redacted text, a counts-only redaction manifest and, only with a granted processing
// consent, the minimum quote excerpt. Transcript text has no authority: nothing here creates approvals, decisions,
// quotes or incident transitions.
import { UtcInstantSchema, type UtcInstant } from '@uptimebuyer/contracts';
import {
  dbNow,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { ingestDocument, withdrawConsentedCommunicationsInTx, type ObjectStorePort } from '@uptimebuyer/evidence';
import { z } from 'zod';
import { emitProviderEvent } from './events.js';
import { hold, invalid } from './errors.js';
import { newProviderId } from './ids.js';
import { actorFields, authorizeScoped, isoOf, loadIncident } from './internal.js';
import {
  REDACTION_RULE_VERSION,
  contentDigest,
  minimumQuoteExcerpt,
  redactCommunicationText,
  type RedactionManifest,
} from './redaction.js';
import { loadRequest, type RequestRow } from './requests.js';
import { sha256Digest } from '@uptimebuyer/data';

export const COMMUNICATION_LIMITS = Object.freeze({ maxRawChars: 20_000, maxExportItems: 1_000 });
const RETENTION_DAYS = { COMMUNICATION_SHORT: 30, COMMUNICATION_STANDARD: 365 } as const;

const PAIRS = { RECORDING: 'QUOTE_RECORDING', PROCESSING: 'EVIDENCE_REASONING' } as const;

export interface ConsentInput {
  consentKind: 'RECORDING' | 'PROCESSING';
  purpose: 'QUOTE_RECORDING' | 'EVIDENCE_REASONING';
  status: 'GRANTED' | 'DECLINED' | 'WITHDRAWN';
  capturedVia: 'PROVIDER_API' | 'PHONE_DISCLOSURE_ACK' | 'EMAIL_REPLY' | 'OPERATOR_ATTESTED';
  disclosureText: string | null;
  sourceAttemptId: string | null;
}

export async function recordProviderConsentInTx(c: Tx, ctx: TenantContext, req: RequestRow, input: ConsentInput) {
  if (PAIRS[input.consentKind] !== input.purpose) throw invalid('CONSENT_PURPOSE_MISMATCH');
  if (input.sourceAttemptId !== null) {
    const a = await c.query(
      `SELECT 1 FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2 AND contact_request_id = $3`,
      [ctx.tenantId, input.sourceAttemptId, req.id],
    );
    if (a.rowCount !== 1) throw invalid('CONSENT_ATTEMPT_NOT_OF_REQUEST');
  }
  const id = newProviderId('consent');
  const actor = actorFields(ctx);
  await c.query(
    `INSERT INTO provider_consents (tenant_id, id, contact_request_id, service_provider_id, consent_kind, purpose, status,
       captured_via, disclosure_digest, source_attempt_id, recorded_by_kind, recorded_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      ctx.tenantId,
      id,
      req.id,
      req.service_provider_id,
      input.consentKind,
      input.purpose,
      input.status,
      input.capturedVia,
      input.disclosureText ? sha256Digest(input.disclosureText) : null,
      input.sourceAttemptId,
      actor.kind,
      actor.id,
    ],
  );
  return id;
}

const ConsentSchema = z.strictObject({
  contactRequestId: z.string().regex(/^pcr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  consentKind: z.enum(['RECORDING', 'PROCESSING']),
  purpose: z.enum(['QUOTE_RECORDING', 'EVIDENCE_REASONING']),
  status: z.enum(['GRANTED', 'DECLINED', 'WITHDRAWN']),
  capturedVia: z.enum(['PROVIDER_API', 'PHONE_DISCLOSURE_ACK', 'EMAIL_REPLY', 'OPERATOR_ATTESTED']),
  disclosureText: z.string().min(1).max(2_000).optional(),
  sourceAttemptId: z
    .string()
    .regex(/^pca_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)
    .optional(),
});

/** Append a consent observation (latest wins; WITHDRAWN revokes future use, never past records). */
export async function recordConsent(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof ConsentSchema>,
): Promise<{ consentId: string }> {
  const p = ConsentSchema.safeParse(raw);
  if (!p.success) throw invalid('INVALID_CONSENT');
  const input = p.data;
  const meta = {
    action: 'provider_consent.record',
    resourceType: 'provider_contact_request',
    resourceId: input.contactRequestId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const req = await loadRequest(c, ctx.tenantId, input.contactRequestId);
    if (!req) throw unavailable(meta);
    // Humans record consent as operators; the engine records provider-API-sourced consent.
    if (ctx.principal.kind === 'HUMAN') authorizeScoped(ctx, 'provider.contact', req.site_id, meta);
    else requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    await lockConsent(c, ctx.tenantId, req.id);
    const consentId = await recordProviderConsentInTx(c, ctx, req, {
      consentKind: input.consentKind,
      purpose: input.purpose,
      status: input.status,
      capturedVia: input.capturedVia,
      disclosureText: input.disclosureText ?? null,
      sourceAttemptId: input.sourceAttemptId ?? null,
    });
    let withdrawn = 0;
    if (input.consentKind === 'PROCESSING' && input.status !== 'GRANTED') {
      // INV-13: in the same transaction, every excerpt promoted under this request's processing consents leaves
      // future evidence revisions (system action, unbounded, idempotent).
      const refs = (
        await c.query<{ id: string }>(
          `SELECT id FROM provider_consents WHERE tenant_id = $1 AND contact_request_id = $2 AND consent_kind = 'PROCESSING'`,
          [ctx.tenantId, req.id],
        )
      ).rows.map((r) => r.id);
      withdrawn = await withdrawConsentedCommunicationsInTx(c, ctx.tenantId, refs, {
        reasonCode: 'PROCESSING_CONSENT_WITHDRAWN',
        systemActorId: `provider-consent-withdrawal:${consentId}`,
      });
    }
    await recordAudit(c, ctx, {
      ...meta,
      result: 'SUCCEEDED',
      reasonCode: `${input.consentKind}_${input.status}`,
      metadata: { evidenceWithdrawn: withdrawn },
    });
    return { consentId };
  });
}

/**
 * Serializes consent changes with excerpt promotion for one contact request (transaction-scoped here; promotion
 * holds the same key as a session lock across its check-and-ingest), so a withdrawal can never miss a promotion.
 */
const consentLockKey = (tenantId: string, requestId: string) => `provider-consent:${tenantId}:${requestId}`;
async function lockConsent(c: Tx, tenantId: string, requestId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [consentLockKey(tenantId, requestId)]);
}

async function latestConsent(c: Tx, tenantId: string, requestId: string, kind: 'RECORDING' | 'PROCESSING') {
  const { rows } = await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM provider_consents WHERE tenant_id = $1 AND contact_request_id = $2 AND consent_kind = $3
      ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [tenantId, requestId, kind],
  );
  return rows[0]?.status === 'GRANTED' ? rows[0] : null;
}

async function retentionDays(c: Tx, tenantId: string, cls: keyof typeof RETENTION_DAYS): Promise<number> {
  const { rows } = await c.query<{ body: { communicationDays?: number } }>(
    `SELECT r.body FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE r.tenant_id = $1 AND p.policy_key = 'RETENTION' AND r.effective_at <= clock_timestamp()
      ORDER BY r.effective_at DESC LIMIT 1`,
    [tenantId],
  );
  const policyDays = rows[0]?.body?.communicationDays;
  return typeof policyDays === 'number' ? Math.min(policyDays, RETENTION_DAYS[cls]) : RETENTION_DAYS[cls];
}

const CHANNEL_OF = { PHONE_TRANSCRIPT: 'PHONE', EMAIL: 'EMAIL', API_MESSAGE: 'API' } as const;

const RecordSchema = z.strictObject({
  contactAttemptId: z.string().regex(/^pca_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  direction: z.enum(['OUTBOUND', 'INBOUND']),
  commType: z.enum(['EMAIL', 'PHONE_TRANSCRIPT', 'API_MESSAGE']),
  transcriptSource: z.enum(['PROVIDER_TRANSCRIPTION', 'ADAPTER_CAPTURE', 'OPERATOR_NOTES']),
  /** Optional echo only: derived server-side (OPERATOR for humans, else the attempt's adapter class). */
  sourceAdapterClass: z
    .enum(['LIVE', 'SANDBOX', 'RECORDED_FIXTURE', 'SYNTHETIC_FIXTURE', 'LOCAL_FAKE', 'BROKER', 'OPERATOR'])
    .optional(),
  recordingDisclosure: z.enum(['GIVEN', 'NOT_GIVEN', 'NOT_APPLICABLE']),
  rawText: z.string().min(1).max(COMMUNICATION_LIMITS.maxRawChars),
  observedAt: UtcInstantSchema,
});
export type RecordCommunicationInput = z.input<typeof RecordSchema>;

export async function recordCommunication(
  pool: Db,
  ctx: TenantContext,
  raw: RecordCommunicationInput,
): Promise<{
  communicationId: string;
  minimumExcerptAvailable: boolean;
  redactionCounts: RedactionManifest['counts'];
}> {
  const p = RecordSchema.safeParse(raw);
  if (!p.success) throw invalid('INVALID_COMMUNICATION');
  const input = p.data;
  const meta = {
    action: 'provider_communication.record',
    resourceType: 'provider_contact_attempt',
    resourceId: input.contactAttemptId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const a = await c.query<{ contact_request_id: string; transport_state: string; adapter_class: string }>(
      `SELECT contact_request_id, transport_state, adapter_class FROM provider_contact_attempts WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.contactAttemptId],
    );
    if (!a.rows[0]) throw unavailable(meta);
    const req = (await loadRequest(c, ctx.tenantId, a.rows[0].contact_request_id))!;
    authorizeScoped(ctx, 'provider.quote', req.site_id, meta);
    if (CHANNEL_OF[input.commType] !== req.channel) throw invalid('COMM_TYPE_CHANNEL_MISMATCH');
    // Provenance is never client-asserted: a human-recorded transcript is OPERATOR, a server capture is the adapter's.
    const sourceAdapterClass =
      ctx.principal.kind === 'HUMAN'
        ? 'OPERATOR'
        : a.rows[0].adapter_class === 'NONE'
          ? 'OPERATOR'
          : a.rows[0].adapter_class;
    if (input.sourceAdapterClass !== undefined && input.sourceAdapterClass !== sourceAdapterClass)
      throw invalid('SOURCE_CLASS_MISMATCH');
    if (a.rows[0].transport_state === 'PREPARED') throw hold('ATTEMPT_NOT_SENT');
    const now = await dbNow(c);
    if (Date.parse(input.observedAt) > Date.parse(now) + 60_000) throw invalid('OBSERVED_IN_FUTURE');
    let recordingConsentId: string | null = null;
    if (input.commType === 'PHONE_TRANSCRIPT' && req.recording_disclosure === 'REQUIRED') {
      if (input.recordingDisclosure !== 'GIVEN') throw hold('RECORDING_DISCLOSURE_REQUIRED');
      const rc = await latestConsent(c, ctx.tenantId, req.id, 'RECORDING');
      if (!rc) throw hold('RECORDING_CONSENT_REQUIRED');
      recordingConsentId = rc.id;
    } else if (input.recordingDisclosure === 'GIVEN') {
      const rc = await latestConsent(c, ctx.tenantId, req.id, 'RECORDING');
      if (!rc) throw hold('RECORDING_CONSENT_REQUIRED');
      recordingConsentId = rc.id;
    }
    if (input.commType === 'PHONE_TRANSCRIPT' && input.recordingDisclosure === 'NOT_APPLICABLE')
      throw invalid('PHONE_DISCLOSURE_STATE_REQUIRED');
    const pc = await latestConsent(c, ctx.tenantId, req.id, 'PROCESSING');
    const { text, manifest } = redactCommunicationText(input.rawText);
    const excerpt = pc ? minimumQuoteExcerpt(text) : null;
    const days = await retentionDays(c, ctx.tenantId, req.retention_class as keyof typeof RETENTION_DAYS);
    const id = newProviderId('communication');
    const actor = actorFields(ctx);
    const digest = contentDigest(input.rawText);
    const excerptDigest = excerpt ? sha256Digest(excerpt) : null;
    await c.query(
      `INSERT INTO provider_communications (tenant_id, id, contact_attempt_id, contact_request_id, service_provider_id,
         incident_id, site_id, direction, comm_type, transcript_source, source_adapter_class, recording_disclosure,
         recording_consent_id, processing_consent_id, content_digest, redacted_text, redaction_manifest, minimum_excerpt,
         excerpt_digest, retention_class, retain_until, observed_at, recorded_by_kind, recorded_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               clock_timestamp() + make_interval(days => $21), $22, $23, $24)`,
      [
        ctx.tenantId,
        id,
        input.contactAttemptId,
        req.id,
        req.service_provider_id,
        req.incident_id,
        req.site_id,
        input.direction,
        input.commType,
        input.transcriptSource,
        sourceAdapterClass,
        input.recordingDisclosure,
        recordingConsentId,
        pc?.id ?? null,
        digest,
        text,
        JSON.stringify(manifest),
        excerpt,
        excerptDigest,
        req.retention_class,
        days,
        input.observedAt,
        actor.kind,
        actor.id,
      ],
    );
    await c.query(
      `INSERT INTO provider_communication_bodies (tenant_id, id, communication_id, raw_text) VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, newProviderId('communicationBody'), id, input.rawText],
    );
    await emitProviderEvent(c, ctx, 'provider.communication_recorded.v1', id, 1, {
      communicationId: id,
      contactAttemptId: input.contactAttemptId,
      contactRequestId: req.id,
      incidentId: req.incident_id,
      commType: input.commType,
      contentDigest: digest,
      excerptDigest,
      recordingConsentId,
      processingConsentId: pc?.id ?? null,
      authority: 'NONE',
    });
    await recordAudit(c, ctx, { ...meta, resourceId: id, result: 'SUCCEEDED', metadata: { ...manifest.counts } });
    return { communicationId: id, minimumExcerptAvailable: excerpt !== null, redactionCounts: manifest.counts };
  });
}

export interface CommunicationView {
  communicationId: string;
  contactAttemptId: string;
  contactRequestId: string;
  serviceProviderId: string;
  incidentId: string;
  direction: string;
  commType: string;
  transcriptSource: string;
  sourceAdapterClass: string;
  recordingDisclosure: string;
  recordingConsentId: string | null;
  processingConsentId: string | null;
  contentDigest: string;
  redactedText: string;
  redactionManifest: RedactionManifest;
  minimumExcerpt: string | null;
  excerptDigest: string | null;
  retentionClass: string;
  retainUntil: UtcInstant;
  bodyErased: boolean;
  authority: 'NONE';
  observedAt: UtcInstant;
  recordedAt: UtcInstant;
}

const SELECT_COMM = `SELECT m.*, (b.erased_at IS NOT NULL) AS body_erased FROM provider_communications m
  LEFT JOIN provider_communication_bodies b ON b.tenant_id = m.tenant_id AND b.communication_id = m.id`;

function toView(r: Record<string, unknown>): CommunicationView {
  return {
    communicationId: r.id as string,
    contactAttemptId: r.contact_attempt_id as string,
    contactRequestId: r.contact_request_id as string,
    serviceProviderId: r.service_provider_id as string,
    incidentId: r.incident_id as string,
    direction: r.direction as string,
    commType: r.comm_type as string,
    transcriptSource: r.transcript_source as string,
    sourceAdapterClass: r.source_adapter_class as string,
    recordingDisclosure: r.recording_disclosure as string,
    recordingConsentId: (r.recording_consent_id as string | null) ?? null,
    processingConsentId: (r.processing_consent_id as string | null) ?? null,
    contentDigest: r.content_digest as string,
    redactedText: r.redacted_text as string,
    redactionManifest: r.redaction_manifest as RedactionManifest,
    minimumExcerpt: (r.minimum_excerpt as string | null) ?? null,
    excerptDigest: (r.excerpt_digest as string | null) ?? null,
    retentionClass: r.retention_class as string,
    retainUntil: isoOf(r.retain_until as Date)!,
    bodyErased: r.body_erased === true,
    authority: 'NONE',
    observedAt: isoOf(r.observed_at as Date)!,
    recordedAt: isoOf(r.recorded_at as Date)!,
  };
}

/** Redacted, role-scoped display (operators, approvers, engineers, admins, auditors at the incident's site). */
export async function getCommunication(
  pool: Db,
  ctx: TenantContext,
  communicationId: string,
): Promise<CommunicationView> {
  const meta = {
    action: 'provider_communication.read',
    resourceType: 'provider_communication',
    resourceId: communicationId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`${SELECT_COMM} WHERE m.tenant_id = $1 AND m.id = $2`, [
      ctx.tenantId,
      String(communicationId),
    ]);
    if (!rows[0]) throw unavailable(meta);
    authorizeScoped(ctx, 'provider.communication.read', rows[0].site_id, meta);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return toView(rows[0]);
  });
}

/** Redacted export with declared omissions and cut-off (admin/auditor). Raw content and contact values never leave. */
export async function exportCommunications(
  pool: Db,
  ctx: TenantContext,
  input: { incidentId: string },
): Promise<{
  cutoffAt: UtcInstant;
  redactionRuleVersion: string;
  omittedFields: string[];
  items: CommunicationView[];
}> {
  const meta = { action: 'provider_communication.export', resourceType: 'incident', resourceId: input?.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.communication.export', siteId: null });
    await loadIncident(c, ctx, meta, String(input.incidentId));
    const cutoffAt = await dbNow(c);
    const { rows } = await c.query(
      `${SELECT_COMM} WHERE m.tenant_id = $1 AND m.incident_id = $2 AND m.recorded_at <= $3 ORDER BY m.recorded_at, m.id LIMIT $4`,
      [ctx.tenantId, input.incidentId, cutoffAt, COMMUNICATION_LIMITS.maxExportItems],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { items: rows.length } });
    return {
      cutoffAt,
      redactionRuleVersion: REDACTION_RULE_VERSION,
      omittedFields: ['rawText', 'contactValues', 'consentDisclosureText'],
      items: rows.map(toView),
    };
  });
}

async function excerptFor(
  c: Tx,
  ctx: TenantContext,
  communicationId: string,
  meta: { action: string; resourceType: string },
  authorizeSite: (siteId: string) => void,
) {
  // Load only the scope first and authorize; no consent, erasure or retention state is evaluated before that.
  const scope = await c.query<{ site_id: string }>(
    `SELECT site_id FROM provider_communications WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, communicationId],
  );
  if (!scope.rows[0]) throw unavailable({ ...meta, resourceId: communicationId });
  authorizeSite(scope.rows[0].site_id);
  const { rows } = await c.query(`${SELECT_COMM} WHERE m.tenant_id = $1 AND m.id = $2`, [
    ctx.tenantId,
    communicationId,
  ]);
  const m = rows[0];
  const pc = await latestConsent(c, ctx.tenantId, m.contact_request_id, 'PROCESSING');
  if (!pc) throw hold('PROCESSING_CONSENT_REQUIRED');
  if (m.body_erased) throw hold('COMMUNICATION_ERASED');
  if (Date.parse(isoOf(m.retain_until)!) <= Date.parse(await dbNow(c))) throw hold('RETENTION_EXPIRED');
  if (!m.minimum_excerpt) throw hold('MINIMUM_EXCERPT_NOT_AVAILABLE');
  return { m, consentId: pc.id };
}

/**
 * The only communication text that may enter an approved model run: the stored minimum excerpt, re-checked against
 * current processing consent, erasure and retention. The outbound digest is audited (engine only).
 */
export async function prepareModelExcerpt(
  pool: Db,
  ctx: TenantContext,
  input: { communicationId: string; purpose: 'EVIDENCE_REASONING' },
): Promise<{
  communicationId: string;
  purpose: 'EVIDENCE_REASONING';
  excerpt: string;
  excerptDigest: string;
  redactionRuleVersion: string;
}> {
  if (input?.purpose !== 'EVIDENCE_REASONING') throw invalid('PURPOSE_NOT_PERMITTED');
  const meta = {
    action: 'provider_communication.model_excerpt',
    resourceType: 'provider_communication',
    resourceId: input.communicationId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.engine', siteId: null });
    const { m } = await excerptFor(c, ctx, String(input.communicationId), meta, () => {});
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { excerptDigest: m.excerpt_digest } });
    return {
      communicationId: m.id,
      purpose: 'EVIDENCE_REASONING',
      excerpt: m.minimum_excerpt,
      excerptDigest: m.excerpt_digest,
      redactionRuleVersion: REDACTION_RULE_VERSION,
    };
  });
}

/**
 * Promote the minimum excerpt to M05 evidence as a consented TRANSCRIPT document (purpose EVIDENCE_REASONING), so
 * the bounded SERV packet can cite it. The raw transcript is never ingested.
 */
export async function promoteExcerptToEvidence(
  pool: Db,
  ctx: TenantContext,
  store: ObjectStorePort,
  input: { communicationId: string },
): Promise<{ documentId: string }> {
  const meta = {
    action: 'provider_communication.promote',
    resourceType: 'provider_communication',
    resourceId: input?.communicationId,
  };
  // Resolve the request id without revealing anything (scope is authorized inside excerptFor before any check).
  const scope = await pool.query<{ contact_request_id: string }>(
    `SELECT contact_request_id FROM provider_communications WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, String(input?.communicationId)],
  );
  const lock = await pool.connect();
  const key = consentLockKey(ctx.tenantId, scope.rows[0]?.contact_request_id ?? 'none');
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    const prepared = await tenantCommand(pool, ctx, meta, async (c) => {
      const { m, consentId } = await excerptFor(c, ctx, String(input.communicationId), meta, (siteId) =>
        authorizeScoped(ctx, 'provider.contact', siteId, { ...meta, resourceId: String(input.communicationId) }),
      );
      const req = (await loadRequest(c, ctx.tenantId, m.contact_request_id))!;
      const asset = await c.query<{ manufacturer: string; model: string }>(
        `SELECT manufacturer, model FROM asset_revisions WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.asset_revision_id],
      );
      await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { excerptDigest: m.excerpt_digest } });
      return { excerpt: m.minimum_excerpt as string, consentId, req, asset: asset.rows[0]! };
    });
    const doc = await ingestDocument(pool, ctx, store, {
      role: 'TRANSCRIPT',
      mediaType: 'text/plain',
      bytes: Buffer.from(`${prepared.excerpt}\n`, 'utf8'),
      title: `Provider quote excerpt ${input.communicationId}`,
      documentRevision: String(input.communicationId),
      applicability: {
        manufacturer: prepared.asset.manufacturer,
        model: prepared.asset.model,
        assetId: prepared.req.asset_id as never,
      },
      sourceKind: 'COMMUNICATION',
      sourceRef: `provider-communication:${input.communicationId}`,
      communication: { consentRef: prepared.consentId, purposes: ['EVIDENCE_REASONING'] },
    });
    return { documentId: doc.documentId };
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {});
    lock.release();
  }
}

/** Privacy erasure of raw content (admin); refused under an active legal hold. The redacted record remains. */
export async function eraseCommunicationBody(
  pool: Db,
  ctx: TenantContext,
  communicationId: string,
  reasonCode: string,
) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) throw invalid('INVALID_REASON');
  const meta = {
    action: 'provider_communication.erase',
    resourceType: 'provider_communication',
    resourceId: communicationId,
  };
  await tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT m.site_id, m.incident_id, q.asset_id FROM provider_communications m
         JOIN provider_contact_requests q ON q.tenant_id = m.tenant_id AND q.id = m.contact_request_id
        WHERE m.tenant_id = $1 AND m.id = $2`,
      [ctx.tenantId, String(communicationId)],
    );
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'provider.communication.erase', siteId: null });
    const held = await c.query(
      `SELECT 1 FROM legal_holds WHERE tenant_id = $1 AND released_at IS NULL
          AND ((scope_type = 'TENANT') OR (scope_type = 'SITE' AND scope_id = $2) OR (scope_type = 'ASSET' AND scope_id = $3)
               OR (scope_type = 'INCIDENT' AND scope_id = $4))`,
      [ctx.tenantId, rows[0].site_id, rows[0].asset_id, rows[0].incident_id],
    );
    if ((held.rowCount ?? 0) > 0) throw hold('LEGAL_HOLD_ACTIVE');
    const r = await c.query(
      `UPDATE provider_communication_bodies SET raw_text = NULL, erased_at = clock_timestamp(), erasure_reason = $3
        WHERE tenant_id = $1 AND communication_id = $2 AND erased_at IS NULL`,
      [ctx.tenantId, communicationId, reasonCode],
    );
    await recordAudit(c, ctx, {
      ...meta,
      result: 'SUCCEEDED',
      reasonCode: r.rowCount === 1 ? reasonCode : 'ALREADY_ERASED',
    });
  });
}
