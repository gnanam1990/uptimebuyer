// Authentication adapters (FR-24, NFR-05). Human, device, service and integration principals authenticate
// separately and their tokens are not interchangeable. All JWT/JWS handling is delegated to `jose` (a maintained,
// production-grade implementation); this module only chooses parameters and maps subjects to stored principals.
// - Humans: OIDC bearer tokens verified against the issuer's JWKS (asymmetric algorithms only).
// - Devices/services/integrations: short-lived HS256 tokens with a distinct `typ` and audience per kind, keyed by
//   a per-principal secret resolved from its opaque credential reference through a CredentialResolver port.
import { randomUUID } from 'node:crypto';
import {
  DomainError,
  type DeviceId,
  type ProviderAccountId,
  type ServiceIdentityId,
  type SiteId,
  type TenantId,
  type UserId,
} from '@uptimebuyer/contracts';
import { decodeProtectedHeader, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import type { Db } from './db.js';
import { issuePrincipal, type AuthenticatedPrincipal } from './context.js';
import type { IntegrationIdentityId } from './ids.js';
import { recordSecurityAudit } from './security-audit.js';

/** Port to the secret store. Production adapters resolve opaque `secretref:` references; nothing is cached here. */
export interface CredentialResolver {
  resolveSigningKey(credentialRef: string): Promise<Uint8Array | undefined>;
}

/** Test/dev resolver. Keys are supplied at runtime and never persisted. */
export class InMemoryCredentialResolver implements CredentialResolver {
  private readonly keys = new Map<string, Uint8Array>();
  set(credentialRef: string, key: Uint8Array): void {
    this.keys.set(credentialRef, key);
  }
  get(credentialRef: string): Uint8Array | undefined {
    return this.keys.get(credentialRef);
  }
  async resolveSigningKey(credentialRef: string): Promise<Uint8Array | undefined> {
    return this.keys.get(credentialRef);
  }
}

const unauthenticated = () => new DomainError('UNAUTHENTICATED', 'Authentication failed.');

/** Replaceable human-session verification interface (OIDC JWT here; another IdP adapter may implement it). */
export interface HumanSessionVerifier {
  verify(token: string): Promise<{ issuer: string; subject: string }>;
}

export class HumanOidcVerifier implements HumanSessionVerifier {
  constructor(
    private readonly opts: {
      issuer: string;
      audience: string;
      keys: JWTVerifyGetKey;
      algorithms: readonly ('ES256' | 'ES384' | 'RS256' | 'PS256' | 'EdDSA')[];
      clockToleranceSeconds?: number;
      maxTokenAgeSeconds?: number;
    },
  ) {
    if (opts.algorithms.length === 0) throw new DomainError('VALIDATION_FAILED', 'At least one algorithm is required.');
  }

  async verify(token: string): Promise<{ issuer: string; subject: string }> {
    const { payload } = await jwtVerify(token, this.opts.keys, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: [...this.opts.algorithms],
      clockTolerance: this.opts.clockToleranceSeconds ?? 5,
      maxTokenAge: this.opts.maxTokenAgeSeconds ?? 3600,
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.iss !== 'string') throw unauthenticated();
    return { issuer: payload.iss, subject: payload.sub };
  }
}

/** Authenticate an `Authorization: Bearer <OIDC token>` header and map it to an active user. */
export async function authenticateHuman(
  pool: Db,
  verifier: HumanSessionVerifier,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedPrincipal> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorizationHeader ?? '');
  const fail = async (reasonCode: string): Promise<never> => {
    await recordSecurityAudit(pool, {
      principal: { kind: 'HUMAN', id: null },
      action: 'principal.authenticate',
      result: 'DENIED',
      reasonCode,
    });
    throw unauthenticated();
  };
  if (!match) return fail('MALFORMED_CREDENTIAL');
  let claims: { issuer: string; subject: string };
  try {
    claims = await verifier.verify(match[1]!);
  } catch {
    return fail('TOKEN_REJECTED');
  }
  const { rows } = await pool.query<{ id: UserId; issuer: string; status: string }>(
    `SELECT id, issuer, status FROM users WHERE external_subject = $1`,
    [claims.subject],
  );
  const user = rows[0];
  if (!user || user.issuer !== claims.issuer || user.status !== 'ACTIVE') return fail('UNKNOWN_OR_DISABLED_SUBJECT');
  return issuePrincipal({ kind: 'HUMAN', id: user.id, issuer: claims.issuer, subject: claims.subject }, 'OIDC');
}

