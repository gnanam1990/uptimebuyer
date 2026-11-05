// Incident lifecycle commands (FR-04, FR-16, NFR-03). Every command runs in one tenant transaction that locks the
// incident row, authorizes the caller at the incident's site, honours its Idempotency-Key, then compare-and-sets the
// aggregate version: a stale `expectedVersion` is VERSION_CONFLICT, never last-write-wins. State changes go only
// through the M01 transition table. Ownership-bound commands (escalation re-entry, pause, resume, handoff) need the
// accepted current owner. Deadline events are planned from the incident's PINNED procedure only.
import { DomainError, UtcInstantSchema, type UserId } from '@uptimebuyer/contracts';
import {
  dbNow,
  recordAudit,
  tenantCommand,
  unavailable,
  versionConflict,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import { loadProcedure } from './config.js';
import { appendDeadlineEvent } from './deadline-store.js';
import { attachmentsInTenant, recordReopenEvidence, reopenRow } from './engine.js';
import {
  actorFor,
  assertVersion,
  bumpRow,
  deny,
  emit,
  holdsRoleAt,
  isoOf,
  loadIncident,
  lockReceiptKey,
  ms,
  newIncidentDataId,
  ownerEligibility,
  parseInput,
  requireAt,
  resultOf,
  transitionRow,
  validation,
  withReceipt,
  type IncidentCommandResult,
  type IncidentRow,
} from './internal.js';

const Version = z.int().min(1);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const Opaque = z.string().max(128);
const base = { expectedVersion: Version, idempotencyKey: Opaque };

interface AssignmentRow {
  id: string;
  incident_id: string;
  assignee_user_id: string;
  accepted_at: Date | null;
  superseded_at: Date | null;
}

async function currentAssignment(c: Tx, row: IncidentRow): Promise<AssignmentRow | undefined> {
  if (!row.current_assignment_id) return undefined;
  const { rows } = await c.query<AssignmentRow>(
    `SELECT * FROM incident_assignments WHERE tenant_id = $1 AND incident_id = $2 AND id = $3 AND superseded_at IS NULL`,
    [row.tenant_id, row.id, row.current_assignment_id],
  );
  return rows[0];
}

/** The caller must be the accepted current owner of the incident. */
async function requireAcceptedOwner(
  c: Tx,
  ctx: TenantContext,
  meta: { action: string; resourceType: string },
  row: IncidentRow,
) {
  const cur = await currentAssignment(c, row);
  if (!cur || cur.accepted_at === null || ctx.principal.kind !== 'HUMAN' || cur.assignee_user_id !== ctx.principal.id)
    throw deny(meta, 'NOT_ACCEPTED_OWNER', row.id);
  return cur;
}

type Run = (c: Tx, row: IncidentRow) => Promise<IncidentCommandResult>;

/** Shared command skeleton: lock + authorize, Idempotency-Key, version CAS, audit. */
/** @internal Shared command skeleton; exported for the internal recovery hook only (not from index.ts). */
export async function command(
  pool: Db,
  ctx: TenantContext,
  incidentId: unknown,
  spec: {
    action: string;
    commandType: string;
    authorize: 'incident.manage' | 'incident.engine' | 'incident.acknowledge' | null;
  },
  input: { expectedVersion: number; idempotencyKey: string } & Record<string, unknown>,
  run: Run,
): Promise<IncidentCommandResult> {
  const meta = {
    action: spec.action,
    resourceType: 'incident',
    resourceId: typeof incidentId === 'string' ? incidentId : null,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    if (spec.authorize === 'incident.engine') requireAt(ctx, meta, 'incident.engine', null);
    // Lock order everywhere: Idempotency-Key first, then incident rows (a manual report sharing the key would
    // otherwise hold the key and wait for the row while this command holds the row and waits for the key).
    await lockReceiptKey(c, ctx, input.idempotencyKey);
    const row = await loadIncident(c, ctx, meta, incidentId, {
      action: spec.authorize === 'incident.engine' ? null : spec.authorize,
      lock: 'UPDATE',
    });
    const { idempotencyKey, ...request } = input;
    return withReceipt(
      c,
      ctx,
      { commandType: spec.commandType, idempotencyKey, request: { incidentId: row.id, ...request } },
      row.id,
      async () => {
        assertVersion(row, input.expectedVersion);
        const result = await run(c, row);
        await recordAudit(c, ctx, {
          action: spec.action,
          resourceType: 'incident',
          resourceId: row.id,
          result: 'SUCCEEDED',
          reasonCode: typeof input['reasonCode'] === 'string' ? (input['reasonCode'] as string) : null,
          metadata: { version: result.version, state: result.state },
        });
        return result;
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------

const AckSchema = z.strictObject({ ...base });
/** Record operator acknowledgement (message delivery is never acknowledgement). Idempotent within a lifecycle. */
export async function acknowledgeIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof AckSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(AckSchema, raw);
  return command(
    pool,
    ctx,
    incidentId,
    { action: 'incident.acknowledge', commandType: 'incident.acknowledge.v1', authorize: 'incident.acknowledge' },
    input,
    async (c, row) => {
      if (row.acknowledged_at !== null) return resultOf(row, { acknowledgedAt: isoOf(row.acknowledged_at) });
      const userId = ctx.principal.id;
      const updated = await bumpRow(c, ctx, row, `acknowledged_at = clock_timestamp(), acknowledged_by_user_id = $4`, [
        userId,
      ]);
      await c.query(
        `INSERT INTO incident_acknowledgements (tenant_id, id, incident_id, user_id, incident_version, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.tenantId, newIncidentDataId('acknowledgement'), row.id, userId, updated.version, updated.acknowledged_at],
      );
      return resultOf(updated, { acknowledgedAt: isoOf(updated.acknowledged_at!) });
    },
  );
}

const AssignSchema = z.strictObject({
  ...base,
  assigneeUserId: Opaque,
  reasonCode: Code,
  nextActionDueAt: UtcInstantSchema.optional(),
});

async function supersedeAndAssign(
  c: Tx,
  ctx: TenantContext,
  meta: { action: string; resourceType: string },
  row: IncidentRow,
  input: {
    assigneeUserId: string;
    reasonCode: string;
    nextActionDueAt: string | null;
    kind: 'ASSIGN' | 'HANDOFF';
    handoffFrom: AssignmentRow | null;
  },
): Promise<IncidentCommandResult> {
  if (input.nextActionDueAt !== null && ms(input.nextActionDueAt) <= ms(await dbNow(c)))
    throw validation('NEXT_ACTION_DUE_IN_PAST');
  const eligible = await ownerEligibility(c, ctx.tenantId, input.assigneeUserId, row.site_id);
  if (eligible === 'NOT_MEMBER') throw unavailable({ ...meta, resourceId: row.id }, input.assigneeUserId, 'user');
  if (eligible === 'NO_ROLE') throw deny(meta, 'ASSIGNEE_NOT_ELIGIBLE', row.id);
  const cur = await currentAssignment(c, row);
  const actor = actorFor(ctx);
  const assignmentId = newIncidentDataId('assignment');
  const updated = await bumpRow(c, ctx, row, `current_assignment_id = $4`, [assignmentId]);
  if (cur)
    await c.query(
      `UPDATE incident_assignments SET superseded_at = clock_timestamp(), superseded_by_assignment_id = $4
        WHERE tenant_id = $1 AND incident_id = $2 AND id = $3 AND superseded_at IS NULL`,
      [ctx.tenantId, row.id, cur.id, assignmentId],
    );
  const handoffDigest =
    input.kind === 'HANDOFF'
      ? canonicalDigest('incident-handoff', 1, {
          incidentId: row.id,
          from: input.handoffFrom!.id,
          fromUserId: input.handoffFrom!.assignee_user_id,
          toUserId: input.assigneeUserId,
          reasonCode: input.reasonCode,
          nextActionDueAt: input.nextActionDueAt,
          incidentVersion: updated.version,
        })
      : null;
  await c.query(
    `INSERT INTO incident_assignments (tenant_id, id, incident_id, assignee_user_id, assignment_kind, assigned_by_kind,
       assigned_by_id, reason_code, next_action_due_at, handoff_from_assignment_id, handoff_digest, incident_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      ctx.tenantId,
      assignmentId,
      row.id,
      input.assigneeUserId,
      input.kind,
      actor.kind,
      actor.id,
      input.reasonCode,
      input.nextActionDueAt,
      input.handoffFrom?.id ?? null,
      handoffDigest,
      updated.version,
    ],
  );
  await emit(c, ctx, updated, 'incident.assignment_changed.v1', {
    incidentId: row.id,
    assignmentId,
    assignmentKind: input.kind,
    assigneeUserId: input.assigneeUserId,
    supersededAssignmentId: cur?.id ?? null,
    reasonCode: input.reasonCode,
    nextActionDueAt: input.nextActionDueAt,
  });
  return resultOf(updated, { assignmentId });
}

/** Append a tenant-scoped owner assignment (initial dispatch or reassignment), superseding the current one. */
export async function assignIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof AssignSchema> & { assigneeUserId: UserId | string },
): Promise<IncidentCommandResult & { assignmentId: string }> {
  const input = parseInput(AssignSchema, raw);
  const meta = { action: 'incident.assign', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.assign.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      if (row.state === 'RECOVERED')
        throw new DomainError('STATE_TRANSITION_INVALID', 'A recovered incident is not assignable.', {
          reasonCode: 'INCIDENT_RECOVERED',
        });
      return supersedeAndAssign(c, ctx, meta, row, {
        assigneeUserId: input.assigneeUserId,
        reasonCode: input.reasonCode,
        nextActionDueAt: input.nextActionDueAt ?? null,
        kind: 'ASSIGN',
        handoffFrom: null,
      });
    },
  ) as Promise<IncidentCommandResult & { assignmentId: string }>;
}

const AcceptSchema = z.strictObject({ ...base });
/** Compare-and-set acceptance of the CURRENT assignment by its assigned principal. */
export async function acceptAssignment(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  assignmentId: string,
  raw: z.input<typeof AcceptSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(AcceptSchema, raw);
  const meta = { action: 'incident.assignment.accept', resourceType: 'incident' };
  if (typeof assignmentId !== 'string' || !/^ias_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(assignmentId))
    throw validation('ASSIGNMENT_ID_INVALID');
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.accept.v1', authorize: null },
    { ...input, assignmentId },
    async (c, row) => {
      const { rows } = await c.query<AssignmentRow>(
        `SELECT * FROM incident_assignments WHERE tenant_id = $1 AND incident_id = $2 AND id = $3`,
        [ctx.tenantId, row.id, assignmentId],
      );
      const a = rows[0];
      if (!a) throw unavailable({ ...meta, resourceId: row.id }, assignmentId, 'incident_assignment');
      if (a.superseded_at !== null || row.current_assignment_id !== a.id)
        throw new DomainError('STATE_TRANSITION_INVALID', 'The assignment is no longer current.', {
          reasonCode: 'ASSIGNMENT_NOT_CURRENT',
        });
      if (ctx.principal.kind !== 'HUMAN' || a.assignee_user_id !== ctx.principal.id)
        throw deny(meta, 'NOT_ASSIGNEE', row.id);
      if (a.accepted_at !== null) throw versionConflict('ASSIGNMENT_ALREADY_ACCEPTED');
      const updated = await bumpRow(c, ctx, row, '', []);
      const r = await c.query<{ accepted_at: Date }>(
        `UPDATE incident_assignments SET accepted_at = clock_timestamp()
        WHERE tenant_id = $1 AND incident_id = $2 AND id = $3 AND accepted_at IS NULL AND superseded_at IS NULL
        RETURNING accepted_at`,
        [ctx.tenantId, row.id, a.id],
      );
      if (!r.rows[0]) throw versionConflict('ASSIGNMENT_CHANGED');
      await emit(c, ctx, updated, 'incident.assignment_accepted.v1', {
        incidentId: row.id,
        assignmentId: a.id,
        assigneeUserId: a.assignee_user_id,
        acceptedAt: isoOf(r.rows[0].accepted_at),
      });
      return resultOf(updated, { assignmentId: a.id });
    },
  );
}

const HandoffSchema = z.strictObject({
  ...base,
  nextOwnerUserId: Opaque,
  reasonCode: Code,
  nextActionDueAt: UtcInstantSchema,
});
/** The accepted current owner hands the incident to a next owner with reason and next-action deadline. */
export async function handoffIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof HandoffSchema> & { nextOwnerUserId: UserId | string },
): Promise<IncidentCommandResult & { assignmentId: string }> {
  const input = parseInput(HandoffSchema, raw);
  const meta = { action: 'incident.handoff', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.handoff.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      const owner = await requireAcceptedOwner(c, ctx, meta, row);
      if (input.nextOwnerUserId === owner.assignee_user_id) throw validation('HANDOFF_TO_SELF');
      return supersedeAndAssign(c, ctx, meta, row, {
        assigneeUserId: input.nextOwnerUserId,
        reasonCode: input.reasonCode,
        nextActionDueAt: isoOf(input.nextActionDueAt),
        kind: 'HANDOFF',
        handoffFrom: owner,
      });
    },
  ) as Promise<IncidentCommandResult & { assignmentId: string }>;
}

const ReasonSchema = z.strictObject({ ...base, reasonCode: Code });

/** Explicit escalation with reason, from any active state (M01 table). */
export async function escalateIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof ReasonSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(ReasonSchema, raw);
  return command(
    pool,
    ctx,
    incidentId,
    { action: 'incident.escalate', commandType: 'incident.escalate.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => resultOf(await transitionRow(c, ctx, row, 'ESCALATED', input.reasonCode)),
  );
}

const ReturnSchema = z.strictObject({
  ...base,
  reasonCode: Code,
  to: z.enum(['TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING']),
});
/** ESCALATED -> TRIAGING | AWAITING_EVIDENCE | PLANNING, only for the accepted current owner (compare-and-set). */
export async function returnFromEscalation(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof ReturnSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(ReturnSchema, raw);
  const meta = { action: 'incident.escalation.return', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.return_from_escalation.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      await requireAcceptedOwner(c, ctx, meta, row);
      return resultOf(
        await transitionRow(c, ctx, row, input.to, input.reasonCode, { extraSet: `signal_state = 'LIVE'` }),
      );
    },
  );
}

