// T-017 — Threshold incident creation (FR-03, FR-04, NFR-08). A policy-qualified LIVE signal window opens exactly one
// incident pinning the exact telemetry/assignment/channel revisions, rule and AUTHORITY policy revisions, the
// immutable SOP procedure revision, the deadline basis/timezone digest, the original computed containment deadline,
// the initial owner assignment, asset, risk and correlation references. Isolated noise, LATE/BACKFILL data and a
// stale tail never open as live. A later procedure publication or an optional risk estimate cannot extend it.
import { IncidentStateChangedEventSchema, decodeWire, type AssetId } from '@uptimebuyer/contracts';
import { listTelemetrySamples, readEvidenceLedger, registerAsset } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IncidentOpenedEventSchema,
  adjustIncidentDeadline,
  evaluateIncidentRules,
  getIncident,
  getIncidentTimeline,
  publishOperatingProcedure,
  recordRiskEstimate,
} from '../src/index.js';
import {
  COLD_CHAIN_PROCEDURE,
  createIncidentWorld,
  freshAsset,
  isoAt,
  liveRun,
  provisionDevice,
  rejection,
  type IncidentWorld,
} from './helpers.js';

let w: IncidentWorld;

const HOT = [9_000, 9_200, 9_400, 9_600, 9_800];
const minute = 60_000;

async function outboxFor(incidentId: string) {
  const { rows } = await w.db.admin(
    `SELECT event_type, aggregate_version, payload, correlation_id, causation_id, occurred_at, id, tenant_id
       FROM outbox_events WHERE aggregate_id = $1 ORDER BY aggregate_version, event_type`,
    [incidentId],
  );
  return rows.map((r) => ({
    eventId: r.id,
    eventType: r.event_type,
    occurredAt: new Date(r.occurred_at).toISOString(),
    tenantId: r.tenant_id,
    aggregateType: 'incident',
    aggregateId: incidentId,
    aggregateVersion: r.aggregate_version,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    schemaVersion: 1,
    payload: r.payload,
  }));
}

