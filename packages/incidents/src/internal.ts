// Internal helpers shared by the incident repositories: id minting, input validation, tenant/site authorization of
// an incident (foreign, nonexistent and out-of-site rows are indistinguishable), row locking with aggregate-version
// compare-and-set, legal transitions through the M01 table, outbox emission and Idempotency-Key receipts.
import {
  DomainError,
  IdempotencyKeySchema,
  IncidentIdSchema,
  newId,
  type IncidentState,
  type TenantId,
} from '@uptimebuyer/contracts';
import {
  Denial,
  actorOf,
  appendOutboxEvent,
  authorize,
  notPermitted,
  sha256Digest,
  unavailable,
  versionConflict,
  type ActionName,
  type CommandMeta,
  type HumanRole,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { applyTransition, canonicalize } from '@uptimebuyer/domain';
import type { z } from 'zod';

export const INCIDENT_ID_PREFIXES = Object.freeze({
  procedureRevision: 'opr',
  ruleRevision: 'irl',
  transition: 'itr',
  assignment: 'ias',
  deadlineEvent: 'idl',
  manualReport: 'imr',
  signal: 'isg',
  acknowledgement: 'iak',
  riskEstimate: 'ire',
  /** Column-default ids of child rows (attachments, signal samples, command receipts). */
  attachment: 'ima',
  signalSample: 'iss',
  commandReceipt: 'icr',
} as const);
export type IncidentIdKind = keyof typeof INCIDENT_ID_PREFIXES;
export const newIncidentDataId = (kind: IncidentIdKind): string =>
  `${INCIDENT_ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID()}`;
export const newIncidentId = () => newId('incident');

export const validation = (reasonCode: string, fieldErrors?: { path: string; issue: string }[]) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', {
    reasonCode,
    ...(fieldErrors ? { fieldErrors } : {}),
  });

/** Strict zod parse; unknown fields (tenant, trust, sample ids, procedure ids, ...) fail validation. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, reasonCode = 'INVALID_INPUT'): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success)
    throw validation(
      reasonCode,
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), issue: i.code })),
    );
  return r.data;
}

export const ms = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v));
export const isoOf = (v: Date | string) => new Date(ms(v)).toISOString();
export const isoOrNull = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : isoOf(v));

/** Raw incidents row as selected with `SELECT *`. */
export interface IncidentRow {
  tenant_id: TenantId;
  id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  rule_revision_id: string;
  procedure_revision_id: string;
  policy_revision_id: string | null;
  trigger_kind: 'TELEMETRY_RULE' | 'MANUAL_REPORT';
  trigger_input_origin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT' | 'OPERATOR_REPORT';
  state: IncidentState;
  paused_from_state: IncidentState | null;
  fault_family: string;
  fault_window_key: string;
  dedupe_key: string;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  signal_state: 'LIVE' | 'UNCERTAIN';
  trigger_event_at: Date;
  trigger_received_at: Date;
  opened_at: Date;
  open_latency_ms: string;
  deadline_kind: 'RESPONSE' | 'CONTAINMENT';
  deadline_basis: 'TRIGGER_EVENT_AT' | 'OPENED_AT';
  deadline_basis_at: Date;
  deadline_computed_at: Date;
  deadline_basis_digest: string;
  deadline_timezone_basis: string;
  original_response_deadline_at: Date;
  current_response_deadline_at: Date;
  deadline_status: 'RUNNING' | 'PAUSED' | 'EXPIRED';
  deadline_paused_at: Date | null;
  deadline_extended_ms: string;
  current_assignment_id: string | null;
  acknowledged_at: Date | null;
  acknowledged_by_user_id: string | null;
  recovered_at: Date | null;
  reopen_count: number;
  correlation_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Principals that may read an incident at `siteId`: human roles there, or the engine worker. */
export function canRead(ctx: TenantContext, siteId: string): boolean {
  return (
    authorize(ctx, { action: 'incident.read', siteId: siteId as never }).allowed ||
    authorize(ctx, { action: 'incident.engine' }).allowed
  );
}

/**
 * Lock and load an incident in the caller's tenant. A malformed, foreign, nonexistent or out-of-site id is the same
 * audited RESOURCE_UNAVAILABLE; a readable incident whose `action` is not permitted is FORBIDDEN with its reason.
 */
export async function loadIncident(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  incidentId: unknown,
  opts: { action: ActionName | null; lock: 'UPDATE' | 'SHARE' | null },
): Promise<IncidentRow> {
  if (typeof incidentId !== 'string' || !IncidentIdSchema.safeParse(incidentId).success) throw unavailable(meta);
  const lock = opts.lock === 'UPDATE' ? ' FOR UPDATE' : opts.lock === 'SHARE' ? ' FOR SHARE' : '';
  const { rows } = await c.query<IncidentRow>(`SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2${lock}`, [
    ctx.tenantId,
    incidentId,
  ]);
  const row = rows[0];
  if (!row || !canRead(ctx, row.site_id)) throw unavailable(meta);
  if (opts.action) requireAt(ctx, meta, opts.action, row.site_id, row.id);
  return row;
}

/** Authorize `action` at `siteId` inside a tenant command (audited Denial on refusal). */
export function requireAt(
  ctx: TenantContext,
  meta: CommandMeta,
  action: ActionName,
  siteId: string | null,
  resourceId: string | null = null,
): void {
  const d = authorize(ctx, { action, siteId: siteId as never });
  if (!d.allowed)
    throw new Denial(notPermitted(d.reasonCode), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId,
      reasonCode: d.reasonCode,
    });
}

