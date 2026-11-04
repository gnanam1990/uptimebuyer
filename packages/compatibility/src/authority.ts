// Named-engineer and policy-approver authority records (INV-02, INV-15). Only an authenticated human holding the
// required role at the decision's site may record one, and only for a CURRENT HOLD that names that requirement on
// a tuple that is still current. Scope, exception classes and overridden reasons are copied from the held decision,
// never from the client; the reason and expiry are the human's and are signed with the authority service's key. The
// record is evidence: the HOLD resolves only when the engine evaluates the new tuple (STATE-MACHINES §3).
import {
  CompatibilityDecisionIdSchema,
  ReasonCodeSchema,
  UtcInstantSchema,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import {
  AUTHORITY_KINDS,
  NAMED_ENGINEER_ROLE,
  signAuthorityRecord,
  type AuthorityEvidence,
  type AuthorityKind,
  type AuthorityRecord,
  type RequiredAuthority,
} from '@uptimebuyer/domain';
import {
  Denial,
  authorize,
  humanActor,
  notPermitted,
  recordAudit,
  requireAuthorized,
  tenantCommand,
  unavailable,
  dbNow,
  type Db,
  type Queryable,
  type TenantContext,
} from '@uptimebuyer/data';
import { z } from 'zod';
import {
  assertSigning,
  currentAssetRevisionId,
  effectiveAuthorityRevisionId,
  heldRolesAt,
  hold,
  invalid,
  isoOf,
  latestEvidenceRevision,
  loadGoverning,
  newCompatibilityId,
  type AuthoritySigning,
} from './internal.js';

const RecordSchema = z.strictObject({
  compatibilityDecisionId: CompatibilityDecisionIdSchema,
  kind: z.enum(AUTHORITY_KINDS),
  reasonCode: ReasonCodeSchema,
  reasonText: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => s.trim().length > 0, 'Blank reason.'),
  expiresAt: UtcInstantSchema,
});

export interface RecordAuthorityInput {
  compatibilityDecisionId: string;
  kind: AuthorityKind;
  reasonCode: string;
  reasonText: string;
  expiresAt: UtcInstant | string;
}

export interface AuthorityRecordView extends Omit<AuthorityRecord, 'status'> {
  status: AuthorityRecord['status'];
  label: 'HUMAN APPROVAL';
  createdAt: UtcInstant;
}

const actionFor = (kind: AuthorityKind) =>
  kind === 'ENGINEER_EXCEPTION' ? 'compatibility.engineer_exception' : 'compatibility.policy_approval';

interface AuthorityRow {
  id: string;
  kind: AuthorityKind;
  tenant_id: string;
  site_id: string;
  incident_id: string;
  candidate_action_id: string;
  asset_revision_id: string;
  evidence_revision_id: string;
  policy_revision_id: string;
  action_digest: string;
  held_decision_id: string;
  exception_classes: string[];
  overridden_reasons: string[];
  actor_user_id: string;
  actor_role: string;
  reason_code: string;
  reason_text: string;
  issued_at: Date;
  expires_at: Date;
  signature_algorithm: string;
  signature_key_id: string;
  signature_value: string;
  created_at: Date;
  event_type: string | null;
}

export function toAuthorityRecord(r: AuthorityRow): AuthorityRecord {
  return {
    authorityRecordId: r.id,
    kind: r.kind,
    tenantId: r.tenant_id,
    siteId: r.site_id,
    incidentId: r.incident_id,
    candidateActionId: r.candidate_action_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    actionDigest: r.action_digest,
    heldDecisionId: r.held_decision_id,
    exceptionClasses: r.exception_classes,
    overriddenReasons: r.overridden_reasons,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    reasonCode: r.reason_code,
    reasonText: r.reason_text,
    issuedAt: isoOf(r.issued_at)!,
    expiresAt: isoOf(r.expires_at)!,
    signature: { algorithm: r.signature_algorithm, keyId: r.signature_key_id, value: r.signature_value },
    status: r.event_type === null ? 'ACTIVE' : r.event_type === 'REVOKED' ? 'REVOKED' : 'INVALIDATED',
  } as AuthorityRecord;
}

const AUTHORITY_SELECT = `SELECT a.*, e.event_type FROM compatibility_authority_records a
  LEFT JOIN compatibility_authority_events e ON e.tenant_id = a.tenant_id AND e.authority_record_id = a.id`;

/**
 * Every authority record bound to a candidate, as evaluation evidence: the record and the roles the role registry
 * says its actor holds at the site now. `grantIds` identify the exact grants (bound into the tuple digest).
 */
