// T-017 (consumer and stale-data paths) — the incident engine consumes the durable telemetry outbox exactly once
// logically: telemetry.accepted.v1 re-evaluates rules by event time and opens one incident; a replayed event is a
// DUPLICATE. telemetry.stale.v1 never closes or recovers anything: under an ESCALATE_ACTIVE rule it appends a
// system-derived STALE_SIGNAL, marks the signal UNCERTAIN and escalates the live incident; re-entry by the accepted
// owner clears the marker. (Added during implementation as coverage for the consumer and stale paths.)
import { DomainEventEnvelopeSchema, decodeWire, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import { sweepTelemetryFreshness } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptAssignment,
  getIncident,
  getIncidentTimeline,
  handleTelemetryEvent,
  returnFromEscalation,
} from '../src/index.js';
import { createIncidentWorld, freshAsset, isoAt, liveRun, type IncidentWorld } from './helpers.js';

let w: IncidentWorld;

async function deviceEvents(deviceId: string, eventType: string): Promise<DomainEventEnvelope[]> {
  const { rows } = await w.db.admin(
    `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2 ORDER BY aggregate_version`,
    [deviceId, eventType],
  );
  return rows.map((r) =>
    decodeWire(DomainEventEnvelopeSchema, {
      eventId: r.id,
      eventType: r.event_type,
      occurredAt: new Date(r.occurred_at).toISOString(),
      tenantId: r.tenant_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      aggregateVersion: r.aggregate_version,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      schemaVersion: 1,
      payload: r.payload,
    }),
  );
}

describe('T-017 telemetry outbox consumer and stale-data behaviour', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t017c');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('accepted-telemetry events open one incident once; stale events escalate it without proving anything', async () => {
    const { assetId, device } = await freshAsset(w);
    await liveRun(w, device, [9_000, 9_200, 9_400, 9_600, 9_800]);
    const accepted = await deviceEvents(device.deviceId, 'telemetry.accepted.v1');
    expect(accepted).toHaveLength(5);
    for (const e of accepted) expect(await handleTelemetryEvent(w.db.pool, e)).toBe('PROCESSED');
    for (const e of accepted) expect(await handleTelemetryEvent(w.db.pool, e)).toBe('DUPLICATE');
    const incidents = await w.db.admin(`SELECT id FROM incidents WHERE asset_id = $1`, [assetId]);
    expect(incidents.rows).toHaveLength(1);
    const incidentId = incidents.rows[0].id as string;
    let inc = await getIncident(w.db.pool, w.admin, incidentId);
    expect(inc).toMatchObject({ state: 'TRIAGING', triggerKind: 'TELEMETRY_RULE', signalState: 'LIVE' });

    // Stop the device: the M03 sweeper emits telemetry.stale.v1, which the engine applies.
    await sweepTelemetryFreshness(w.db.pool, { now: isoAt(w.clock.now() + 10 * 60_000) });
    const stale = await deviceEvents(device.deviceId, 'telemetry.stale.v1');
    expect(stale.length).toBeGreaterThan(0);
    for (const e of stale) expect(await handleTelemetryEvent(w.db.pool, e)).toBe('PROCESSED');
    inc = await getIncident(w.db.pool, w.admin, incidentId);
    expect(inc).toMatchObject({ state: 'ESCALATED', signalState: 'UNCERTAIN' });
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, incidentId);
    expect(timeline.signals.filter((s) => s.signalKind === 'STALE_SIGNAL')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trust: 'SYSTEM_DERIVED', sampleCount: 0, inputOrigin: 'SYSTEM' }),
      ]),
    );
    expect(timeline.transitions.at(-1)).toMatchObject({
      fromState: 'TRIAGING',
      toState: 'ESCALATED',
      reasonCode: 'SIGNAL_UNCERTAIN',
    });

    // The accepted owner re-enters and clears the marker; nothing ever reached RECOVERED.
    await acceptAssignment(w.db.pool, w.people.oncall!.ctx, incidentId, inc.currentAssignment!.assignmentId, {
      expectedVersion: inc.version,
      idempotencyKey: w.key('accept'),
    });
    inc = await getIncident(w.db.pool, w.admin, incidentId);
    await returnFromEscalation(w.db.pool, w.people.oncall!.ctx, incidentId, {
      to: 'TRIAGING',
      reasonCode: 'SIGNAL_CHECKED',
      expectedVersion: inc.version,
      idempotencyKey: w.key('reenter'),
    });
    inc = await getIncident(w.db.pool, w.admin, incidentId);
    expect(inc).toMatchObject({ state: 'TRIAGING', signalState: 'LIVE', recoveredAt: null });
    expect(timeline.transitions.some((t) => t.toState === 'RECOVERED')).toBe(false);
    // Events not owned by the engine are ignored, not consumed.
    const assignmentEvents = await w.db.admin(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'incident.opened.v1'`,
      [incidentId],
    );
    expect(
      await handleTelemetryEvent(w.db.pool, {
        ...stale[0]!,
        eventType: 'incident.opened.v1',
        aggregateType: 'incident',
        eventId: assignmentEvents.rows[0].id,
      } as DomainEventEnvelope),
    ).toBe('IGNORED');
  });
});
