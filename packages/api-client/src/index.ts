// @uptimebuyer/api-client — the typed client of the operator HTTP API (M12). Every request body is encoded with the
// same strict @uptimebuyer/contracts schema the server parses with, and every response is decoded with its response
// schema, so an unknown state value fails loudly instead of being rendered as a guess (INV-12). The access token is
// obtained per request from the caller's in-memory provider; this module never stores it, logs it or places it in a
// URL. Mutations always send an Idempotency-Key (and If-Match for versioned aggregate commands).
import { ApiErrorBodySchema, type ApiErrorBody } from '@uptimebuyer/contracts';
import * as api from '@uptimebuyer/contracts/api';
import type { z } from 'zod';

export * from '@uptimebuyer/contracts/api';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
    readonly correlationId: string | null,
  ) {
    super(body?.error.message ?? `Request failed with status ${status}.`);
    this.name = 'ApiClientError';
  }
  get code(): string | null {
    return this.body?.error.code ?? null;
  }
  get reasonCode(): string | null {
    return this.body?.error.reasonCode ?? null;
  }
  get currentVersion(): number | null {
    return this.body?.error.currentVersion ?? null;
  }
}

/** A response that could not be decoded against its contract (never rendered as data). */
export class ApiContractError extends Error {
  constructor(
    readonly path: string,
    readonly issues: readonly { path: string; code: string }[],
  ) {
    super(`The server response for ${path} did not match the contract.`);
    this.name = 'ApiContractError';
  }
}

export interface ApiClientOptions {
  /** Same-origin by default (''). */
  baseUrl?: string;
  /** Returns the current access token from memory, or null when signed out. */
  getAccessToken: () => string | null;
  /** Optional X-Tenant-ID request (the server only honours one of the principal's own memberships). */
  getTenantId?: () => string | null;
  fetch?: typeof fetch;
  newIdempotencyKey?: () => string;
}

const defaultKey = () => `ub-web-${globalThis.crypto.randomUUID()}`;
const enc = encodeURIComponent;

export interface Mutation {
  /** Reuse a key to retry the same intent safely; a fresh one is generated per call otherwise. */
  idempotencyKey?: string;
}
export interface Versioned extends Mutation {
  expectedVersion: number;
}

