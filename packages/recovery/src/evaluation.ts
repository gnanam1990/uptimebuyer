// Recovery evaluation bindings and gates (FR-15, INV-01, INV-03, INV-14). An evaluation pins the incident, its asset
// revision and recovery cycle, the designated milestone (its normalized occurred time is the observation boundary),
// the milestone's plan/action digest and the recovery-policy revision in force when the milestone was verified, the
// incident's evidence and rule revisions, and the exact open assignment/channel revisions of the asset. The gates are
// evaluated identically by the assessment and by the closeout transaction: the stable window, every policy-required
// work-order signoff/attestation, and the exact approved installed-part identity.
import type { TenantContext, Tx } from '@uptimebuyer/data';
import { canonicalDigest } from '@uptimebuyer/domain';
import { attesterRoleAt, evidenceSealValid, type EvidenceRow } from './evidence.js';
import { activeIntegrations, approvedActions, cycleStart, disputedIds, type ApprovedAction } from './facts.js';
import { isoOf, ms, type IncidentRow, type RecoverySigning } from './internal.js';
import { loadPolicy, num, type PolicyRow } from './policy.js';
import { evaluateStableWindow, type WindowResult, type WindowSample } from './window.js';

export interface MilestoneRow {
  id: string;
  incident_id: string;
  recovery_cycle: number;
  plan_id: string;
  plan_action_id: string;
  action_digest: string;
  milestone_type: string;
  source_evidence_id: string;
  source_kind: string;
  recovery_policy_revision_id: string;
  occurred_at: Date;
  verified_at: Date;
  signature: string;
}

export interface ChannelPin {
  device_id: string;
  device_assignment_id: string;
  channel_id: string;
  channel_revision_id: string;
  calibration_revision: number;
  asset_revision_id: string;
}

export interface RuleRow {
  id: string;
  channel_kind: string;
  comparator: 'ABOVE' | 'BELOW';
  threshold_int: string;
  hysteresis_int: string;
  recovery_window_ms: string;
  watch_window_ms: string;
}

export interface EvaluationRow {
  tenant_id: string;
  id: string;
  incident_id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  recovery_cycle: number;
  plan_id: string;
  plan_action_id: string;
  action_digest: string;
  evidence_revision_id: string;
  recovery_policy_revision_id: string;
  rule_revision_id: string;
  milestone_id: string;
  observation_boundary_at: Date;
  stable_window_ms: string;
  expires_at: Date;
  binding_digest: string;
  state: 'PENDING' | 'OBSERVING' | 'PASSED' | 'FAILED' | 'EXPIRED';
  state_reason: string | null;
  decided_at: Date | null;
  version: number;
}

export interface DesiredBinding {
  milestone: MilestoneRow;
  policy: PolicyRow;
  rule: RuleRow;
  evidenceRevisionId: string;
  channels: ChannelPin[];
  stableWindowMs: number;
  expiresAtMs: number;
  bindingDigest: string;
}