export type MachinePrincipalKind = 'DEVICE' | 'SERVICE' | 'INTEGRATION';
const MACHINE = {
  DEVICE: { typ: 'ub-device+jwt', audience: 'urn:uptimebuyer:device', issuer: 'urn:uptimebuyer:device' },
  SERVICE: { typ: 'ub-service+jwt', audience: 'urn:uptimebuyer:service', issuer: 'urn:uptimebuyer:service' },
  INTEGRATION: {
    typ: 'ub-integration+jwt',
    audience: 'urn:uptimebuyer:integration',
    issuer: 'urn:uptimebuyer:integration',
  },
} as const satisfies Record<MachinePrincipalKind, { typ: string; audience: string; issuer: string }>;
const MIN_KEY_BYTES = 32;
const MAX_TTL_SECONDS = 900;

/**
 * Mint a machine-principal token (device firmware, workloads, integrations hold their own key). The `kid` and
 * `sub` are the principal id; the key must be at least 256 bits.
 */
export async function signPrincipalToken(
  kind: MachinePrincipalKind,
  principalId: string,
  key: Uint8Array,
  opts: { ttlSeconds?: number } = {},
): Promise<string> {
  if (!(key instanceof Uint8Array) || key.byteLength < MIN_KEY_BYTES)
    throw new DomainError('VALIDATION_FAILED', 'Signing key must be at least 32 bytes.');
  const ttl = Math.min(opts.ttlSeconds ?? 300, MAX_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const m = MACHINE[kind];
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: m.typ, kid: principalId })
    .setIssuer(m.issuer)
    .setAudience(m.audience)
    .setSubject(principalId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(randomUUID())
    .sign(key);
}

interface MachineRow {
  tenant_id: TenantId;
  id: string;
  credential_ref: string;
  site_id?: SiteId;
  workload?: string;
  provider_account_id?: ProviderAccountId | null;
}

const LOOKUP: Record<MachinePrincipalKind, string> = {
  DEVICE: `SELECT d.tenant_id, d.id, d.credential_ref, d.site_id FROM devices d JOIN tenants t ON t.id = d.tenant_id
            WHERE d.id = $1 AND d.status <> 'REVOKED' AND t.status = 'ACTIVE'`,
  SERVICE: `SELECT s.tenant_id, s.id, s.credential_ref, s.workload FROM service_identities s JOIN tenants t ON t.id = s.tenant_id
             WHERE s.id = $1 AND s.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
  INTEGRATION: `SELECT i.tenant_id, i.id, i.credential_ref, i.provider_account_id FROM integration_identities i
                 JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1 AND i.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
};