export const deny = (meta: CommandMeta, reasonCode: string, resourceId: string | null = null) =>
  new Denial(notPermitted(reasonCode), {
    action: meta.action,
    resourceType: meta.resourceType,
    resourceId,
    reasonCode,
  });

export function assertVersion(row: IncidentRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) throw versionConflict();
}

/** Does the context hold `role` covering `siteId` (site grant or tenant-wide grant)? */
export function holdsRoleAt(ctx: TenantContext, role: HumanRole, siteId: string): boolean {
  return ctx.grants.some((g) => g.role === role && (g.siteId === null || g.siteId === siteId));
}

export const ELIGIBLE_OWNER_ROLES: readonly HumanRole[] = ['operator', 'maintenance_approver', 'engineer', 'admin'];

/** An incident owner must be an ACTIVE member of this tenant holding an operating role at the site (or anywhere). */
export async function ownerEligibility(
  c: Tx,
  tenantId: TenantId,
  userId: unknown,
  siteId: string | null,
): Promise<'ELIGIBLE' | 'NOT_MEMBER' | 'NO_ROLE'> {
  if (typeof userId !== 'string' || !/^usr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(userId)) return 'NOT_MEMBER';
  const m = await c.query(
    `SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'`,
    [tenantId, userId],
  );
  if (m.rowCount !== 1) return 'NOT_MEMBER';
  const r = await c.query(
    `SELECT 1 FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL AND role = ANY($3)
        AND ($4::text IS NULL OR site_id IS NULL OR site_id = $4) LIMIT 1`,
    [tenantId, userId, ELIGIBLE_OWNER_ROLES, siteId],
  );
  return r.rowCount === 1 ? 'ELIGIBLE' : 'NO_ROLE';
}

export interface Actor {
  kind: 'HUMAN' | 'SERVICE' | 'WORKER';
  id: string;
}
export function actorFor(ctx: TenantContext): Actor {
  const a = actorOf(ctx);
  if (a.kind !== 'HUMAN' && a.kind !== 'SERVICE' && a.kind !== 'WORKER')
    throw notPermitted('PRINCIPAL_KIND_NOT_PERMITTED');
  return { kind: a.kind, id: a.id.slice(0, 128) };
}

/**
 * Apply one legal incident transition through the M01 table: validates the edge (and pause/resume prior state),
 * advances the version by one, appends the transition row and the incident.state_changed.v1 event.
 */
