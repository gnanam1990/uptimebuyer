// T-028 — Policy revision forces reevaluation (FR-21, INV-03, INV-10, INV-15), persisted. When a new AUTHORITY policy
// revision becomes effective, every unexecuted compatibility decision, authority record and approval bound to the
// prior revision is invalidated (lifecycle column / append-only events only; no row is edited), plan.invalidated.v1
// is emitted per affected incident, the old candidate cannot be evaluated again (its tuple is stale) and a newly
// registered candidate binds the new revision and a new action digest. A future-dated revision invalidates nothing
// until it is effective, yet a stale decision is non-executable the moment it is. Historical decisions remain
// reproducible under the policy body that governed them. The same consumer invalidates decisions and authority
// records when M05 commits a new evidence revision (T-024's downstream assertion for compatibility decisions).
// The race against reserve-plus-SEND_STARTED belongs to T-040 (M09).
import { decodeWire, money } from '@uptimebuyer/contracts';
import { getApprovalStatus, recordApproval } from '@uptimebuyer/data';
import { PlanInvalidatedEventSchema, commitIncidentEvidence, withdrawDocument } from '@uptimebuyer/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_INVALIDATION_CONSUMER,
  activateEffectivePolicy,
  checkDecisionExecutable,
  evaluateCandidate,
  getAuthorityRecord,
  getDecision,
  handleInvalidationEvent,
  listPolicyHistory,
  reproduceDecision,
  validatePolicyDraft,
} from '../src/index.js';
import { WORK_ORDERS, ingestAs } from '../../evidence/test/helpers.js';
import {
  APPROVAL_LIMITS,
  compatibilityPolicy,
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  outboxEvents,
  publishPolicy,
  recordAuthorityFor,
  rejection,
  sleep,
  type CompatWorld,
} from './helpers.js';

let w: CompatWorld;

const evaluate = (candidateActionId: string) => evaluateCandidate(w.db.pool, w.service, { candidateActionId });