async function authenticateMachine(
  pool: Db,
  resolver: CredentialResolver,
  kind: MachinePrincipalKind,
  token: string,
): Promise<{ row: MachineRow }> {
  const m = MACHINE[kind];
  const fail = async (reasonCode: string, id: string | null = null): Promise<never> => {
    await recordSecurityAudit(pool, {
      principal: { kind, id },
      action: 'principal.authenticate',
      result: 'DENIED',
      reasonCode,
    });
    throw unauthenticated();
  };
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return fail('MALFORMED_CREDENTIAL');
  }
  if (header.alg !== 'HS256' || header.typ !== m.typ || typeof header.kid !== 'string' || header.kid.length > 80)
    return fail('WRONG_TOKEN_KIND');
  const { rows } = await pool.query<MachineRow>(LOOKUP[kind], [header.kid]);
  if (rows.length !== 1) return fail('UNKNOWN_OR_REVOKED_PRINCIPAL');
  const row = rows[0]!;
  const key = await resolver.resolveSigningKey(row.credential_ref);
  if (!key || key.byteLength < MIN_KEY_BYTES) return fail('CREDENTIAL_UNAVAILABLE', row.id);
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      typ: m.typ,
      issuer: m.issuer,
      audience: m.audience,
      subject: row.id,
      clockTolerance: 5,
      maxTokenAge: MAX_TTL_SECONDS + 60,
      requiredClaims: ['sub', 'exp', 'iat', 'jti'],
    }));
  } catch {
    return fail('TOKEN_REJECTED', row.id);
  }
  if (payload.sub !== header.kid) return fail('SUBJECT_MISMATCH', row.id);
  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length < 16 || jti.length > 64 || typeof payload.exp !== 'number')
    return fail('TOKEN_ID_INVALID', row.id);
  // One use per token id: a captured token cannot be replayed within its lifetime.
  const use = await pool.query(
    `INSERT INTO principal_token_uses (tenant_id, id, principal_kind, principal_id, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [row.tenant_id, jti, kind, row.id, payload.exp],
  );
  if (use.rowCount !== 1) return fail('TOKEN_REPLAYED', row.id);
  return { row };
}

/**
 * Structural pre-check of a machine token without any I/O: protected header (alg, typ, kid) only. Returns the claimed
 * principal id, or null when the token is not even shaped like a token of this kind. Never proof of identity.
 */
export function peekMachineTokenSubject(kind: MachinePrincipalKind, token: string): string | null {
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'HS256' || header.typ !== MACHINE[kind].typ) return null;
    return typeof header.kid === 'string' && /^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(header.kid)
      ? header.kid
      : null;
  } catch {
    return null;
  }
}

/**
 * In-memory verification of a machine token against an already-known key (same parameters as authentication).
 * Used by edge gateways to recognise a valid credential before spending failure budgets; it does NOT authenticate
 * (no revocation check, no single-use jti) — the caller must still call the authenticate function.
 */
export async function verifyMachineTokenOffline(
  kind: MachinePrincipalKind,
  token: string,
  key: Uint8Array,
): Promise<{ subject: string; jti: string } | null> {
  const m = MACHINE[kind];
  const subject = peekMachineTokenSubject(kind, token);
  if (!subject || !(key instanceof Uint8Array) || key.byteLength < MIN_KEY_BYTES) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      typ: m.typ,
      issuer: m.issuer,
      audience: m.audience,
      subject,
      clockTolerance: 5,
      maxTokenAge: MAX_TTL_SECONDS + 60,
      requiredClaims: ['sub', 'exp', 'iat', 'jti'],
    });
    return typeof payload.jti === 'string' && payload.jti.length >= 16 && payload.jti.length <= 64
      ? { subject, jti: payload.jti }
      : null;
  } catch {
    return null;
  }
}

export async function authenticateDevice(
  pool: Db,
  resolver: CredentialResolver,
  token: string,
): Promise<AuthenticatedPrincipal> {
  const { row } = await authenticateMachine(pool, resolver, 'DEVICE', token);
  return issuePrincipal(
    { kind: 'DEVICE', id: row.id as DeviceId, tenantId: row.tenant_id, siteId: row.site_id as SiteId },
    'DEVICE_TOKEN',
  );
}

export async function authenticateService(
  pool: Db,
  resolver: CredentialResolver,
  token: string,
): Promise<AuthenticatedPrincipal> {
  const { row } = await authenticateMachine(pool, resolver, 'SERVICE', token);
  return issuePrincipal(
    { kind: 'SERVICE', id: row.id as ServiceIdentityId, tenantId: row.tenant_id, workload: row.workload as string },
    'SERVICE_TOKEN',
  );
}

export async function authenticateIntegration(
  pool: Db,
  resolver: CredentialResolver,
  token: string,
): Promise<AuthenticatedPrincipal> {
  const { row } = await authenticateMachine(pool, resolver, 'INTEGRATION', token);
  return issuePrincipal(
    {
      kind: 'INTEGRATION',
      id: row.id as IntegrationIdentityId,
      tenantId: row.tenant_id,
      providerAccountId: row.provider_account_id ?? null,
    },
    'INTEGRATION_TOKEN',
  );
}
