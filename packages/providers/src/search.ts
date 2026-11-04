// Durable bounded provider discovery (FR-07, NFR-04). A search is an immutable request pinned to the exact current
// account revision and the incident's latest evidence revision, executed outside any transaction under explicit
// result/page/time bounds and the revision rate limit, then persisted with source-labelled results. Rank is ordering
// only; approved-vendor status is a separate projection that only a registry APPROVED_VENDOR record can set.
import {
  IdempotencyKeySchema,
  IncidentIdSchema,
  ProviderAccountIdSchema,
  money,
  type CurrencyCode,
  type Money,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import {
  humanActor,
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
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { emitProviderEvent } from './events.js';
import { invalid } from './errors.js';
import { newProviderId } from './ids.js';
import {
  DEFAULT_RATE_LIMITER,
  authorizeScoped,
  actorFields,
  isoOf,
  latestEvidence,
  loadCurrentRevision,
  loadIncident,
  receipts,
  requestDigestOf,
  unpaidCredential,
  withTimeout,
  type RevisionRateLimiter,
  type RevisionRow,
} from './internal.js';
import {
  contactValueDigest,
  normalizeContactValue,
  normalizeCountry,
  normalizeDomain,
  normalizePostalCode,
  normalizeProviderName,
  normalizeServiceArea,
  providerDedupeKey,
  safeProviderText,
  serviceAreaMatch,
  type ServiceArea,
} from './normalize.js';
import { NotSentError, type AdapterClass, type ProviderAdapterRegistry, type UnpaidProviderAdapter } from './ports.js';
import { PROVIDER_KINDS, type WireCandidate } from './schemas.js';

export const SEARCH_LIMITS = Object.freeze({
  maxResults: 100,
  maxPages: 10,
  maxTimeoutMs: 30_000,
  pageSize: 50,
  defaults: { maxResults: 25, maxPages: 3, timeoutMs: 10_000 },
});

const RunSearchSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  providerAccountId: ProviderAccountIdSchema,
  query: z.strictObject({
    providerKinds: z.array(z.enum(PROVIDER_KINDS)).min(1).max(5),
    country: z.string().regex(/^[A-Z]{2}$/),
    postalCode: z.string().max(16).nullable().optional(),
  }),
  bounds: z
    .strictObject({
      maxResults: z.int().min(1).max(SEARCH_LIMITS.maxResults).optional(),
      maxPages: z.int().min(1).max(SEARCH_LIMITS.maxPages).optional(),
      timeoutMs: z.int().min(100).max(SEARCH_LIMITS.maxTimeoutMs).optional(),
    })
    .optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type RunSearchInput = z.input<typeof RunSearchSchema>;

export interface SearchDeps {
  adapters: ProviderAdapterRegistry;
  credentials?: CredentialResolver;
  limiter?: RevisionRateLimiter;
}

export interface SearchResultView {
  rank: number;
  rankAuthority: 'NONE';
  provider: {
    serviceProviderId: string;
    displayName: string;
    normalizedName: string;
    providerKind: string;
    country: string | null;
    postalCode: string | null;
    websiteDomain: string | null;
    serviceArea: ServiceArea;
  };
  discovery: {
    sourceKind: 'PROVIDER_API' | 'DIRECTORY' | 'OPERATOR_ENTRY';
    externalRef: string | null;
    providerAccountRevisionId: string;
    adapterClass: string | null;
    rawResponseDigest: string;
    observedAt: UtcInstant;
  };
  vendorApproval: {
    status: 'UNKNOWN' | 'APPROVED' | 'NOT_APPROVED';
    vendorId: string | null;
    checkedAt: UtcInstant | null;
  };
  availability: { status: string; nextWindowAt: UtcInstant | null };
  price: { amount: Money; basis: string } | null;
  etaMinutes: number | null;
  serviceAreaMatch: 'IN_AREA' | 'OUT_OF_AREA' | 'UNKNOWN';
  capabilities: string[];
  /** Destinations by id and review state only; contact values never leave the server. */
  contactPoints: {
    contactPointId: string;
    channel: 'PHONE' | 'EMAIL' | 'API';
    intakeState: 'DISCOVERED' | 'PENDING_REVIEW';
    reviewState: 'UNREVIEWED' | 'VERIFIED' | 'REJECTED';
    sourceSearchId: string | null;
  }[];
}

export interface ProviderSearchView {
  searchId: string;
  incidentId: string;
  providerAccountId: string;
  providerAccountRevisionId: string;
  evidenceRevisionId: string;
  state: 'PENDING' | 'COMPLETED' | 'TRUNCATED' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
  stateReason: string | null;
  retryAfterMs: number | null;
  adapterCapability: 'ELIGIBLE' | 'UNSUPPORTED';
  adapterClass: AdapterClass | null;
  pagesFetched: number;
  resultCount: number;
  bounds: { maxResults: number; maxPages: number; timeoutMs: number };
  createdAt: UtcInstant;
  completedAt: UtcInstant | null;
  results: SearchResultView[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Prepared =
  | { kind: 'EXISTING'; searchId: string }
  | { kind: 'DONE'; searchId: string }
  | {
      kind: 'RUN';
      searchId: string;
      revision: RevisionRow;
      adapter: UnpaidProviderAdapter;
      query: { providerKinds: string[]; country: string; postalCode: string | null };
      bounds: { maxResults: number; maxPages: number; timeoutMs: number };
    };

export async function runProviderSearch(
  pool: Db,
  ctx: TenantContext,
  raw: RunSearchInput,
  deps: SearchDeps,
): Promise<ProviderSearchView> {
  const p = RunSearchSchema.safeParse(raw);
  if (!p.success) throw invalid('INVALID_PROVIDER_SEARCH');
  const input = p.data;
  const meta = { action: 'provider_search.run', resourceType: 'provider_search', resourceId: null };
  const query = {
    providerKinds: [...new Set(input.query.providerKinds)].sort(),
    country: input.query.country,
    postalCode: normalizePostalCode(input.query.postalCode ?? null),
  };
  const bounds = {
    maxResults: input.bounds?.maxResults ?? SEARCH_LIMITS.defaults.maxResults,
    maxPages: input.bounds?.maxPages ?? SEARCH_LIMITS.defaults.maxPages,
    timeoutMs: input.bounds?.timeoutMs ?? SEARCH_LIMITS.defaults.timeoutMs,
  };

  const prepared = await tenantCommand<Prepared>(pool, ctx, meta, async (c) => {
    const incident = await loadIncident(c, ctx, meta, input.incidentId);
    authorizeScoped(ctx, 'provider.search', incident.site_id, meta);
    const digest = requestDigestOf({ op: 'provider.search', ...input, query, bounds });
    const prior = await receipts.hit(c, ctx.tenantId, 'provider.search', input.idempotencyKey, digest);
    if (prior) return { kind: 'EXISTING', searchId: prior };
    const revision = await loadCurrentRevision(c, ctx.tenantId, input.providerAccountId);
    if (!revision) throw unavailable(meta, input.providerAccountId, 'provider_account');
    const evidence = await latestEvidence(c, ctx.tenantId, input.incidentId);
    let blocked: string | null = null;
    let adapter: UnpaidProviderAdapter | undefined;
    if (revision.accountStatus !== 'ACTIVE') blocked = 'PROVIDER_ACCOUNT_DISABLED';
    else if (revision.paid || revision.ownerService !== 'M07_UNPAID') blocked = 'PAID_SEARCH_REQUIRES_BROKER';
    else if (!revision.capabilities.includes('SEARCH')) blocked = 'CAPABILITY_NOT_DECLARED';
    else {
      adapter = deps.adapters.find(revision.providerKey, 'SEARCH');
      if (!adapter?.search) blocked = 'ADAPTER_NOT_CONFIGURED';
      else {
        const cap = adapter.assess(revision, 'SEARCH');
        if (cap.kind === 'UNSUPPORTED') blocked = cap.reasonCode;
      }
    }
    const searchId = newProviderId('search');
    const actor = actorFields(ctx);
    await c.query(
      `INSERT INTO provider_searches (tenant_id, id, incident_id, site_id, asset_id, evidence_revision_id, provider_account_id,
         provider_account_revision_id, query, query_digest, max_results, max_pages, timeout_ms, max_cost_minor, state,
         state_reason, adapter_capability, created_by_kind, created_by_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, $15, $16, $17, $18,
               CASE WHEN $14 = 'BLOCKED' THEN clock_timestamp() END)`,
      [
        ctx.tenantId,
        searchId,
        incident.id,
        incident.site_id,
        incident.asset_id,
        evidence.evidenceRevisionId,
        revision.providerAccountId,
        revision.providerAccountRevisionId,
        JSON.stringify(query),
        canonicalDigest('provider-search-query', 1, query),
        bounds.maxResults,
        bounds.maxPages,
        bounds.timeoutMs,
        blocked ? 'BLOCKED' : 'PENDING',
        blocked,
        blocked ? 'UNSUPPORTED' : 'ELIGIBLE',
        actor.kind,
        actor.id,
      ],
    );
    await receipts.store(c, ctx.tenantId, 'provider.search', input.idempotencyKey, digest, searchId);
    await recordAudit(c, ctx, { ...meta, resourceId: searchId, result: 'SUCCEEDED', reasonCode: blocked });
    if (blocked) {
      await emitSearchCompleted(c, ctx, searchId);
      return { kind: 'DONE', searchId };
    }
    return { kind: 'RUN', searchId, revision, adapter: adapter!, query, bounds };
  });

  if (prepared.kind !== 'RUN') return getProviderSearch(pool, ctx, prepared.searchId);
  const run = await executeSearch(prepared, deps);
  await withTenantTransaction(pool, ctx, (c) => persistResults(c, ctx, prepared, run));
  const view = await getProviderSearch(pool, ctx, prepared.searchId);
  return view;
}

interface SearchRun {
  items: (WireCandidate & { rawResponseDigest: string; observedAt: string })[];
  pagesFetched: number;
  state: 'COMPLETED' | 'TRUNCATED' | 'PARTIAL' | 'FAILED';
  reason: string | null;
  retryAfterMs: number | null;
}

async function executeSearch(p: Extract<Prepared, { kind: 'RUN' }>, deps: SearchDeps): Promise<SearchRun> {
  const limiter = deps.limiter ?? DEFAULT_RATE_LIMITER;
  const deadline = Date.now() + p.bounds.timeoutMs;
  const items: SearchRun['items'] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let reason: string | null = null;
  let retryAfterMs: number | null = null;
  let truncated = false;
  const credential = unpaidCredential(p.revision, deps.credentials);
  for (;;) {
    if (pages >= p.bounds.maxPages) {
      truncated = true;
      reason = 'MAX_PAGES';
      break;
    }
    const wait = limiter.take(p.revision.providerAccountRevisionId);
    if (wait > 0) {
      if (Date.now() + wait >= deadline) {
        reason = 'LOCAL_RATE_LIMITED';
        break;
      }
      await sleep(wait);
    }
    const remaining = deadline - Date.now();
    if (remaining < 50) {
      reason = 'TIMEOUT';
      break;
    }
    const pageSize = Math.min(SEARCH_LIMITS.pageSize, p.bounds.maxResults - items.length);
    const r = await withTimeout(remaining, (signal) =>
      p.adapter.search!({ query: p.query, cursor, pageSize }, { revision: p.revision, signal, credential }),
    );
    pages++;
    if (r.kind === 'TIMEOUT') {
      reason = 'TIMEOUT';
      break;
    }
    if (r.kind === 'ERROR') {
      reason = r.error instanceof NotSentError ? 'NOT_SENT' : 'PROVIDER_ERROR';
      break;
    }
    const res = r.value;
    if (res.kind === 'RATE_LIMITED') {
      reason = 'RATE_LIMITED';
      retryAfterMs = res.retryAfterMs;
      break;
    }
    if (res.kind === 'ERROR') {
      reason = res.reasonCode;
      break;
    }
    const observedAt = new Date().toISOString();
    for (const item of res.page.items) {
      const key = `${normalizeProviderName(item.name)}|${item.country}|${normalizePostalCode(item.postalCode ?? null)}|${normalizeDomain(item.website ?? null)}`;
      if (seen.has(key) || normalizeProviderName(item.name).length === 0) continue;
      seen.add(key);
      if (items.length >= p.bounds.maxResults) {
        truncated = true;
        break;
      }
      items.push({ ...item, rawResponseDigest: res.rawResponseDigest, observedAt });
    }
    if (truncated) {
      reason = 'MAX_RESULTS';
      break;
    }
    if (res.page.nextCursor === null) break;
    if (items.length >= p.bounds.maxResults) {
      truncated = true;
      reason = 'MAX_RESULTS';
      break;
    }
    if (cursors.has(res.page.nextCursor)) {
      reason = 'CURSOR_CYCLE';
      break;
    }
    cursors.add(res.page.nextCursor);
    cursor = res.page.nextCursor;
  }
  const state =
    truncated && (reason === 'MAX_PAGES' || reason === 'MAX_RESULTS')
      ? 'TRUNCATED'
      : reason === null
        ? 'COMPLETED'
        : items.length > 0
          ? 'PARTIAL'
          : 'FAILED';
  return { items, pagesFetched: pages, state, reason, retryAfterMs };
}

async function persistResults(c: Tx, ctx: TenantContext, p: Extract<Prepared, { kind: 'RUN' }>, run: SearchRun) {
  const locked = await c.query(`SELECT state FROM provider_searches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    ctx.tenantId,
    p.searchId,
  ]);
  if (locked.rows[0]?.state !== 'PENDING') return;
  let rank = 0;
  for (const item of run.items) {
    const normalizedName = normalizeProviderName(item.name);
    const country = normalizeCountry(item.country);
    const postalCode = normalizePostalCode(item.postalCode ?? null);
    const websiteDomain = normalizeDomain(item.website ?? null);
    const area = normalizeServiceArea(item.serviceArea ?? {});
    const dedupeKey = providerDedupeKey(ctx.tenantId, { normalizedName, country, postalCode, websiteDomain });
    const ins = await c.query<{ id: string }>(
      `INSERT INTO service_providers (tenant_id, id, dedupe_key, provider_kind, display_name, normalized_name, country,
         postal_code, website_domain, service_area)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
      [
        ctx.tenantId,
        newProviderId('serviceProvider'),
        dedupeKey,
        item.kind,
        safeProviderText(item.name) || normalizedName,
        normalizedName,
        country,
        postalCode,
        websiteDomain,
        JSON.stringify(area),
      ],
    );
    const providerId =
      ins.rows[0]?.id ??
      (
        await c.query<{ id: string }>(`SELECT id FROM service_providers WHERE tenant_id = $1 AND dedupe_key = $2`, [
          ctx.tenantId,
          dedupeKey,
        ])
      ).rows[0]!.id;
    // A provider already linked to an approved-vendor record cannot gain usable destinations from a search.
    const linked = (
      await c.query<{ approved_vendor_status: string }>(
        `SELECT approved_vendor_status FROM service_providers WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, providerId],
      )
    ).rows[0]!.approved_vendor_status;
    for (const cp of item.contacts) {
      const value = normalizeContactValue(cp.channel, cp.value);
      if (value === null) continue;
      await c.query(
        `INSERT INTO service_provider_contact_points (tenant_id, id, service_provider_id, channel, value, value_digest,
           source_search_id, source_provider_account_revision_id, intake_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, service_provider_id, channel, value_digest) DO NOTHING`,
        [
          ctx.tenantId,
          newProviderId('contactPoint'),
          providerId,
          cp.channel,
          value,
          contactValueDigest(cp.channel, value),
          p.searchId,
          p.revision.providerAccountRevisionId,
          linked === 'UNKNOWN' ? 'DISCOVERED' : 'PENDING_REVIEW',
        ],
      );
    }
    rank++;
    await c.query(
      `INSERT INTO provider_search_results (tenant_id, id, search_id, service_provider_id, rank, source_kind, external_ref,
         service_area_match, availability_status, availability_next_at, price_amount_minor, price_currency, price_basis,
         eta_minutes, capabilities, raw_response_digest, observed_at)
       VALUES ($1, $2, $3, $4, $5, 'PROVIDER_API', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        ctx.tenantId,
        newProviderId('searchResult'),
        p.searchId,
        providerId,
        rank,
        item.id,
        serviceAreaMatch(area, { country: p.query.country, postalCode: p.query.postalCode }),
        item.availability.status,
        item.availability.nextWindowAt,
        item.price ? item.price.amountMinor.toString() : null,
        item.price?.currency ?? null,
        item.price?.basis ?? null,
        item.etaMinutes,
        [...new Set(item.capabilities)].sort(),
        item.rawResponseDigest,
        item.observedAt,
      ],
    );
  }
  await c.query(
    `UPDATE provider_searches SET state = $3, state_reason = $4, retry_after_ms = $5, adapter_class = $6,
            pages_fetched = $7, result_count = $8, completed_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, p.searchId, run.state, run.reason, run.retryAfterMs, p.adapter.adapterClass, run.pagesFetched, rank],
  );
  await emitSearchCompleted(c, ctx, p.searchId);
}

async function emitSearchCompleted(c: Tx, ctx: TenantContext, searchId: string) {
  const { rows } = await c.query(`SELECT * FROM provider_searches WHERE tenant_id = $1 AND id = $2`, [
    ctx.tenantId,
    searchId,
  ]);
  const s = rows[0]!;
  await emitProviderEvent(c, ctx, 'provider.search_completed.v1', searchId, 1, {
    searchId,
    incidentId: s.incident_id,
    providerAccountRevisionId: s.provider_account_revision_id,
    state: s.state,
    stateReason: s.state_reason,
    resultCount: s.result_count,
    pagesFetched: s.pages_fetched,
    adapterClass: s.adapter_class,
    queryDigest: s.query_digest,
  });
}

export async function getProviderSearch(pool: Db, ctx: TenantContext, searchId: string): Promise<ProviderSearchView> {
  const meta = { action: 'provider_search.read', resourceType: 'provider_search', resourceId: searchId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(`SELECT * FROM provider_searches WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      String(searchId),
    ]);
    const s = rows[0];
    if (!s) throw unavailable(meta);
    authorizeScoped(ctx, 'provider.read', s.site_id, meta);
    const res = await c.query(
      `SELECT r.*, p.display_name, p.normalized_name, p.provider_kind, p.country, p.postal_code, p.website_domain,
              p.service_area, p.approved_vendor_status, p.approved_vendor_ref, p.approved_vendor_checked_at
         FROM provider_search_results r
         JOIN service_providers p ON p.tenant_id = r.tenant_id AND p.id = r.service_provider_id
        WHERE r.tenant_id = $1 AND r.search_id = $2 ORDER BY r.rank`,
      [ctx.tenantId, searchId],
    );
    const pts = await c.query(
      `SELECT p.id, p.service_provider_id, p.channel, p.intake_state, p.source_search_id,
              (SELECT r.decision FROM service_provider_contact_point_reviews r WHERE r.tenant_id = p.tenant_id
                  AND r.contact_point_id = p.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1) AS decision
         FROM service_provider_contact_points p
        WHERE p.tenant_id = $1 AND p.service_provider_id = ANY($2::text[]) ORDER BY p.created_at, p.id LIMIT 1000`,
      [ctx.tenantId, res.rows.map((r) => r.service_provider_id)],
    );
    const pointsOf = (providerId: string) =>
      pts.rows
        .filter((x) => x.service_provider_id === providerId)
        .map((x) => ({
          contactPointId: x.id,
          channel: x.channel,
          intakeState: x.intake_state,
          reviewState: x.decision ?? 'UNREVIEWED',
          sourceSearchId: x.source_search_id,
        }));
    return {
      searchId: s.id,
      incidentId: s.incident_id,
      providerAccountId: s.provider_account_id,
      providerAccountRevisionId: s.provider_account_revision_id,
      evidenceRevisionId: s.evidence_revision_id,
      state: s.state,
      stateReason: s.state_reason,
      retryAfterMs: s.retry_after_ms,
      adapterCapability: s.adapter_capability,
      adapterClass: s.adapter_class,
      pagesFetched: s.pages_fetched,
      resultCount: s.result_count,
      bounds: { maxResults: s.max_results, maxPages: s.max_pages, timeoutMs: s.timeout_ms },
      createdAt: isoOf(s.created_at)!,
      completedAt: isoOf(s.completed_at),
      results: res.rows.map((r): SearchResultView => ({
        rank: r.rank,
        rankAuthority: 'NONE',
        provider: {
          serviceProviderId: r.service_provider_id,
          displayName: r.display_name,
          normalizedName: r.normalized_name,
          providerKind: r.provider_kind,
          country: r.country,
          postalCode: r.postal_code,
          websiteDomain: r.website_domain,
          serviceArea: r.service_area,
        },
        discovery: {
          sourceKind: r.source_kind,
          externalRef: r.external_ref,
          providerAccountRevisionId: s.provider_account_revision_id,
          adapterClass: s.adapter_class,
          rawResponseDigest: r.raw_response_digest,
          observedAt: isoOf(r.observed_at)!,
        },
        vendorApproval: {
          status: r.approved_vendor_status,
          vendorId: r.approved_vendor_ref,
          checkedAt: isoOf(r.approved_vendor_checked_at),
        },
        availability: { status: r.availability_status, nextWindowAt: isoOf(r.availability_next_at) },
        price:
          r.price_amount_minor === null
            ? null
            : { amount: money(BigInt(r.price_amount_minor), r.price_currency as CurrencyCode), basis: r.price_basis },
        etaMinutes: r.eta_minutes,
        serviceAreaMatch: r.service_area_match,
        capabilities: r.capabilities,
        contactPoints: pointsOf(r.service_provider_id),
      })),
    };
  });
}

/**
 * Link a discovered provider to an approved-vendor registry record (admin). The projection mirrors the record's
 * status at link time; discovery, rank and provider claims can never set it.
 */
export async function linkApprovedVendor(
  pool: Db,
  ctx: TenantContext,
  input: { serviceProviderId: string; vendorId: string },
): Promise<{
  serviceProviderId: string;
  approvedVendorStatus: 'APPROVED' | 'NOT_APPROVED';
  vendorId: string;
  checkedAt: UtcInstant;
}> {
  const meta = {
    action: 'provider.vendor_link',
    resourceType: 'service_provider',
    resourceId: input?.serviceProviderId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider.vendor_link', siteId: null });
    const sp = await c.query(`SELECT version FROM service_providers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      ctx.tenantId,
      String(input.serviceProviderId),
    ]);
    if (!sp.rows[0]) throw unavailable(meta);
    const v = await c.query<{ body: { status: string } }>(
      `SELECT body FROM registry_revisions WHERE tenant_id = $1 AND entity_kind = 'APPROVED_VENDOR' AND entity_id = $2
        ORDER BY revision DESC LIMIT 1`,
      [ctx.tenantId, String(input.vendorId)],
    );
    if (!v.rows[0]) throw unavailable(meta, input.vendorId, 'approved_vendor');
    const status = v.rows[0].body.status === 'APPROVED' ? 'APPROVED' : 'NOT_APPROVED';
    const { rows } = await c.query<{ approved_vendor_checked_at: Date }>(
      `UPDATE service_providers SET approved_vendor_status = $3, approved_vendor_ref = $4,
              approved_vendor_checked_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 RETURNING approved_vendor_checked_at`,
      [ctx.tenantId, input.serviceProviderId, status, input.vendorId],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: status });
    return {
      serviceProviderId: input.serviceProviderId,
      approvedVendorStatus: status,
      vendorId: input.vendorId,
      checkedAt: isoOf(rows[0]!.approved_vendor_checked_at)!,
    };
  });
}

/**
 * Admin review of a discovered contact point (destination-hijack control): VERIFIED makes it usable for any account,
 * REJECTED makes it unusable. Append-only; the latest decision wins.
 */
export async function reviewContactPoint(
  pool: Db,
  ctx: TenantContext,
  input: { contactPointId: string; decision: 'VERIFIED' | 'REJECTED' },
): Promise<{ contactPointId: string; decision: 'VERIFIED' | 'REJECTED' }> {
  if (input?.decision !== 'VERIFIED' && input?.decision !== 'REJECTED') throw invalid('INVALID_REVIEW_DECISION');
  const meta = {
    action: 'provider.contact_point_review',
    resourceType: 'contact_point',
    resourceId: input.contactPointId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const cp = await c.query(`SELECT 1 FROM service_provider_contact_points WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      String(input.contactPointId),
    ]);
    if (cp.rowCount !== 1) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'provider.vendor_link', siteId: null });
    await c.query(
      `INSERT INTO service_provider_contact_point_reviews (tenant_id, id, contact_point_id, decision, reviewed_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.tenantId, newProviderId('contactPointReview'), input.contactPointId, input.decision, humanActor(ctx)],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.decision });
    return { contactPointId: input.contactPointId, decision: input.decision };
  });
}
