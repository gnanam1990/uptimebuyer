// Recovery evidence ingestion (FR-14, INV-02, INV-10). Every post-intervention record keeps its source identity, trust
// label, occurred time and observed (receipt) time:
//  * signed CMMS records from an authenticated CMMS integration identity bound to the incident's site
//    (work-order signoff, technician record, installed-part barcode/serial), verified over the exact raw bytes;
//  * authorized-operator attestations and installed-part scans (only a role the recovery policy names, at the site);
//  * unattested operator notes and technician records, provider completion, receipts and model assertions, recorded
//    with labels that can never back a milestone or a signoff.
// Authority-capable rows carry an HMAC seal over their bound fields (keyed by the runtime recovery keyring) so a row
// forged directly in the database never verifies. Rows are append-only; replays are idempotent.
import { createHash } from 'node:crypto';
import {
  AssetIdSchema,
  AssetRevisionIdSchema,
  DomainError,
  IncidentIdSchema,
  PlanIdSchema,
  SiteIdSchema,
  UtcInstantSchema,
} from '@uptimebuyer/contracts';
import {
  Denial,
  assertTenantContext,
  assertTenantSecretRef,
  dbNow,
  humanActor,
  notPermitted,
  recordAudit,
  sha256Digest,
  tenantCommand,
  unavailable,
  type CredentialResolver,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalize } from '@uptimebuyer/domain';
import { z } from 'zod';
import { CMMS_RECORD_LIMITS, verifyCmmsSignature } from './cmms-adapter.js';
import {
  IdempotencyKey,
  actorFor,
  hold,
  isoOf,
  loadIncident,
  ms,
  newRecoveryId,
  parseInput,
  readReceipt,
  requestDigest,
  requireAt,
  seal,
  validation,
  verifySeal,
  writeReceipt,
  type RecoverySigning,
} from './internal.js';
import { effectivePolicy, MILESTONE_TYPES } from './policy.js';

const Token = z.string().regex(/^[\x21-\x7E]{1,128}$/);
const ActionDigest = z.string().regex(/^action\.v1:sha256:[0-9a-f]{64}$/);
const PartSchema = z.strictObject({
  manufacturer: z.string().min(1).max(200),
  partNumber: z.string().min(1).max(80),
  serial: z.string().regex(/^\S(?:.{0,126}\S)?$/),
  barcode: z
    .string()
    .regex(/^\S(?:.{0,126}\S)?$/)
    .optional(),
});
const ClaimedMilestone = z.enum([...MILESTONE_TYPES, 'PART_RECEIVED', 'TECHNICIAN_ARRIVED']);

export interface EvidenceRow {
  tenant_id: string;
  id: string;
  incident_id: string;
  site_id: string;
  asset_id: string;
  kind: string;
  source_kind: 'CMMS' | 'AUTHORIZED_OPERATOR' | 'OPERATOR' | 'PROVIDER' | 'MODEL';
  trust: string;
  cmms_integration_id: string | null;
  external_record_id: string | null;
  supersedes_record_id: string | null;
  actor_kind: string;
  actor_id: string;
  attester_user_id: string | null;
  attester_role: string | null;
  claimed_asset_id: string | null;
  claimed_asset_revision_id: string | null;
  plan_id: string | null;
  action_digest: string | null;
  milestone_type: string | null;
  occurred_at: Date;
  observed_at: Date;
  recorded_at: Date;
  work_order_ref: string | null;
  technician_ref: string | null;
  signer_ref: string | null;
  part_manufacturer: string | null;
  part_number: string | null;
  part_serial: string | null;
  part_barcode: string | null;
  note: string | null;
  source_ref: string | null;
  body: Record<string, unknown>;
  body_digest: string;
  signature_digest: string;
  signature_key_id: string;
}

