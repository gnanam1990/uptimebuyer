// Normalized immutable quote revisions (FR-08, FR-09 input). A quote records what a provider (or an operator who
// spoke to one) stated: integer minor-unit price and tax with currency, ETA, validity and availability, with every
// missing field explicit and its source evidence digest. A quote never approves compatibility, spend or closure
// (authority 'NONE'); M08 reads quotes as planning inputs only.
import {
  CurrencyCodeSchema,
  UtcInstantSchema,
  money,
  type CurrencyCode,
  type Money,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest, canonicalize } from '@uptimebuyer/domain';
import {
  dbNow,
  recordAudit,
  sha256Digest,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import type { AttemptRow } from './attempts.js';
import { emitProviderEvent } from './events.js';
import { hold, invalid } from './errors.js';
import { newProviderId } from './ids.js';
import { actorFields, authorizeScoped, isoOf, loadIncident } from './internal.js';
import { loadRequest, type RequestRow } from './requests.js';
import { AVAILABILITY_STATUSES, type WireQuote } from './schemas.js';

export const QUOTE_SCOPES = Object.freeze(['DIAGNOSTIC_VISIT', 'REPAIR_LABOR', 'PART_SUPPLY', 'CONTAINMENT'] as const);

export interface QuoteView {
  quoteId: string;
  contactRequestId: string;
  incidentId: string;
  serviceProviderId: string;
  revision: number;
  supersedesQuoteId: string | null;
  state: 'CURRENT' | 'SUPERSEDED' | 'EXPIRED';
  sourceKind: 'ADAPTER_RESPONSE' | 'OPERATOR_ENTRY' | 'BROKER_RESULT';
  sourceAttemptId: string | null;
  sourceCommunicationId: string | null;
  sourceAdapterClass: string;
  sourceEvidenceDigest: string;
  scopeKind: string;
  scopeDigest: string;
  partNumber: string | null;
  manufacturer: string | null;
  amount: Money | null;
  taxMinor: bigint | null;
  etaMinutes: number | null;
  availabilityStatus: string;
  validUntil: UtcInstant | null;
  missingFields: string[];
  authority: 'NONE';
  compatibilityApproved: false;
  recordedAt: UtcInstant;
}

interface QuoteFields {
  scopeKind: (typeof QUOTE_SCOPES)[number];
  partNumber: string | null;
  manufacturer: string | null;
  amount: Money | null;
  taxMinor: bigint | null;
  etaMinutes: number | null;
  availabilityStatus: (typeof AVAILABILITY_STATUSES)[number];
  validUntil: string | null;
}

function missing(q: QuoteFields): string[] {
  const m: string[] = [];
  if (q.amount === null) m.push('amount');
  if (q.taxMinor === null) m.push('tax');
  if (q.etaMinutes === null) m.push('eta');
  if (q.validUntil === null) m.push('validity');
  if (q.availabilityStatus === 'UNKNOWN') m.push('availability');
  return m;
}

async function insertQuote(
  c: Tx,
  ctx: TenantContext,
  req: RequestRow,
  q: QuoteFields,
  source: {
    kind: QuoteView['sourceKind'];
    attemptId: string | null;
    communicationId: string | null;
    adapterClass: string;
    evidenceDigest: string;
  },
): Promise<string> {
  await c.query(`SELECT 1 FROM provider_contact_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    ctx.tenantId,
    req.id,
  ]);
  const prev = await c.query<{ id: string; revision: number }>(
    `SELECT id, revision FROM provider_quotes WHERE tenant_id = $1 AND contact_request_id = $2 ORDER BY revision DESC LIMIT 1`,
    [ctx.tenantId, req.id],
  );
  const revision = (prev.rows[0]?.revision ?? 0) + 1;
  const id = newProviderId('quote');
  const actor = actorFields(ctx);
  const missingFields = missing(q);
  await c.query(
    `INSERT INTO provider_quotes (tenant_id, id, incident_id, site_id, contact_request_id, service_provider_id, revision,
       supersedes_quote_id, source_kind, source_attempt_id, source_communication_id, source_evidence_digest,
       source_adapter_class, scope_digest, scope_kind, part_number, manufacturer, amount_minor, tax_minor, currency,
       eta_minutes, availability_status, valid_until, missing_fields, recorded_by_kind, recorded_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
             $24, $25, $26)`,
    [
      ctx.tenantId,
      id,
      req.incident_id,
      req.site_id,
      req.id,
      req.service_provider_id,
      revision,
      prev.rows[0]?.id ?? null,
      source.kind,
      source.attemptId,
      source.communicationId,
      source.evidenceDigest,
      source.adapterClass,
      canonicalDigest('provider-quote-scope', 1, {
        contactRequestId: req.id,
        scopeKind: q.scopeKind,
        partNumber: q.partNumber,
        manufacturer: q.manufacturer,
      }),
      q.scopeKind,
      q.partNumber,
      q.manufacturer,
      q.amount ? q.amount.amountMinor.toString() : null,
      q.taxMinor === null ? null : q.taxMinor.toString(),
      q.amount?.currency ?? null,
      q.etaMinutes,
      q.availabilityStatus,
      q.validUntil,
      missingFields,
      actor.kind,
      actor.id,
    ],
  );
  await emitProviderEvent(c, ctx, 'provider.quote_recorded.v1', id, 1, {
    quoteId: id,
    contactRequestId: req.id,
    incidentId: req.incident_id,
    serviceProviderId: req.service_provider_id,
    revision,
    amountMinor: q.amount ? q.amount.amountMinor.toString() : null,
    currency: q.amount?.currency ?? null,
    etaMinutes: q.etaMinutes,
    missingFields,
    sourceKind: source.kind,
    authority: 'NONE',
  });
  return id;
}

/** Quote observed in an M07 adapter response (structured, never extracted from free text). */
export async function recordQuoteInTx(
  c: Tx,
  ctx: TenantContext,
  req: RequestRow,
  src: { sourceKind: 'ADAPTER_RESPONSE'; attempt: AttemptRow; quote: WireQuote; digest: string },
): Promise<string> {
  const q = src.quote;
  const amount =
    q.amountMinor !== null && q.currency !== null ? money(q.amountMinor, q.currency as CurrencyCode) : null;
  return insertQuote(
    c,
    ctx,
    req,
    {
      scopeKind: q.scope,
      partNumber: null,
      manufacturer: null,
      amount,
      taxMinor: amount ? q.taxMinor : null,
      etaMinutes: q.etaMinutes,
      availabilityStatus: q.availability,
      validUntil: q.validUntil,
    },
    {
      kind: 'ADAPTER_RESPONSE',
      attemptId: src.attempt.id,
      communicationId: null,
      adapterClass: src.attempt.adapter_class === 'NONE' ? 'LOCAL_FAKE' : src.attempt.adapter_class,
      evidenceDigest: src.digest,
    },
  );
}

const text = (max: number) => z.string().min(1).max(max);
const RecordQuoteSchema = z.strictObject({
  contactRequestId: z.string().regex(/^pcr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  sourceKind: z.literal('OPERATOR_ENTRY'),
  sourceCommunicationId: z
    .string()
    .regex(/^pcm_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)
    .nullable()
    .optional(),
  scopeKind: z.enum(QUOTE_SCOPES),
  partNumber: text(80).nullable().optional(),
  manufacturer: text(200).nullable().optional(),
  amount: z
    .strictObject({ amountMinor: z.bigint().min(0n).max(9_223_372_036_854_775_807n), currency: CurrencyCodeSchema })
    .nullable(),
  taxMinor: z.bigint().min(0n).max(9_223_372_036_854_775_807n).nullable(),
  etaMinutes: z.int().min(0).max(100_000).nullable(),
  availabilityStatus: z.enum(AVAILABILITY_STATUSES),
  validUntil: UtcInstantSchema.nullable(),
  /** Structured source evidence (e.g. the operator's call note); only its digest is stored. */
  sourceEvidence: z.record(z.string().max(64), z.unknown()),
});
export type RecordQuoteInput = z.input<typeof RecordQuoteSchema>;

/** Operator-entered quote (FR-08): structured fields only; the note is evidence by digest, never parsed. */
export async function recordQuote(pool: Db, ctx: TenantContext, raw: RecordQuoteInput): Promise<QuoteView> {
  const p = RecordQuoteSchema.safeParse(raw);
  if (!p.success) throw invalid('INVALID_QUOTE');
  const input = p.data;
  let evidenceText: string;
  try {
    evidenceText = canonicalize(input.sourceEvidence as never);
  } catch {
    throw invalid('INVALID_QUOTE_EVIDENCE');
  }
  if (evidenceText.length > 4_000) throw invalid('QUOTE_EVIDENCE_TOO_LARGE');
  if (input.taxMinor !== null && input.amount === null) throw invalid('TAX_WITHOUT_AMOUNT');
  const meta = {
    action: 'provider_quote.record',
    resourceType: 'provider_contact_request',
    resourceId: input.contactRequestId,
  };
  const quoteId = await tenantCommand(pool, ctx, meta, async (c) => {
    const req = await loadRequest(c, ctx.tenantId, input.contactRequestId);
    if (!req) throw unavailable(meta);
    authorizeScoped(ctx, 'provider.quote', req.site_id, meta);
    if (input.sourceCommunicationId) {
      const comm = await c.query(
        `SELECT 1 FROM provider_communications WHERE tenant_id = $1 AND id = $2 AND contact_request_id = $3`,
        [ctx.tenantId, input.sourceCommunicationId, req.id],
      );
      if (comm.rowCount !== 1) throw hold('COMMUNICATION_NOT_OF_REQUEST');
    }
    const id = await insertQuote(
      c,
      ctx,
      req,
      {
        scopeKind: input.scopeKind,
        partNumber: input.partNumber ?? null,
        manufacturer: input.manufacturer ?? null,
        amount: input.amount ? money(input.amount.amountMinor, input.amount.currency) : null,
        taxMinor: input.taxMinor,
        etaMinutes: input.etaMinutes,
        availabilityStatus: input.availabilityStatus,
        validUntil: input.validUntil,
      },
      {
        kind: 'OPERATOR_ENTRY',
        attemptId: null,
        communicationId: input.sourceCommunicationId ?? null,
        adapterClass: 'OPERATOR',
        evidenceDigest: sha256Digest(evidenceText),
      },
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return id;
  });
  const all = await listIncidentQuotesInternal(pool, ctx, null, quoteId);
  return all[0]!;
}

function toQuote(r: Record<string, unknown>, now: number, latest: Set<string>): QuoteView {
  const validUntil = isoOf(r.valid_until as Date | null);
  const superseded = !latest.has(r.id as string);
  return {
    quoteId: r.id as string,
    contactRequestId: r.contact_request_id as string,
    incidentId: r.incident_id as string,
    serviceProviderId: r.service_provider_id as string,
    revision: r.revision as number,
    supersedesQuoteId: (r.supersedes_quote_id as string | null) ?? null,
    state: superseded ? 'SUPERSEDED' : validUntil !== null && Date.parse(validUntil) <= now ? 'EXPIRED' : 'CURRENT',
    sourceKind: r.source_kind as QuoteView['sourceKind'],
    sourceAttemptId: (r.source_attempt_id as string | null) ?? null,
    sourceCommunicationId: (r.source_communication_id as string | null) ?? null,
    sourceAdapterClass: r.source_adapter_class as string,
    sourceEvidenceDigest: r.source_evidence_digest as string,
    scopeKind: r.scope_kind as string,
    scopeDigest: r.scope_digest as string,
    partNumber: (r.part_number as string | null) ?? null,
    manufacturer: (r.manufacturer as string | null) ?? null,
    amount: r.amount_minor === null ? null : money(BigInt(r.amount_minor as string), r.currency as CurrencyCode),
    taxMinor: r.tax_minor === null ? null : BigInt(r.tax_minor as string),
    etaMinutes: (r.eta_minutes as number | null) ?? null,
    availabilityStatus: r.availability_status as string,
    validUntil,
    missingFields: r.missing_fields as string[],
    authority: 'NONE',
    compatibilityApproved: false,
    recordedAt: isoOf(r.recorded_at as Date)!,
  };
}

async function listIncidentQuotesInternal(
  pool: Db,
  ctx: TenantContext,
  incidentId: string | null,
  quoteId: string | null,
): Promise<QuoteView[]> {
  const meta = { action: 'provider_quote.read', resourceType: 'incident', resourceId: incidentId ?? quoteId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    let siteId: string;
    let rows: Record<string, unknown>[];
    if (incidentId !== null) {
      const incident = await loadIncident(c, ctx, meta, incidentId);
      siteId = incident.site_id;
      rows = (
        await c.query(
          `SELECT * FROM provider_quotes WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recorded_at, revision LIMIT 1000`,
          [ctx.tenantId, incidentId],
        )
      ).rows;
    } else {
      rows = (await c.query(`SELECT * FROM provider_quotes WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, quoteId]))
        .rows;
      if (!rows[0]) throw unavailable(meta);
      siteId = rows[0].site_id as string;
    }
    authorizeScoped(ctx, 'provider.read', siteId, meta);
    const latest = new Set(
      (
        await c.query<{ id: string }>(
          `SELECT DISTINCT ON (contact_request_id) id FROM provider_quotes
            WHERE tenant_id = $1 AND contact_request_id = ANY($2::text[]) ORDER BY contact_request_id, revision DESC`,
          [ctx.tenantId, [...new Set(rows.map((r) => r.contact_request_id as string))]],
        )
      ).rows.map((r) => r.id),
    );
    const now = Date.parse(await dbNow(c));
    return rows.map((r) => toQuote(r, now, latest));
  });
}

/** Quotes for an incident (M08 planning input). State is CURRENT, SUPERSEDED (newer revision) or EXPIRED. */
export async function listIncidentQuotes(pool: Db, ctx: TenantContext, incidentId: string): Promise<QuoteView[]> {
  return listIncidentQuotesInternal(pool, ctx, String(incidentId), null);
}
