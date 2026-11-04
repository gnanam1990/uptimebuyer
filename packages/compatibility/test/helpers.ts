// Shared fixtures for the M06 integration tests: the M05 evidence world (throwaway database, tenant, site, people,
// worker service, Northwind NWR-2D-48 asset and object store) plus a named engineer, a finance approver, an engineer
// at another site, a paid provider-account revision, warranty and approved-vendor registry records, an OEM part data
// sheet, and an AUTHORITY policy revision carrying the compatibility/safety section. Nothing here is a real provider,
// manual or payment; every document is a fictional fixture.
import { randomBytes } from 'node:crypto';
import { money, type AssetId, type IncidentId } from '@uptimebuyer/contracts';
import { createProviderAccount, createSite, recordRegistryEdit, type AuthorityPolicy } from '@uptimebuyer/data';
import { commitIncidentEvidence, searchEvidence, type IngestDocumentInput } from '@uptimebuyer/evidence';
import {
  BOM_7,
  MANUAL_C,
  createEvidenceWorld,
  ingestAs,
  nwrAsset,
  openIncident,
  person,
  type EvidenceWorld,
  type Person,
} from '../../evidence/test/helpers.js';
import { MANUFACTURER, MODEL } from '../../evidence/test/fixtures/content.js';
import {
  publishCompatibilityPolicy,
  recordAuthority,
  registerCandidateAction,
  type AuthoritySigning,
  type CompatibilityPolicy,
  type RegisterCandidateInput,
} from '../src/index.js';

export { rejection, person, type Person } from '../../evidence/test/helpers.js';
export { MANUFACTURER, MODEL };

export const DAY = 86_400_000;

export interface CompatWorld extends EvidenceWorld {
  engineer: Person;
  farEngineer: Person;
  finance: Person;
  otherSiteId: string;
  providerAccountRevisionId: string;
  vendorId: string;
  unapprovedVendorId: string;
  policyRevisionId: string;
  /** The authority service's signing configuration; the key is generated at runtime and never persisted. */
  signing: AuthoritySigning;
}

/** The OEM part data sheet: exact electrical spec lines plus the listing certification (cited by candidates). */
export const DATASHEET = (): IngestDocumentInput => ({
  role: 'OTHER',
  mediaType: 'text/markdown',
  bytes: Buffer.from(
    [
      '# Northwind 5A1-0402 evaporator fan motor data sheet',
      '',
      'Rated voltage: 115 V',
      '',
      'Frequency: 60 Hz',
      '',
      'Certification: UL 471',
      '',
    ].join('\n'),
  ),
  title: 'Northwind 5A1-0402 data sheet',
  documentRevision: '2025-04',
  applicability: { manufacturer: MANUFACTURER, model: MODEL, bomRevision: null, serial: null, assetId: null },
  sourceKind: 'OEM_PUBLICATION',
  sourceRef: 'Northwind dealer portal export DS-5A1-0402',
});

/** A marketplace listing: seller text only (PROVIDER_DOCUMENT), never authoritative. */
export const SELLER_LISTING = (): IngestDocumentInput => ({
  role: 'OTHER',
  mediaType: 'text/plain',
  bytes: Buffer.from(
    [
      'Coldline universal evaporator fan motor CL-9000',
      'Seller note: compatible replacement for Northwind NWR-2D-48, fits like OEM',
      'Seller note: certification UL 471 claimed by seller',
      '',
    ].join('\n'),
  ),
  title: 'Marketplace listing CL-9000',
  documentRevision: 'listing-1',
  applicability: { manufacturer: MANUFACTURER, model: MODEL, bomRevision: null, serial: null, assetId: null },
  sourceKind: 'PROVIDER_DOCUMENT',
  sourceRef: 'marketplace listing snapshot',
});

