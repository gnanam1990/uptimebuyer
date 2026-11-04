// T-010 — Cross-tenant access denial, re-run by M04 against the incident surfaces (INV-16, TEST-PLAN coverage rule).
// Every incident table is tenant-keyed with tenant-leading foreign keys; tenant A cannot read, infer, command or link
// tenant B incidents, rules, procedures, assets, users or blobs: foreign ids behave exactly like nonexistent ids, the
// denial is audited in A with only a digest, and B is unchanged. Engine and consumer paths keep each row's tenant.
import { newId, type IncidentId } from '@uptimebuyer/contracts';
import { createSite, listAuditEntries, registerAsset } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeIncident,
  adjustIncidentDeadline,
  assignIncident,
  escalateIncident,
  evaluateIncidentRules,
  getIncident,
  getIncidentTimeline,
  listIncidents,
  publishIncidentRule,
  publishOperatingProcedure,
  recordRiskEstimate,
  reopenIncident,
  submitManualReport,
} from '../src/index.js';
import { seedTenant, type SeededTenant } from '../../../packages/data/test/helpers.js';
import {
  COLD_CHAIN_PROCEDURE,
  HIGH_TEMP_RULE,
  createIncidentWorld,
  person,
  rejection,
  workerService,
  type IncidentWorld,
  type Person,
} from './helpers.js';

let w: IncidentWorld;
let b: SeededTenant;
let bOperator: Person;
let bIncident: IncidentId;
let bAsset: string;

const INCIDENT_TABLES = [
  'incident_rule_revisions',
  'operating_procedure_revisions',
  'incidents',
  'incident_transitions',
  'incident_assignments',
  'incident_deadline_events',
  'incident_manual_reports',
  'incident_manual_report_attachments',
  'incident_signals',
  'incident_signal_samples',
  'incident_acknowledgements',
  'incident_risk_estimates',
  'incident_command_receipts',
];

async function tenantDigest(tenantId: string): Promise<string> {
  const parts: string[] = [];
  for (const t of INCIDENT_TABLES) {
    const r = await w.db.admin(
      `SELECT coalesce(md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)), '') AS d FROM ${t} x WHERE tenant_id = $1`,
      [tenantId],
    );
    parts.push(`${t}=${r.rows[0].d}`);
  }
  return parts.join(';');
}

