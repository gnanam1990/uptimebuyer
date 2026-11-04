// Shared persistence helpers for M07: incident/evidence/policy probes, pinned account revisions, idempotency
// receipts, attempt observation log and bounded timeouts. Nothing here returns a credential value; unpaid credential
// resolution is a closure that refuses broker-owned revisions.
import { DomainError, type UtcInstant } from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import {
  actorOf,
  sha256Digest,
  unavailable,
  type CommandMeta,
  type CredentialResolver,
  type Queryable,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { hold, keyReused } from './errors.js';
import { newProviderId } from './ids.js';
import type { PinnedRevision, UnpaidCredential } from './ports.js';

export const isoOf = (d: Date | string | null): UtcInstant | null =>
  d === null ? null : (new Date(d).toISOString() as UtcInstant);

export function actorFields(ctx: TenantContext): { kind: 'HUMAN' | 'SERVICE' | 'WORKER'; id: string } {
  const a = actorOf(ctx);
  if (a.kind !== 'HUMAN' && a.kind !== 'SERVICE' && a.kind !== 'WORKER')
    throw new DomainError('FORBIDDEN', 'The action is not permitted for this principal.', {
      reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED',
    });
  return { kind: a.kind, id: a.id.slice(0, 128) };
}

export async function loadIncident(c: Queryable, ctx: TenantContext, meta: CommandMeta, incidentId: string) {
  const { rows } = await c.query<{ id: string; site_id: string; asset_id: string; state: string }>(
    `SELECT id, site_id, asset_id, state FROM incidents WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, incidentId],
  );
  if (!rows[0]) throw unavailable(meta, incidentId, 'incident');
  return rows[0];
}

export async function latestEvidence(c: Queryable, tenantId: string, incidentId: string) {
  const { rows } = await c.query<{ id: string; asset_revision_id: string }>(
    `SELECT id, asset_revision_id FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2
      ORDER BY revision DESC LIMIT 1`,
    [tenantId, incidentId],
  );
  if (!rows[0]) throw hold('EVIDENCE_REVISION_REQUIRED');
  return { evidenceRevisionId: rows[0].id, assetRevisionId: rows[0].asset_revision_id };
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

export interface RevisionRow extends PinnedRevision {
  readonly paid: boolean;
  readonly ownerService: 'M07_UNPAID' | 'KITE_BROKER_PAID';
  readonly credentialRef: string;
  readonly webhookVerifierRef: string | null;
  readonly superseded: boolean;
  readonly supersededAt: Date | null;
  readonly accountStatus: 'ACTIVE' | 'DISABLED';
  readonly currentRevisionId: string;
}

const REVISION_SELECT = `
  SELECT r.id, r.provider_account_id, r.capabilities, r.paid, r.owner_service, r.credential_ref,
         r.webhook_verifier_ref, r.endpoint_policy_digest, r.superseded_at, p.provider_key, p.environment, p.status,
         p.current_revision_id
    FROM provider_account_revisions r
    JOIN provider_accounts p ON p.tenant_id = r.tenant_id AND p.id = r.provider_account_id`;

function toRevision(r: Record<string, unknown>): RevisionRow {
  return {
    providerAccountId: r.provider_account_id as string,
    providerAccountRevisionId: r.id as string,
    providerKey: r.provider_key as string,
    environment: r.environment as 'SANDBOX' | 'PRODUCTION',
    capabilities: Object.freeze([...(r.capabilities as string[])]),
    endpointPolicyDigest: r.endpoint_policy_digest as string,
    paid: r.paid as boolean,
    ownerService: r.owner_service as 'M07_UNPAID' | 'KITE_BROKER_PAID',
    credentialRef: r.credential_ref as string,
    webhookVerifierRef: (r.webhook_verifier_ref as string | null) ?? null,
    superseded: r.superseded_at !== null || r.current_revision_id !== r.id,
    supersededAt: (r.superseded_at as Date | null) ?? null,
    accountStatus: r.status as 'ACTIVE' | 'DISABLED',
    currentRevisionId: r.current_revision_id as string,
  };
}

/** The exact (possibly superseded) revision `revisionId`; `lock` takes FOR SHARE on the stable account row. */
export async function loadRevision(c: Queryable, tenantId: string, revisionId: string, lock = false) {
  const { rows } = await c.query(
    `${REVISION_SELECT} WHERE r.tenant_id = $1 AND r.id = $2 ${lock ? 'FOR SHARE OF p' : ''}`,
    [tenantId, revisionId],
  );
  return rows[0] ? toRevision(rows[0]) : undefined;
}

/** The current revision of a stable account (FOR SHARE: serializes with M02 supersession, which locks FOR UPDATE). */
export async function loadCurrentRevision(c: Queryable, tenantId: string, providerAccountId: string) {
  const { rows } = await c.query(
    `${REVISION_SELECT} WHERE r.tenant_id = $1 AND p.id = $2 AND r.id = p.current_revision_id FOR SHARE OF p`,
    [tenantId, providerAccountId],
  );
  return rows[0] ? toRevision(rows[0]) : undefined;
}

/** Credential closure for an M07-owned unpaid revision; a broker-owned revision can never resolve (INV-06). */
export function unpaidCredential(rev: RevisionRow, resolver: CredentialResolver | undefined): UnpaidCredential {
  return async () => {
    if (rev.paid || rev.ownerService !== 'M07_UNPAID')
      throw new DomainError('FORBIDDEN', 'Paid credentials are owned by the broker.', {
        reasonCode: 'PAID_CREDENTIAL_BROKER_ONLY',
      });
    return resolver ? resolver.resolveSigningKey(rev.credentialRef) : undefined;
  };
}

export const requestDigestOf = (value: unknown) => sha256Digest(canonicalize(value));

/**
 * Idempotency receipt (API-EVENT-SPEC §8): same key + same digest returns the stored result reference; same key with a
 * different digest is IDEMPOTENCY_KEY_REUSED. Call `hit` first, then `store` once the result exists.
 */
export const receipts = {
  async hit(c: Tx, tenantId: string, route: string, key: string, digest: string): Promise<string | null> {
    const { rows } = await c.query<{ request_digest: string; result_ref: string }>(
      `SELECT request_digest, result_ref FROM provider_command_receipts WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3`,
      [tenantId, route, key],
    );
    if (!rows[0]) return null;
    if (rows[0].request_digest !== digest) throw keyReused();
    return rows[0].result_ref;
  },
  async store(c: Tx, tenantId: string, route: string, key: string, digest: string, resultRef: string): Promise<void> {
    const r = await c.query(
      `INSERT INTO provider_command_receipts (tenant_id, id, route, idempotency_key, request_digest, result_ref)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, route, idempotency_key) DO NOTHING`,
      [tenantId, newProviderId('commandReceipt'), route, key, digest, resultRef],
    );
    if (r.rowCount === 0) {
      const again = await receipts.hit(c, tenantId, route, key, digest);
      if (again !== resultRef) throw keyReused();
    }
  },
};

export interface AttemptObservation {
  kind:
    | 'PREPARED'
    | 'PRE_EGRESS_BLOCK'
    | 'SEND_STARTED'
    | 'HANDOFF'
    | 'ADAPTER_RESULT'
    | 'TIMEOUT'
    | 'LOOKUP'
    | 'WEBHOOK'
    | 'BROKER_SUBMITTED'
    | 'BROKER_EVENT'
    | 'CAPABILITY_CHANGE';
  transportState: string;
  externalOutcomeState: string;
  adapterCapability: string;
  economicState?: string | null;
  rawProviderStatus?: string | null;
  reasonCode?: string | null;
  rawResponseDigest?: string | null;
  sourceEventId?: string | null;
}

export async function appendAttemptEvent(c: Tx, tenantId: string, attemptId: string, o: AttemptObservation) {
  await c.query(
    `INSERT INTO provider_contact_attempt_events (tenant_id, id, attempt_id, sequence, observation_kind, transport_state,
       external_outcome_state, adapter_capability, economic_state, raw_provider_status, reason_code, raw_response_digest,
       source_event_id)
     VALUES ($1, $2, $3,
       (SELECT coalesce(max(sequence), 0) + 1 FROM provider_contact_attempt_events WHERE tenant_id = $1 AND attempt_id = $3),
       $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      tenantId,
      newProviderId('attemptEvent'),
      attemptId,
      o.kind,
      o.transportState,
      o.externalOutcomeState,
      o.adapterCapability,
      o.economicState ?? null,
      o.rawProviderStatus ?? null,
      o.reasonCode ?? null,
      o.rawResponseDigest ?? null,
      o.sourceEventId ?? null,
    ],
  );
}

export type Timed<T> = { kind: 'OK'; value: T } | { kind: 'TIMEOUT' } | { kind: 'ERROR'; error: unknown };

/** Run `fn` with an explicit timeout; the signal aborts at the deadline and the result is TIMEOUT, never a guess. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<Timed<T>> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ kind: 'TIMEOUT' });
    }, ms);
  });
  try {
    return await Promise.race([
      fn(ac.signal).then(
        (value): Timed<T> => ({ kind: 'OK', value }),
        (error): Timed<T> => (ac.signal.aborted ? { kind: 'TIMEOUT' } : { kind: 'ERROR', error }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** In-process token bucket per account revision (NFR-04). Multi-instance deployments need a shared budget. */
export class RevisionRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly ratePerSecond = 10,
    private readonly burst = 20,
    private readonly maxKeys = 10_000,
  ) {}
  /** Milliseconds to wait before a token is available (0 = token taken now). */
  take(key: string, now = Date.now()): number {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.ratePerSecond);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / this.ratePerSecond) * 1000);
  }
}
export const DEFAULT_RATE_LIMITER = new RevisionRateLimiter();
