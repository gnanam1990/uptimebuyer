// T-024 — Evidence revision invalidates stale proposal (FR-05, INV-03, INV-10). Adding, removing or replacing evidence,
// or changing the immutable asset revision, commits a new evidence revision with a new digest, marks the stale model
// proposal SUPERSEDED, emits evidence.revision_committed.v1 and plan.invalidated.v1 through the outbox, and leaves
// every historical revision, proposal and citation reproducible. (Compatibility-decision and approval invalidation by
// that event are asserted by T-028/M06 and T-037/M09.)
import { DomainEventEnvelopeSchema, decodeWire } from '@uptimebuyer/contracts';
import { reviseAssetIdentity } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractFakeReasoner,
  EvidenceRevisionCommittedEventSchema,
  PlanInvalidatedEventSchema,
  ReasoningCompletedEventSchema,
  commitIncidentEvidence,
  getEvidenceRevision,
  getProposal,
  listIncidentProposals,
  refreshEvidenceForAsset,
  reopenCitation,
  runReasoning,
  withdrawDocument,
} from '../src/index.js';
import {
  BOM_7,
  MANUAL_C,
  WORK_ORDERS,
  createEvidenceWorld,
  currentAssetRevision,
  ingestAs,
  nwrAsset,
  openIncident,
  proposalFor,
  rejection,
  type EvidenceWorld,
} from './helpers.js';

let w: EvidenceWorld;
let asset: Awaited<ReturnType<typeof nwrAsset>>;
let incidentId: string;

const fake = () => new ContractFakeReasoner((req) => ({ kind: 'FINAL', content: JSON.stringify(proposalFor(req)) }));

