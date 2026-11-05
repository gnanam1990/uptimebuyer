// Shared M11 plumbing: identifiers, validation, the recovery signing keyring (HMAC seals for authority-capable evidence,
// milestones and closeout decisions), tenant-scoped incident loading with site authorization inside the caller's
// transaction, Idempotency-Key receipts and the evaluation-instant rule.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError, IncidentIdSchema } from '@uptimebuyer/contracts';
import {
  Denial,
  authorize,
  dbNow,
  notPermitted,
  sha256Digest,
  unavailable,
  type ActionName,
  type CommandMeta,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { canonicalize } from '@uptimebuyer/domain';
import { z } from 'zod';

export const RECOVERY_ID_PREFIXES = Object.freeze({
  policyRevision: 'rpr',
  cmmsIntegration: 'cmi',
  evidence: 'rce',
  dispute: 'rcd',
  milestone: 'iml',
  evaluation: 'rev',
  evaluationTransition: 'rvt',
  assessment: 'ras',
  closeout: 'rco',
  cmmsUpdate: 'cwu',
  cmmsAttempt: 'cwa',
} as const);
export const newRecoveryId = (kind: keyof typeof RECOVERY_ID_PREFIXES): string =>
  `${RECOVERY_ID_PREFIXES[kind]}_${randomUUID()}`;

export const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });
export const hold = (reasonCode: string, message = 'Recovery policy does not permit this.') =>
  new DomainError('POLICY_HOLD', message, { reasonCode });

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw validation('INVALID_INPUT');
  return r.data;
}

export const ms = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v));
export const isoOf = (v: Date | string | number) => new Date(typeof v === 'number' ? v : ms(v)).toISOString();
export const isoOrNull = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : isoOf(v));

/** Runtime signing keyring (HMAC-SHA256, >= 32-byte keys); retired keys stay in the ring to verify history. */
export interface RecoverySigning {
  readonly keyId: string;
  readonly keyring: Readonly<Record<string, Uint8Array>>;
}

export function assertSigning(s: RecoverySigning | undefined): RecoverySigning {
  const key = s && Object.hasOwn(s.keyring, s.keyId) ? s.keyring[s.keyId] : undefined;
  if (!s || !(key instanceof Uint8Array) || key.byteLength < 32)
    throw new DomainError('DEPENDENCY_FAILED', 'Recovery signing is not configured.', {
      reasonCode: 'RECOVERY_SIGNING_UNCONFIGURED',
    });
  return s;
}

/** Recovery signing from RECOVERY_SIGNING_KEY_ID / RECOVERY_SIGNING_KEY (base64url, >= 32 bytes); absent is an error. */
export function recoverySigningFromEnv(env: Record<string, string | undefined> = process.env): RecoverySigning {
  const keyId = env.RECOVERY_SIGNING_KEY_ID;
  const raw = env.RECOVERY_SIGNING_KEY;
  if (!keyId || !raw) return assertSigning(undefined);
  return assertSigning({ keyId, keyring: Object.freeze({ [keyId]: new Uint8Array(Buffer.from(raw, 'base64url')) }) });
}

const hmacHex = (key: Uint8Array, domain: string, value: unknown) =>
  createHmac('sha256', key)
    .update(`${domain}\n${canonicalize(value)}`, 'utf8')
    .digest('hex');

export function seal(signing: RecoverySigning, domain: string, value: unknown): { signature: string; keyId: string } {
  const s = assertSigning(signing);
  return { signature: `hmac-sha256:${hmacHex(s.keyring[s.keyId]!, domain, value)}`, keyId: s.keyId };
}

