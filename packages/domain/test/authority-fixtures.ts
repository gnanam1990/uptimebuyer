// Test-only authority-record fixtures. The signing key is generated at runtime (never committed) and lives only in
// this module; the production package index exports no fixture signer (security review, M06).
import { randomBytes } from 'node:crypto';
import type { CompatibilityDecisionId } from '@uptimebuyer/contracts';
import {
  signAuthorityRecord,
  type AuthorityEvidence,
  type AuthorityRecord,
  type CompatibilityInput,
  type UnsignedAuthorityRecord,
} from '../src/index.js';

export const FIXTURE_KEY_ID = 'fixture-k1';
export const FIXTURE_MASTER_KEY = new Uint8Array(randomBytes(32));
export const FIXTURE_KEYRING: Readonly<Record<string, Uint8Array>> = Object.freeze({
  [FIXTURE_KEY_ID]: FIXTURE_MASTER_KEY,
});

let seq = 0;
export function unsignedAuthority(
  input: CompatibilityInput,
  over: Partial<UnsignedAuthorityRecord> = {},
): UnsignedAuthorityRecord {
  const b = input.binding;
  return {
    authorityRecordId: `cau_fixture-${++seq}`,
    kind: 'ENGINEER_EXCEPTION',
    tenantId: b.tenantId,
    siteId: b.siteId,
    incidentId: b.incidentId,
    candidateActionId: b.candidateActionId,
    assetRevisionId: b.assetRevisionId,
    evidenceRevisionId: b.evidenceRevisionId,
    policyRevisionId: b.policyRevisionId,
    actionDigest: b.actionDigest,
    heldDecisionId: 'cmp_fixture-held' as CompatibilityDecisionId,
    exceptionClasses: [],
    overriddenReasons: [],
    actorUserId: 'usr_fixture-engineer',
    actorRole: 'engineer',
    reasonCode: 'OEM_PART_BACKORDERED',
    reasonText: 'Superseded OEM motor with identical mounting and rating; verified on site.',
    issuedAt: '2026-11-01T11:00:00.000Z',
    expiresAt: '2026-11-01T23:00:00.000Z',
    status: 'ACTIVE',
    ...over,
  } as UnsignedAuthorityRecord;
}

/** A record bound to `input`'s tuple, signed (after `over` is applied) with the fixture key. */
export function fixtureAuthority(
  input: CompatibilityInput,
  over: Partial<UnsignedAuthorityRecord> = {},
  key: Uint8Array = FIXTURE_MASTER_KEY,
  keyId: string = FIXTURE_KEY_ID,
): AuthorityRecord {
  return signAuthorityRecord(unsignedAuthority(input, over), key, keyId);
}

/** Authority evidence as the server assembles it: the record plus the roles the registry says the actor holds. */
export const held = (record: AuthorityRecord, heldRoles: string[] = [record.actorRole]): AuthorityEvidence => ({
  record,
  heldRoles,
});