describe('T-028 policy revision forces reevaluation (persisted)', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t028');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('an effective policy change invalidates unexecuted decisions, authorities and approvals and forces a new tuple', async () => {
    const inc = await incidentWithEvidence(w, { warrantyExpiresOn: '2025-01-31' });
    const m = merchant();
    const exact = await exactCandidate(w, inc, { merchantId: m as never });
    const allowed = await evaluate(exact.candidateActionId);
    expect(allowed.decision).toBe('ALLOW');
    const sub = await exactCandidate(w, inc, { partNumber: '5A1-0398', merchantId: merchant() as never });
    const held = await evaluate(sub.candidateActionId);
    const authority = await recordAuthorityFor(w, held.compatibilityDecisionId);
    const approval = await recordApproval(w.db.pool, w.people.approver!.ctx, {
      approvalKind: 'PLAN_ACTION',
      incidentId: inc.incidentId,
      siteId: w.siteId,
      assetRevisionId: exact.assetRevisionId,
      evidenceRevisionId: inc.evidenceRevisionId,
      policyRevisionId: w.policyRevisionId,
      planHash: `plan.v1:sha256:${'a'.repeat(64)}`,
      actionDigest: exact.actionDigest,
      actionClass: 'STANDARD',
      paid: true,
      providerAccountRevisionId: w.providerAccountRevisionId,
      targetExecutionAuthorityId: null,
      maxAmount: money(18_500n, 'USD'),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const before = await w.db.pool.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      allowed.compatibilityDecisionId,
    ]);

    const p2 = await publishPolicy(
      w,
      compatibilityPolicy({
        ruleSet: 'northwind-cold-chain.r2',
        requiredCertifications: [
          { code: 'UL 471', components: null },
          { code: 'NSF 7', components: null },
        ],
      }),
    );
    expect(p2.activation).toMatchObject({ policyRevisionId: p2.policyRevisionId, activated: true });
    expect(p2.activation!.supersededDecisionIds).toEqual(
      expect.arrayContaining([allowed.compatibilityDecisionId, held.compatibilityDecisionId]),
    );
    expect(p2.activation!.invalidatedAuthorityIds).toEqual([authority.authorityRecordId]);
    expect(p2.activation!.invalidatedApprovalIds).toContain(approval.approvalId);

    const old = await getDecision(w.db.pool, w.service, allowed.compatibilityDecisionId);
    expect(old).toMatchObject({
      decision: 'ALLOW',
      lifecycle: 'SUPERSEDED',
      supersededReason: 'POLICY_REVISION_CHANGED',
    });
    const after = await w.db.pool.query(`SELECT * FROM compatibility_decisions WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      allowed.compatibilityDecisionId,
    ]);
    for (const k of [
      'decision',
      'reason_codes',
      'input',
      'input_digest',
      'policy_revision_id',
      'action_digest',
      'decided_at',
    ])
      expect(after.rows[0][k], k).toEqual(before.rows[0][k]);
    expect((await getAuthorityRecord(w.db.pool, w.engineer.ctx, authority.authorityRecordId)).status).toBe(
      'INVALIDATED',
    );
    const ap = await getApprovalStatus(w.db.pool, w.people.approver!.ctx, approval.approvalId);
    expect(ap.executable).toBe(false);
    expect(ap.events).toEqual([
      expect.objectContaining({ eventType: 'INVALIDATED', reasonCode: 'POLICY_REVISION_CHANGED' }),
    ]);

    const events = (await outboxEvents(w, 'plan.invalidated.v1', inc.incidentId)).map((e) =>
      decodeWire(PlanInvalidatedEventSchema, e),
    );
    const policyEvent = events.find((e) => e.payload.reasonCode === 'POLICY_REVISION_CHANGED');
    expect(policyEvent?.payload).toMatchObject({
      incidentId: inc.incidentId,
      supersededPolicyRevisionId: w.policyRevisionId,
      policyRevisionId: p2.policyRevisionId,
    });

    const stale = await rejection(evaluate(exact.candidateActionId));
    expect([stale.code, stale.reasonCode]).toEqual(['POLICY_HOLD', 'CANDIDATE_TUPLE_STALE']);
    const notExec = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: allowed.compatibilityDecisionId,
        actionDigest: exact.actionDigest,
      }),
    );
    expect([notExec.code, notExec.reasonCode]).toEqual(['POLICY_HOLD', 'DECISION_NOT_CURRENT']);

    const fresh = await exactCandidate(w, inc, { merchantId: m as never });
    expect(fresh.candidateActionId).not.toBe(exact.candidateActionId);
    expect(fresh.policyRevisionId).toBe(p2.policyRevisionId);
    expect(fresh.actionDigest).not.toBe(exact.actionDigest);
    const next = await evaluate(fresh.candidateActionId);
    expect(next.decision).toBe('HOLD');
    expect(next.missingFields).toContain('certification:NSF 7');

    const replay = await reproduceDecision(w.db.pool, w.service, allowed.compatibilityDecisionId);
    expect(replay).toMatchObject({
      reproduced: true,
      decision: 'ALLOW',
      inputDigest: allowed.inputDigest,
      policyRevisionId: w.policyRevisionId,
    });

    const again = await activateEffectivePolicy(w.db.pool, w.service);
    expect(again).toMatchObject({ policyRevisionId: p2.policyRevisionId, activated: false, supersededDecisionIds: [] });
    w.policyRevisionId = p2.policyRevisionId;
  });

  it('a future-dated revision changes nothing until effective, but a stale decision is non-executable at once', async () => {
    const inc = await incidentWithEvidence(w);
    const cand = await exactCandidate(w, inc, { merchantId: merchant() as never });
    const d = await evaluate(cand.candidateActionId);
    const effectiveAt = new Date(Date.now() + 2_500).toISOString();
    const p3 = await publishPolicy(w, compatibilityPolicy({ ruleSet: 'northwind-cold-chain.r3' }), effectiveAt);
    expect(p3.activation).toBeNull();
    expect((await activateEffectivePolicy(w.db.pool, w.service)).activated).toBe(false);
    expect((await getDecision(w.db.pool, w.service, d.compatibilityDecisionId)).lifecycle).toBe('CURRENT');
    await sleep(3_000);
    const r = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: d.compatibilityDecisionId,
        actionDigest: d.actionDigest,
      }),
    );
    expect([r.code, r.reasonCode]).toEqual(['POLICY_HOLD', 'POLICY_REVISION_NOT_EFFECTIVE']);
    const act = await activateEffectivePolicy(w.db.pool, w.service);
    expect(act).toMatchObject({ policyRevisionId: p3.policyRevisionId, activated: true });
    expect(act.supersededDecisionIds).toContain(d.compatibilityDecisionId);
    w.policyRevisionId = p3.policyRevisionId;
  });

  it('policy administration validates drafts and keeps a reproducible audit history', async () => {
    expect(validatePolicyDraft({ approvalLimits: APPROVAL_LIMITS, compatibility: compatibilityPolicy() })).toEqual({
      ok: true,
      issues: [],
    });
    const bad = validatePolicyDraft({
      approvalLimits: APPROVAL_LIMITS,
      compatibility: {
        ...compatibilityPolicy(),
        authoritativeSources: [
          {
            category: 'PART_IDENTITY',
            roles: ['OTHER'],
            sourceKinds: ['PROVIDER_DOCUMENT'],
            trustLevels: ['PROVIDER_REPORTED'],
          },
        ],
      },
    });
    expect(bad.ok).toBe(false);
    const refused = await rejection(
      publishPolicy(w, { ...compatibilityPolicy(), overridableReasons: ['KNOWN_INCOMPATIBILITY'] } as never),
    );
    expect(refused.code).toBe('VALIDATION_FAILED');
    const unknownSite = await rejection(
      publishPolicy(
        w,
        compatibilityPolicy({
          autoPermit: [
            {
              siteIds: ['sit_not-a-site-0001' as never],
              currency: 'USD',
              maxAmountMinor: 1n,
              actionKinds: ['PART_PURCHASE'],
            },
          ],
        }),
      ),
    );
    expect(unknownSite.code).toBe('FORBIDDEN');
    const notAdmin = await rejection(publishPolicy({ ...w, admin: w.engineer.ctx } as never, compatibilityPolicy()));
    expect(notAdmin.code).toBe('FORBIDDEN');

    const history = await listPolicyHistory(w.db.pool, w.admin);
    expect(history.map((h) => h.ruleSet)).toEqual(
      expect.arrayContaining(['northwind-cold-chain.r1', 'northwind-cold-chain.r2', 'northwind-cold-chain.r3']),
    );
    const r2 = history.find((h) => h.ruleSet === 'northwind-cold-chain.r2')!;
    expect(r2).toMatchObject({ publishedBy: expect.stringMatching(/^usr_/), activatedAt: expect.any(String) });
    expect(r2.effectiveUntil).not.toBeNull();
    expect(history.find((h) => h.current)?.ruleSet).toBe('northwind-cold-chain.r3');
    const audit = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND action = 'policy.publish' AND result = 'SUCCEEDED'`,
      [w.tenant.tenantId],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it('a new evidence revision invalidates dependent decisions and authority records through the M05 event', async () => {
    const inc = await incidentWithEvidence(w, { warrantyExpiresOn: '2025-01-31' });
    const exact = await exactCandidate(w, inc, { merchantId: merchant() as never });
    const allowed = await evaluate(exact.candidateActionId);
    const sub = await exactCandidate(w, inc, { partNumber: '5A1-0398', merchantId: merchant() as never });
    const held = await evaluate(sub.candidateActionId);
    const authority = await recordAuthorityFor(w, held.compatibilityDecisionId);

    const wo = await ingestAs(w, w.people.operator!, WORK_ORDERS(inc.assetId));
    const rev = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId: inc.incidentId,
      reasonCode: 'WORK_ORDERS',
    });
    expect(rev.changed).toBe(true);
    // Before the event is consumed the decision is already non-executable: its evidence revision is not current.
    const early = await rejection(
      checkDecisionExecutable(w.db.pool, w.service, {
        compatibilityDecisionId: allowed.compatibilityDecisionId,
        actionDigest: exact.actionDigest,
      }),
    );
    expect([early.code, early.reasonCode]).toEqual(['POLICY_HOLD', 'EVIDENCE_REVISION_NOT_CURRENT']);

    const events = await outboxEvents(w, 'plan.invalidated.v1', inc.incidentId);
    const evidenceEvent = events.find((e) => e.payload.evidenceRevisionId === rev.evidenceRevisionId)!;
    expect(await handleInvalidationEvent(w.db.pool, evidenceEvent as never)).toBe('PROCESSED');
    expect(await handleInvalidationEvent(w.db.pool, evidenceEvent as never)).toBe('DUPLICATE');
    for (const id of [allowed.compatibilityDecisionId, held.compatibilityDecisionId])
      expect(await getDecision(w.db.pool, w.service, id)).toMatchObject({
        lifecycle: 'SUPERSEDED',
        supersededReason: 'EVIDENCE_REVISION_CHANGED',
      });
    expect((await getAuthorityRecord(w.db.pool, w.engineer.ctx, authority.authorityRecordId)).status).toBe(
      'INVALIDATED',
    );

    const committed = (await outboxEvents(w, 'evidence.revision_committed.v1', rev.evidenceRevisionId))[0]!;
    expect(await handleInvalidationEvent(w.db.pool, committed as never)).toBe('PROCESSED');
    const receipts = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM outbox_consumer_receipts WHERE consumer = $1`,
      [COMPATIBILITY_INVALIDATION_CONSUMER],
    );
    expect(receipts.rows[0].n).toBeGreaterThanOrEqual(2);

    // Historical decisions still resolve to their original revisions and reproduce.
    expect((await reproduceDecision(w.db.pool, w.service, allowed.compatibilityDecisionId)).evidenceRevisionId).toBe(
      inc.evidenceRevisionId,
    );
    await withdrawDocument(w.db.pool, w.people.operator!.ctx, wo.documentId as never, { reasonCode: 'WRONG_ASSET' });
  });
});