export function compatibilityPolicy(over: Partial<CompatibilityPolicy> = {}): CompatibilityPolicy {
  return {
    schemaVersion: 1,
    ruleSet: 'northwind-cold-chain.r1',
    authoritativeSources: [
      {
        category: 'PART_IDENTITY',
        roles: ['MANUAL', 'PARTS_LIST'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'ELECTRICAL',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'MECHANICAL',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'CERTIFICATION',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'WARRANTY',
        roles: ['WARRANTY'],
        sourceKinds: ['REGISTRY_SNAPSHOT'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'VENDOR',
        roles: ['VENDOR_RECORD'],
        sourceKinds: ['REGISTRY_SNAPSHOT'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
    ],
    mandatoryConstraints: [
      { key: 'rated-voltage', category: 'ELECTRICAL' },
      { key: 'frequency', category: 'ELECTRICAL' },
      { key: 'refrigerant', category: 'MECHANICAL' },
    ],
    requiredCertifications: [{ code: 'UL 471', components: null }],
    warranty: { statusRequired: true },
    substitution: { mode: 'ENGINEER_EXCEPTION' },
    safetyClasses: [
      { components: ['evaporator-fan-motor'], actionKinds: null, assetSafetyClasses: null, safetyClass: 'STANDARD' },
      { components: ['compressor'], actionKinds: null, assetSafetyClasses: null, safetyClass: 'SAFETY_CRITICAL' },
      { components: ['refrigerant-circuit'], actionKinds: null, assetSafetyClasses: null, safetyClass: 'PROHIBITED' },
    ],
    overridableReasons: ['VENDOR_NOT_APPROVED', 'WARRANTY_REQUIRES_OEM_PART'],
    freshness: { maxOfferAgeMs: DAY },
    autoPermit: [{ siteIds: null, currency: 'USD', maxAmountMinor: 50_000n, actionKinds: ['PART_PURCHASE'] }],
    authorityMaxTtlMs: 3 * DAY,
    ...over,
  };
}

export const APPROVAL_LIMITS: AuthorityPolicy['approvalLimits'] = [
  {
    approvalKind: 'PLAN_ACTION',
    actionClass: 'STANDARD',
    role: 'maintenance_approver',
    currency: 'USD',
    maxAmountMinor: 500_000n,
    siteIds: null,
  },
  {
    approvalKind: 'PLAN_ACTION',
    actionClass: 'POLICY_OVERRIDE',
    role: 'maintenance_approver',
    currency: 'USD',
    maxAmountMinor: 500_000n,
    siteIds: null,
  },
];

export async function publishPolicy(
  w: EvidenceWorld,
  compatibility: CompatibilityPolicy = compatibilityPolicy(),
  effectiveAt?: string,
) {
  return publishCompatibilityPolicy(w.db.pool, w.admin, {
    body: { approvalLimits: APPROVAL_LIMITS, compatibility },
    effectiveAt: effectiveAt as never,
    source: 'API',
  });
}

export async function warranty(w: EvidenceWorld, assetId: AssetId, expiresOn = '2027-03-31') {
  await recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'WARRANTY',
    entityId: assetId,
    body: { provider: 'Northwind Refrigeration', expiresOn, termsBlobId: null },
    source: 'API',
  });
}

export async function createCompatWorld(label: string): Promise<CompatWorld> {
  const w = await createEvidenceWorld(label);
  const engineer = await person(w, 'engineer', ['engineer', 'operator'], w.siteId);
  const finance = await person(w, 'finance', ['finance_approver', 'operator'], w.siteId);
  const otherSiteId = (
    await createSite(w.db.pool, w.admin, { name: 'Depot', timezone: 'Europe/London', source: 'API' })
  ).siteId;
  const farEngineer = await person(w, 'far-engineer', ['engineer', 'operator'], otherSiteId);
  const provider = await createProviderAccount(w.db.pool, w.admin, {
    providerKey: 'parts-marketplace',
    environment: 'SANDBOX',
    revision: {
      capabilities: ['PURCHASE', 'QUOTE'],
      paid: true,
      ownerService: 'KITE_BROKER_PAID',
      credentialRef: `secretref:provider/tenants/${w.tenant.tenantId}/${label}-parts`,
      endpointPolicyDigest: `sha256:${'d'.repeat(64)}`,
      webhookVerifierRef: `secretref:webhook/tenants/${w.tenant.tenantId}/${label}-parts`,
    },
    source: 'API',
  });
  await warranty(w, w.nwr.assetId);
  const vendor = await recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'APPROVED_VENDOR',
    entityId: null,
    body: { vendorName: 'Coldline Service Co', status: 'APPROVED', siteIds: [w.siteId] },
    source: 'API',
  });
  const unapproved = await recordRegistryEdit(w.db.pool, w.admin, {
    entityKind: 'APPROVED_VENDOR',
    entityId: null,
    body: { vendorName: 'Grey Market Parts', status: 'SUSPENDED', siteIds: [w.siteId] },
    source: 'API',
  });
  const policy = await publishPolicy(w);
  await ingestAs(w, w.librarian, MANUAL_C());
  await ingestAs(w, w.librarian, BOM_7());
  await ingestAs(w, w.librarian, DATASHEET());
  return {
    ...w,
    engineer,
    farEngineer,
    finance,
    otherSiteId,
    providerAccountRevisionId: provider.providerAccountRevisionId,
    vendorId: vendor.entityId,
    unapprovedVendorId: unapproved.entityId,
    policyRevisionId: policy.policyRevisionId,
    signing: { keyId: 'test-k1', keyring: Object.freeze({ 'test-k1': new Uint8Array(randomBytes(32)) }) },
  };
}