/** The fields an evidence seal binds (identical at write and at verification). */
export function evidenceSealValue(r: {
  tenant_id: string;
  id: string;
  incident_id: string;
  kind: string;
  source_kind: string;
  trust: string;
  cmms_integration_id: string | null;
  external_record_id: string | null;
  supersedes_record_id: string | null;
  actor_kind: string;
  actor_id: string;
  attester_user_id: string | null;
  attester_role: string | null;
  claimed_asset_revision_id: string | null;
  plan_id: string | null;
  action_digest: string | null;
  milestone_type: string | null;
  occurred_at: Date | string;
  observed_at: Date | string;
  part_manufacturer: string | null;
  part_number: string | null;
  part_serial: string | null;
  body_digest: string;
}) {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    incidentId: r.incident_id,
    kind: r.kind,
    sourceKind: r.source_kind,
    trust: r.trust,
    cmmsIntegrationId: r.cmms_integration_id,
    externalRecordId: r.external_record_id,
    supersedesRecordId: r.supersedes_record_id,
    actor: `${r.actor_kind}:${r.actor_id}`,
    attester: r.attester_user_id === null ? null : [r.attester_user_id, r.attester_role],
    claimedAssetRevisionId: r.claimed_asset_revision_id,
    planId: r.plan_id,
    actionDigest: r.action_digest,
    milestoneType: r.milestone_type,
    occurredAt: isoOf(r.occurred_at),
    observedAt: isoOf(r.observed_at),
    part: r.part_number === null ? null : [r.part_manufacturer, r.part_number, r.part_serial],
    bodyDigest: r.body_digest,
  };
}

export const EVIDENCE_SEAL_DOMAIN = 'recovery-evidence-seal.v1';
const AUTHORITY_SOURCES = new Set(['CMMS', 'AUTHORIZED_OPERATOR']);

/** Authority-capable evidence must carry a valid seal; anything else is never authority anyway. */
export function evidenceSealValid(signing: RecoverySigning, r: EvidenceRow): boolean {
  if (!AUTHORITY_SOURCES.has(r.source_kind)) return false;
  return verifySeal(signing, EVIDENCE_SEAL_DOMAIN, evidenceSealValue(r), r.signature_digest, r.signature_key_id);
}

interface InsertEvidence {
  id: string;
  incident: { id: string; site_id: string; asset_id: string };
  kind: string;
  sourceKind: EvidenceRow['source_kind'];
  trust: string;
  actor: { kind: string; id: string };
  attester?: { userId: string; role: string } | null;
  cmmsIntegrationId?: string | null;
  externalRecordId?: string | null;
  supersedesRecordId?: string | null;
  claimedAssetId?: string | null;
  claimedAssetRevisionId?: string | null;
  planId?: string | null;
  actionDigest?: string | null;
  milestoneType?: string | null;
  occurredAt: string;
  observedAt: string;
  workOrderRef?: string | null;
  technicianRef?: string | null;
  signerRef?: string | null;
  part?: { manufacturer: string; partNumber: string; serial: string; barcode?: string | undefined } | null;
  note?: string | null;
  sourceRef?: string | null;
  body: Record<string, unknown>;
  bodyDigest: string;
}