/** Pause a resumable active state; records `paused_from_state`. The accepted current owner only. */
export async function pauseIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof ReasonSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(ReasonSchema, raw);
  const meta = { action: 'incident.pause', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.pause.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      await requireAcceptedOwner(c, ctx, meta, row);
      return resultOf(await transitionRow(c, ctx, row, 'PAUSED', input.reasonCode));
    },
  );
}

/**
 * Revalidation before resuming (STATE-MACHINES §1). M04 checks what it owns: the pinned asset revision is still the
 * asset's current identity and the asset is active. Later modules add plan/approval/in-flight checks through the
 * `revalidate` hook; any failure is a POLICY_HOLD and the incident stays PAUSED.
 */
export type ResumeRevalidator = (c: Tx, incident: Readonly<IncidentRow>) => Promise<string | null>;

async function revalidateForResume(c: Tx, row: IncidentRow, extra: readonly ResumeRevalidator[]): Promise<void> {
  const { rows } = await c.query<{ current_revision_id: string; status: string }>(
    `SELECT current_revision_id, status FROM assets WHERE tenant_id = $1 AND id = $2`,
    [row.tenant_id, row.asset_id],
  );
  const asset = rows[0]!;
  const fail = (reasonCode: string) =>
    new DomainError('POLICY_HOLD', 'The incident cannot resume until it is revalidated.', { reasonCode });
  if (asset.status !== 'ACTIVE') throw fail('ASSET_NOT_ACTIVE');
  const planBound = ['AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING'].includes(row.paused_from_state ?? '');
  if (planBound && asset.current_revision_id !== row.asset_revision_id) throw fail('ASSET_REVISION_SUPERSEDED');
  for (const check of extra) {
    const reason = await check(c, row);
    if (reason !== null) throw fail(reason);
  }
}