/** A fresh NWR asset (with warranty), an incident on it and its first evidence revision. */
export async function incidentWithEvidence(
  w: CompatWorld,
  opts: { warrantyExpiresOn?: string; assetId?: AssetId } = {},
): Promise<{ assetId: AssetId; incidentId: IncidentId; evidenceRevisionId: string }> {
  let assetId = opts.assetId;
  if (!assetId) {
    assetId = (await nwrAsset(w)).assetId;
    await warranty(w, assetId, opts.warrantyExpiresOn);
  }
  const incidentId = await openIncident(w, assetId);
  const rev = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
    incidentId,
    reasonCode: 'TRIAGE_EVIDENCE',
  });
  return { assetId, incidentId, evidenceRevisionId: rev.evidenceRevisionId };
}

export async function citationFor(w: CompatWorld, evidenceRevisionId: string, query: string, title?: string) {
  const hits = await searchEvidence(w.db.pool, w.people.operator!.ctx, { evidenceRevisionId, query, limit: 20 });
  const hit = hits.find((h) => (title ? h.title === title : true));
  if (!hit) throw new Error(`no evidence hit for ${query}`);
  return hit.citation.citationId;
}

export const merchant = () => `mer_${randomBytes(6).toString('hex')}`;

/** The exact OEM candidate (5A1-0402 from the approved vendor) with the cited UL 471 listing. */
export async function exactCandidate(
  w: CompatWorld,
  inc: { incidentId: IncidentId; evidenceRevisionId: string },
  over: Partial<RegisterCandidateInput> = {},
  who: Person = w.people.operator!,
) {
  const cert = await citationFor(w, inc.evidenceRevisionId, 'Certification UL 471', 'Northwind 5A1-0402 data sheet');
  return registerCandidateAction(w.db.pool, who.ctx, {
    incidentId: inc.incidentId,
    kind: 'PART_PURCHASE',
    component: 'Evaporator fan motor',
    manufacturer: MANUFACTURER,
    partNumber: '5A1-0402',
    quantity: 1,
    vendorId: w.vendorId,
    providerAccountRevisionId: w.providerAccountRevisionId,
    merchantId: 'mer_coldline-0001',
    amount: money(18_500n, 'USD'),
    purpose: 'PART_PURCHASE',
    offerObservedAt: new Date(Date.now() - 60_000).toISOString(),
    specClaims: [],
    certificationClaims: [{ code: 'UL 471', citationId: cert }],
    explanation: {
      origin: 'OPERATOR',
      proposalId: null,
      modelConfidencePpm: null,
      searchRank: null,
      semanticScorePpm: null,
      sellerClaim: null,
    },
    ...over,
  } as RegisterCandidateInput);
}

export async function outboxEvents(w: EvidenceWorld, eventType: string, aggregateId?: string) {
  const { rows } = await w.db.pool.query(
    `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = $2 AND ($3::text IS NULL OR aggregate_id = $3)
      ORDER BY seq`,
    [w.tenant.tenantId, eventType, aggregateId ?? null],
  );
  return rows.map((r) => ({
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
  }));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The named engineer's exception for a held substitute decision. */
export async function recordAuthorityFor(w: CompatWorld, compatibilityDecisionId: string) {
  return recordAuthority(
    w.db.pool,
    w.engineer.ctx,
    {
      compatibilityDecisionId,
      kind: 'ENGINEER_EXCEPTION',
      reasonCode: 'OEM_PART_BACKORDERED',
      reasonText: 'Superseded OEM motor with identical mounting and rating; checked on site.',
      expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    },
    w.signing,
  );
}