/** Constant-time seal verification against the keyring entry named by the stored key id. */
export function verifySeal(
  signing: RecoverySigning,
  domain: string,
  value: unknown,
  signature: string,
  keyId: string,
): boolean {
  if (!Object.hasOwn(signing.keyring, keyId)) return false;
  const key = signing.keyring[keyId];
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || !signature.startsWith('hmac-sha256:')) return false;
  const want = Buffer.from(hmacHex(key, domain, value), 'hex');
  const got = Buffer.from(signature.slice('hmac-sha256:'.length), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface IncidentRow {
  tenant_id: string;
  id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  rule_revision_id: string;
  state: string;
  reopen_count: number;
  recovered_at: Date | null;
  version: number;
  correlation_id: string;
}

/** Whether the caller may see recovery data at `siteId` (human read roles there, or the recovery engine). */
export function canReadAt(ctx: TenantContext, siteId: string): boolean {
  return (
    authorize(ctx, { action: 'recovery.read', siteId: siteId as never }).allowed ||
    authorize(ctx, { action: 'recovery.engine' }).allowed
  );
}

export function requireAt(ctx: TenantContext, meta: CommandMeta, action: ActionName, siteId: string | null): void {
  const d = authorize(ctx, { action, siteId: siteId as never });
  if (!d.allowed)
    throw new Denial(notPermitted(d.reasonCode), {
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      reasonCode: d.reasonCode,
    });
}

export const deny = (meta: CommandMeta, reasonCode: string) =>
  new Denial(notPermitted(reasonCode), {
    action: meta.action,
    resourceType: meta.resourceType,
    resourceId: meta.resourceId ?? null,
    reasonCode,
  });

/**
 * Load (and optionally lock) an incident in the caller's tenant. Malformed, foreign, nonexistent and out-of-site ids
 * are the same audited RESOURCE_UNAVAILABLE; `action` is then authorized at the incident's own site.
 */
export async function loadIncident(
  c: Tx,
  ctx: TenantContext,
  meta: CommandMeta,
  incidentId: unknown,
  opts: { action: ActionName | null; lock: 'UPDATE' | null },
): Promise<IncidentRow> {
  if (typeof incidentId !== 'string' || !IncidentIdSchema.safeParse(incidentId).success) throw unavailable(meta);
  const { rows } = await c.query<IncidentRow>(
    `SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2${opts.lock === 'UPDATE' ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, incidentId],
  );
  const row = rows[0];
  if (!row || !canReadAt(ctx, row.site_id)) throw unavailable(meta);
  if (opts.action) requireAt(ctx, meta, opts.action, row.site_id);
  return row;
}

export interface Actor {
  kind: 'HUMAN' | 'SERVICE' | 'WORKER' | 'INTEGRATION';
  id: string;
}
export function actorFor(ctx: TenantContext): Actor {
  const p = ctx.principal;
  if (p.kind === 'DEVICE') throw notPermitted('PRINCIPAL_KIND_NOT_PERMITTED');
  return { kind: p.kind, id: String(p.id).slice(0, 128) };
}

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

/** Request digest bound to the command, the principal and the body (a reused key with anything else is a conflict). */
export function requestDigest(ctx: TenantContext, commandType: string, body: unknown): string {
  const a = actorFor(ctx);
  return sha256Digest(canonicalize({ commandType, principal: `${a.kind}:${a.id}`, body }));
}

/** The stored result of an Idempotency-Key, or undefined; a key reused for another request is refused. */
export async function readReceipt<T>(c: Tx, ctx: TenantContext, key: string, digest: string): Promise<T | undefined> {
  const { rows } = await c.query<{ request_digest: string; result: T }>(
    `SELECT request_digest, result FROM recovery_command_receipts WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, key],
  );
  if (!rows[0]) return undefined;
  if (rows[0].request_digest !== digest)
    throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for another request.', {
      reasonCode: 'IDEMPOTENCY_KEY_REUSED',
    });
  return rows[0].result;
}

/** Store a result; a concurrent writer of the same key wins and its (identical-request) result is returned. */
export async function writeReceipt<T extends Record<string, unknown>>(
  c: Tx,
  ctx: TenantContext,
  key: string,
  commandType: string,
  digest: string,
  result: T,
): Promise<T> {
  const a = actorFor(ctx);
  const { rowCount } = await c.query(
    `INSERT INTO recovery_command_receipts (tenant_id, idempotency_key, command_type, request_digest, result, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [ctx.tenantId, key, commandType, digest, JSON.stringify(result), a.kind, a.id],
  );
  if (rowCount === 1) return result;
  return (await readReceipt<T>(c, ctx, key, digest))!;
}

export const MAX_AS_OF_LEAD_MS = 3_600_000;

/**
 * Evaluation instant: the database clock, or a later `asOf` at most one hour ahead. A later instant can only make the
 * fresh-tail test stricter (and expiry earlier, i.e. escalate sooner); it never admits a sample the gateway refused.
 */
export async function evaluationInstant(c: Tx, asOf: string | undefined): Promise<{ nowMs: number; atMs: number }> {
  const now = ms(await dbNow(c));
  if (asOf === undefined) return { nowMs: now, atMs: now };
  const a = ms(asOf);
  if (!Number.isFinite(a) || a > now + MAX_AS_OF_LEAD_MS) throw validation('EVALUATION_TIME_OUT_OF_BOUNDS');
  return { nowMs: now, atMs: Math.max(now, a) };
}
