// T-011 — Role and authority denial, re-run by M04 on the incident commands (FR-24, NFR-05, TEST-PLAN coverage rule).
// Reads need a human role at the incident's site (or the engine worker); commands need an operating role there;
// deadline extension and pause need the role the pinned procedure names; ownership-bound commands need the accepted
// current owner; rule evaluation and system transitions are worker-only; devices and integrations get nothing.
// Out-of-site incidents look like nonexistent ones. Configuration publishing is tenant-admin only.
import { createSite, registerAsset } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeIncident,
  adjustIncidentDeadline,
  advanceIncident,
  escalateIncident,
  evaluateIncidentRules,
  expireIncidentDeadlines,
  getIncident,
  listIncidents,
  publishIncidentRule,
  publishOperatingProcedure,
  recordRiskEstimate,
  submitManualReport,
  type IncidentView,
} from '../src/index.js';
import {
  COLD_CHAIN_PROCEDURE,
  HIGH_TEMP_RULE,
  createIncidentWorld,
  freshAsset,
  isoAt,
  person,
  rejection,
  type IncidentWorld,
  type Person,
} from './helpers.js';

let w: IncidentWorld;
let inc: IncidentView;
let otherSiteOperator: Person;
let otherSiteIncident: string;

describe('T-011 incident role and authority denial', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t011m04');
    const { assetId } = await freshAsset(w);
    const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
      idempotencyKey: w.key('open'),
      assetId,
      ruleKey: HIGH_TEMP_RULE.ruleKey,
      reasonCode: 'ALARM_PANEL_RED',
    });
    inc = await getIncident(w.db.pool, w.admin, r.incidentId);
    const s2 = await createSite(w.db.pool, w.admin, { name: 'second', timezone: 'UTC', source: 'API' });
    otherSiteOperator = await person(w, 'op-s2', ['operator'], s2.siteId);
    const a2 = await registerAsset(w.db.pool, w.admin, {
      siteId: s2.siteId,
      identity: { manufacturer: 'True', model: 'T-23', serial: 's2-1', safetyClass: 'STANDARD', bomRevision: 'B' },
      source: 'API',
    });
    otherSiteIncident = (
      await submitManualReport(w.db.pool, otherSiteOperator.ctx, {
        idempotencyKey: w.key('open-s2'),
        assetId: a2.assetId,
        ruleKey: HIGH_TEMP_RULE.ruleKey,
        reasonCode: 'ALARM_PANEL_RED',
      })
    ).incidentId;
  });
  afterAll(async () => {
    await w?.close();
  });

  it('reads: human roles at the site and the engine worker; other-site users see nothing', async () => {
    for (const p of ['operator', 'viewer', 'auditor', 'approver', 'oncall'])
      expect((await getIncident(w.db.pool, w.people[p]!.ctx, inc.incidentId)).incidentId, p).toBe(inc.incidentId);
    expect((await getIncident(w.db.pool, w.service, inc.incidentId)).incidentId).toBe(inc.incidentId);
    expect(await rejection(getIncident(w.db.pool, otherSiteOperator.ctx, inc.incidentId))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
    const visible = (await listIncidents(w.db.pool, w.people.operator!.ctx, {})).map((i) => i.incidentId);
    expect(visible).toContain(inc.incidentId);
    expect(visible).not.toContain(otherSiteIncident);
    const s2Visible = (await listIncidents(w.db.pool, otherSiteOperator.ctx, {})).map((i) => i.incidentId);
    expect(s2Visible).toEqual([otherSiteIncident]);
  });

  it('commands: viewers, auditors and services cannot act as operators; other-site operators cannot reach it', async () => {
    const tryAck = (ctx: Parameters<typeof acknowledgeIncident>[1]) =>
      rejection(
        acknowledgeIncident(w.db.pool, ctx, inc.incidentId, {
          expectedVersion: inc.version,
          idempotencyKey: w.key('ack'),
        }),
      );
    expect(await tryAck(w.people.viewer!.ctx)).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ROLE_NOT_GRANTED' });
    expect(await tryAck(w.people.auditor!.ctx)).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ROLE_NOT_GRANTED' });
    expect(await tryAck(w.service)).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED' });
    expect(await tryAck(otherSiteOperator.ctx)).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
    expect(
      await rejection(
        escalateIncident(w.db.pool, w.people.viewer!.ctx, inc.incidentId, {
          reasonCode: 'X',
          expectedVersion: inc.version,
          idempotencyKey: w.key('esc'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('engine-only paths: humans cannot evaluate rules, advance the main path, mark recovery or sweep deadlines', async () => {
    const op = w.people.operator!.ctx;
    expect(await rejection(evaluateIncidentRules(w.db.pool, op, { assetId: inc.assetId }))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
    });
    for (const to of ['PLANNING', 'ESCALATED'] as const)
      expect(
        await rejection(
          advanceIncident(w.db.pool, w.admin, inc.incidentId, {
            to,
            reasonCode: 'X',
            guardRef: 'rev_fixture-passed-0001',
            expectedVersion: inc.version,
            idempotencyKey: w.key('adv'),
          }),
        ),
      ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED' });
    expect(await rejection(expireIncidentDeadlines(w.db.pool, op, {}))).toMatchObject({ code: 'FORBIDDEN' });
    // The public engine path can never mark recovery, whatever reference it names (INV-01, INV-14).
    for (const guardRef of ['evr_not-a-recovery-0001', 'rev_fixture-passed-0001'])
      expect(
        await rejection(
          advanceIncident(w.db.pool, w.service, inc.incidentId, {
            to: 'RECOVERED',
            reasonCode: 'X',
            guardRef,
            expectedVersion: inc.version,
            idempotencyKey: w.key('adv-rec'),
          }),
        ),
      ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'RECOVERY_EVALUATOR_REQUIRED' });
    // Manual-only edges are not reachable through the engine path.
    expect(
      await rejection(
        advanceIncident(w.db.pool, w.service, inc.incidentId, {
          to: 'PAUSED' as never,
          reasonCode: 'X',
          guardRef: 'evr_fixture-guard-0001',
          expectedVersion: inc.version,
          idempotencyKey: w.key('adv-pause'),
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deadline authority comes from the pinned procedure; risk estimates need an operating role or the engine', async () => {
    const cur = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
          eventType: 'EXTEND',
          newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) + 60_000),
          reasonCode: 'X',
          expectedVersion: cur.version,
          idempotencyKey: w.key('ext'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PROCEDURE_ROLE_REQUIRED' });
    expect(
      await rejection(
        adjustIncidentDeadline(w.db.pool, w.people.viewer!.ctx, inc.incidentId, {
          eventType: 'SHORTEN',
          newDeadlineAt: isoAt(Date.parse(cur.currentResponseDeadlineAt) - 60_000),
          reasonCode: 'X',
          expectedVersion: cur.version,
          idempotencyKey: w.key('sh'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ROLE_NOT_GRANTED' });
    expect(
      await rejection(
        recordRiskEstimate(w.db.pool, w.people.viewer!.ctx, inc.incidentId, {
          estimatorKind: 'OPERATOR',
          sourceRevision: 'manual',
          asOf: new Date().toISOString(),
          safeTimeRemainingMs: 1,
          lowerBoundMs: 0,
          upperBoundMs: 2,
          confidencePpm: 1,
          provenanceDigest: `sha256:${'d'.repeat(64)}`,
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only tenant administrators publish rules and procedures, and rules must name an effective procedure', async () => {
    expect(await rejection(publishIncidentRule(w.db.pool, w.people.operator!.ctx, HIGH_TEMP_RULE))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await rejection(
        publishOperatingProcedure(w.db.pool, w.people.approver!.ctx, {
          ...COLD_CHAIN_PROCEDURE,
          initialAssigneeUserId: w.people.oncall!.userId,
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await rejection(
        publishIncidentRule(w.db.pool, w.admin, { ...HIGH_TEMP_RULE, ruleKey: 'orphan', procedureKey: 'missing' }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', reasonCode: 'PROCEDURE_NOT_EFFECTIVE' });
    expect(
      await rejection(
        publishOperatingProcedure(w.db.pool, w.admin, {
          ...COLD_CHAIN_PROCEDURE,
          procedureKey: 'viewer-owned',
          initialAssigneeUserId: w.people.viewer!.userId,
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'ASSIGNEE_NOT_ELIGIBLE' });
  });
});