export async function transitionRow(
  c: Tx,
  ctx: TenantContext,
  row: IncidentRow,
  to: IncidentState,
  reasonCode: string,
  opts: { guardRef?: string | null; extraSet?: string; extraParams?: unknown[]; causationId?: string } = {},
): Promise<IncidentRow> {
  const next = applyTransition(
    'INCIDENT',
    { state: row.state, version: row.version, pausedFromState: row.paused_from_state },
    to,
  );
  const params: unknown[] = [
    ctx.tenantId,
    row.id,
    row.version,
    next.state,
    next.pausedFromState,
    ...(opts.extraParams ?? []),
  ];
  const { rows } = await c.query<IncidentRow>(
    `UPDATE incidents SET state = $4, paused_from_state = $5, version = version + 1${opts.extraSet ? `, ${opts.extraSet}` : ''}
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    params,
  );
  const updated = rows[0];
  if (!updated) throw versionConflict();
  const actor = actorFor(ctx);
  await c.query(
    `INSERT INTO incident_transitions (tenant_id, id, incident_id, incident_version, from_state, to_state, paused_from_state,
       reason_code, guard_ref, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.tenantId,
      newIncidentDataId('transition'),
      row.id,
      updated.version,
      row.state,
      to,
      updated.paused_from_state,
      reasonCode,
      opts.guardRef ?? null,
      actor.kind,
      actor.id,
    ],
  );
  await emit(
    c,
    ctx,
    updated,
    'incident.state_changed.v1',
    {
      incidentId: row.id,
      from: row.state,
      to,
      reasonCode,
      pausedFromState: updated.paused_from_state,
    },
    opts.causationId,
  );
  return updated;
}

/** Bump the version for a non-transition change, applying `set` (SQL assignments with params from $4). */
export async function bumpRow(
  c: Tx,
  ctx: TenantContext,
  row: IncidentRow,
  set: string,
  params: unknown[],
): Promise<IncidentRow> {
  const { rows } = await c.query<IncidentRow>(
    `UPDATE incidents SET version = version + 1${set ? `, ${set}` : ''}
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [ctx.tenantId, row.id, row.version, ...params],
  );
  if (!rows[0]) throw versionConflict();
  return rows[0];
}

export async function emit(
  c: Tx,
  ctx: TenantContext,
  row: Pick<IncidentRow, 'id' | 'version' | 'correlation_id'>,
  eventType:
    | 'incident.opened.v1'
    | 'incident.state_changed.v1'
    | 'incident.assignment_changed.v1'
    | 'incident.assignment_accepted.v1'
    | 'incident.deadline_changed.v1'
    | 'incident.reopened.v1',
  payload: Record<string, unknown>,
  causationId?: string,
): Promise<void> {
  await appendOutboxEvent(c, ctx, {
    eventType,
    aggregateType: 'incident',
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload,
    correlationId: row.correlation_id,
    causationId: causationId ?? newId('command'),
  });
}

export interface ReceiptScope {
  commandType: string;
  idempotencyKey: unknown;
  request: Record<string, unknown>;
}

/**
 * Idempotency-Key handling (API-EVENT-SPEC §8) inside the command transaction: serialize on the key, return the
 * stored result for an identical request by the same principal, refuse reuse with a different request, else run
 * `fn` and store its result. The request digest includes the principal, so a key cannot replay another's result.
 */
export async function withReceipt<T extends Record<string, unknown>>(
  c: Tx,
  ctx: TenantContext,
  scope: ReceiptScope,
  incidentId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const key = IdempotencyKeySchema.safeParse(scope.idempotencyKey);
  if (!key.success) throw validation('IDEMPOTENCY_KEY_INVALID');
  const actor = actorFor(ctx);
  // JSON round-trip drops absent optional fields so the digest is defined for every valid request.
  const request = JSON.parse(JSON.stringify(scope.request)) as Record<string, unknown>;
  const digest = sha256Digest(canonicalize({ commandType: scope.commandType, actor, request }));
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `incident-receipt:${ctx.tenantId}:${key.data}`,
  ]);
  const prior = await c.query<{ request_digest: string; result: T }>(
    `SELECT request_digest, result FROM incident_command_receipts WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, key.data],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].request_digest !== digest)
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.');
    return prior.rows[0].result;
  }
  const result = await fn();
  await c.query(
    `INSERT INTO incident_command_receipts (tenant_id, command_type, idempotency_key, request_digest, incident_id, result,
       principal_kind, principal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, scope.commandType, key.data, digest, incidentId, JSON.stringify(result), actor.kind, actor.id],
  );
  return result;
}

/** The command result every lifecycle command returns. */
export interface IncidentCommandResult extends Record<string, unknown> {
  incidentId: string;
  state: IncidentState;
  version: number;
}
export const resultOf = (row: IncidentRow, extra: Record<string, unknown> = {}): IncidentCommandResult => ({
  incidentId: row.id,
  state: row.state,
  version: row.version,
  ...extra,
});

export const IDEMPOTENCY_KEY = IdempotencyKeySchema;
