// T-011 re-run over M05 document ingestion (INV-04, INV-15 spirit): tenant-wide (model-level) library documents and
// any document declared as an OEM publication need tenant-wide library authority. A site-scoped operator can upload
// site-scoped tenant records, but cannot publish tenant-wide evidence or self-declare an OEM source that
// compatibility policy would read as manufacturer-published.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withdrawDocument } from '../src/index.js';
import { MANUAL_C, createEvidenceWorld, ingestAs, rejection, type EvidenceWorld } from './helpers.js';

let w: EvidenceWorld;

describe('T-011 document library authority', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t011lib');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a site-scoped operator cannot ingest a tenant-wide document', async () => {
    const op = w.people.operator!;
    expect((await rejection(ingestAs(w, op, { ...MANUAL_C(), sourceKind: 'TENANT_RECORD' }))).code).toBe('FORBIDDEN');
  });

  it('a site-scoped operator cannot self-declare an OEM publication even for an asset at their own site', async () => {
    const op = w.people.operator!;
    const input = { ...MANUAL_C(), applicability: { ...MANUAL_C().applicability, assetId: w.nwr.assetId } };
    expect((await rejection(ingestAs(w, op, input))).code).toBe('FORBIDDEN');
  });

  it('tenant-wide library authority may ingest and withdraw OEM publications; a site operator may not withdraw them', async () => {
    const doc = await ingestAs(w, w.librarian, MANUAL_C());
    const denied = await rejection(
      withdrawDocument(w.db.pool, w.people.operator!.ctx, doc.documentId, { reasonCode: 'WRONG_DOCUMENT' }),
    );
    expect(['FORBIDDEN']).toContain(denied.code);
    await expect(
      withdrawDocument(w.db.pool, w.librarian.ctx, doc.documentId, { reasonCode: 'WRONG_DOCUMENT' }),
    ).resolves.toMatchObject({ withdrawn: true });
  });
});