async function outbox(eventType: string, aggregateId?: string) {
  const { rows } = await w.db.pool.query(
    `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = $2 AND ($3::text IS NULL OR aggregate_id = $3)
      ORDER BY seq`,
    [w.tenant.tenantId, eventType, aggregateId ?? null],
  );
  return rows.map((r) =>
    decodeWire(DomainEventEnvelopeSchema, {
      eventId: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at.toISOString(),
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

const commit = (reasonCode = 'EVIDENCE_CHANGED') =>
  commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, { incidentId: incidentId as never, reasonCode });
const reason = () => runReasoning(w.db.pool, w.service, { reasoner: fake(), store: w.store }, { incidentId: incidentId as never });

describe('T-024 evidence revision invalidates stale proposal', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t024');
    asset = await nwrAsset(w);
    await ingestAs(w, w.librarian, MANUAL_C());
    await ingestAs(w, w.librarian, BOM_7());
    incidentId = await openIncident(w, asset.assetId);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('adding evidence creates a new revision and digest, supersedes the proposal and emits both events', async () => {
    const r1 = await commit('TRIAGE_EVIDENCE');
    const run1 = await reason();
    expect(run1.status).toBe('COMPLETED');
    const p1 = await getProposal(w.db.pool, w.people.viewer!.ctx, run1.proposalId!);
    expect(p1).toMatchObject({ lifecycle: 'CURRENT', evidenceRevisionId: r1.evidenceRevisionId });
    const [completed] = await outbox('reasoning.completed.v1', run1.reasoningRunId);
    expect(ReasoningCompletedEventSchema.parse(completed).payload).toMatchObject({
      proposalId: run1.proposalId,
      approved: false,
    });

    // No material change: no new revision, no events.
    const same = await commit();
    expect(same).toMatchObject({ changed: false, evidenceRevisionId: r1.evidenceRevisionId });

    await ingestAs(w, w.people.operator!, WORK_ORDERS(asset.assetId));
    const r2 = await commit('EVIDENCE_ADDED');
    expect(r2).toMatchObject({ changed: true, revision: 2, previousRevisionId: r1.evidenceRevisionId });
    expect(r2.manifestSha256).not.toBe(r1.manifestSha256);
    expect(r2.contentDigest).not.toBe(r1.contentDigest);
    expect(r2.supersededProposalIds).toEqual([run1.proposalId]);

    const p1After = await getProposal(w.db.pool, w.people.viewer!.ctx, run1.proposalId!);
    expect(p1After).toMatchObject({
      lifecycle: 'SUPERSEDED',
      supersededByEvidenceRevisionId: r2.evidenceRevisionId,
      evidenceRevisionId: r1.evidenceRevisionId,
    });

    const [committed] = await outbox('evidence.revision_committed.v1', r2.evidenceRevisionId);
    expect(EvidenceRevisionCommittedEventSchema.parse(committed).payload).toMatchObject({
      evidenceRevisionId: r2.evidenceRevisionId,
      incidentId,
      revision: 2,
      previousRevisionId: r1.evidenceRevisionId,
      assetRevisionId: asset.assetRevisionId,
      manifestSha256: r2.manifestSha256,
    });
    const invalidated = await outbox('plan.invalidated.v1', incidentId);
    expect(invalidated).toHaveLength(1);
    const ev = PlanInvalidatedEventSchema.parse(invalidated[0]);
    expect(ev.aggregateVersion).toBe(1);
    expect(ev.payload).toMatchObject({
      incidentId,
      reasonCode: 'EVIDENCE_REVISION_CHANGED',
      supersededEvidenceRevisionId: r1.evidenceRevisionId,
      evidenceRevisionId: r2.evidenceRevisionId,
      supersededAssetRevisionId: asset.assetRevisionId,
      assetRevisionId: asset.assetRevisionId,
      supersededProposalIds: [run1.proposalId],
    });
  });

  it('a new proposal on the new revision has new candidate digests; the old one still reproduces', async () => {
    const run2 = await reason();
    const proposals = await listIncidentProposals(w.db.pool, w.people.viewer!.ctx, incidentId as never);
    const [old, current] = [proposals.find((p) => p.lifecycle === 'SUPERSEDED')!, proposals.find((p) => p.proposalId === run2.proposalId)!];
    expect(current.lifecycle).toBe('CURRENT');
    expect(current.candidates[0]!.candidateDigest).not.toBe(old.candidates[0]!.candidateDigest);
    expect(current.proposalDigest).not.toBe(old.proposalDigest);
    for (const p of [old, current]) expect(p.verification).toEqual({ proposalDigestMatches: true, candidateDigestsMatch: true });
  });

  it('removing evidence creates a new revision and supersedes again', async () => {
    const before = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, (await commit()).evidenceRevisionId);
    const wo = before.documents.find((d) => d.role === 'WORK_ORDER')!;
    await withdrawDocument(w.db.pool, w.people.operator!.ctx, wo.documentId, { reasonCode: 'WRONG_ASSET_EXPORT' });
    const r3 = await commit('EVIDENCE_REMOVED');
    expect(r3).toMatchObject({ changed: true, revision: 3 });
    expect(r3.supersededProposalIds).toHaveLength(1);
    const rev3 = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, r3.evidenceRevisionId);
    expect(rev3.documents.map((d) => d.role)).not.toContain('WORK_ORDER');
    // The withdrawn document is still part of revision 2's history.
    const rev2 = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, before.evidenceRevisionId);
    expect(rev2.documents.map((d) => d.documentId)).toContain(wo.documentId);
    expect(rev2.current).toBe(false);
  });

  it('changing the immutable asset revision rebinds evidence and invalidates the plan scope', async () => {
    const run = await reason();
    const before = await currentAssetRevision(w, asset.assetId);
    const changed = await reviseAssetIdentity(
      w.db.pool,
      w.admin,
      asset.assetId,
      { ...before.current, bomRevision: 'BOM-8' } as never,
      { expectedVersion: before.version, source: 'API' },
    );
    const [r4] = await refreshEvidenceForAsset(w.db.pool, w.service, w.store, asset.assetId, {
      reasonCode: 'ASSET_REVISION_CHANGED',
    });
    expect(r4).toMatchObject({ changed: true, revision: 4, assetRevisionId: changed.assetRevisionId });
    expect(r4!.supersededProposalIds).toEqual([run.proposalId]);
    const rev4 = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, r4!.evidenceRevisionId);
    // The BOM-7 parts list no longer applies to the BOM-8 revision.
    expect(rev4.documents.map((d) => d.role)).not.toContain('PARTS_LIST');
    const inv = await outbox('plan.invalidated.v1', incidentId);
    expect(inv.map((e) => e.aggregateVersion)).toEqual([1, 2, 3]);
    expect(PlanInvalidatedEventSchema.parse(inv[2]).payload).toMatchObject({
      reasonCode: 'ASSET_REVISION_CHANGED',
      supersededAssetRevisionId: asset.assetRevisionId,
      assetRevisionId: changed.assetRevisionId,
    });
  });

  it('history is reproducible: every revision, proposal and citation resolves to its original inputs', async () => {
    const proposals = await listIncidentProposals(w.db.pool, w.people.viewer!.ctx, incidentId as never);
    expect(proposals.filter((p) => p.lifecycle === 'CURRENT')).toHaveLength(0);
    const first = proposals.at(0)!;
    const rev1 = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, first.evidenceRevisionId);
    expect(rev1).toMatchObject({ revision: 1, assetRevisionId: asset.assetRevisionId, current: false });
    expect(rev1.verification).toEqual({ manifestDigestMatches: true, contentDigestMatches: true });
    expect(first.verification).toEqual({ proposalDigestMatches: true, candidateDigestsMatch: true });
    for (const f of first.proposal.extractedFields)
      for (const c of f.citations) {
        const opened = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, c.citationId);
        expect(opened.verified).toBe(true);
        expect(opened.citation.evidenceRevisionId).toBe(first.evidenceRevisionId);
      }
  });

  it('evidence revisions and proposals are append-only in the database', async () => {
    const r = await rejection(w.db.pool.query(`UPDATE evidence_revisions SET revision = revision WHERE tenant_id = $1`, [w.tenant.tenantId]));
    expect(r.code).toBe('UB001');
    const p = await rejection(w.db.pool.query(`UPDATE reasoning_proposals SET body = '{}'::jsonb WHERE tenant_id = $1`, [w.tenant.tenantId]));
    expect(p.code).toBe('UB001');
    const d = await rejection(w.db.pool.query(`DELETE FROM evidence_document_spans WHERE tenant_id = $1`, [w.tenant.tenantId]));
    expect(d.code).toBe('UB001');
  });

  it('concurrent commits after one change produce exactly one new revision', async () => {
    await ingestAs(w, w.people.operator!, WORK_ORDERS(asset.assetId, 'nwr-2d-48-work-orders-conflict.csv'));
    const results = await Promise.all([commit(), commit(), commit(), commit()]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.evidenceRevisionId)).size).toBe(1);
  });

  it('a proposal finished after its evidence moved on is recorded already superseded', async () => {
    let moved = false;
    const racing = new ContractFakeReasoner(async (req) => {
      if (!moved) {
        moved = true;
        await withdrawDocument(
          w.db.pool,
          w.people.operator!.ctx,
          (await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, req.packet.binding.evidenceRevisionId)).documents.find(
            (d) => d.role === 'WORK_ORDER',
          )!.documentId,
          { reasonCode: 'RACE' },
        );
        await commit('EVIDENCE_REMOVED');
      }
      return { kind: 'FINAL', content: JSON.stringify(proposalFor(req)) };
    });
    const run = await runReasoning(w.db.pool, w.service, { reasoner: racing, store: w.store }, { incidentId: incidentId as never });
    expect(run).toMatchObject({ status: 'COMPLETED', disposition: 'SUPERSEDED_BEFORE_RECORDING' });
    const p = await getProposal(w.db.pool, w.people.viewer!.ctx, run.proposalId!);
    expect(p.lifecycle).toBe('SUPERSEDED');
    expect(await outbox('reasoning.completed.v1', run.reasoningRunId)).toHaveLength(0);
  });
});