describe('T-010 incident cross-tenant access denial', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t010m04');
    b = await seedTenant(w.db.pool, w.idp, 't010m04-beta');
    const site = await createSite(w.db.pool, b.admin, { name: 'beta', timezone: 'UTC', source: 'API' });
    const asset = await registerAsset(w.db.pool, b.admin, {
      siteId: site.siteId,
      identity: { manufacturer: 'True', model: 'T-23', serial: 'beta-1', safetyClass: 'STANDARD', bomRevision: 'B' },
      source: 'API',
    });
    bAsset = asset.assetId;
    bOperator = await person(w, 'beta-op', ['operator'], site.siteId, b.admin);
    await publishOperatingProcedure(w.db.pool, b.admin, {
      ...COLD_CHAIN_PROCEDURE,
      initialAssigneeUserId: bOperator.userId,
    });
    await publishIncidentRule(w.db.pool, b.admin, HIGH_TEMP_RULE);
    bIncident = (
      await submitManualReport(w.db.pool, bOperator.ctx, {
        idempotencyKey: 'beta-report-0001',
        assetId: asset.assetId,
        ruleKey: HIGH_TEMP_RULE.ruleKey,
        reasonCode: 'ALARM_PANEL_RED',
      })
    ).incidentId;
  });
  afterAll(async () => {
    await w?.close();
  });

  it('every incident table is keyed by (tenant_id, id) or a tenant-leading key, with tenant-leading foreign keys', async () => {
    for (const table of INCIDENT_TABLES) {
      const pk = await w.db.admin(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [table],
      );
      expect(pk.rows[0].cols[0], table).toBe('tenant_id');
      const fks = await w.db.admin(
        `SELECT conname, (SELECT attname::text FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'`,
        [table],
      );
      for (const fk of fks.rows) expect(fk.first, `${table}.${fk.conname}`).toBe('tenant_id');
    }
    const m02 = await w.db.admin(
      `SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'incidents'::regclass
         AND conrelid::regclass::text IN ('evidence_revisions', 'evidence_ledger_entries', 'approvals', 'legal_holds', 'privacy_requests')`,
    );
    expect(m02.rows.map((r) => r.t).sort()).toEqual([
      'approvals',
      'evidence_ledger_entries',
      'evidence_revisions',
      'legal_holds',
      'privacy_requests',
    ]);
  });

  it("tenant A cannot read or command tenant B's incident; it looks exactly like a nonexistent id", async () => {
    const before = await tenantDigest(b.tenantId);
    const op = w.people.operator!.ctx;
    const ghost = newId('incident');
    const attempts = (id: string) => [
      () => getIncident(w.db.pool, op, id),
      () => getIncidentTimeline(w.db.pool, op, id),
      () => acknowledgeIncident(w.db.pool, op, id, { expectedVersion: 2, idempotencyKey: w.key('ack') }),
      () => escalateIncident(w.db.pool, op, id, { reasonCode: 'X', expectedVersion: 2, idempotencyKey: w.key('esc') }),
      () =>
        assignIncident(w.db.pool, op, id, {
          assigneeUserId: w.people.operator2!.userId,
          reasonCode: 'X',
          expectedVersion: 2,
          idempotencyKey: w.key('as'),
        }),
      () =>
        adjustIncidentDeadline(w.db.pool, op, id, {
          eventType: 'SHORTEN',
          newDeadlineAt: new Date(Date.now()).toISOString(),
          reasonCode: 'X',
          expectedVersion: 2,
          idempotencyKey: w.key('dl'),
        }),
      () => reopenIncident(w.db.pool, op, id, { reasonCode: 'X', expectedVersion: 2, idempotencyKey: w.key('re') }),
      () =>
        recordRiskEstimate(w.db.pool, w.service, id, {
          estimatorKind: 'RULE',
          sourceRevision: 'r1',
          asOf: new Date().toISOString(),
          safeTimeRemainingMs: 1,
          lowerBoundMs: 0,
          upperBoundMs: 2,
          confidencePpm: 1,
          provenanceDigest: `sha256:${'c'.repeat(64)}`,
        }),
    ];
    const foreign = await Promise.all(attempts(bIncident).map((f) => rejection(f())));
    const missing = await Promise.all(attempts(ghost).map((f) => rejection(f())));
    expect(foreign).toEqual(missing);
    for (const r of foreign) expect(r).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    expect(await tenantDigest(b.tenantId)).toBe(before);
    const audit = await listAuditEntries(w.db.pool, w.admin, { result: 'DENIED' });
    expect(audit.some((a) => a.action.startsWith('incident.'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(bIncident);
    expect((await listIncidents(w.db.pool, op, {})).map((i) => i.incidentId)).not.toContain(bIncident);
  });

  it("A cannot report on, evaluate, or assign across into B's assets and users; engine contexts stay in their tenant", async () => {
    const before = await tenantDigest(b.tenantId);
    expect(
      await rejection(
        submitManualReport(w.db.pool, w.people.operator!.ctx, {
          idempotencyKey: w.key('x'),
          assetId: bAsset as never,
          ruleKey: HIGH_TEMP_RULE.ruleKey,
          reasonCode: 'X',
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    expect(await rejection(evaluateIncidentRules(w.db.pool, w.service, { assetId: bAsset as never }))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
    // Assigning A's incident to a B-only user fails like an unknown user.
    const aIncident = (
      await submitManualReport(w.db.pool, w.people.operator!.ctx, {
        idempotencyKey: w.key('a-report'),
        assetId: w.assetId,
        ruleKey: HIGH_TEMP_RULE.ruleKey,
        reasonCode: 'ALARM_PANEL_RED',
      })
    ).incidentId;
    const aView = await getIncident(w.db.pool, w.admin, aIncident);
    expect(
      await rejection(
        assignIncident(w.db.pool, w.people.operator!.ctx, aIncident, {
          assigneeUserId: bOperator.userId,
          reasonCode: 'X',
          expectedVersion: aView.version,
          idempotencyKey: w.key('as-b'),
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    const bService = await workerService(w, b.admin);
    expect(await rejection(getIncident(w.db.pool, bService, aIncident))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
    expect((await getIncident(w.db.pool, bService, bIncident)).tenantId).toBe(b.tenantId);
    expect((await listIncidents(w.db.pool, bService, {})).map((i) => i.incidentId)).toEqual([bIncident]);
    expect(await tenantDigest(b.tenantId)).toBe(before);
  });
});