export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl ?? '';
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = opts.newIdempotencyKey ?? defaultKey;

  async function call<S extends z.ZodType>(
    schema: S,
    method: 'GET' | 'POST',
    path: string,
    init: {
      body?: unknown;
      bodySchema?: z.ZodType;
      idempotencyKey?: string;
      expectedVersion?: number;
      auth?: boolean;
    } = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.auth !== false) {
      const token = opts.getAccessToken();
      if (!token) throw new ApiClientError(401, null, null);
      headers.authorization = `Bearer ${token}`;
      const tenant = opts.getTenantId?.();
      if (tenant) headers[api.TENANT_HEADER] = tenant;
    }
    let payload: string | undefined;
    if (method === 'POST') {
      headers[api.IDEMPOTENCY_KEY_HEADER] = init.idempotencyKey ?? newKey();
      if (init.expectedVersion !== undefined) headers[api.IF_MATCH_HEADER] = `"${init.expectedVersion}"`;
      const value = init.bodySchema ? init.bodySchema.parse(init.body ?? {}) : (init.body ?? {});
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(value);
    }
    const res = await f(`${base}${path}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    const correlationId = res.headers.get(api.CORRELATION_HEADER);
    const json: unknown = await res.json().catch(() => null);
    // A non-2xx is an error; so is a 202 whose body is an error (DEPENDENCY_OUTCOME_UNKNOWN: the outcome is unknown,
    // which must never be decoded as success).
    const err = ApiErrorBodySchema.safeParse(json);
    if (!res.ok || err.success) throw new ApiClientError(res.status, err.success ? err.data : null, correlationId);
    const r = schema.safeParse(json);
    if (!r.success)
      throw new ApiContractError(
        path,
        r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), code: i.code })),
      );
    return r.data;
  }

  return {
    publicConfig: () => call(api.PublicConfigSchema, 'GET', '/v1/public-config', { auth: false }),
    session: () => call(api.SessionSchema, 'GET', '/v1/session'),
    fleet: () => call(api.FleetSchema, 'GET', '/v1/fleet'),
    telemetry: (assetId: string, windowMinutes = 30) =>
      call(api.TelemetrySchema, 'GET', `/v1/assets/${enc(assetId)}/telemetry?windowMinutes=${windowMinutes}`),

    incidents: (q: { activeOnly?: boolean; siteId?: string } = {}) => {
      const p = new URLSearchParams();
      if (q.activeOnly !== undefined) p.set('activeOnly', String(q.activeOnly));
      if (q.siteId) p.set('siteId', q.siteId);
      const s = p.toString();
      return call(api.IncidentListSchema, 'GET', `/v1/incidents${s ? `?${s}` : ''}`);
    },
    incident: (id: string) => call(api.IncidentDetailSchema, 'GET', `/v1/incidents/${enc(id)}`),
    timeline: (id: string) => call(api.TimelineSchema, 'GET', `/v1/incidents/${enc(id)}/timeline`),
    assignableMembers: (id: string) => call(api.MembersSchema, 'GET', `/v1/incidents/${enc(id)}/assignable-members`),
    acknowledge: (id: string, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}:acknowledge`, {
        body: {},
        bodySchema: api.EmptyBodySchema,
        ...m,
      }),
    assign: (id: string, b: z.input<typeof api.AssignIncidentBodySchema>, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}:assign`, {
        body: b,
        bodySchema: api.AssignIncidentBodySchema,
        ...m,
      }),
    accept: (id: string, assignmentId: string, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}/assignments/${enc(assignmentId)}:accept`, {
        body: {},
        bodySchema: api.EmptyBodySchema,
        ...m,
      }),
    handoff: (id: string, b: z.input<typeof api.HandoffIncidentBodySchema>, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}:handoff`, {
        body: b,
        bodySchema: api.HandoffIncidentBodySchema,
        ...m,
      }),
    adjustDeadline: (id: string, b: z.input<typeof api.AdjustDeadlineBodySchema>, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}:adjust-deadline`, {
        body: b,
        bodySchema: api.AdjustDeadlineBodySchema,
        ...m,
      }),
    escalate: (id: string, b: z.input<typeof api.EscalateIncidentBodySchema>, m: Versioned) =>
      call(api.CommandResultSchema, 'POST', `/v1/incidents/${enc(id)}:escalate`, {
        body: b,
        bodySchema: api.EscalateIncidentBodySchema,
        ...m,
      }),

    evidence: (id: string) => call(api.EvidenceSchema, 'GET', `/v1/incidents/${enc(id)}/evidence`),
    citation: (citationId: string) => call(api.CitationResponseSchema, 'GET', `/v1/citations/${enc(citationId)}`),
    compatibility: (id: string) => call(api.CompatibilitySchema, 'GET', `/v1/incidents/${enc(id)}/compatibility`),
    plans: (id: string) => call(api.PlansSchema, 'GET', `/v1/incidents/${enc(id)}/plans`),
    approve: (planId: string, b: z.input<typeof api.ApprovePlanBodySchema>, m: Mutation = {}) =>
      call(api.ApprovalResultSchema, 'POST', `/v1/plans/${enc(planId)}:approve`, {
        body: b,
        bodySchema: api.ApprovePlanBodySchema,
        ...m,
      }),
    hold: (planId: string, b: z.input<typeof api.HoldPlanBodySchema>, m: Mutation = {}) =>
      call(api.HoldResultSchema, 'POST', `/v1/plans/${enc(planId)}:hold`, {
        body: b,
        bodySchema: api.HoldPlanBodySchema,
        ...m,
      }),

    authorities: (id: string) => call(api.AuthoritiesSchema, 'GET', `/v1/incidents/${enc(id)}/execution-authorities`),
    authority: (authorityId: string) =>
      call(api.AuthorityWireSchema, 'GET', `/v1/execution-authorities/${enc(authorityId)}`),
    issueAuthority: (approvalId: string, b: z.input<typeof api.IssueAuthorityBodySchema>, m: Mutation = {}) =>
      call(api.IssueAuthorityResultSchema, 'POST', `/v1/approvals/${enc(approvalId)}/execution-authorities`, {
        body: b,
        bodySchema: api.IssueAuthorityBodySchema,
        ...m,
      }),
    changeAuthority: (authorityId: string, b: z.input<typeof api.ChangeAuthorityBodySchema>, m: Mutation = {}) =>
      call(api.AuthorityWireSchema, 'POST', `/v1/execution-authorities/${enc(authorityId)}:change-status`, {
        body: b,
        bodySchema: api.ChangeAuthorityBodySchema,
        ...m,
      }),
    intent: (intentId: string) => call(api.IntentWireSchema, 'GET', `/v1/intents/${enc(intentId)}`),
    orders: (id: string) => call(api.OrdersSchema, 'GET', `/v1/incidents/${enc(id)}/orders`),
    purchaseOrder: (orderId: string) => call(api.OrderWireSchema, 'GET', `/v1/purchase-orders/${enc(orderId)}`),
    serviceJob: (orderId: string) => call(api.OrderWireSchema, 'GET', `/v1/service-jobs/${enc(orderId)}`),
    verifyOrder: (orderId: string, b: z.input<typeof api.VerifyOrderBodySchema>, m: Mutation = {}) =>
      call(api.OrderWireSchema, 'POST', `/v1/orders/${enc(orderId)}:verify`, {
        body: b,
        bodySchema: api.VerifyOrderBodySchema,
        ...m,
      }),
    recovery: (id: string) => call(api.RecoverySchema, 'GET', `/v1/incidents/${enc(id)}/recovery`),

    ledger: () => call(api.LedgerSchema, 'GET', '/v1/ledger'),
    audit: () => call(api.AuditSchema, 'GET', '/v1/audit'),
    policies: () => call(api.PolicyHistorySchema, 'GET', '/v1/policies'),
    validatePolicy: (b: z.input<typeof api.PolicyDraftBodySchema>) =>
      call(api.PolicyValidationSchema, 'POST', '/v1/policies:validate', {
        body: b,
        bodySchema: api.PolicyDraftBodySchema,
      }),
    publishPolicy: (b: z.input<typeof api.PolicyDraftBodySchema>, m: Mutation = {}) =>
      call(api.PolicyPublishResultSchema, 'POST', '/v1/policies', {
        body: b,
        bodySchema: api.PolicyDraftBodySchema,
        ...m,
      }),
    notifications: () => call(api.NotificationsSchema, 'GET', '/v1/notifications'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
