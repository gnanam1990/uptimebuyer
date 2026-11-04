// T-010 re-run over the M05 tables (INV-16): documents, spans, citations, evidence revisions, reasoning runs and
// proposals are reachable only inside the caller's tenant and site scope. A foreign or nonexistent identifier gives
// the same RESOURCE_UNAVAILABLE denial, the structural tenant-key gate covers the new tables, and object keys can
// never name another tenant's namespace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSite } from '@uptimebuyer/data';
import { seedTenant } from '../../data/test/helpers.js';
import {
  ContractFakeReasoner,
  commitIncidentEvidence,
  getDocument,
  getEvidenceRevision,
  getProposal,
  getReasoningRun,
  reopenCitation,
  retrieveEvidence,
  runReasoning,
  searchEvidence,
  withdrawDocument,
} from '../src/index.js';
import {
  BOM_7,
  MANUAL_C,
  createEvidenceWorld,
  ingestAs,
  openIncident,
  person,
  proposalFor,
  rejection,
  type EvidenceWorld,
} from './helpers.js';

let w: EvidenceWorld;
let ids: { documentId: string; evidenceRevisionId: string; citationId: string; runId: string; proposalId: string };
let foreign: Awaited<ReturnType<typeof seedTenant>>;

const M05_TABLES = [
  'evidence_documents',
  'evidence_document_events',
  'evidence_document_spans',
  'evidence_document_facts',
  'evidence_revision_contents',
  'evidence_revision_documents',
  'evidence_revision_conflicts',
  'citations',
  'reasoning_runs',
  'reasoning_proposals',
];

describe('T-010 evidence and reasoning cross-tenant denial', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t010e');
    const doc = await ingestAs(w, w.librarian, MANUAL_C());
    await ingestAs(w, w.librarian, BOM_7());
    const incidentId = await openIncident(w, w.nwr.assetId);
    const rev = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    const hits = await searchEvidence(w.db.pool, w.people.operator!.ctx, {
      evidenceRevisionId: rev.evidenceRevisionId,
      query: 'evaporator fan motor',
    });
    const run = await runReasoning(
      w.db.pool,
      w.service,
      {
        reasoner: new ContractFakeReasoner((req) => ({ kind: 'FINAL', content: JSON.stringify(proposalFor(req)) })),
        store: w.store,
      },
      { incidentId },
    );
    ids = {
      documentId: doc.documentId,
      evidenceRevisionId: rev.evidenceRevisionId,
      citationId: hits[0]!.citation.citationId,
      runId: run.reasoningRunId,
      proposalId: run.proposalId!,
    };
    foreign = await seedTenant(w.db.pool, w.idp, 't010e-beta');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('every M05 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M05_TABLES) {
      const col = await w.db.pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(col.rows[0]?.is_nullable, table).toBe('NO');
      const fks = await w.db.pool.query(
        `SELECT conname, (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'`,
        [table],
      );
      for (const fk of fks.rows) expect(fk.first, `${table}.${fk.conname}`).toBe('tenant_id');
    }
  });

  it('another tenant sees the same denial as for a nonexistent id, on every read and write path', async () => {
    const other = foreign.admin;
    const probes: [string, () => Promise<unknown>][] = [
      ['document', () => getDocument(w.db.pool, other, ids.documentId as never)],
      ['withdraw', () => withdrawDocument(w.db.pool, other, ids.documentId as never, { reasonCode: 'X' })],
      ['revision', () => getEvidenceRevision(w.db.pool, other, ids.evidenceRevisionId as never)],
      ['retrieve', () => retrieveEvidence(w.db.pool, other, { evidenceRevisionId: ids.evidenceRevisionId as never })],
      ['search', () => searchEvidence(w.db.pool, other, { evidenceRevisionId: ids.evidenceRevisionId as never, query: 'fan' })],
      ['citation', () => reopenCitation(w.db.pool, other, w.store, ids.citationId as never)],
      ['run', () => getReasoningRun(w.db.pool, other, ids.runId)],
      ['proposal', () => getProposal(w.db.pool, other, ids.proposalId)],
    ];
    for (const [name, probe] of probes) {
      const r = await rejection(probe());
      expect([name, r.code, r.reasonCode]).toEqual([name, 'FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
    const missing = await rejection(getEvidenceRevision(w.db.pool, w.admin, 'evr_does-not-exist' as never));
    expect([missing.code, missing.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
  });

  it('a member scoped to another site cannot read this site’s evidence', async () => {
    const s2 = (await createSite(w.db.pool, w.admin, { name: 'other', timezone: 'Europe/London', source: 'API' })).siteId;
    const outsider = await person(w, 'outsider', ['viewer'], s2);
    const r = await rejection(retrieveEvidence(w.db.pool, outsider.ctx, { evidenceRevisionId: ids.evidenceRevisionId as never }));
    expect(r.code).toBe('FORBIDDEN');
    const c = await rejection(reopenCitation(w.db.pool, outsider.ctx, w.store, ids.citationId as never));
    expect(c.code).toBe('FORBIDDEN');
  });

  it('a citation cannot be redirected to a foreign tenant object key', async () => {
    const r = await rejection(
      w.db.pool.query(`UPDATE evidence_documents SET blob_id = blob_id WHERE tenant_id = $1`, [w.tenant.tenantId]),
    );
    expect(r.code).toBe('UB001');
    // The object key is derived from the server tenant: a foreign-tenant key is refused by the store port.
    const { assertObjectKeyInTenant } = await import('@uptimebuyer/data');
    expect(() => assertObjectKeyInTenant(foreign.admin, `tenants/${w.tenant.tenantId}/evidence/${'a'.repeat(64)}`)).toThrow();
  });
});
