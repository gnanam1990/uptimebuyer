// Shared fixtures for the M05 evidence tests: the M04 incident world (throwaway database, tenant, site, people, a
// worker service, procedure and rule), a Northwind NWR-2D-48 asset, a throwaway local object store, fixture
// documents and contract-fake proposal builders. Synthetic secrets are assembled at runtime only.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetId, AssetRevisionId, IncidentId } from '@uptimebuyer/contracts';
import { getAsset, recordRegistryEdit, registerAsset } from '@uptimebuyer/data';
import { submitManualReport } from '@uptimebuyer/incidents';
import {
  HIGH_TEMP_RULE,
  createIncidentWorld,
  person,
  rejection,
  type IncidentWorld,
  type Person,
} from '../../incidents/test/helpers.js';
import {
  LocalFilesystemObjectStore,
  ingestDocument,
  type IngestDocumentInput,
  type ReasonerRequest,
  type ReasoningProposal,
} from '../src/index.js';
import { MANUFACTURER, MODEL } from './fixtures/content.js';

export { rejection, person, type Person };

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): Buffer => readFileSync(join(here, 'fixtures', name));
export const sha256Of = (b: Uint8Array | string) =>
  `sha256:${createHash('sha256')
    .update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b)
    .digest('hex')}`;

export interface EvidenceWorld extends IncidentWorld {
  store: LocalFilesystemObjectStore;
  storeRoot: string;
  /** Tenant-wide operator: model-wide documents (manuals, BOMs) need a tenant-level evidence.submit grant. */
  librarian: Person;
  nwr: { assetId: AssetId; assetRevisionId: AssetRevisionId };
}

let serial = 0;
export async function nwrAsset(
  w: IncidentWorld,
  opts: { bomRevision?: string; model?: string } = {},
): Promise<{ assetId: AssetId; assetRevisionId: AssetRevisionId }> {
  const a = await registerAsset(w.db.pool, w.admin, {
    siteId: w.siteId,
    identity: {
      manufacturer: MANUFACTURER,
      model: opts.model ?? MODEL,
      serial: `NW48-24${String(++serial).padStart(5, '0')}-${randomBytes(2).toString('hex')}`,
      safetyClass: 'STANDARD',
      bomRevision: opts.bomRevision ?? 'BOM-7',
    },
    source: 'API',
  });
  return { assetId: a.assetId, assetRevisionId: a.assetRevisionId };
}

export async function createEvidenceWorld(label: string): Promise<EvidenceWorld> {
  const w = await createIncidentWorld(label);
  const storeRoot = mkdtempSync(join(tmpdir(), `ub-m05-${label}-`));
  const store = new LocalFilesystemObjectStore(storeRoot);
  const librarian = await person(w, 'librarian', ['operator'], null);
  const nwr = await nwrAsset(w);
  const close = w.close;
  return {
    ...w,
    store,
    storeRoot,
    librarian,
    nwr,
    async close() {
      await close();
      rmSync(storeRoot, { recursive: true, force: true });
    },
  };
}

/** Open (or join) an incident on `assetId` through an authorized operator's manual report. */
export async function openIncident(w: EvidenceWorld, assetId: AssetId): Promise<IncidentId> {
  const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
    idempotencyKey: w.key('report'),
    assetId,
    ruleKey: HIGH_TEMP_RULE.ruleKey,
    reasonCode: 'CABINET_WARM',
    note: 'Cabinet reads 9 C; evaporator fan silent.',
    observedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return r.incidentId as IncidentId;
}

type Applicability = IngestDocumentInput['applicability'];
const modelWide = (extra: Partial<Applicability> = {}): Applicability => ({
  manufacturer: MANUFACTURER,
  model: MODEL,
  bomRevision: null,
  serial: null,
  assetId: null,
  ...extra,
});