/** Resume to exactly the recorded prior state after revalidation. The accepted current owner only. */
export async function resumeIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof ReasonSchema>,
  opts: { revalidate?: readonly ResumeRevalidator[] } = {},
): Promise<IncidentCommandResult> {
  const input = parseInput(ReasonSchema, raw);
  const meta = { action: 'incident.resume', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.resume.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      await requireAcceptedOwner(c, ctx, meta, row);
      if (row.state !== 'PAUSED' || row.paused_from_state === null)
        throw new DomainError('STATE_TRANSITION_INVALID', 'The incident is not paused.', { reasonCode: 'NOT_PAUSED' });
      await revalidateForResume(c, row, opts.revalidate ?? []);
      return resultOf(await transitionRow(c, ctx, row, row.paused_from_state, input.reasonCode));
    },
  );
}

const ReopenSchema = z.strictObject({
  ...base,
  reasonCode: Code,
  note: z.string().min(1).max(2000).optional(),
  attachments: z
    .array(
      z.strictObject({
        blobId: z.string().regex(/^blb_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
        role: z.enum(['PHOTO', 'DOCUMENT', 'OTHER']),
      }),
    )
    .max(20)
    .optional(),
});
/** Authorized human reopen of a RECOVERED incident with evidence: RECOVERED -> REOPENED -> TRIAGING. */
export async function reopenIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof ReopenSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(ReopenSchema, raw);
  const meta = { action: 'incident.reopen', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.reopen.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      if (ctx.principal.kind !== 'HUMAN') throw deny(meta, 'PRINCIPAL_KIND_NOT_PERMITTED', row.id);
      await attachmentsInTenant(c, ctx, { ...meta, resourceId: row.id }, input.attachments ?? []);
      await c.query('SAVEPOINT manual_reopen');
      let updated: IncidentRow;
      try {
        updated = await reopenRow(c, ctx, row, input.reasonCode, 'OPERATOR_COMMAND');
        await c.query('RELEASE SAVEPOINT manual_reopen');
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          await c.query('ROLLBACK TO SAVEPOINT manual_reopen');
          throw new DomainError(
            'STATE_TRANSITION_INVALID',
            'Another incident is already active for this fault window.',
            {
              reasonCode: 'ACTIVE_INCIDENT_EXISTS',
            },
          );
        }
        throw e;
      }
      const manualReportId = await recordReopenEvidence(c, ctx, updated, {
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        attachments: input.attachments ?? [],
      });
      return resultOf(updated, { manualReportId });
    },
  );
}

