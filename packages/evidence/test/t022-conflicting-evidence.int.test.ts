// T-022 — Conflicting evidence surfaced (FR-05, INV-02, INV-04 input). Two manual revisions and a service record
// disagree on the evaporator fan motor part number. Retrieval preserves every source, marks the conflict and never
// reports an authoritative or exact-match claim; a model proposal that hides the conflict is forced to human review
// and one that asserts exact compatibility is rejected by the schema.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractFakeReasoner,
  commitIncidentEvidence,
  getEvidenceRevision,
  getProposal,
  reopenCitation,
  retrieveEvidence,
  runReasoning,
} from '../src/index.js';
import {
  BOM_7,
  MANUAL_B,
  MANUAL_C,
  WORK_ORDERS,
  createEvidenceWorld,
  ingestAs,
  nwrAsset,
  openIncident,
  proposalFor,
  type EvidenceWorld,
} from './helpers.js';

let w: EvidenceWorld;
let incidentId: string;
let evidenceRevisionId: string;

describe('T-022 conflicting evidence surfaced', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t022');
    const asset = await nwrAsset(w);
    await ingestAs(w, w.librarian, MANUAL_C());
    await ingestAs(w, w.librarian, MANUAL_B());
    await ingestAs(w, w.librarian, BOM_7());
    await ingestAs(w, w.people.operator!, WORK_ORDERS(asset.assetId, 'nwr-2d-48-work-orders-conflict.csv'));
    incidentId = await openIncident(w, asset.assetId);
    const c = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId: incidentId as never,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    evidenceRevisionId = c.evidenceRevisionId;
    expect(c.conflictCount).toBeGreaterThanOrEqual(1);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('preserves both sources, marks the conflict and makes no authoritative claim', async () => {
    const view = await retrieveEvidence(w.db.pool, w.people.viewer!.ctx, { evidenceRevisionId: evidenceRevisionId as never });
    const fan = view.facts.find((f) => f.factKey === 'part:evaporator-fan-motor')!;
    expect(fan.status).toBe('CONFLICT');
    expect(fan.authority).toBe('NONE');
    expect(fan.values.map((v) => v.value).sort()).toEqual(['5A1-0398', '5A1-0402']);
    const sourcesOf = (value: string) =>
      fan.values
        .find((v) => v.value === value)!
        .sources.map((s) => `${s.role}:${s.documentRevision}`)
        .sort();
    expect(sourcesOf('5A1-0402')).toEqual(['MANUAL:C', 'PARTS_LIST:BOM-7']);
    expect(sourcesOf('5A1-0398')).toEqual(['MANUAL:B', 'WORK_ORDER:export-2023']);
    // Nothing in the retrieval view is an exact-match or compatibility verdict.
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/EXACT_MATCH|ALLOW|"authority":"(?!NONE)/);
    for (const f of view.facts) expect(f.authority).toBe('NONE');

    expect(view.conflicts).toEqual([
      expect.objectContaining({ factKey: 'part:evaporator-fan-motor', values: expect.any(Array) }),
    ]);
    const stored = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, evidenceRevisionId as never);
    expect(stored.conflicts.map((c) => c.factKey)).toEqual(['part:evaporator-fan-motor']);

    // Every side of the conflict re-opens from its own immutable source.
    for (const v of fan.values)
      for (const s of v.sources) {
        const opened = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, s.citation.citationId);
        expect(opened.verified).toBe(true);
        expect(opened.text).toContain(v.value);
      }
  });

  it('a proposal that hides the conflict is annotated with both sources and forced to human review', async () => {
    const fake = new ContractFakeReasoner((req) => ({
      kind: 'FINAL',
      content: JSON.stringify(proposalFor(req, {}, '5A1-0402')),
    }));
    const run = await runReasoning(w.db.pool, w.service, { reasoner: fake, store: w.store }, { incidentId: incidentId as never });
    expect(run).toMatchObject({ status: 'COMPLETED', disposition: 'NEEDS_HUMAN_REVIEW', resultOrigin: 'CONTRACT_FAKE' });
    // The packet given to the model carried the conflict with both sides.
    const packet = fake.requests[0]!.packet;
    const conflict = packet.conflicts.find((c) => c.factKey === 'part:evaporator-fan-motor')!;
    expect(conflict.values.map((v) => v.value).sort()).toEqual(['5A1-0398', '5A1-0402']);

    const p = await getProposal(w.db.pool, w.people.viewer!.ctx, run.proposalId!);
    expect(p).toMatchObject({ authority: 'NONE', label: 'MODEL PROPOSAL', lifecycle: 'CURRENT' });
    expect(p.serverConflicts.map((c) => c.factKey)).toEqual(['part:evaporator-fan-motor']);
    expect(p.candidates[0]).toMatchObject({ conflicted: true, compatibilityClaim: 'CANDIDATE_ONLY' });
    expect(p.reviewReasons).toContain('UNREPORTED_CONFLICT');
  });

  it('a proposal that asserts exact compatibility is rejected, never stored as a proposal', async () => {
    const fake = new ContractFakeReasoner((req) => {
      const p = proposalFor(req, {}, '5A1-0402');
      const bad = { ...p, candidateActions: [{ ...p.candidateActions[0]!, compatibilityClaim: 'EXACT_MATCH' }] };
      return { kind: 'FINAL', content: JSON.stringify(bad) };
    });
    const run = await runReasoning(w.db.pool, w.service, { reasoner: fake, store: w.store }, { incidentId: incidentId as never });
    expect(run).toMatchObject({ status: 'REJECTED', disposition: 'REJECTED', proposalId: null });
    expect(run.rejectionReasons).toContain('SCHEMA_INVALID');
  });

  it('a proposal citing only one side while declaring the conflict stays a reviewable proposal', async () => {
    const fake = new ContractFakeReasoner((req) => {
      const c = req.packet.conflicts[0]!;
      return {
        kind: 'FINAL',
        content: JSON.stringify(
          proposalFor(req, {
            conflicts: [{ factKey: c.factKey, citationIds: c.values.flatMap((v) => v.citationIds).slice(0, 4) }],
            uncertainty: ['CONFLICTING_SOURCES'],
          }),
        ),
      };
    });
    const run = await runReasoning(w.db.pool, w.service, { reasoner: fake, store: w.store }, { incidentId: incidentId as never });
    expect(run.status).toBe('COMPLETED');
    expect(run.disposition).toBe('NEEDS_HUMAN_REVIEW');
    const p = await getProposal(w.db.pool, w.people.viewer!.ctx, run.proposalId!);
    expect(p.reviewReasons).toContain('CONFLICTING_EVIDENCE');
    expect(p.reviewReasons).not.toContain('UNREPORTED_CONFLICT');
  });
});