async function insertEvidence(
  c: Tx,
  tenantId: string,
  e: InsertEvidence,
  signing: RecoverySigning | null,
  onConflictRecord = false,
): Promise<string | null> {
  const row = {
    tenant_id: tenantId,
    id: e.id,
    incident_id: e.incident.id,
    kind: e.kind,
    source_kind: e.sourceKind,
    trust: e.trust,
    cmms_integration_id: e.cmmsIntegrationId ?? null,
    external_record_id: e.externalRecordId ?? null,
    supersedes_record_id: e.supersedesRecordId ?? null,
    actor_kind: e.actor.kind,
    actor_id: e.actor.id,
    attester_user_id: e.attester?.userId ?? null,
    attester_role: e.attester?.role ?? null,
    claimed_asset_revision_id: e.claimedAssetRevisionId ?? null,
    plan_id: e.planId ?? null,
    action_digest: e.actionDigest ?? null,
    milestone_type: e.milestoneType ?? null,
    occurred_at: e.occurredAt,
    observed_at: e.observedAt,
    part_manufacturer: e.part?.manufacturer ?? null,
    part_number: e.part?.partNumber ?? null,
    part_serial: e.part?.serial ?? null,
    body_digest: e.bodyDigest,
  };
  let signature: string;
  let keyId: string;
  if (AUTHORITY_SOURCES.has(e.sourceKind)) {
    if (!signing) throw new DomainError('INTERNAL', 'Authority-capable evidence needs the recovery keyring.');
    ({ signature, keyId } = seal(signing, EVIDENCE_SEAL_DOMAIN, evidenceSealValue(row)));
  } else {
    // Non-authority evidence carries a plain integrity digest only (never a seal, so it can never verify as authority).
    signature = `sha256:${createHash('sha256')
      .update(canonicalize(evidenceSealValue(row)))
      .digest('hex')}`;
    keyId = 'unsealed';
  }
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO recovery_evidence (tenant_id, id, incident_id, site_id, asset_id, kind, source_kind, trust,
       cmms_integration_id, external_record_id, supersedes_record_id, actor_kind, actor_id, attester_user_id, attester_role,
       claimed_asset_id,
       claimed_asset_revision_id, plan_id, action_digest, milestone_type, occurred_at, observed_at, work_order_ref,
       technician_ref, signer_ref, part_manufacturer, part_number, part_serial, part_barcode, note, source_ref, body,
       body_digest, signature_digest, signature_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)
     ${onConflictRecord ? 'ON CONFLICT (tenant_id, cmms_integration_id, external_record_id) DO NOTHING' : ''}
     RETURNING id`,
    [
      tenantId,
      e.id,
      e.incident.id,
      e.incident.site_id,
      e.incident.asset_id,
      e.kind,
      e.sourceKind,
      e.trust,
      row.cmms_integration_id,
      row.external_record_id,
      row.supersedes_record_id,
      e.actor.kind,
      e.actor.id,
      row.attester_user_id,
      row.attester_role,
      e.claimedAssetId ?? null,
      row.claimed_asset_revision_id,
      row.plan_id,
      row.action_digest,
      row.milestone_type,
      e.occurredAt,
      e.observedAt,
      e.workOrderRef ?? null,
      e.technicianRef ?? null,
      e.signerRef ?? null,
      row.part_manufacturer,
      row.part_number,
      row.part_serial,
      e.part?.barcode ?? null,
      e.note ?? null,
      e.sourceRef ?? null,
      JSON.stringify(e.body),
      e.bodyDigest,
      signature,
      keyId,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Occurred times outside [now - 30 d, now + 1 h] are refused at ingestion (policy bounds apply at milestone time). */
function checkOccurred(occurredAt: string, nowIso: string) {
  const o = ms(occurredAt);
  const now = ms(nowIso);
  if (o > now + 3_600_000 || o < now - 30 * 86_400_000) throw validation('OCCURRED_AT_OUT_OF_BOUNDS');
}

/** Whether the human holds one of the policy's attestation roles at the site (or tenant-wide). */
export async function attesterRoleAt(
  c: Tx,
  tenantId: string,
  userId: string,
  siteId: string,
  roles: readonly string[],
): Promise<string | null> {
  const { rows } = await c.query<{ role: string }>(
    `SELECT r.role FROM role_assignments r
       JOIN tenant_memberships m ON m.tenant_id = r.tenant_id AND m.user_id = r.user_id AND m.status = 'ACTIVE'
      WHERE r.tenant_id = $1 AND r.user_id = $2 AND r.revoked_at IS NULL AND r.role = ANY($4::text[])
        AND (r.site_id IS NULL OR r.site_id = $3)
      ORDER BY array_position($4::text[], r.role) LIMIT 1`,
    [tenantId, userId, siteId, roles],
  );
  return rows[0]?.role ?? null;
}

/**
 * An authorized-operator row still authorizes when its stored attester role is one `roles` names AND the attester
 * still holds exactly that role at the site (or tenant-wide) with an active membership.
 */
export async function attesterStillAuthorized(
  c: Tx,
  tenantId: string,
  e: Pick<EvidenceRow, 'source_kind' | 'attester_user_id' | 'attester_role'>,
  siteId: string,
  roles: readonly string[],
): Promise<boolean> {
  if (e.source_kind !== 'AUTHORIZED_OPERATOR' || !e.attester_user_id || !e.attester_role) return false;
  if (!roles.includes(e.attester_role)) return false;
  return (await attesterRoleAt(c, tenantId, e.attester_user_id, siteId, [e.attester_role])) !== null;
}

// ---------------------------------------------------------------------------------------------------------------
// Human / worker evidence

const HUMAN_KINDS = new Set(['OPERATOR_ATTESTATION', 'INSTALLED_PART', 'TECHNICIAN_RECORD', 'OPERATOR_NOTE']);
const WORKER_KINDS = new Set(['PROVIDER_COMPLETION', 'RECEIPT', 'MODEL_ASSERTION']);

const RecordEvidenceSchema = z.strictObject({
  incidentId: z.string().max(128),
  idempotencyKey: IdempotencyKey,
  kind: z.enum([
    'OPERATOR_ATTESTATION',
    'INSTALLED_PART',
    'TECHNICIAN_RECORD',
    'OPERATOR_NOTE',
    'PROVIDER_COMPLETION',
    'RECEIPT',
    'MODEL_ASSERTION',
  ]),
  occurredAt: UtcInstantSchema,
  planId: PlanIdSchema.optional(),
  actionDigest: ActionDigest.optional(),
  milestoneType: z.enum(MILESTONE_TYPES).optional(),
  installedPart: PartSchema.optional(),
  note: z.string().min(1).max(2000).optional(),
  technicianRef: Token.optional(),
  sourceRef: Token.optional(),
});
export type RecoveryEvidenceInput = z.input<typeof RecordEvidenceSchema>;
export interface RecoveryEvidenceResult extends Record<string, unknown> {
  evidenceId: string;
  kind: string;
  trust: string;
  created: boolean;
}

export async function recordRecoveryEvidence(
  pool: Db,
  ctx: TenantContext,
  raw: RecoveryEvidenceInput,
  signing: RecoverySigning,
): Promise<RecoveryEvidenceResult> {
  const input = parseInput(RecordEvidenceSchema, raw);
  const meta = { action: 'recovery.evidence.record', resourceType: 'incident', resourceId: input.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const inc = await loadIncident(c, ctx, meta, input.incidentId, { action: 'recovery.evidence', lock: null });
    const human = ctx.principal.kind === 'HUMAN';
    if (human ? !HUMAN_KINDS.has(input.kind) : !WORKER_KINDS.has(input.kind))
      throw new Denial(notPermitted('EVIDENCE_KIND_NOT_PERMITTED'), {
        action: meta.action,
        resourceType: 'incident',
        resourceId: inc.id,
        reasonCode: 'EVIDENCE_KIND_NOT_PERMITTED',
      });
    const { idempotencyKey, ...body } = input;
    const digest = requestDigest(ctx, 'recovery.evidence.v1', body);
    const prior = await readReceipt<RecoveryEvidenceResult>(c, ctx, idempotencyKey, digest);
    if (prior) return { ...prior, created: false };
    const now = await dbNow(c);
    checkOccurred(input.occurredAt, now);
    let sourceKind: EvidenceRow['source_kind'];
    let trust: string;
    let attester: { userId: string; role: string } | null = null;
    if (input.kind === 'OPERATOR_ATTESTATION' || input.kind === 'INSTALLED_PART') {
      if (!input.planId || !input.actionDigest) throw validation('ACTION_BINDING_REQUIRED');
      if (input.kind === 'INSTALLED_PART' && !input.installedPart) throw validation('INSTALLED_PART_REQUIRED');
      if (input.kind === 'INSTALLED_PART' && input.milestoneType) throw validation('MILESTONE_NOT_PERMITTED');
      const policy = await effectivePolicy(c, ctx.tenantId, inc.site_id);
      if (!policy) throw hold('RECOVERY_POLICY_MISSING');
      const role = await attesterRoleAt(c, ctx.tenantId, humanActor(ctx), inc.site_id, policy.attestation_roles);
      if (!role)
        throw hold('ATTESTER_ROLE_NOT_PERMITTED', 'The recovery policy does not name this role as an attester.');
      sourceKind = 'AUTHORIZED_OPERATOR';
      trust = 'OPERATOR_ATTESTED';
      attester = { userId: humanActor(ctx), role };
    } else if (input.kind === 'OPERATOR_NOTE' || input.kind === 'TECHNICIAN_RECORD') {
      if (input.kind === 'OPERATOR_NOTE' && !input.note) throw validation('NOTE_REQUIRED');
      sourceKind = 'OPERATOR';
      trust = 'UNATTESTED';
    } else if (input.kind === 'MODEL_ASSERTION') {
      sourceKind = 'MODEL';
      trust = 'MODEL_PROPOSED';
    } else {
      sourceKind = 'PROVIDER';
      trust = 'PROVIDER_REPORTED';
    }
    // Free-text and non-authority evidence never carries an action binding or milestone claim.
    const authority = sourceKind === 'AUTHORIZED_OPERATOR';
    const id = newRecoveryId('evidence');
    const bodyDigest = sha256Digest(canonicalize(body));
    await insertEvidence(
      c,
      ctx.tenantId,
      {
        id,
        incident: inc,
        kind: input.kind,
        sourceKind,
        trust,
        actor: actorFor(ctx),
        attester,
        planId: authority ? input.planId! : null,
        actionDigest: authority ? input.actionDigest! : null,
        milestoneType: authority && input.kind === 'OPERATOR_ATTESTATION' ? (input.milestoneType ?? null) : null,
        occurredAt: isoOf(input.occurredAt),
        observedAt: now,
        technicianRef: input.technicianRef ?? null,
        part: authority ? (input.installedPart ?? null) : null,
        note: input.note ?? null,
        sourceRef: input.sourceRef ?? null,
        body,
        bodyDigest,
      },
      signing,
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { kind: input.kind, trust, evidenceId: id } });
    return writeReceipt(c, ctx, idempotencyKey, 'recovery.evidence.v1', digest, {
      evidenceId: id,
      kind: input.kind,
      trust,
      created: true,
    });
  });
}

/** Worker-side provider evidence written inside another module's transaction (outbox consumers). */
export async function recordProviderEvidenceInTx(
  c: Tx,
  ctx: TenantContext,
  incident: { id: string; site_id: string; asset_id: string },
  e: { kind: 'PROVIDER_COMPLETION' | 'RECEIPT'; occurredAt: string; sourceRef: string; body: Record<string, unknown> },
): Promise<string> {
  const id = newRecoveryId('evidence');
  await insertEvidence(
    c,
    ctx.tenantId,
    {
      id,
      incident,
      kind: e.kind,
      sourceKind: 'PROVIDER',
      trust: 'PROVIDER_REPORTED',
      actor: actorFor(ctx),
      occurredAt: e.occurredAt,
      observedAt: await dbNow(c),
      sourceRef: e.sourceRef,
      body: e.body,
      bodyDigest: sha256Digest(canonicalize(e.body)),
    },
    null,
  );
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Signed CMMS records

const CmmsRecordSchema = z.strictObject({
  schema: z.literal('cmms-record.v1'),
  recordId: Token,
  recordType: z.enum(['WORK_ORDER_SIGNOFF', 'TECHNICIAN_RECORD', 'INSTALLED_PART']),
  incidentId: IncidentIdSchema,
  assetId: AssetIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  planId: PlanIdSchema,
  actionDigest: ActionDigest,
  workOrderRef: Token,
  milestoneType: ClaimedMilestone.optional(),
  occurredAt: UtcInstantSchema,
  technicianRef: Token,
  signerRef: Token,
  installedPart: PartSchema.optional(),
  supersedesRecordId: Token.optional(),
});
export type CmmsRecord = z.output<typeof CmmsRecordSchema>;

export interface CmmsIngestResult {
  status: 'ACCEPTED' | 'DUPLICATE';
  evidenceId: string;
  kind: string;
}

const KIND_OF: Record<CmmsRecord['recordType'], string> = {
  WORK_ORDER_SIGNOFF: 'CMMS_SIGNOFF',
  TECHNICIAN_RECORD: 'TECHNICIAN_RECORD',
  INSTALLED_PART: 'INSTALLED_PART',
};

/**
 * Ingest one signed CMMS record from an authenticated CMMS integration identity. The tenant and site come only from
 * the identity's active binding; the body cannot select either. Signature (exact raw bytes, timestamp tolerance) is
 * verified before parsing; the incident must be in the binding's site, else the same RESOURCE_UNAVAILABLE as absence.
 */
export async function ingestCmmsRecord(
  pool: Db,
  ctx: TenantContext,
  req: { signature: string; rawBody: Uint8Array },
  deps: { credentials: CredentialResolver },
  signing: RecoverySigning,
): Promise<CmmsIngestResult> {
  assertTenantContext(ctx);
  const meta = { action: 'recovery.cmms.ingest', resourceType: 'cmms_record', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'recovery.cmms_ingest', null);
    if (ctx.principal.kind !== 'INTEGRATION')
      throw new Denial(notPermitted('PRINCIPAL_KIND_NOT_PERMITTED'), {
        ...meta,
        reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
      });
    if (!(req.rawBody instanceof Uint8Array) || req.rawBody.byteLength > CMMS_RECORD_LIMITS.maxBodyBytes)
      throw validation('BODY_TOO_LARGE');
    if (typeof req.signature !== 'string' || req.signature.length > 200) throw validation('SIGNATURE_MALFORMED');
    const { rows: bindings } = await c.query<{ id: string; site_id: string; verifier_ref: string }>(
      `SELECT id, site_id, verifier_ref FROM cmms_integrations
        WHERE tenant_id = $1 AND integration_identity_id = $2 AND revoked_at IS NULL`,
      [ctx.tenantId, ctx.principal.id],
    );
    const binding = bindings[0];
    if (!binding)
      throw new Denial(notPermitted('CMMS_INTEGRATION_INACTIVE'), { ...meta, reasonCode: 'CMMS_INTEGRATION_INACTIVE' });
    const key = await deps.credentials.resolveSigningKey(binding.verifier_ref);
    const now = await dbNow(c);
    const check = key
      ? verifyCmmsSignature(key, req.signature, req.rawBody, Math.floor(ms(now) / 1000))
      : ({ ok: false, reasonCode: 'VERIFIER_UNAVAILABLE' } as const);
    if (!check.ok)
      throw new Denial(notPermitted('CMMS_SIGNATURE_INVALID'), {
        ...meta,
        reasonCode: 'CMMS_SIGNATURE_INVALID',
        metadata: { cause: check.reasonCode },
      });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(req.rawBody).toString('utf8'));
    } catch {
      throw validation('BODY_NOT_JSON');
    }
    const r = CmmsRecordSchema.safeParse(parsed);
    if (!r.success) throw validation('CMMS_RECORD_INVALID');
    const rec = r.data;
    if (rec.recordType === 'INSTALLED_PART' && !rec.installedPart) throw validation('INSTALLED_PART_REQUIRED');
    if (rec.supersedesRecordId !== undefined && rec.recordType !== 'INSTALLED_PART')
      throw validation('SUPERSESSION_NOT_PERMITTED');
    if (rec.milestoneType !== undefined && rec.recordType !== 'WORK_ORDER_SIGNOFF')
      throw validation('MILESTONE_NOT_PERMITTED');
    checkOccurred(rec.occurredAt, now);
    const { rows: incs } = await c.query<{ id: string; site_id: string; asset_id: string }>(
      `SELECT id, site_id, asset_id FROM incidents WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, rec.incidentId],
    );
    const inc = incs[0];
    // Another site's (or another tenant's, or no) incident: the same answer as absence.
    if (!inc || inc.site_id !== binding.site_id)
      throw unavailable({ ...meta, resourceType: 'incident' }, rec.incidentId);
    const bodyDigest = sha256Digest(Buffer.from(req.rawBody).toString('latin1'));
    const id = newRecoveryId('evidence');
    const kind = KIND_OF[rec.recordType];
    const inserted = await insertEvidence(
      c,
      ctx.tenantId,
      {
        id,
        incident: inc,
        kind,
        sourceKind: 'CMMS',
        trust: 'VERIFIED_CMMS',
        actor: actorFor(ctx),
        cmmsIntegrationId: binding.id,
        externalRecordId: rec.recordId,
        supersedesRecordId: rec.supersedesRecordId ?? null,
        claimedAssetId: rec.assetId,
        claimedAssetRevisionId: rec.assetRevisionId,
        planId: rec.planId,
        actionDigest: rec.actionDigest,
        milestoneType: rec.milestoneType ?? null,
        occurredAt: isoOf(rec.occurredAt),
        observedAt: now,
        workOrderRef: rec.workOrderRef,
        technicianRef: rec.technicianRef,
        signerRef: rec.signerRef,
        part: rec.installedPart ?? null,
        body: { record: rec, cmmsSignature: req.signature, rawBodyDigest: bodyDigest },
        bodyDigest,
      },
      signing,
      true,
    );
    if (inserted) {
      await recordAudit(c, ctx, {
        ...meta,
        resourceId: id,
        result: 'SUCCEEDED',
        metadata: { kind, cmmsIntegrationId: binding.id },
      });
      return { status: 'ACCEPTED', evidenceId: id, kind };
    }
    const prior = await c.query<{ id: string; body_digest: string; kind: string }>(
      `SELECT id, body_digest, kind FROM recovery_evidence
        WHERE tenant_id = $1 AND cmms_integration_id = $2 AND external_record_id = $3`,
      [ctx.tenantId, binding.id, rec.recordId],
    );
    const p = prior.rows[0]!;
    if (p.body_digest !== bodyDigest)
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'The CMMS record id was already used for another record.', {
        reasonCode: 'CMMS_RECORD_REPLAYED',
      });
    return { status: 'DUPLICATE', evidenceId: p.id, kind: p.kind };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// CMMS integrations