export async function loadAuthorityEvidence(
  q: Queryable,
  tenantId: string,
  where: { candidateActionId?: string; authorityRecordIds?: string[] },
): Promise<(AuthorityEvidence & { grantIds: string[] })[]> {
  const { rows } = await q.query<AuthorityRow>(
    `${AUTHORITY_SELECT} WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.candidate_action_id = $2)
        AND ($3::text[] IS NULL OR a.id = ANY($3)) ORDER BY a.id`,
    [tenantId, where.candidateActionId ?? null, where.authorityRecordIds ?? null],
  );
  const out = [];
  for (const r of rows) {
    const held = await heldRolesAt(q, tenantId, r.actor_user_id, r.site_id);
    out.push({ record: toAuthorityRecord(r), heldRoles: held.roles, grantIds: held.grantIds });
  }
  return out;
}

export async function recordAuthority(
  pool: Db,
  ctx: TenantContext,
  raw: RecordAuthorityInput,
  signing: AuthoritySigning,
): Promise<{
  authorityRecordId: string;
  signature: AuthorityRecord['signature'];
  issuedAt: UtcInstant;
  expiresAt: UtcInstant;
}> {
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid('INVALID_AUTHORITY', {
      fieldErrors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), issue: i.code })),
    });
  const input = parsed.data;
  const keys = assertSigning(signing);
  const action = actionFor(input.kind);
  const meta = { action, resourceType: 'compatibility_decision', resourceId: input.compatibilityDecisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, input.compatibilityDecisionId],
    );
    const d = rows[0];
    if (!d) throw unavailable(meta);
    requireAuthorized(ctx, { action, siteId: d.site_id }, undefined, { type: 'compatibility_decision', id: d.id });
    const actorUserId = humanActor(ctx);
    if (d.lifecycle !== 'CURRENT') throw hold('DECISION_NOT_CURRENT');
    const requirement = (d.required_authorities as RequiredAuthority[]).find((r) => r.kind === input.kind);
    if (d.decision !== 'HOLD' || !requirement) throw hold('AUTHORITY_NOT_REQUIRED');

    // The actor's role must be the one required: the named engineer, or a role the governing policy names.
    const held = await heldRolesAt(c, ctx.tenantId, actorUserId, d.site_id);
    const actorRole =
      input.kind === 'ENGINEER_EXCEPTION'
        ? held.roles.includes(NAMED_ENGINEER_ROLE)
          ? NAMED_ENGINEER_ROLE
          : null
        : (requirement.roles.find((r) => held.roles.includes(r)) ?? null);
    if (!actorRole)
      throw new Denial(notPermitted('ROLE_NOT_NAMED_BY_POLICY'), {
        action,
        resourceType: 'compatibility_decision',
        resourceId: d.id,
        reasonCode: 'ROLE_NOT_NAMED_BY_POLICY',
      });

    // TOCTOU: the held tuple must still be the current one while this transaction holds the decision row.
    const ca = await c.query<{ asset_id: string }>(
      `SELECT asset_id FROM candidate_actions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, d.candidate_action_id],
    );
    const evr = await latestEvidenceRevision(c, ctx.tenantId, d.incident_id);
    if (
      evr?.id !== d.evidence_revision_id ||
      (await currentAssetRevisionId(c, ctx.tenantId, ca.rows[0]!.asset_id)) !== d.asset_revision_id ||
      (await effectiveAuthorityRevisionId(c, ctx.tenantId)) !== d.policy_revision_id
    )
      throw hold('DECISION_TUPLE_STALE');
    const governing = await loadGoverning(c, ctx.tenantId, d.policy_revision_id);
    const now = await dbNow(c);
    const ttl = governing?.compatibility?.authorityMaxTtlMs ?? 0;
    if (Date.parse(input.expiresAt) <= Date.parse(now)) throw hold('AUTHORITY_ALREADY_EXPIRED');
    if (Date.parse(input.expiresAt) - Date.parse(now) > ttl) throw hold('AUTHORITY_TTL_EXCEEDED');
    const dup = await c.query(
      `SELECT 1 FROM compatibility_authority_records WHERE tenant_id = $1 AND held_decision_id = $2 AND kind = $3`,
      [ctx.tenantId, d.id, input.kind],
    );
    if (dup.rowCount) throw hold('AUTHORITY_ALREADY_RECORDED');

    const record = signAuthorityRecord(
      {
        authorityRecordId: newCompatibilityId('authorityRecord'),
        kind: input.kind,
        tenantId: ctx.tenantId,
        siteId: d.site_id,
        incidentId: d.incident_id,
        candidateActionId: d.candidate_action_id,
        assetRevisionId: d.asset_revision_id,
        evidenceRevisionId: d.evidence_revision_id,
        policyRevisionId: d.policy_revision_id,
        actionDigest: d.action_digest,
        heldDecisionId: d.id,
        exceptionClasses: input.kind === 'ENGINEER_EXCEPTION' ? requirement.exceptionClasses : [],
        overriddenReasons: input.kind === 'POLICY_APPROVAL' ? requirement.overriddenReasons : [],
        actorUserId,
        actorRole,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        issuedAt: now,
        expiresAt: new Date(input.expiresAt).toISOString() as UtcInstant,
        status: 'ACTIVE',
      } as Omit<AuthorityRecord, 'signature'>,
      keys.keyring[keys.keyId]!,
      keys.keyId,
    );
    await c.query(
      `INSERT INTO compatibility_authority_records (tenant_id, id, kind, held_decision_id, candidate_action_id, incident_id,
         site_id, asset_revision_id, evidence_revision_id, policy_revision_id, action_digest, candidate_key, exception_classes,
         overridden_reasons, actor_user_id, actor_role, reason_code, reason_text, issued_at, expires_at, signature_algorithm,
         signature_key_id, signature_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        ctx.tenantId,
        record.authorityRecordId,
        record.kind,
        d.id,
        d.candidate_action_id,
        d.incident_id,
        d.site_id,
        d.asset_revision_id,
        d.evidence_revision_id,
        d.policy_revision_id,
        d.action_digest,
        d.candidate_key,
        record.exceptionClasses,
        record.overriddenReasons,
        actorUserId,
        actorRole,
        record.reasonCode,
        record.reasonText,
        record.issuedAt,
        record.expiresAt,
        record.signature.algorithm,
        record.signature.keyId,
        record.signature.value,
      ],
    );
    await recordAudit(c, ctx, {
      action,
      resourceType: 'compatibility_authority_record',
      resourceId: record.authorityRecordId,
      result: 'SUCCEEDED',
      reasonCode: record.reasonCode,
      metadata: { heldDecisionId: d.id, actorRole },
    });
    return {
      authorityRecordId: record.authorityRecordId,
      signature: record.signature,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
  });
}

