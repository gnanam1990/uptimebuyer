// T-047 — CMMS signature and installed-part verification (FR-14, FR-15, FR-17, INV-01, INV-03, INV-14). Closeout
// needs an immutable tenant/incident/asset/plan/action-bound intervention milestone from policy-authorized onsite or
// CMMS evidence, a work-order signoff from the CMMS integration bound to the incident's site, and the exact approved
// installed-part identity. Provider-only, forged, tampered, replayed, stale-signed, backdated-beyond-policy,
// pre-execution, future-skewed, revoked-integration, disputed, cross-action, cross-incident, wrong-asset and cross-site
// evidence fails. Outbound CMMS writes (closeout decision with evidence references, plan, costs, receipts and part
// identity; M10 order/job facts) are idempotent under retry, replay and restart: no duplicate work-order update.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractFakeCmmsAdapter,
  HttpsCmmsAdapter,
  disputeRecoveryEvidence,
  handleOrderFactEvent,
  recordInterventionMilestone,
  recordRecoveryEvidence,
  revokeCmmsIntegration,
  runCmmsWrites,
} from '@uptimebuyer/recovery';
import { deliver, MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import { rejection, sleep } from './helpers.js';
import {
  assess,
  cmmsBinding,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  iso,
  milestoneAt,
  readings,
  recoveredIncident,
  sendCmms,
  steady,
  verifyingIncident,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';

let w: RecoveryWorld;
let v: VerifyingIncident;
beforeAll(async () => {
  w = await createRecoveryWorld('t047');
  v = await verifyingIncident(w);
});
afterAll(async () => w?.close());

const evidenceCount = async (incidentId: string) =>
  (
    await w.db.pool.query(
      `SELECT count(*)::int AS n FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2`,
      [w.tenant.tenantId, incidentId],
    )
  ).rows[0].n as number;

const promote = (incidentId: string, evidenceId: string) =>
  recordInterventionMilestone(
    w.db.pool,
    w.service,
    { incidentId, evidenceId, idempotencyKey: w.key('m') },
    w.recoverySigning,
  );

describe('T-047 CMMS records: authenticity, replay and site authority', () => {
  it('forged, tampered and stale-signed records are refused and store nothing', async () => {
    const before = await evidenceCount(v.incidentId);
    const body = cmmsRecord(v, Date.now());
    const raw = new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8'));
    expect(await rejection(sendCmms(w, w.cmms, body, { key: new Uint8Array(randomBytes(32)) }))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CMMS_SIGNATURE_INVALID',
    });
    const tampered = new Uint8Array(Buffer.from(JSON.stringify({ ...body, workOrderRef: 'WO-EVIL' }), 'utf8'));
    const { signCmmsRecord } = await import('@uptimebuyer/recovery');
    const ts = Math.floor(Date.now() / 1000);
    expect(
      await rejection(
        sendCmms(w, w.cmms, body, { raw: tampered, signature: signCmmsRecord(w.cmms.verifierKey, ts, raw) }),
      ),
    ).toMatchObject({ reasonCode: 'CMMS_SIGNATURE_INVALID' });
    expect(await rejection(sendCmms(w, w.cmms, body, { ts: ts - 400 }))).toMatchObject({
      reasonCode: 'CMMS_SIGNATURE_INVALID',
    });
    expect(await rejection(sendCmms(w, w.cmms, body, { ts: ts + 400 }))).toMatchObject({
      reasonCode: 'CMMS_SIGNATURE_INVALID',
    });
    // Unknown fields (e.g. a tenant selector) are refused by the strict schema.
    expect(await rejection(sendCmms(w, w.cmms, { ...body, tenantId: w.tenant.tenantId }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await evidenceCount(v.incidentId)).toBe(before);
  });

  it('a replayed record is the same evidence; the same record id with another body is a conflict', async () => {
    const body = cmmsRecord(v, Date.now());
    const a = await sendCmms(w, w.cmms, body);
    expect(a).toMatchObject({ status: 'ACCEPTED' });
    const b = await sendCmms(w, w.cmms, body);
    expect(b).toEqual({ ...a, status: 'DUPLICATE' });
    expect(await rejection(sendCmms(w, w.cmms, { ...body, workOrderRef: 'WO-OTHER' }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      reasonCode: 'CMMS_RECORD_REPLAYED',
    });
  });

  it('an integration bound to another site, or another tenant identity, cannot submit for this incident', async () => {
    const body = cmmsRecord(v, Date.now());
    expect(await rejection(sendCmms(w, w.farCmms, body))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
    // Humans and services are not CMMS integrations.
    const { ingestCmmsRecord } = await import('@uptimebuyer/recovery');
    for (const ctx of [w.operator, w.service])
      expect(
        await rejection(
          ingestCmmsRecord(
            w.db.pool,
            ctx,
            { signature: 't=1,v1=00', rawBody: new Uint8Array(2) },
            { credentials: w.creds },
            w.recoverySigning,
          ),
        ),
      ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a revoked integration is refused and its earlier records no longer authorize a milestone', async () => {
    const tmp = await cmmsBinding(w, w.siteId, 't047-revoked');
    const ev = await sendCmms(w, tmp, cmmsRecord(v, (await dbNowMs(w)) + 2_000));
    await revokeCmmsIntegration(w.db.pool, w.admin, {
      cmmsIntegrationId: tmp.cmmsIntegrationId,
      reasonCode: 'KEY_COMPROMISED',
    });
    expect(await rejection(sendCmms(w, tmp, cmmsRecord(v, Date.now())))).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CMMS_INTEGRATION_INACTIVE',
    });
    expect(await rejection(promote(v.incidentId, ev.evidenceId))).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'CMMS_AUTHORITY_REVOKED',
    });
  });
});

describe('T-047 milestone binding: action, incident, asset, time', () => {
  it('cross-action, cross-incident and wrong-asset evidence cannot become the milestone', async () => {
    const other = await verifyingIncident(w);
    const now = await dbNowMs(w);
    const wrongAction = await sendCmms(
      w,
      w.cmms,
      cmmsRecord(v, now, { actionDigest: other.actionDigest, planId: other.planId }),
    );
    expect(await rejection(promote(v.incidentId, wrongAction.evidenceId))).toMatchObject({
      reasonCode: 'WRONG_ACTION',
    });
    const forged = await sendCmms(
      w,
      w.cmms,
      cmmsRecord(v, now, { actionDigest: `action.v1:sha256:${'0'.repeat(64)}` }),
    );
    expect(await rejection(promote(v.incidentId, forged.evidenceId))).toMatchObject({ reasonCode: 'WRONG_ACTION' });
    const sibling = await sendCmms(w, w.cmms, cmmsRecord(other, now));
    expect(await rejection(promote(v.incidentId, sibling.evidenceId))).toMatchObject({
      reasonCode: 'EVIDENCE_INCIDENT_MISMATCH',
    });
    const wrongAsset = await sendCmms(
      w,
      w.cmms,
      cmmsRecord(v, now, { assetId: other.assetId, assetRevisionId: other.assetRevisionId }),
    );
    expect(await rejection(promote(v.incidentId, wrongAsset.evidenceId))).toMatchObject({ reasonCode: 'WRONG_ASSET' });
  });

  it('future-skewed, backdated-beyond-policy and pre-execution milestones fail', async () => {
    const now = await dbNowMs(w);
    for (const [at, reason] of [
      [now + 10 * 60_000, 'FUTURE_SKEWED'],
      [now - 2 * 3_600_000, 'BACKDATED_BEYOND_POLICY'],
      [now - 30 * 60_000, 'WORK_BEFORE_EXECUTION'],
    ] as const) {
      const ev = await sendCmms(w, w.cmms, cmmsRecord(v, at));
      expect(await rejection(promote(v.incidentId, ev.evidenceId)), reason).toMatchObject({
        code: 'POLICY_HOLD',
        reasonCode: reason,
      });
    }
    const { rows } = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM intervention_milestones WHERE tenant_id = $1 AND incident_id = $2`,
      [w.tenant.tenantId, v.incidentId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('disputed evidence cannot become a milestone; unauthorized attesters cannot attest', async () => {
    const ev = await sendCmms(w, w.cmms, cmmsRecord(v, (await dbNowMs(w)) + 1_000));
    await disputeRecoveryEvidence(w.db.pool, w.operator, {
      evidenceId: ev.evidenceId,
      reasonCode: 'TECHNICIAN_NOT_ONSITE',
      idempotencyKey: w.key('dispute'),
    });
    expect(await rejection(promote(v.incidentId, ev.evidenceId))).toMatchObject({ reasonCode: 'EVIDENCE_DISPUTED' });
    const attest = (ctx: typeof w.operator) =>
      recordRecoveryEvidence(
        w.db.pool,
        ctx,
        {
          incidentId: v.incidentId,
          idempotencyKey: w.key('att'),
          kind: 'OPERATOR_ATTESTATION',
          occurredAt: iso(Date.now()),
          planId: v.planId,
          actionDigest: v.actionDigest,
          milestoneType: 'WORK_COMPLETED',
        },
        w.recoverySigning,
      );
    // The policy names maintenance_approver/engineer: a plain operator is not an authorized attester.
    expect(await rejection(attest(w.operator))).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'ATTESTER_ROLE_NOT_PERMITTED',
    });
    expect(await rejection(attest(w.viewerCtx))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await rejection(attest(w.farEngineer.ctx))).toMatchObject({ code: 'FORBIDDEN' });
    // A milestone is recorded once per evidence row (idempotent).
    const good = await sendCmms(w, w.cmms, cmmsRecord(v, (await dbNowMs(w)) + 1_000));
    const m1 = await promote(v.incidentId, good.evidenceId);
    const m2 = await promote(v.incidentId, good.evidenceId);
    expect(m2.interventionMilestoneId).toBe(m1.interventionMilestoneId);
    expect([m1.created, m2.created]).toEqual([true, false]);
    await expect(
      w.db.admin(
        `UPDATE intervention_milestones SET occurred_at = occurred_at - interval '1 hour' WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, m1.interventionMilestoneId],
      ),
    ).rejects.toMatchObject({ code: 'UB001' });
  });
});