const RegisterSchema = z.strictObject({
  siteId: SiteIdSchema,
  integrationIdentityId: z.string().regex(/^itg_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  systemKey: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  environment: z.enum(['SANDBOX', 'PRODUCTION']),
  verifierRef: z.string().max(300),
});

export async function registerCmmsIntegration(
  pool: Db,
  ctx: TenantContext,
  raw: z.input<typeof RegisterSchema>,
): Promise<{ cmmsIntegrationId: string }> {
  const input = parseInput(RegisterSchema, raw);
  const id = newRecoveryId('cmmsIntegration');
  const meta = { action: 'recovery.cmms.register', resourceType: 'cmms_integration', resourceId: id };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAt(ctx, meta, 'recovery.cmms_manage', input.siteId);
    assertTenantSecretRef(ctx.tenantId, input.verifierRef, 'verifierRef');
    const site = await c.query(`SELECT 1 FROM sites WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, input.siteId]);
    if (site.rowCount !== 1) throw unavailable(meta, input.siteId, 'site');
    const ident = await c.query(
      `SELECT 1 FROM integration_identities WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, input.integrationIdentityId],
    );
    if (ident.rowCount !== 1) throw unavailable(meta, input.integrationIdentityId, 'integration_identity');
    try {
      await c.query('SAVEPOINT cmms_bind');
      await c.query(
        `INSERT INTO cmms_integrations (tenant_id, id, site_id, integration_identity_id, system_key, environment,
           verifier_ref, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.tenantId,
          id,
          input.siteId,
          input.integrationIdentityId,
          input.systemKey,
          input.environment,
          input.verifierRef,
          humanActor(ctx),
        ],
      );
      await c.query('RELEASE SAVEPOINT cmms_bind');
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      await c.query('ROLLBACK TO SAVEPOINT cmms_bind');
      throw validation('CMMS_INTEGRATION_ALREADY_BOUND');
    }
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { siteId: input.siteId } });
    return { cmmsIntegrationId: id };
  });
}

export async function revokeCmmsIntegration(
  pool: Db,
  ctx: TenantContext,
  raw: { cmmsIntegrationId: string; reasonCode: string },
): Promise<void> {
  const input = parseInput(
    z.strictObject({
      cmmsIntegrationId: z.string().regex(/^cmi_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
      reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    }),
    raw,
  );
  const meta = {
    action: 'recovery.cmms.revoke',
    resourceType: 'cmms_integration',
    resourceId: input.cmmsIntegrationId,
  };
  await tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query<{ site_id: string; revoked_at: Date | null }>(
      `SELECT site_id, revoked_at FROM cmms_integrations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, input.cmmsIntegrationId],
    );
    if (!rows[0]) throw unavailable(meta);
    requireAt(ctx, meta, 'recovery.cmms_manage', rows[0].site_id);
    if (rows[0].revoked_at) return;
    await c.query(
      `UPDATE cmms_integrations SET revoked_at = clock_timestamp(), revoked_reason = $3 WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.cmmsIntegrationId, input.reasonCode],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', reasonCode: input.reasonCode });
  });
}

export async function loadEvidence(c: Tx, tenantId: string, id: string): Promise<EvidenceRow | undefined> {
  if (!/^rce_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(id)) return undefined;
  const { rows } = await c.query<EvidenceRow>(`SELECT * FROM recovery_evidence WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return rows[0];
}
