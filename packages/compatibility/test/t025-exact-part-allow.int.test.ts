// T-025 — Exact manufacturer part allow (FR-06, INV-03, INV-04), persisted. The exact OEM evaporator fan motor
// (5A1-0402, from the revision-bound manual, BOM and data sheet) from an approved vendor, with a cited UL 471 listing,
// in-warranty OEM part and a fresh offer, is evaluated by the server engine to ALLOW with machine-readable reasons.
// The decision row is immutable, bound to the exact tenant/incident/asset/evidence/policy revisions and the
// server-computed action digest, carries the exact input digest, is reproducible, is emitted and ledgered, and the
// same tuple evaluated again (or concurrently) returns the same single row.
import { computeActionDigest } from '@uptimebuyer/domain';
import { getIncident } from '@uptimebuyer/incidents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompatibilityEvaluatedEventSchema,
  checkDecisionExecutable,
  evaluateCandidate,
  getCandidateAction,
  getDecision,
  reproduceDecision,
} from '../src/index.js';
import { decodeWire } from '@uptimebuyer/contracts';
import {
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  outboxEvents,
  rejection,
  type CompatWorld,
} from './helpers.js';

let w: CompatWorld;
let inc: Awaited<ReturnType<typeof incidentWithEvidence>>;

describe('T-025 exact manufacturer part allow (persisted)', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t025');
    inc = await incidentWithEvidence(w);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('registers a candidate whose action digest the server computes from the current revision tuple', async () => {
    const cand = await exactCandidate(w, inc);
    const incident = await getIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId);
    expect(cand.evidenceRevisionId).toBe(inc.evidenceRevisionId);
    expect(cand.assetRevisionId).toBe(incident.assetRevisionId);
    expect(cand.policyRevisionId).toBe(w.policyRevisionId);
    const view = await getCandidateAction(w.db.pool, w.people.operator!.ctx, cand.candidateActionId);
    expect(view.actionDigest).toBe(
      computeActionDigest({
        tenantId: w.tenant.tenantId,
        incidentId: inc.incidentId,
        assetRevisionId: cand.assetRevisionId as never,
        evidenceRevisionId: inc.evidenceRevisionId as never,
        policyRevisionId: w.policyRevisionId as never,
        action: {
          kind: 'PART_PURCHASE',
          subjectId: inc.assetId,
          quantity: 1,
          partNumber: '5A1-0402',
          manufacturer: 'Northwind Refrigeration',
        },
        providerAccountRevisionId: w.providerAccountRevisionId as never,
        merchantId: 'mer_coldline-0001' as never,
        amount: { amountMinor: 18_500n, currency: 'USD' } as never,
        purpose: 'PART_PURCHASE' as never,
      }),
    );
    expect(view.certificationClaims).toEqual([
      expect.objectContaining({
        code: 'UL 471',
        sourceKind: 'OEM_PUBLICATION',
        role: 'OTHER',
        trustLevel: 'OPERATOR_ATTESTED',
      }),
    ]);
  });

  it('the engine returns ALLOW with reasons, the exact input digest and the bound tuple', async () => {
    const cand = await exactCandidate(w, inc);
    const again = await exactCandidate(w, inc);
    expect(again.candidateActionId).toBe(cand.candidateActionId);
    expect(again.created).toBe(false);
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId });
    expect(d.created).toBe(true);
    expect(d.decision).toBe('ALLOW');
    expect(d.lifecycle).toBe('CURRENT');
    expect(d.label).toBe('DETERMINISTIC DECISION');
    expect(d.reasonCodes).toEqual([
      'APPROVED_VENDOR',
      'ASSET_IDENTITY_RESOLVED',
      'CERTIFICATION_SATISFIED',
      'ELECTRICAL_CONSTRAINTS_SATISFIED',
      'EXACT_OEM_MATCH',
      'MECHANICAL_CONSTRAINTS_SATISFIED',
      'OFFER_FRESH',
      'WARRANTY_COMPATIBLE',
    ]);
    expect(d.missingFields).toEqual([]);
    expect(d.conflictingFields).toEqual([]);
    expect(d.requiredAuthorities).toEqual([]);
    expect(d.approvalRoute.outcome).toBe('AUTO_PERMITTED');
    expect(d.inputDigest).toMatch(/^compatibility-input\.v1:sha256:[0-9a-f]{64}$/);
    expect(d).toMatchObject({
      tenantId: w.tenant.tenantId,
      incidentId: inc.incidentId,
      candidateActionId: cand.candidateActionId,
      assetRevisionId: cand.assetRevisionId,
      evidenceRevisionId: inc.evidenceRevisionId,
      policyRevisionId: w.policyRevisionId,
      actionDigest: cand.actionDigest,
      ruleVersion: 'compatibility-engine.v1',
    });
    const read = await getDecision(w.db.pool, w.people.viewer!.ctx, d.compatibilityDecisionId);
    expect(read.decision).toBe('ALLOW');
    const replay = await reproduceDecision(w.db.pool, w.people.viewer!.ctx, d.compatibilityDecisionId);
    expect(replay).toMatchObject({ reproduced: true, decision: 'ALLOW', inputDigest: d.inputDigest });
    const ok = await checkDecisionExecutable(w.db.pool, w.service, {
      compatibilityDecisionId: d.compatibilityDecisionId,
      actionDigest: cand.actionDigest,
    });
    expect(ok).toMatchObject({ executable: true, decision: 'ALLOW' });

    const events = await outboxEvents(w, 'compatibility.evaluated.v1', d.compatibilityDecisionId);
    expect(events).toHaveLength(1);
    const e = decodeWire(CompatibilityEvaluatedEventSchema, events[0]);
    expect(e.payload).toMatchObject({ decision: 'ALLOW', inputDigest: d.inputDigest, approved: false });
    const ledger = await w.db.pool.query(
      `SELECT kind, payload_digest FROM evidence_ledger_entries WHERE tenant_id = $1 AND subject_aggregate_id = $2`,
      [w.tenant.tenantId, d.compatibilityDecisionId],
    );
    expect(ledger.rows).toEqual([{ kind: 'POLICY_DECISION', payload_digest: expect.stringMatching(/^sha256:/) }]);
  });

  it('the same tuple evaluated again or concurrently converges on one immutable row', async () => {
    const cand = await exactCandidate(w, inc, { merchantId: merchant() as never });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId })),
    );
    expect(new Set(results.map((r) => r.compatibilityDecisionId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const again = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId });
    expect(again.created).toBe(false);
    expect(again.compatibilityDecisionId).toBe(results[0]!.compatibilityDecisionId);
    const n = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM compatibility_decisions WHERE tenant_id = $1 AND candidate_action_id = $2`,
      [w.tenant.tenantId, cand.candidateActionId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('decision rows and candidates are immutable; only the lifecycle projection may move to SUPERSEDED', async () => {
    const cand = await exactCandidate(w, inc, { merchantId: merchant() as never });
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId });
    for (const sql of [
      `UPDATE compatibility_decisions SET decision = 'HOLD' WHERE tenant_id = $1 AND id = $2`,
      `UPDATE compatibility_decisions SET reason_codes = '{}' WHERE tenant_id = $1 AND id = $2`,
      `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED' WHERE tenant_id = $1 AND id = $2`,
      `DELETE FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`,
    ]) {
      const r = await rejection(w.db.pool.query(sql, [w.tenant.tenantId, d.compatibilityDecisionId]));
      expect(r.code, sql).toBe('UB001');
    }
    const c = await rejection(
      w.db.pool.query(`UPDATE candidate_actions SET part_number = '5A1-0398' WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        cand.candidateActionId,
      ]),
    );
    expect(c.code).toBe('UB001');
  });

  it('humans cannot run the engine; only deterministic server evaluation creates a decision', async () => {
    const cand = await exactCandidate(w, inc, { merchantId: merchant() as never });
    for (const who of [w.people.operator!, w.engineer, w.people.approver!, w.admin]) {
      const ctx = 'ctx' in who ? who.ctx : who;
      const r = await rejection(evaluateCandidate(w.db.pool, ctx, { candidateActionId: cand.candidateActionId }));
      expect(r.code).toBe('FORBIDDEN');
    }
  });
});
