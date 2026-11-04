// T-020 — Manual report audit linkage (FR-03, FR-04). An authorized operator's report records actor, reason and
// attachments, opens (or joins) the asset's incident, links later device signals, and never impersonates
// authenticated device evidence: it carries no samples, is operator-attested, and the database refuses otherwise.
import { newId, type AssetId } from '@uptimebuyer/contracts';
import { listAuditEntries, readEvidenceLedger, registerEvidenceBlob } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateIncidentRules, getIncident, getIncidentTimeline, submitManualReport } from '../src/index.js';
import { seedTenant, sha } from '../../../packages/data/test/helpers.js';
import {
  HIGH_TEMP_RULE,
  createIncidentWorld,
  freshAsset,
  isoAt,
  liveRun,
  rejection,
  type IncidentWorld,
} from './helpers.js';

let w: IncidentWorld;

async function blob(label: string) {
  return (
    await registerEvidenceBlob(w.db.pool, w.people.operator!.ctx, {
      sha256: sha(`t020-${label}`),
      mediaType: 'image/jpeg',
      sizeBytes: 2048,
      trustLevel: 'OPERATOR_ATTESTED',
    })
  ).blobId;
}

describe('T-020 manual report audit linkage', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t020');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('records actor, reason and attachments, opens the incident and links later device signals', async () => {
    const { assetId, device } = await freshAsset(w);
    const photo = await blob('photo-1');
    const doc = await blob('doc-1');
    const observedAt = isoAt(Date.now() - 60_000);
    const report = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
      idempotencyKey: w.key('report'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'CABINET_WARM_TO_TOUCH',
      note: 'Door gasket torn; product feels warm.',
      observedAt,
      attachments: [
        { blobId: photo, role: 'PHOTO' },
        { blobId: doc, role: 'DOCUMENT' },
      ],
    });
    expect(report.outcome).toBe('OPENED');
    const inc = await getIncident(w.db.pool, w.people.operator!.ctx, report.incidentId);
    expect(inc).toMatchObject({
      triggerKind: 'MANUAL_REPORT',
      triggerInputOrigin: 'OPERATOR_REPORT',
      state: 'TRIAGING',
      assetId,
      deadlineBasisAt: observedAt,
    });

    let timeline = await getIncidentTimeline(w.db.pool, w.people.operator!.ctx, report.incidentId);
    expect(timeline.manualReports).toEqual([
      expect.objectContaining({
        manualReportId: report.manualReportId,
        reportKind: 'FAULT_REPORT',
        reportedByUserId: w.people.operator!.userId,
        reasonCode: 'CABINET_WARM_TO_TOUCH',
        note: 'Door gasket torn; product feels warm.',
        observedAt,
        attachments: [
          { ordinal: 1, blobId: photo, role: 'PHOTO' },
          { ordinal: 2, blobId: doc, role: 'DOCUMENT' },
        ],
      }),
    ]);
    expect(timeline.manualReports[0]!.reportDigest).toMatch(/^incident-manual-report\.v1:sha256:/);
    expect(timeline.signals).toEqual([
      expect.objectContaining({
        signalKind: 'MANUAL_REPORT',
        trust: 'OPERATOR_ATTESTED',
        inputOrigin: 'OPERATOR_REPORT',
        manualReportId: report.manualReportId,
        sampleCount: 0,
        samples: [],
        actor: { kind: 'HUMAN', id: w.people.operator!.userId },
      }),
    ]);
    // Audit and ledger carry the human actor, and the ledger entry is operator-attested material input.
    const audit = await listAuditEntries(w.db.pool, w.admin, { action: 'incident.manual_report' });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: 'SUCCEEDED',
          actor: { kind: 'HUMAN', id: w.people.operator!.userId },
          resourceId: report.incidentId,
          reasonCode: 'CABINET_WARM_TO_TOUCH',
        }),
      ]),
    );
    const ledger = await readEvidenceLedger(w.db.pool, w.admin);
    expect(ledger.filter((e) => e.incidentId === report.incidentId)).toEqual([
      expect.objectContaining({
        kind: 'MATERIAL_INPUT',
        trust: 'OPERATOR_ATTESTED',
        payloadSchema: 'incident.manual_report.v1',
        payloadDigest: `sha256:${timeline.manualReports[0]!.reportDigest.split(':sha256:')[1]}`,
      }),
    ]);

    // A later qualifying device window links to the same incident as authenticated device evidence.
    const run = await liveRun(w, device, [9_000, 9_200, 9_400, 9_600, 9_800]);
    const e = (await evaluateIncidentRules(w.db.pool, w.service, { assetId, at: isoAt(run.at) })).evaluations[0]!;
    expect(e).toMatchObject({ outcome: 'ATTACHED', incidentId: report.incidentId });
    timeline = await getIncidentTimeline(w.db.pool, w.admin, report.incidentId);
    expect(timeline.signals.map((s) => [s.signalKind, s.trust, s.outcome])).toEqual([
      ['MANUAL_REPORT', 'OPERATOR_ATTESTED', 'OPENED'],
      ['TELEMETRY_TRIGGER', 'DEVICE_AUTHENTICATED', 'ATTACHED'],
    ]);
    expect(timeline.signals[1]!.samples.map((s) => s.sampleId)).toEqual(run.sampleIds);
    // The incident's trigger provenance is unchanged: a report never becomes device evidence after the fact.
    expect((await getIncident(w.db.pool, w.admin, report.incidentId)).triggerKind).toBe('MANUAL_REPORT');

    // The database refuses a report signal that claims device trust or carries samples.
    const reportSignal = timeline.signals[0]!;
    await expect(
      w.db.admin(
        `INSERT INTO incident_signal_samples (tenant_id, signal_id, sample_id, ordinal, channel_id, channel_revision_id,
           calibration_revision, device_assignment_id, asset_revision_id, event_at)
         SELECT s.tenant_id, $1, s.id, 1, s.channel_id, s.channel_revision_id, s.calibration_revision,
                s.device_assignment_id, s.asset_revision_id, s.event_at FROM telemetry_samples s WHERE s.id = $2`,
        [reportSignal.signalId, run.sampleIds[0]],
      ),
    ).rejects.toMatchObject({ code: 'UB043' });
    await expect(
      w.db.admin(
        `INSERT INTO incident_signals (tenant_id, id, incident_id, signal_kind, trust, outcome, input_origin,
           manual_report_id, reason_code, signal_digest, actor_kind, actor_id)
         VALUES ($1, 'isg_forged-0001', $2, 'MANUAL_REPORT', 'DEVICE_AUTHENTICATED', 'ATTACHED', 'PHYSICAL_SENSOR',
           $3, 'FORGED', $4, 'HUMAN', $5)`,
        [
          w.tenant.tenantId,
          report.incidentId,
          report.manualReportId,
          `incident-signal.v1:${sha('forged')}`,
          w.people.operator!.userId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      w.db.admin(
        `INSERT INTO incident_signals (tenant_id, id, incident_id, signal_kind, trust, outcome, input_origin,
           rule_revision_id, window_start_at, window_end_at, sample_count, window_sample_total, reason_code,
           signal_digest, actor_kind, actor_id)
         VALUES ($1, 'isg_forged-0002', $2, 'TELEMETRY_TRIGGER', 'DEVICE_AUTHENTICATED', 'ATTACHED', 'PHYSICAL_SENSOR',
           $3, now(), now(), 1, 1, 'FORGED', $4, 'HUMAN', $5)`,
        [
          w.tenant.tenantId,
          report.incidentId,
          w.rule.ruleRevisionId,
          `incident-signal.v1:${sha('forged-2')}`,
          w.people.operator!.userId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      w.db.admin(`UPDATE incident_manual_reports SET reason_code = 'EDITED' WHERE id = $1`, [report.manualReportId]),
    ).rejects.toMatchObject({ code: 'UB001' });
  });

  it('a second report joins the open incident and keeps its own actor and reason', async () => {
    const { assetId } = await freshAsset(w);
    const first = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
      idempotencyKey: w.key('r1'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'ALARM_PANEL_RED',
    });
    const second = await submitManualReport(w.db.pool, w.people.approver!.ctx, {
      idempotencyKey: w.key('r2'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'PRODUCT_TEMPERATURE_PROBE_HIGH',
    });
    expect(second).toMatchObject({ outcome: 'ATTACHED', incidentId: first.incidentId });
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, first.incidentId);
    expect(timeline.manualReports.map((r) => [r.reportedByUserId, r.reasonCode])).toEqual([
      [w.people.operator!.userId, 'ALARM_PANEL_RED'],
      [w.people.approver!.userId, 'PRODUCT_TEMPERATURE_PROBE_HIGH'],
    ]);
  });

  it('only authorized humans may report, within bounds, about their own tenant and site, without device fields', async () => {
    const { assetId } = await freshAsset(w);
    const base = { assetId, ruleKey: HIGH_TEMP_RULE.ruleKey, reasonCode: 'CABINET_WARM_TO_TOUCH' };
    expect(
      await rejection(submitManualReport(w.db.pool, w.people.viewer!.ctx, { ...base, idempotencyKey: w.key('v') })),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ROLE_NOT_GRANTED' });
    expect(
      await rejection(submitManualReport(w.db.pool, w.service, { ...base, idempotencyKey: w.key('s') })),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED' });
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          idempotencyKey: w.key('n'),
          note: 'x'.repeat(2001),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          idempotencyKey: w.key('f'),
          observedAt: isoAt(Date.now() + 10 * 60_000),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', reasonCode: 'OBSERVED_AT_OUT_OF_BOUNDS' });
    const many = await Promise.all(Array.from({ length: 21 }, (_, i) => blob(`many-${i}`)));
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          idempotencyKey: w.key('m'),
          attachments: many.map((blobId) => ({ blobId, role: 'PHOTO' as const })),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    // Device-evidence fields are not part of the report contract at all.
    for (const extra of [
      { sampleIds: ['tsm_x-0001'] },
      { trust: 'DEVICE_AUTHENTICATED' },
      { tenantId: 'ten_other-0001' },
    ])
      expect(
        await rejection(
          submitManualReport(w.db.pool, w.people.operator!.ctx, {
            ...base,
            idempotencyKey: w.key('x'),
            ...extra,
          } as never),
        ),
      ).toMatchObject({ code: 'VALIDATION_FAILED' });
    // A rule that does not exist, another tenant's asset, and another tenant's attachment are unavailable.
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          ruleKey: 'no-such-rule',
          idempotencyKey: w.key('r'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    const other = await seedTenant(w.db.pool, w.idp, 't020-other');
    const foreignBlob = await registerEvidenceBlob(w.db.pool, other.admin, {
      sha256: sha('t020-foreign'),
      mediaType: 'image/jpeg',
      sizeBytes: 1,
      trustLevel: 'OPERATOR_ATTESTED',
    });
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          idempotencyKey: w.key('fb'),
          attachments: [{ blobId: foreignBlob.blobId, role: 'PHOTO' }],
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          ...base,
          assetId: newId('asset') as AssetId,
          idempotencyKey: w.key('fa'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    const count = await w.db.admin(`SELECT count(*)::int AS n FROM incidents WHERE asset_id = $1`, [assetId]);
    expect(count.rows[0].n).toBe(0);
  });
});