export async function loadRule(c: Tx, tenantId: string, id: string): Promise<RuleRow> {
  const { rows } = await c.query<RuleRow>(`SELECT * FROM incident_rule_revisions WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return rows[0]!;
}

/** The designated milestone of the current cycle: the latest one whose source evidence is undisputed and still authorized. */
export async function currentMilestone(c: Tx, inc: IncidentRow): Promise<MilestoneRow | undefined> {
  const { rows } = await c.query<MilestoneRow>(
    `SELECT m.* FROM intervention_milestones m
       JOIN recovery_evidence e ON e.tenant_id = m.tenant_id AND e.id = m.source_evidence_id
      WHERE m.tenant_id = $1 AND m.incident_id = $2 AND m.recovery_cycle = $3
        AND NOT EXISTS (SELECT 1 FROM recovery_evidence_disputes d WHERE d.tenant_id = e.tenant_id AND d.evidence_id = e.id)
        AND (e.cmms_integration_id IS NULL OR EXISTS (
          SELECT 1 FROM cmms_integrations ci WHERE ci.tenant_id = e.tenant_id AND ci.id = e.cmms_integration_id
             AND ci.site_id = m.site_id AND ci.revoked_at IS NULL))
      ORDER BY m.occurred_at DESC, m.verified_at DESC, m.id DESC LIMIT 1`,
    [inc.tenant_id, inc.id, inc.reopen_count],
  );
  return rows[0];
}

/** Open, non-revoked assignment/channel revisions of the asset's pinned revision for the rule's channel kind. */
export async function currentChannels(c: Tx, inc: IncidentRow, channelKind: string): Promise<ChannelPin[]> {
  const { rows } = await c.query<ChannelPin>(
    `SELECT a.device_id, a.id AS device_assignment_id, sc.id AS channel_id, r.id AS channel_revision_id,
            r.calibration_revision, a.asset_revision_id
       FROM device_asset_assignments a
       JOIN devices d ON d.tenant_id = a.tenant_id AND d.id = a.device_id AND d.status <> 'REVOKED'
       JOIN sensor_channels sc ON sc.tenant_id = a.tenant_id AND sc.device_id = a.device_id AND sc.status = 'ACTIVE'
       JOIN sensor_channel_revisions r ON r.tenant_id = sc.tenant_id AND r.id = sc.current_revision_id AND r.valid_to IS NULL
      WHERE a.tenant_id = $1 AND a.asset_id = $2 AND a.asset_revision_id = $3 AND a.valid_to IS NULL AND r.kind = $4
      ORDER BY sc.id LIMIT 16`,
    [inc.tenant_id, inc.asset_id, inc.asset_revision_id, channelKind],
  );
  return rows;
}

export async function pinnedChannels(c: Tx, tenantId: string, evaluationId: string): Promise<ChannelPin[]> {
  const { rows } = await c.query<ChannelPin>(
    `SELECT device_id, device_assignment_id, channel_id, channel_revision_id, calibration_revision, asset_revision_id
       FROM recovery_evaluation_channels WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY channel_id`,
    [tenantId, evaluationId],
  );
  return rows;
}

export type BindingProblem = 'MILESTONE_MISSING' | 'EVIDENCE_REVISION_MISSING' | 'NO_RECOVERY_CHANNEL';

/** Everything an evaluation for this incident must pin right now (or why none can be opened). */
export async function desiredBinding(c: Tx, inc: IncidentRow): Promise<DesiredBinding | BindingProblem> {
  const milestone = await currentMilestone(c, inc);
  if (!milestone) return 'MILESTONE_MISSING';
  const policy = await loadPolicy(c, inc.tenant_id, milestone.recovery_policy_revision_id);
  const rule = await loadRule(c, inc.tenant_id, inc.rule_revision_id);
  const er = await c.query<{ id: string }>(
    `SELECT id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2 ORDER BY revision DESC LIMIT 1`,
    [inc.tenant_id, inc.id],
  );
  if (!er.rows[0]) return 'EVIDENCE_REVISION_MISSING';
  const channels = await currentChannels(c, inc, rule.channel_kind);
  if (channels.length === 0) return 'NO_RECOVERY_CHANNEL';
  const boundaryMs = milestone.occurred_at.getTime();
  const stableWindowMs = num(policy.stable_window_ms);
  const expiresAtMs = boundaryMs + num(policy.max_observation_ms);
  const bindingDigest = canonicalDigest('recovery-binding', 1, {
    tenantId: inc.tenant_id,
    incidentId: inc.id,
    recoveryCycle: inc.reopen_count,
    assetRevisionId: inc.asset_revision_id,
    planId: milestone.plan_id,
    planActionId: milestone.plan_action_id,
    actionDigest: milestone.action_digest,
    evidenceRevisionId: er.rows[0].id,
    recoveryPolicyRevisionId: policy.id,
    ruleRevisionId: rule.id,
    milestoneId: milestone.id,
    observationBoundaryAt: isoOf(boundaryMs),
    stableWindowMs,
    expiresAt: isoOf(expiresAtMs),
    channels: channels.map((ch) => ({ ...ch, calibration_revision: Number(ch.calibration_revision) })),
  });
  return {
    milestone,
    policy,
    rule,
    evidenceRevisionId: er.rows[0].id,
    channels,
    stableWindowMs,
    expiresAtMs,
    bindingDigest,
  };
}

export interface SignoffPin {
  requirement: 'CMMS_WORK_ORDER' | 'OPERATOR_ATTESTATION' | 'INSTALLED_PART';
  evidenceId: string;
}

export interface GateResult {
  passed: boolean;
  reasonCodes: string[];
  window: WindowResult;
  signoffs: SignoffPin[];
  signoffEvidence: EvidenceRow[];
  installedPart: {
    manufacturer: string;
    partNumber: string;
    serial: string;
    barcode: string | null;
    evidenceId: string;
  } | null;
  actions: ApprovedAction[];
}

const FUTURE_SAMPLE_SKEW_MS = 5_000;

interface SampleRow {
  id: string;
  event_at: Date;
  channel_id: string;
  channel_revision_id: string;
  device_assignment_id: string;
  asset_id: string;
  asset_revision_id: string;
  ingestion_class: 'LIVE' | 'LATE' | 'BACKFILL';
  delivery: 'LIVE' | 'BACKFILL';
  quality_flags: string[];
  input_origin: 'PHYSICAL_SENSOR' | 'SIMULATED_INPUT';
  value_int: string;
  revoked: boolean;
  linked: string[];
}

export async function windowSamples(
  c: Tx,
  tenantId: string,
  channelIds: readonly string[],
  fromMs: number,
  toMs: number,
): Promise<WindowSample[]> {
  const { rows } = await c.query<SampleRow>(
    `SELECT s.id, s.event_at, s.channel_id, s.channel_revision_id, s.device_assignment_id, s.asset_id, s.asset_revision_id,
            s.ingestion_class, s.delivery, s.quality_flags, s.input_origin, s.value_int::text, d.status = 'REVOKED' AS revoked,
            coalesce((SELECT array_agg(DISTINCT sg.incident_id) FROM incident_signal_samples ss
                        JOIN incident_signals sg ON sg.tenant_id = ss.tenant_id AND sg.id = ss.signal_id
                       WHERE ss.tenant_id = s.tenant_id AND ss.sample_id = s.id), '{}') AS linked
       FROM telemetry_samples s JOIN devices d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
      WHERE s.tenant_id = $1 AND s.channel_id = ANY($2::text[]) AND s.event_at >= $3 AND s.event_at <= $4
      ORDER BY s.event_at DESC, s.id DESC LIMIT 20000`,
    [tenantId, channelIds, isoOf(fromMs), isoOf(toMs)],
  );
  return rows.map((r) => ({
    id: r.id,
    eventAtMs: r.event_at.getTime(),
    channelId: r.channel_id,
    channelRevisionId: r.channel_revision_id,
    deviceAssignmentId: r.device_assignment_id,
    assetId: r.asset_id,
    assetRevisionId: r.asset_revision_id,
    ingestionClass: r.ingestion_class,
    delivery: r.delivery,
    qualityFlags: r.quality_flags,
    inputOrigin: r.input_origin,
    valueInt: BigInt(r.value_int),
    linkedIncidentIds: r.linked,
    deviceRevoked: r.revoked,
  }));
}

/**
 * The closeout gates for an evaluation at instant `atMs`. Deterministic for the same durable state and instant; used by
 * the assessment and again, under lock, by the closeout transaction.
 */
export async function computeGates(
  c: Tx,
  ctx: TenantContext,
  inc: IncidentRow,
  ev: EvaluationRow,
  pins: readonly ChannelPin[],
  policy: PolicyRow,
  rule: RuleRow,
  atMs: number,
  signing: RecoverySigning,
): Promise<GateResult> {
  const reasons: string[] = [];
  const boundaryMs = ev.observation_boundary_at.getTime();
  const samples = await windowSamples(
    c,
    ctx.tenantId,
    pins.map((p) => p.channel_id),
    boundaryMs,
    atMs + 3_600_000,
  );
  const window = evaluateStableWindow(
    {
      incidentId: inc.id,
      boundaryAtMs: boundaryMs,
      asOfMs: atMs,
      stableWindowMs: Math.max(num(ev.stable_window_ms), num(rule.recovery_window_ms)),
      maxGapMs: num(policy.max_gap_ms),
      minSamples: policy.min_samples,
      maxTailAgeMs: num(policy.max_tail_age_ms),
      maxFutureSkewMs: FUTURE_SAMPLE_SKEW_MS,
      allowSimulatedInput: policy.allow_simulated_input,
      safe: {
        comparator: rule.comparator,
        thresholdInt: BigInt(rule.threshold_int),
        hysteresisInt: BigInt(rule.hysteresis_int),
      },
      pins: pins.map((p) => ({
        channelId: p.channel_id,
        channelRevisionId: p.channel_revision_id,
        deviceAssignmentId: p.device_assignment_id,
        assetId: ev.asset_id,
        assetRevisionId: p.asset_revision_id,
      })),
    },
    samples,
  );
  if (!window.passed) reasons.push(...window.reasonCodes);

  // Evidence of this incident's current cycle, bound to the evaluation's plan and action, undisputed and sealed.
  const since = await cycleStart(c, ctx.tenantId, inc.id);
  const { rows: all } = await c.query<EvidenceRow>(
    `SELECT * FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2 AND recorded_at >= $3
        AND plan_id = $4 AND action_digest = $5 AND source_kind IN ('CMMS', 'AUTHORIZED_OPERATOR')
      ORDER BY occurred_at, recorded_at, id`,
    [ctx.tenantId, inc.id, since, ev.plan_id, ev.action_digest],
  );
  const disputed = await disputedIds(
    c,
    ctx.tenantId,
    all.map((e) => e.id),
  );
  const active = await activeIntegrations(c, ctx.tenantId);
  const roleOk = new Map<string, boolean>();
  const valid: EvidenceRow[] = [];
  for (const e of all) {
    if (disputed.has(e.id) || !evidenceSealValid(signing, e)) continue;
    if (e.source_kind === 'CMMS') {
      if (!e.cmms_integration_id || active.get(e.cmms_integration_id) !== inc.site_id) continue;
    } else {
      if (!roleOk.has(e.actor_id))
        roleOk.set(
          e.actor_id,
          (await attesterRoleAt(c, ctx.tenantId, e.actor_id, inc.site_id, policy.attestation_roles)) !== null,
        );
      if (!roleOk.get(e.actor_id)) continue;
    }
    valid.push(e);
  }
  const signoffs: SignoffPin[] = [];
  for (const req of policy.required_signoffs) {
    const kind = req === 'CMMS_WORK_ORDER' ? 'CMMS_SIGNOFF' : 'OPERATOR_ATTESTATION';
    const matches = valid.filter((e) => e.kind === kind && ms(e.occurred_at) >= boundaryMs);
    if (matches.length === 0) reasons.push(`SIGNOFF_MISSING_${req}`);
    for (const e of matches) signoffs.push({ requirement: req, evidenceId: e.id });
  }

  const actions = await approvedActions(c, ctx.tenantId, inc.id);
  const own = actions.find((a) => a.plan_id === ev.plan_id && a.action_digest === ev.action_digest);
  if (!own) reasons.push('ACTION_NOT_APPROVED');
  let installedPart: GateResult['installedPart'] = null;
  if (policy.installed_part_required) {
    const target =
      own && own.part_number !== null
        ? own
        : actions.find((a) => a.plan_id === ev.plan_id && a.action_kind === 'PART_PURCHASE' && a.part_number !== null);
    if (!target) reasons.push('INSTALLED_PART_TARGET_MISSING');
    else {
      const claims = valid.filter((e) => e.part_number !== null);
      const superseded = new Set(
        claims
          .filter((e) => e.kind === 'INSTALLED_PART' && e.source_kind === 'CMMS' && e.supersedes_record_id !== null)
          .map((e) => `${e.cmms_integration_id}|${e.supersedes_record_id}`),
      );
      const live = claims.filter(
        (e) => !(e.source_kind === 'CMMS' && superseded.has(`${e.cmms_integration_id}|${e.external_record_id}`)),
      );
      const matches = (e: EvidenceRow) =>
        e.part_number === target.part_number && e.part_manufacturer === target.part_manufacturer;
      if (live.length === 0) reasons.push('INSTALLED_PART_MISSING');
      else if (!live.every(matches)) reasons.push('INSTALLED_PART_MISMATCH');
      else {
        const chosen = live.at(-1)!;
        installedPart = {
          manufacturer: chosen.part_manufacturer!,
          partNumber: chosen.part_number!,
          serial: chosen.part_serial!,
          barcode: chosen.part_barcode,
          evidenceId: chosen.id,
        };
        signoffs.push({ requirement: 'INSTALLED_PART', evidenceId: chosen.id });
      }
      if (target.order_kind === 'PURCHASE_ORDER' && target.order_state !== 'VERIFIED')
        reasons.push('PART_ORDER_NOT_VERIFIED');
    }
  }
  const used = new Set(signoffs.map((s) => s.evidenceId));
  return {
    passed: reasons.length === 0,
    reasonCodes: [...new Set(reasons)],
    window,
    signoffs,
    signoffEvidence: valid.filter((e) => used.has(e.id)),
    installedPart,
    actions,
  };
}