const EngineReopenSchema = z.strictObject({
  ...base,
  reasonCode: Code,
  guardRef: z.string().regex(/^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
});
/**
 * Engine reopen of a RECOVERED incident requested by the recovery module (M11: lost recovery signal, disputed recovery
 * evidence): RECOVERED -> REOPENED -> TRIAGING with the reason and the M11 record as guard reference. History is kept;
 * this is the conservative direction and never reaches RECOVERED. Worker/service principals only.
 */
export async function reopenRecoveredIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof EngineReopenSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(EngineReopenSchema, raw);
  return command(
    pool,
    ctx,
    incidentId,
    { action: 'incident.reopen_engine', commandType: 'incident.reopen_engine.v1', authorize: 'incident.engine' },
    input,
    async (c, row) => {
      if (row.state !== 'RECOVERED')
        throw new DomainError('STATE_TRANSITION_INVALID', 'Only a recovered incident can be reopened.', {
          reasonCode: 'NOT_RECOVERED',
          currentState: row.state,
        });
      await c.query('SAVEPOINT engine_reopen');
      try {
        const updated = await reopenRow(c, ctx, row, input.reasonCode, 'RECOVERY_ENGINE', input.guardRef);
        await c.query('RELEASE SAVEPOINT engine_reopen');
        return resultOf(updated);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          await c.query('ROLLBACK TO SAVEPOINT engine_reopen');
          throw new DomainError(
            'STATE_TRANSITION_INVALID',
            'Another incident is already active for this fault window.',
            {
              reasonCode: 'ACTIVE_INCIDENT_EXISTS',
            },
          );
        }
        throw e;
      }
    },
  );
}