export const MANUAL_C = (): IngestDocumentInput => ({
  role: 'MANUAL',
  mediaType: 'application/pdf',
  bytes: fixture('nwr-sm-48-rev-c.pdf'),
  title: 'NWR-SM-48 Service Manual',
  documentRevision: 'C',
  applicability: modelWide(),
  sourceKind: 'OEM_PUBLICATION',
  sourceRef: 'Northwind dealer portal export NWR-SM-48-C',
});
export const MANUAL_B = (): IngestDocumentInput => ({
  ...MANUAL_C(),
  bytes: fixture('nwr-sm-48-rev-b.pdf'),
  documentRevision: 'B',
  sourceRef: 'Northwind dealer portal export NWR-SM-48-B',
});
export const BOM_7 = (): IngestDocumentInput => ({
  role: 'PARTS_LIST',
  mediaType: 'text/csv',
  bytes: fixture('nwr-2d-48-bom-7.csv'),
  title: 'NWR-2D-48 bill of materials',
  documentRevision: 'BOM-7',
  applicability: modelWide({ bomRevision: 'BOM-7' }),
  sourceKind: 'OEM_PUBLICATION',
  sourceRef: null,
});
export const WORK_ORDERS = (assetId: AssetId, name = 'nwr-2d-48-work-orders.csv'): IngestDocumentInput => ({
  role: 'WORK_ORDER',
  mediaType: 'text/csv',
  bytes: fixture(name),
  title: 'CMMS work order history',
  documentRevision: name.includes('conflict') ? 'export-2023' : 'export-2025',
  applicability: modelWide({ assetId }),
  sourceKind: 'SERVICE_HISTORY',
  sourceRef: 'CMMS export',
});

export async function ingestAs(w: EvidenceWorld, who: Person, input: IngestDocumentInput) {
  return ingestDocument(w.db.pool, who.ctx, w.store, input);
}

/** Warranty and approved-vendor registry records for the asset/site (cited as RECORD evidence). */
export async function seedRegistryRecords(w: EvidenceWorld, assetId: AssetId) {
  await recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'WARRANTY',
    entityId: assetId,
    body: { provider: 'Northwind Refrigeration', expiresOn: '2027-03-31', termsBlobId: null },
    source: 'API',
  });
  const vendor = await recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'APPROVED_VENDOR',
    entityId: null,
    body: { vendorName: 'Coldline Service Co', status: 'APPROVED', siteIds: [w.siteId] },
    source: 'API',
  });
  return { vendorId: vendor.entityId };
}

export async function currentAssetRevision(w: EvidenceWorld, assetId: AssetId) {
  const a = await getAsset(w.db.pool, w.admin, assetId);
  return { assetRevisionId: a.current.assetRevisionId, version: a.version, current: a.current };
}

/** Citations the packet offers for spans containing `needle`. */
export function excerptCitations(req: ReasonerRequest, needle: string) {
  return req.packet.excerpts.filter((e) => e.text.includes(needle));
}

/**
 * A schema-valid proposal a contract fake would return for `req`: it echoes the binding, cites the packet excerpts
 * that contain `needle` and proposes replacing the evaporator fan motor. `overrides` patch the top level.
 */
export function proposalFor(
  req: ReasonerRequest,
  overrides: Partial<ReasoningProposal> = {},
  needle = 'Evaporator fan motor',
): ReasoningProposal {
  const cites = excerptCitations(req, needle).slice(0, 2);
  if (cites.length === 0) throw new Error(`no excerpt contains ${needle}`);
  const citation = (e: (typeof cites)[number]) => ({
    citationId: e.citationId,
    sourceDigest: e.sourceDigest,
    locator: e.locator,
    quote: needle,
  });
  return {
    schemaVersion: 1,
    incidentId: req.packet.incident.incidentId,
    evidenceRevisionId: req.packet.binding.evidenceRevisionId,
    inputDigest: req.inputDigest,
    faultHypotheses: [
      {
        code: 'EVAPORATOR_FAN_FAILURE',
        rationale: 'Fan silent with power present per troubleshooting steps.',
        citationIds: [cites[0]!.citationId],
      },
    ],
    extractedFields: [
      {
        field: 'OEM_PART_NUMBER',
        component: 'Evaporator fan motor',
        value: '5A1-0402',
        citations: cites.map(citation),
      },
    ],
    candidateActions: [
      {
        kind: 'REPLACE_PART',
        component: 'Evaporator fan motor',
        partNumber: '5A1-0402',
        manufacturer: 'Northwind Refrigeration',
        evidenceFor: cites.map((c) => c.citationId),
        evidenceAgainst: [],
        missingFields: [],
        compatibilityClaim: 'CANDIDATE_ONLY',
      },
    ],
    conflicts: [],
    uncertainty: [],
    providerQueries: [{ kind: 'PART_AVAILABILITY', component: 'Evaporator fan motor', partNumber: '5A1-0402' }],
    confidencePpm: 720_000,
    summary: 'Evaporator fan motor likely failed; replacement candidate cited from manual and BOM.',
    ...overrides,
  };
}

/** Runtime-assembled canary that looks like a credential (never committed as a literal). */
export const canary = (label: string) => ['sk', 'live', label, randomBytes(12).toString('hex')].join('-');