describe('T-017 threshold incident creation', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t017');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a qualifying LIVE window opens one incident with every pinned reference, deadline basis and initial owner', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, [4_000, ...HOT]);
    const evaluation = await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) });
    expect(evaluation.evaluations).toHaveLength(1);
    const e = evaluation.evaluations[0]!;
    expect(e).toMatchObject({ outcome: 'OPENED', reasonCode: 'QUALIFIED', ruleRevisionId: w.rule.ruleRevisionId });
    const incidentId = e.incidentId!;

    const inc = await getIncident(w.db.pool, w.people.operator!.ctx, incidentId);
    const samples = await listTelemetrySamples(w.db.pool, w.admin, { channelId: device.channels.temp! });
    const hotSamples = samples.filter((x) => run.sampleIds.slice(1).includes(x.sampleId));
    expect(hotSamples).toHaveLength(5);
    const asset = await w.db.admin(`SELECT site_id, current_revision_id FROM assets WHERE id = $1`, [assetId]);
    expect(inc).toMatchObject({
      incidentId,
      tenantId: w.tenant.tenantId,
      siteId: w.siteId,
      assetId,
      assetRevisionId: asset.rows[0].current_revision_id,
      ruleRevisionId: w.rule.ruleRevisionId,
      procedureRevisionId: w.procedure.procedureRevisionId,
      policyRevisionId: w.policyRevisionId,
      triggerKind: 'TELEMETRY_RULE',
      triggerInputOrigin: 'PHYSICAL_SENSOR',
      state: 'TRIAGING',
      pausedFromState: null,
      version: 2,
      urgency: 'CRITICAL',
      faultFamily: 'REFRIGERATION_TEMPERATURE_HIGH',
      faultWindowKey: 'cabinet-temperature',
      deadlineKind: 'CONTAINMENT',
      deadlineBasis: 'TRIGGER_EVENT_AT',
      deadlineTimezoneBasis: 'SITE_LOCAL:Europe/London',
      deadlineStatus: 'RUNNING',
      signalState: 'LIVE',
    });
    expect(inc.dedupeKey).toMatch(/^incident-dedupe\.v1:sha256:[0-9a-f]{64}$/);
    expect(inc.deadlineBasisDigest).toMatch(/^incident-deadline-basis\.v1:sha256:[0-9a-f]{64}$/);
    expect(inc.correlationId).toMatch(/^corr_/);
    // The deadline basis is the breach onset in source event time, plus the pinned procedure's duration.
    expect(inc.deadlineBasisAt).toBe(hotSamples[0]!.eventAt);
    expect(inc.originalResponseDeadlineAt).toBe(isoAt(Date.parse(hotSamples[0]!.eventAt) + 30 * minute));
    expect(inc.currentResponseDeadlineAt).toBe(inc.originalResponseDeadlineAt);
    expect(inc.triggerEventAt).toBe(hotSamples[4]!.eventAt);
    expect(inc.openLatencyMs).toBeGreaterThanOrEqual(0);
    expect(inc.currentAssignment).toMatchObject({
      assigneeUserId: w.people.oncall!.userId,
      assignmentKind: 'INITIAL',
      acceptedAt: null,
      supersededAt: null,
    });

    const timeline = await getIncidentTimeline(w.db.pool, w.people.operator!.ctx, incidentId);
    expect(timeline.transitions.map((t) => [t.fromState, t.toState, t.incidentVersion])).toEqual([
      [null, 'DETECTED', 1],
      ['DETECTED', 'TRIAGING', 2],
    ]);
    expect(timeline.signals).toHaveLength(1);
    const signal = timeline.signals[0]!;
    expect(signal).toMatchObject({
      signalKind: 'TELEMETRY_TRIGGER',
      trust: 'DEVICE_AUTHENTICATED',
      outcome: 'OPENED',
      inputOrigin: 'PHYSICAL_SENSOR',
      ruleRevisionId: w.rule.ruleRevisionId,
      sampleCount: 5,
      peakValueInt: 9_800,
    });
    // The exact samples and the assignment / channel / calibration / asset revisions they were stored under.
    expect(signal.samples.map((x) => x.sampleId)).toEqual(hotSamples.map((x) => x.sampleId));
    for (const [i, x] of signal.samples.entries())
      expect(x).toMatchObject({
        channelId: hotSamples[i]!.channelId,
        channelRevisionId: hotSamples[i]!.channelRevisionId,
        calibrationRevision: hotSamples[i]!.calibrationRevision,
        deviceAssignmentId: hotSamples[i]!.deviceAssignmentId,
        assetRevisionId: hotSamples[i]!.assetRevisionId,
        eventAt: hotSamples[i]!.eventAt,
      });
    expect(timeline.deadlineEvents).toHaveLength(1);
    expect(timeline.deadlineEvents[0]).toMatchObject({
      sequence: 1,
      eventType: 'SET',
      priorDeadlineAt: null,
      newDeadlineAt: inc.originalResponseDeadlineAt,
      newStatus: 'RUNNING',
      procedureRevisionId: w.procedure.procedureRevisionId,
      basisDigest: inc.deadlineBasisDigest,
    });
    expect(timeline.assignments).toHaveLength(1);

    // Outbox: opened (with the critical-notification trigger), assignment, deadline, then the triage transition.
    const events = await outboxFor(incidentId);
    expect(events.map((x) => [x.eventType, x.aggregateVersion])).toEqual([
      ['incident.assignment_changed.v1', 1],
      ['incident.deadline_changed.v1', 1],
      ['incident.opened.v1', 1],
      ['incident.state_changed.v1', 2],
    ]);
    const opened = decodeWire(IncidentOpenedEventSchema, events[2]);
    expect(opened.payload).toMatchObject({
      incidentId,
      assetId,
      procedureRevisionId: w.procedure.procedureRevisionId,
      ruleRevisionId: w.rule.ruleRevisionId,
      originalResponseDeadlineAt: inc.originalResponseDeadlineAt,
      urgency: 'CRITICAL',
      notification: { required: true, reasonCode: 'CRITICAL_INCIDENT_OPENED' },
    });
    expect(opened.correlationId).toBe(inc.correlationId);
    expect(decodeWire(IncidentStateChangedEventSchema, events[3]).payload).toMatchObject({
      from: 'DETECTED',
      to: 'TRIAGING',
    });
    // The deterministic rule decision is in the append-only evidence ledger, bound to the incident.
    const ledger = await readEvidenceLedger(w.db.pool, w.admin);
    expect(ledger.filter((x) => x.incidentId === incidentId)).toEqual([
      expect.objectContaining({
        kind: 'POLICY_DECISION',
        trust: 'AUTHORITATIVE',
        payloadSchema: 'incident.rule_decision.v1',
      }),
    ]);

    // Re-evaluating the same window is idempotent: no second incident, no duplicate signal.
    const again = await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) });
    expect(again.evaluations[0]).toMatchObject({ outcome: 'DUPLICATE', incidentId });
    const count = await w.db.admin(`SELECT count(*)::int AS n FROM incidents WHERE asset_id = $1`, [assetId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('isolated noise, short bursts and readings under the threshold open nothing', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, [4_000, 12_000, 4_000, 4_100, 9_000, 9_100, 4_000]);
    const out = await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) });
    expect(out.evaluations[0]).toMatchObject({ outcome: 'NOT_QUALIFIED', incidentId: null });
    const count = await w.db.admin(`SELECT count(*)::int AS n FROM incidents WHERE asset_id = $1`, [assetId]);
    expect(count.rows[0].n).toBe(0);
  });

  it('LATE and BACKFILL breaches, and a breach whose tail is older than the lateness bound, never open as live', async () => {
    const { assetId, device } = await freshAsset(w);
    const backfill = await liveRun(w, device, HOT, { delivery: 'BACKFILL' });
    expect(
      (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(backfill.at) })).evaluations[0],
    ).toMatchObject({ outcome: 'NOT_QUALIFIED', reasonCode: 'NO_LIVE_SAMPLES' });
    const late = await liveRun(w, device, HOT, { eventOffsetMs: -120_000 });
    const lateRows = await w.db.admin(`SELECT DISTINCT ingestion_class FROM telemetry_samples WHERE id = ANY($1)`, [
      late.sampleIds,
    ]);
    expect(lateRows.rows.map((r) => r.ingestion_class)).toEqual(['LATE']);
    expect(
      (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(late.at) })).evaluations[0],
    ).toMatchObject({ outcome: 'NOT_QUALIFIED', reasonCode: 'NO_LIVE_SAMPLES' });

    const other = await freshAsset(w);
    const live = await liveRun(w, other.device, HOT);
    const stale = await evaluateIncidentRules(w.db.pool, w.service, {
      assetId: other.assetId,
      at: isoAt(live.at + 5 * minute),
    });
    expect(stale.evaluations[0]).toMatchObject({ outcome: 'NOT_QUALIFIED', reasonCode: 'STALE_SIGNAL' });
    const count = await w.db.admin(`SELECT count(*)::int AS n FROM incidents WHERE asset_id = ANY($1)`, [
      [assetId, other.assetId],
    ]);
    expect(count.rows[0].n).toBe(0);
    // The database refuses to link a non-LIVE sample as trigger evidence, whatever the writer.
    const anyIncident = await w.db.admin(
      `SELECT id FROM incident_signals WHERE signal_kind = 'TELEMETRY_TRIGGER' LIMIT 1`,
    );
    await expect(
      w.db.admin(
        `INSERT INTO incident_signal_samples (tenant_id, signal_id, sample_id, ordinal, channel_id, channel_revision_id,
           calibration_revision, device_assignment_id, asset_revision_id, event_at)
         SELECT s.tenant_id, $1, s.id, 99, s.channel_id, s.channel_revision_id, s.calibration_revision,
                s.device_assignment_id, s.asset_revision_id, s.event_at FROM telemetry_samples s WHERE s.id = $2`,
        [anyIncident.rows[0].id, backfill.sampleIds[0]],
      ),
    ).rejects.toMatchObject({ code: 'UB043' });
  });

  it('a later procedure publication changes only later incidents; the original deadline never moves', async () => {
    const first = await freshAsset(w);
    const run1 = await liveRun(w, first.device, HOT);
    const inc1 = (await evaluateIncidentRules(w.db.pool, w.service, { assetId: first.assetId, at: isoAt(run1.at) }))
      .evaluations[0]!.incidentId!;
    const before = await getIncident(w.db.pool, w.admin, inc1);

    const rev2 = await publishOperatingProcedure(w.db.pool, w.admin, {
      ...COLD_CHAIN_PROCEDURE,
      responseDeadlineMs: 4 * 60 * minute,
      maxExtensionMs: 4 * 60 * minute,
      initialAssigneeUserId: w.people.operator2!.userId,
    });
    expect(rev2.revision).toBe(2);
    const after = await getIncident(w.db.pool, w.admin, inc1);
    expect(after).toMatchObject({
      procedureRevisionId: w.procedure.procedureRevisionId,
      originalResponseDeadlineAt: before.originalResponseDeadlineAt,
      currentResponseDeadlineAt: before.currentResponseDeadlineAt,
      deadlineBasisDigest: before.deadlineBasisDigest,
      version: before.version,
    });
    // The pinned procedure still bounds extensions: the new revision's larger allowance does not apply.
    const tooFar = isoAt(Date.parse(before.currentResponseDeadlineAt) + 20 * minute);
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, w.people.approver!.ctx, inc1, {
          eventType: 'EXTEND',
          newDeadlineAt: tooFar,
          reasonCode: 'SUPPLIER_DELAY',
          expectedVersion: after.version,
          idempotencyKey: w.key('extend'),
        }),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'EXTENSION_EXCEEDS_PROCEDURE' });
    // An extension needs the pinned procedure's adjust role; an operator cannot extend at all.
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, w.people.operator!.ctx, inc1, {
          eventType: 'EXTEND',
          newDeadlineAt: isoAt(Date.parse(before.currentResponseDeadlineAt) + minute),
          reasonCode: 'SUPPLIER_DELAY',
          expectedVersion: after.version,
          idempotencyKey: w.key('extend'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });

    const second = await freshAsset(w);
    const run2 = await liveRun(w, second.device, HOT);
    const inc2 = (await evaluateIncidentRules(w.db.pool, w.service, { assetId: second.assetId, at: isoAt(run2.at) }))
      .evaluations[0]!.incidentId!;
    const later = await getIncident(w.db.pool, w.admin, inc2);
    expect(later.procedureRevisionId).toBe(rev2.procedureRevisionId);
    expect(Date.parse(later.originalResponseDeadlineAt) - Date.parse(later.deadlineBasisAt)).toBe(4 * 60 * minute);
    expect(later.currentAssignment?.assigneeUserId).toBe(w.people.operator2!.userId);
    expect(Date.parse(after.originalResponseDeadlineAt) - Date.parse(after.deadlineBasisAt)).toBe(30 * minute);
  });

  it('an optional food-risk estimate is stored separately, labelled non-authoritative, and cannot move the deadline', async () => {
    const { assetId, device } = await freshAsset(w);
    const run = await liveRun(w, device, HOT);
    const incidentId = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) }))
      .evaluations[0]!.incidentId!;
    const before = await getIncident(w.db.pool, w.admin, incidentId);
    const est = await recordRiskEstimate(w.db.pool, w.service, incidentId, {
      estimatorKind: 'MODEL',
      sourceRevision: 'food-risk-model:2026-10',
      asOf: isoAt(run.at),
      safeTimeRemainingMs: 6 * 60 * minute,
      lowerBoundMs: 2 * 60 * minute,
      upperBoundMs: 9 * 60 * minute,
      confidencePpm: 600_000,
      provenanceDigest: `sha256:${'a'.repeat(64)}`,
    });
    const after = await getIncident(w.db.pool, w.admin, incidentId);
    expect(after.originalResponseDeadlineAt).toBe(before.originalResponseDeadlineAt);
    expect(after.currentResponseDeadlineAt).toBe(before.currentResponseDeadlineAt);
    expect(after.version).toBe(before.version);
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, incidentId);
    expect(timeline.deadlineEvents.map((d) => d.eventType)).toEqual(['SET']);
    expect(timeline.riskEstimates).toEqual([
      expect.objectContaining({
        riskEstimateId: est.riskEstimateId,
        authority: 'NON_AUTHORITATIVE',
        estimatorKind: 'MODEL',
        sourceRevision: 'food-risk-model:2026-10',
        safeTimeRemainingMs: 6 * 60 * minute,
        lowerBoundMs: 2 * 60 * minute,
        upperBoundMs: 9 * 60 * minute,
        confidencePpm: 600_000,
      }),
    ]);
    await expect(
      w.db.admin(`UPDATE incident_risk_estimates SET authority = 'AUTHORITATIVE' WHERE id = $1`, [est.riskEstimateId]),
    ).rejects.toMatchObject({ code: 'UB001' });
    await expect(
      w.db.admin(
        `INSERT INTO incident_risk_estimates (tenant_id, id, incident_id, estimate_kind, estimator_kind, source_revision, as_of,
           safe_time_remaining_ms, lower_bound_ms, upper_bound_ms, confidence_ppm, provenance_digest, authority,
           recorded_by_kind, recorded_by_id)
         VALUES ($1, 'ire_forged-0001', $2, 'FOOD_SAFE_TIME', 'MODEL', 'x', now(), 1, 0, 2, 1, $3, 'AUTHORITATIVE', 'WORKER', 'w')`,
        [w.tenant.tenantId, incidentId, `sha256:${'b'.repeat(64)}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The pinned original deadline is immutable in the database too.
    await expect(
      w.db.admin(
        `UPDATE incidents SET original_response_deadline_at = original_response_deadline_at + interval '1 hour',
           version = version + 1 WHERE id = $1`,
        [incidentId],
      ),
    ).rejects.toMatchObject({ code: 'UB042' });
  });

  it('simulated input opens a clearly labelled incident; a retired asset scope or foreign asset is refused', async () => {
    const asset = await registerAsset(w.db.pool, w.admin, {
      siteId: w.siteId,
      identity: { manufacturer: 'True', model: 'T-23', serial: 'sim-1', safetyClass: 'STANDARD', bomRevision: 'B' },
      source: 'API',
    });
    const sim = await provisionDevice(w, { siteId: w.siteId, assetId: asset.assetId, inputClass: 'SIMULATOR' });
    const run = await liveRun(w, sim, HOT);
    const e = (await evaluateIncidentRules(w.db.pool, w.service, { assetId: asset.assetId, at: isoAt(run.at) }))
      .evaluations[0]!;
    expect(e.outcome).toBe('OPENED');
    expect((await getIncident(w.db.pool, w.admin, e.incidentId!)).triggerInputOrigin).toBe('SIMULATED_INPUT');
    expect(
      await rejection(evaluateIncidentRules(w.db.pool, w.service, { assetId: 'ast_not-a-real-asset-0001' as AssetId })),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
  });
});