describe('T-047 installed-part identity', () => {
  it('a part that is not the approved MPN blocks closeout; conflicts fail closed until a linked correction', async () => {
    const p = await verifyingIncident(w);
    const wrongId = `wo-wrongpart-${randomBytes(4).toString('hex')}`;
    const m = await milestoneAt(w, p, (await dbNowMs(w)) + 5_000, {
      recordId: wrongId,
      installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0499', serial: 'SN-WRONG-1' },
    });
    await readings(w, p.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const r1 = await assess(w, p, m.boundaryMs + 61_500);
    expect(r1.outcome).toBe('OBSERVING');
    expect(r1.reasonCodes).toContain('INSTALLED_PART_MISMATCH');
    const partRecord = (over: Record<string, unknown>) =>
      cmmsRecord(p, m.boundaryMs + 30_000, {
        recordType: 'INSTALLED_PART',
        milestoneType: undefined,
        installedPart: {
          manufacturer: MANUFACTURER,
          partNumber: '5A1-0402',
          serial: 'SN-RIGHT-1',
          barcode: '0123456789',
        },
        ...over,
      });
    // A second, correct scan alone conflicts with the live wrong one: still blocked.
    await sendCmms(w, w.cmms, partRecord({}));
    const r2 = await assess(w, p, m.boundaryMs + 61_700);
    expect(r2.outcome).toBe('OBSERVING');
    expect(r2.reasonCodes).toContain('INSTALLED_PART_MISMATCH');
    // The CMMS correction explicitly supersedes the wrong part claim (same integration, linked record id).
    await sendCmms(w, w.cmms, partRecord({ supersedesRecordId: wrongId }));
    const r3 = await assess(w, p, m.boundaryMs + 61_900);
    expect(r3.outcome).toBe('PASSED');
    const close = await w.db.pool.query(`SELECT manifest FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      r3.closeoutId,
    ]);
    expect(close.rows[0].manifest.installedPart).toMatchObject({ partNumber: '5A1-0402', serial: 'SN-RIGHT-1' });
  });

  it('a part record with no serial is not identity evidence', async () => {
    expect(
      await rejection(
        sendCmms(
          w,
          w.cmms,
          cmmsRecord(v, Date.now(), {
            recordType: 'INSTALLED_PART',
            installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0402' },
          }),
        ),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('T-047 outbound CMMS writes are replay-safe', () => {
  it('closeout and M10 facts reach the CMMS exactly once under retry, replay and restart', async () => {
    const { inc, r } = await recoveredIncident(w);
    expect(r.outcome).toBe('PASSED');
    await deliver(w, 'purchase_order.state_changed.v1', handleOrderFactEvent);
    const replay = await deliver(w, 'purchase_order.state_changed.v1', handleOrderFactEvent);
    expect(replay.every((x) => x === 'DUPLICATE')).toBe(true);
    const rows = async () =>
      (
        await w.db.pool.query(
          `SELECT id, update_kind, idempotency_key, external_outcome_state, adapter_capability, payload
             FROM cmms_work_order_updates WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at`,
          [w.tenant.tenantId, inc.incidentId],
        )
      ).rows;
    const queued = await rows();
    const closeout = queued.filter((u) => u.update_kind === 'CLOSEOUT');
    expect(closeout).toHaveLength(1);
    expect(queued.filter((u) => u.update_kind === 'ORDER_FACT').length).toBeGreaterThanOrEqual(4);
    expect(new Set(queued.map((u) => u.idempotency_key)).size).toBe(queued.length);
    expect(closeout[0].payload).toMatchObject({
      status: 'RECOVERED',
      decision: { outcome: 'PASSED', closeoutId: r.closeoutId, recoveryEvaluationId: r.recoveryEvaluationId },
      evidence: { milestoneId: expect.stringMatching(/^iml_/), signoffEvidenceIds: expect.any(Array) },
      approvedPlan: { planId: inc.planId, actionDigest: inc.actionDigest },
      costs: [{ orderId: inc.orderId, approvedAmountMinor: '18500', currency: 'USD' }],
      receipts: [{ orderId: inc.orderId, economicState: expect.any(String) }],
      installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0402' },
    });

    // The real adapter without credentials writes nothing and claims nothing.
    const unsupported = await runCmmsWrites(w.db.pool, w.service, {
      adapter: HttpsCmmsAdapter.fromEnv({}),
      workerId: 'cmms-live',
    });
    expect(unsupported.unsupported).toBeGreaterThan(0);
    expect(unsupported.confirmed).toBe(0);
    expect(
      (await rows()).every((u) => u.external_outcome_state === 'AUTHORIZED' && u.adapter_capability === 'UNSUPPORTED'),
    ).toBe(true);

    // Contract fake: an ambiguous timeout after apply, then a crash after send, then clean retries.
    const fake = new ContractFakeCmmsAdapter();
    fake.failNext('TIMEOUT_AFTER_APPLY');
    const first = await runCmmsWrites(w.db.pool, w.service, {
      adapter: fake,
      workerId: 'cmms-a',
      limit: 1,
      reconcileDelayMs: 0,
    });
    expect(first.unknown).toBe(1);
    await expect(
      runCmmsWrites(w.db.pool, w.service, {
        adapter: fake,
        workerId: 'cmms-b',
        limit: 1,
        leaseMs: 50,
        faults: {
          afterSend() {
            throw new Error('worker crashed after send');
          },
        },
      }),
    ).rejects.toThrow('worker crashed after send');
    await sleep(120);
    for (let i = 0; i < 20; i++) {
      const r2 = await runCmmsWrites(w.db.pool, w.service, {
        adapter: fake,
        workerId: `cmms-c${i}`,
        reconcileDelayMs: 0,
      });
      if (r2.claimed === 0) break;
    }
    const after = await rows();
    expect(after.every((u) => u.external_outcome_state === 'CONFIRMED')).toBe(true);
    // Every queued update in the tenant was applied exactly once: no duplicate work-order update.
    const confirmed = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM cmms_work_order_updates WHERE tenant_id = $1 AND external_outcome_state = 'CONFIRMED'`,
      [w.tenant.tenantId],
    );
    expect(fake.appliedCount()).toBe(confirmed.rows[0].n);
    const again = await runCmmsWrites(w.db.pool, w.service, { adapter: fake, workerId: 'cmms-d' });
    expect(again.claimed).toBe(0);
    const attempts = await w.db.pool.query(
      `SELECT update_id, count(*) FILTER (WHERE outcome = 'CONFIRMED')::int AS confirmed FROM cmms_write_attempts
        WHERE tenant_id = $1 GROUP BY update_id`,
      [w.tenant.tenantId],
    );
    expect(attempts.rows.every((a) => a.confirmed <= 1)).toBe(true);
    // Payloads and keys are immutable.
    await expect(
      w.db.admin(`UPDATE cmms_work_order_updates SET payload = '{}'::jsonb WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        closeout[0].id,
      ]),
    ).rejects.toMatchObject({ code: 'UB203' });
  });
});
