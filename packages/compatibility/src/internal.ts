// Shared persistence helpers for M06: ids, errors, authority signing configuration, the governing policy loader and
// the current-tuple probes (latest evidence revision, current asset revision, effective AUTHORITY policy revision).
import { randomUUID } from 'node:crypto';
import { DomainError, type UtcInstant } from '@uptimebuyer/contracts';
import type { AuthorityKeyring, GoverningPolicy } from '@uptimebuyer/domain';
import { loadPolicyRevision, type AuthorityPolicy, type Queryable } from '@uptimebuyer/data';

export const COMPATIBILITY_ID_PREFIXES = Object.freeze({
  authorityRecord: 'cau',
  authorityEvent: 'cae',
  policyActivation: 'cpa',
  decisionAuthority: 'cda',
} as const);
export const newCompatibilityId = (kind: keyof typeof COMPATIBILITY_ID_PREFIXES) =>
  `${COMPATIBILITY_ID_PREFIXES[kind]}_${randomUUID()}`;

export const hold = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('POLICY_HOLD', 'Compatibility policy holds this request.', { reasonCode, ...details });
export const invalid = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode, ...details });

/**
 * The authority service's signing configuration: the current key id and a keyring of master keys (current plus
 * retired keys still needed to verify historical records). Supplied by runtime configuration, never by a client.
 */
export interface AuthoritySigning {
  readonly keyId: string;
  readonly keyring: AuthorityKeyring;
}

export function assertSigning(s: AuthoritySigning | undefined): AuthoritySigning {
  const key = s && Object.hasOwn(s.keyring, s.keyId) ? s.keyring[s.keyId] : undefined;
  if (!s || !(key instanceof Uint8Array) || key.byteLength < 32)
    throw new DomainError('DEPENDENCY_FAILED', 'Authority signing is not configured.', {
      reasonCode: 'AUTHORITY_SIGNING_UNCONFIGURED',
    });
  return s;
}

/**
 * Read the signing configuration from the authority workload's environment: COMPATIBILITY_AUTHORITY_KEY_ID and
 * COMPATIBILITY_AUTHORITY_KEY (base64url, at least 32 bytes). Absent configuration is an explicit error.
 */
export function authoritySigningFromEnv(env: Record<string, string | undefined> = process.env): AuthoritySigning {
  const keyId = env.COMPATIBILITY_AUTHORITY_KEY_ID;
  const raw = env.COMPATIBILITY_AUTHORITY_KEY;
  if (!keyId || !raw) return assertSigning(undefined);
  return assertSigning({ keyId, keyring: Object.freeze({ [keyId]: new Uint8Array(Buffer.from(raw, 'base64url')) }) });
}

export const PURCHASE_KINDS: readonly string[] = ['PART_PURCHASE', 'CONTAINMENT_PURCHASE'];

export async function loadGoverning(
  q: Queryable,
  tenantId: string,
  policyRevisionId: string,
): Promise<(GoverningPolicy & { effectiveNow: boolean }) | undefined> {
  const r = await loadPolicyRevision(q, tenantId as never, policyRevisionId);
  if (!r || r.policyKey !== 'AUTHORITY') return undefined;
  const body = r.body as AuthorityPolicy;
  return {
    policyRevisionId: r.policyRevisionId,
    bodyDigest: r.bodyDigest,
    compatibility: (body.compatibility ?? null) as GoverningPolicy['compatibility'],
    approvalLimits: body.approvalLimits,
    effectiveNow: r.effectiveNow,
  };
}

export async function effectiveAuthorityRevisionId(q: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT r.id FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE r.tenant_id = $1 AND p.policy_key = 'AUTHORITY' AND r.effective_at <= clock_timestamp()
      ORDER BY r.effective_at DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.id ?? null;
}

export async function latestEvidenceRevision(
  q: Queryable,
  tenantId: string,
  incidentId: string,
): Promise<{ id: string; asset_revision_id: string } | undefined> {
  const { rows } = await q.query<{ id: string; asset_revision_id: string }>(
    `SELECT id, asset_revision_id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2
      ORDER BY revision DESC LIMIT 1`,
    [tenantId, incidentId],
  );
  return rows[0];
}

export async function currentAssetRevisionId(q: Queryable, tenantId: string, assetId: string): Promise<string | null> {
  const { rows } = await q.query<{ current_revision_id: string }>(
    `SELECT current_revision_id FROM assets WHERE tenant_id = $1 AND id = $2`,
    [tenantId, assetId],
  );
  return rows[0]?.current_revision_id ?? null;
}

export const isoOf = (d: Date | string | null): UtcInstant | null =>
  d === null ? null : (new Date(d).toISOString() as UtcInstant);

/** Roles the registry says a human holds at `siteId` right now (active membership, unrevoked grants). */
export async function heldRolesAt(q: Queryable, tenantId: string, userId: string, siteId: string) {
  const { rows } = await q.query<{ id: string; role: string }>(
    `SELECT ra.id, ra.role FROM role_assignments ra
       JOIN tenant_memberships m ON m.tenant_id = ra.tenant_id AND m.user_id = ra.user_id
      WHERE ra.tenant_id = $1 AND ra.user_id = $2 AND ra.principal_kind = 'HUMAN' AND ra.revoked_at IS NULL
        AND m.status = 'ACTIVE' AND (ra.site_id IS NULL OR ra.site_id = $3)
      ORDER BY ra.id`,
    [tenantId, userId, siteId],
  );
  return { roles: [...new Set(rows.map((r) => r.role))].sort(), grantIds: rows.map((r) => r.id) };
}