/** Engine-path edges (owning modules enforce their guards; M04 enforces legality, CAS and the recovery reference). */
const ENGINE_TARGETS = [
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
  'RECOVERED',
  'ESCALATED',
] as const;
const AdvanceSchema = z.strictObject({
  ...base,
  to: z.enum(ENGINE_TARGETS),
  reasonCode: Code,
  guardRef: z.string().regex(/^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
});

/**
 * Server-side state change requested by an owning module (M05 evidence, M08 planning, M09/M10 execution, M11
 * recovery) with a reference to the record that satisfies the edge's guard. RECOVERED requires a recovery
 * evaluation reference (`rev_…`); M04 itself never decides recovery. Worker/service principals only.
 */
export async function advanceIncident(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof AdvanceSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(AdvanceSchema, raw);
  // INV-01/INV-14: no public caller may mark recovery. RECOVERED is reachable only through the internal recovery hook
  // (src/recovery.ts), which requires a PASSED evaluation from a recovery evaluator (M11).
  if (input.to === 'RECOVERED')
    throw new DomainError('POLICY_HOLD', 'Recovery requires a passing recovery evaluation.', {
      reasonCode: 'RECOVERY_EVALUATOR_REQUIRED',
    });
  return command(
    pool,
    ctx,
    incidentId,
    { action: 'incident.advance', commandType: 'incident.advance.v1', authorize: 'incident.engine' },
    input,
    async (c, row) =>
      resultOf(
        await transitionRow(c, ctx, row, input.to, input.reasonCode, {
          guardRef: input.guardRef,
          ...(input.to === 'RECOVERED' ? { extraSet: 'recovered_at = clock_timestamp()' } : {}),
        }),
      ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Deadline events

const AdjustSchema = z.strictObject({
  ...base,
  eventType: z.enum(['PAUSE', 'RESUME', 'SHORTEN', 'EXTEND']),
  newDeadlineAt: UtcInstantSchema.optional(),
  reasonCode: Code,
});

/**
 * Append an authorized deadline event. The server reloads the incident's pinned procedure: PAUSE and EXTEND need the
 * procedure's adjust role at the site (and its explicit pause/extension allowance); SHORTEN and RESUME need an
 * operating role. The original deadline is never touched.
 */
export async function adjustIncidentDeadline(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof AdjustSchema>,
): Promise<IncidentCommandResult> {
  const input = parseInput(AdjustSchema, raw);
  const meta = { action: 'incident.deadline.adjust', resourceType: 'incident' };
  return command(
    pool,
    ctx,
    incidentId,
    { action: meta.action, commandType: 'incident.adjust_deadline.v1', authorize: 'incident.manage' },
    input,
    async (c, row) => {
      if ((input.eventType === 'SHORTEN' || input.eventType === 'EXTEND') && input.newDeadlineAt === undefined)
        throw validation('NEW_DEADLINE_REQUIRED');
      if ((input.eventType === 'PAUSE' || input.eventType === 'RESUME') && input.newDeadlineAt !== undefined)
        throw validation('NEW_DEADLINE_NOT_ALLOWED');
      let role: string | null = null;
      if (input.eventType === 'PAUSE' || input.eventType === 'EXTEND') {
        const procedure = await loadProcedure(c, ctx.tenantId, row.procedure_revision_id);
        if (!holdsRoleAt(ctx, procedure.adjustRole, row.site_id)) throw deny(meta, 'PROCEDURE_ROLE_REQUIRED', row.id);
        role = procedure.adjustRole;
      }
      const updated = await appendDeadlineEvent(c, ctx, row, {
        eventType: input.eventType,
        ...(input.newDeadlineAt !== undefined ? { newDeadlineAt: isoOf(input.newDeadlineAt) } : {}),
        reasonCode: input.reasonCode,
        effectiveAt: await dbNow(c),
        role,
      });
      return resultOf(updated, {
        deadlineStatus: updated.deadline_status,
        currentResponseDeadlineAt: isoOf(updated.current_response_deadline_at),
      });
    },
  );
}

const ExpireSchema = z.strictObject({ now: UtcInstantSchema.optional(), limit: z.int().min(1).max(500).optional() });

/**
 * Deadline sweep (engine worker): every RUNNING deadline at or before `now` (never earlier than the database clock,
 * at most one hour ahead) gets an EXPIRE event; an incident in an active state escalates with DEADLINE_EXPIRED.
 */
export async function expireIncidentDeadlines(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof ExpireSchema>,
): Promise<{ expired: string[]; now: string }> {
  const input = parseInput(ExpireSchema, raw);
  const meta = { action: 'incident.deadline.expire', resourceType: 'incident', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'incident.engine', null);
    const dbNowAt = await dbNow(c);
    if (input.now !== undefined && ms(input.now) > ms(dbNowAt) + 3_600_000)
      throw validation('SWEEP_TIME_OUT_OF_BOUNDS');
    const now = input.now !== undefined && ms(input.now) > ms(dbNowAt) ? isoOf(input.now) : dbNowAt;
    const { rows } = await c.query<IncidentRow>(
      `SELECT * FROM incidents WHERE tenant_id = $1 AND deadline_status = 'RUNNING' AND current_response_deadline_at <= $2
        ORDER BY current_response_deadline_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [ctx.tenantId, now, input.limit ?? 100],
    );
    const expired: string[] = [];
    for (const row of rows) {
      let updated = await appendDeadlineEvent(c, ctx, row, {
        eventType: 'EXPIRE',
        reasonCode: 'DEADLINE_EXPIRED',
        effectiveAt: now,
        role: null,
      });
      if (
        [
          'DETECTED',
          'TRIAGING',
          'AWAITING_EVIDENCE',
          'PLANNING',
          'AWAITING_APPROVAL',
          'EXECUTING',
          'VERIFYING',
        ].includes(updated.state)
      )
        updated = await transitionRow(c, ctx, updated, 'ESCALATED', 'DEADLINE_EXPIRED');
      expired.push(updated.id);
    }
    return { expired, now };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Optional food-risk estimate

const RiskSchema = z
  .strictObject({
    estimatorKind: z.enum(['MODEL', 'RULE', 'OPERATOR']),
    sourceRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    asOf: UtcInstantSchema,
    safeTimeRemainingMs: z
      .int()
      .min(0)
      .max(30 * 86_400_000),
    lowerBoundMs: z
      .int()
      .min(0)
      .max(30 * 86_400_000),
    upperBoundMs: z
      .int()
      .min(0)
      .max(30 * 86_400_000),
    confidencePpm: z.int().min(0).max(1_000_000),
    provenanceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .refine((r) => r.lowerBoundMs <= r.safeTimeRemainingMs && r.safeTimeRemainingMs <= r.upperBoundMs, {
    message: 'Bounds must bracket the estimate.',
  });

/**
 * Store an optional food-risk (safe-time) estimate beside the incident, labelled NON_AUTHORITATIVE with provenance and
 * uncertainty. It is never read by any deadline, transition or authority path and does not change the version.
 */
export async function recordRiskEstimate(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof RiskSchema>,
): Promise<{ riskEstimateId: string; incidentId: string; authority: 'NON_AUTHORITATIVE' }> {
  const input = parseInput(RiskSchema, raw);
  const meta = { action: 'incident.risk_estimate', resourceType: 'incident', resourceId: incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const engine = ctx.principal.kind === 'SERVICE' || ctx.principal.kind === 'WORKER';
    const row = await loadIncident(c, ctx, meta, incidentId, { action: engine ? null : 'incident.manage', lock: null });
    if (engine) requireAt(ctx, meta, 'incident.engine', null, row.id);
    const actor = actorFor(ctx);
    const riskEstimateId = newIncidentDataId('riskEstimate');
    await c.query(
      `INSERT INTO incident_risk_estimates (tenant_id, id, incident_id, estimate_kind, estimator_kind, source_revision, as_of,
         safe_time_remaining_ms, lower_bound_ms, upper_bound_ms, confidence_ppm, provenance_digest, recorded_by_kind,
         recorded_by_id)
       VALUES ($1, $2, $3, 'FOOD_SAFE_TIME', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        ctx.tenantId,
        riskEstimateId,
        row.id,
        input.estimatorKind,
        input.sourceRevision,
        input.asOf,
        input.safeTimeRemainingMs,
        input.lowerBoundMs,
        input.upperBoundMs,
        input.confidencePpm,
        input.provenanceDigest,
        actor.kind,
        actor.id,
      ],
    );
    await recordAudit(c, ctx, {
      ...meta,
      resourceId: row.id,
      result: 'SUCCEEDED',
      reasonCode: 'NON_AUTHORITATIVE_ESTIMATE',
    });
    return { riskEstimateId, incidentId: row.id, authority: 'NON_AUTHORITATIVE' as const };
  });
}