export async function getAuthorityRecord(
  pool: Db,
  ctx: TenantContext,
  authorityRecordId: string,
): Promise<AuthorityRecordView> {
  const meta = {
    action: 'compatibility.read',
    resourceType: 'compatibility_authority_record',
    resourceId: authorityRecordId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query<AuthorityRow>(`${AUTHORITY_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`, [
      ctx.tenantId,
      String(authorityRecordId),
    ]);
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'compatibility.read', siteId: rows[0].site_id as never }, undefined, {
      type: 'compatibility_authority_record',
      id: authorityRecordId,
    });
    return { ...toAuthorityRecord(rows[0]), label: 'HUMAN APPROVAL', createdAt: isoOf(rows[0].created_at)! };
  });
}

/**
 * Append-only revocation by the recording human (still holding the role at the site) or a tenant administrator.
 * CURRENT decisions that applied the record are superseded at once; the record and its decisions are never edited.
 */
export async function revokeAuthority(
  pool: Db,
  ctx: TenantContext,
  authorityRecordId: string,
  reasonCode: string,
): Promise<{ supersededDecisionIds: string[] }> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) throw invalid('INVALID_REASON');
  const meta = {
    action: 'compatibility.authority_revoke',
    resourceType: 'compatibility_authority_record',
    resourceId: authorityRecordId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query<AuthorityRow>(`${AUTHORITY_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`, [
      ctx.tenantId,
      String(authorityRecordId),
    ]);
    const r = rows[0];
    if (!r) throw unavailable(meta);
    const admin = authorize(ctx, { action: 'policy.publish', siteId: null }).allowed;
    const own =
      ctx.principal.kind === 'HUMAN' &&
      ctx.principal.id === r.actor_user_id &&
      authorize(ctx, { action: actionFor(r.kind), siteId: r.site_id as never }).allowed;
    if (!admin && !own)
      throw new Denial(notPermitted('NOT_AUTHORITY_OWNER'), { ...meta, reasonCode: 'NOT_AUTHORITY_OWNER' });
    const ins = await c.query(
      `INSERT INTO compatibility_authority_events (tenant_id, id, authority_record_id, event_type, reason_code, actor_kind, actor_id)
       VALUES ($1, $2, $3, 'REVOKED', $4, 'HUMAN', $5) ON CONFLICT (tenant_id, authority_record_id) DO NOTHING`,
      [ctx.tenantId, newCompatibilityId('authorityEvent'), r.id, reasonCode, humanActor(ctx)],
    );
    if (ins.rowCount !== 1) throw hold('AUTHORITY_ALREADY_TERMINAL');
    const sup = await c.query<{ id: string }>(
      `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED', superseded_at = clock_timestamp(),
              superseded_reason = 'AUTHORITY_REVOKED'
        WHERE tenant_id = $1 AND lifecycle = 'CURRENT' AND $2 = ANY (applied_authority_ids) RETURNING id`,
      [ctx.tenantId, r.id],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode });
    return { supersededDecisionIds: sup.rows.map((x) => x.id).sort() };
  });
}
