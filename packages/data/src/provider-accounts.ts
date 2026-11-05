// Provider-account storage (tables owned by M02; behaviour by M07/M09). Stable tenant/provider/environment accounts
// with immutable capability/owner/credential/verifier revisions. Webhook routing resolves the tenant only from the
// server-side endpoint binding (stored as a digest); deliveries are namespaced by (tenant, account, provider event).
import { randomBytes } from 'node:crypto';
import {
  DomainError,
  Sha256DigestSchema,
  newId,
  type CorrelationId,
  type ProviderAccountId,
  type ProviderAccountRevisionId,
  type TenantId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { z } from 'zod';
import { requireAuthorized } from './authz.js';
import { tenantCommand, unavailable, recordAudit } from './command.js';
import { actorOf, assertTenantContext, type TenantContext } from './context.js';
import {
  dbNow,
  iso,
  isoNN,
  laterThan,
  sha256Digest,
  versionConflict,
  withTransaction,
  type Db,
  type Tx,
} from './db.js';
import { newDataId, type WebhookDeliveryId } from './ids.js';
import { SecretRefSchema } from './identity.js';
import { assertTenantSecretRef } from './secret-ref.js';
import { RegistrySourceSchema, type RegistrySource } from './registry-core.js';
import { recordSecurityAudit } from './security-audit.js';

export const PROVIDER_CAPABILITIES = Object.freeze([
  'SEARCH',
  'QUOTE',
  'CONTACT_PHONE',
  'CONTACT_EMAIL',
  'CONTACT_API',
  'PURCHASE',
  'SERVICE_BOOKING',
  'WEBHOOK',
  'KITE_SESSION',
  'CMMS_SYNC',
] as const);
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

const RevisionSchema = z
  .strictObject({
    capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)).min(1).max(16),
    paid: z.boolean(),
    ownerService: z.enum(['M07_UNPAID', 'KITE_BROKER_PAID']),
    credentialRef: SecretRefSchema,
    endpointPolicyDigest: Sha256DigestSchema,
    webhookVerifierRef: SecretRefSchema.nullable(),
  })
  .refine((r) => r.paid === (r.ownerService === 'KITE_BROKER_PAID'), {
    path: ['ownerService'],
    message: 'Paid capability is owned only by the Kite broker; unpaid only by M07.',
  });
export type ProviderAccountRevisionInput = z.input<typeof RevisionSchema>;

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

/** Both references must be bound to the caller tenant (no confused-deputy access to another tenant's secret). */
function assertRevisionRefs(ctx: TenantContext, r: z.output<typeof RevisionSchema>): void {
  assertTenantContext(ctx);
  assertTenantSecretRef(ctx.tenantId, r.credentialRef, 'revision.credentialRef');
  if (r.webhookVerifierRef !== null)
    assertTenantSecretRef(ctx.tenantId, r.webhookVerifierRef, 'revision.webhookVerifierRef');
}

async function insertRevision(
  c: Tx,
  ctx: TenantContext,
  providerAccountId: ProviderAccountId,
  revision: number,
  r: z.output<typeof RevisionSchema>,
  effectiveAt: UtcInstant,
  source: RegistrySource,
): Promise<ProviderAccountRevisionId> {
  const id = newId('providerAccountRevision');
  const actor = actorOf(ctx);
  await c.query(
    `INSERT INTO provider_account_revisions (tenant_id, id, provider_account_id, revision, capabilities, paid, owner_service,
       credential_ref, endpoint_policy_digest, webhook_verifier_ref, effective_at, actor_kind, actor_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ctx.tenantId,
      id,
      providerAccountId,
      revision,
      [...new Set(r.capabilities)].sort(),
      r.paid,
      r.ownerService,
      r.credentialRef,
      r.endpointPolicyDigest,
      r.webhookVerifierRef,
      effectiveAt,
      actor.kind,
      actor.id,
      source,
    ],
  );
  return id;
}

export async function createProviderAccount(
  pool: Db,
  ctx: TenantContext,
  input: {
    providerKey: string;
    environment: 'SANDBOX' | 'PRODUCTION';
    revision: ProviderAccountRevisionInput;
    source: RegistrySource;
  },
): Promise<{
  providerAccountId: ProviderAccountId;
  providerAccountRevisionId: ProviderAccountRevisionId;
  /** Opaque endpoint binding, returned once; only its digest is stored. */
  webhookBinding: string;
}> {
  const rev = RevisionSchema.safeParse(input.revision);
  if (
    !rev.success ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.providerKey) ||
    !['SANDBOX', 'PRODUCTION'].includes(input.environment) ||
    !RegistrySourceSchema.safeParse(input.source).success
  )
    throw validation('INVALID_PROVIDER_ACCOUNT');
  assertRevisionRefs(ctx, rev.data);
  const providerAccountId = newId('providerAccount');
  const meta = { action: 'provider_account.create', resourceType: 'provider_account', resourceId: providerAccountId };
  const webhookBinding = randomBytes(32).toString('base64url');
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'provider_account.manage', siteId: null });
    const now = await dbNow(c);
    const pending = newId('providerAccountRevision');
    await c.query(
      `INSERT INTO provider_accounts (tenant_id, id, provider_key, environment, current_revision_id, webhook_binding_digest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.tenantId, providerAccountId, input.providerKey, input.environment, pending, sha256Digest(webhookBinding)],
    );
    const revId = await insertRevision(c, ctx, providerAccountId, 1, rev.data, now, input.source);
    await c.query(`UPDATE provider_accounts SET current_revision_id = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      providerAccountId,
      revId,
    ]);
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED' });
    return { providerAccountId, providerAccountRevisionId: revId, webhookBinding };
  });
}

/**
 * Append the next immutable revision. The superseded revision is stamped (never edited) and every unexecuted,
 * unexpired approval pinned to it is invalidated; in-flight work keeps reconciling against its pinned revision.
 */
export async function appendProviderAccountRevision(
  pool: Db,
  ctx: TenantContext,
  providerAccountId: ProviderAccountId,
  input: { revision: ProviderAccountRevisionInput; source: RegistrySource; expectedVersion?: number },
): Promise<{
  providerAccountRevisionId: ProviderAccountRevisionId;
  revision: number;
  invalidatedApprovalIds: string[];
}> {
  const rev = RevisionSchema.safeParse(input.revision);
  if (!rev.success || !RegistrySourceSchema.safeParse(input.source).success)
    throw validation('INVALID_PROVIDER_ACCOUNT_REVISION');
  assertRevisionRefs(ctx, rev.data);
  const meta = { action: 'provider_account.revise', resourceType: 'provider_account', resourceId: providerAccountId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT p.version, r.id AS rev_id, r.revision, r.effective_at FROM provider_accounts p
         JOIN provider_account_revisions r ON r.tenant_id = p.tenant_id AND r.id = p.current_revision_id
        WHERE p.tenant_id = $1 AND p.id = $2 FOR UPDATE OF p`,
      [ctx.tenantId, providerAccountId],
    );
    if (!rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'provider_account.manage', siteId: null });
    if (input.expectedVersion !== undefined && rows[0].version !== input.expectedVersion) throw versionConflict();
    const now = laterThan(await dbNow(c), rows[0].effective_at);
    await c.query(`UPDATE provider_account_revisions SET superseded_at = $3 WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      rows[0].rev_id,
      now,
    ]);
    const revision = rows[0].revision + 1;
    const revId = await insertRevision(c, ctx, providerAccountId, revision, rev.data, now, input.source);
    await c.query(
      `UPDATE provider_accounts SET current_revision_id = $3, version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, providerAccountId, revId],
    );
    const inv = await c.query<{ approval_id: string }>(
      `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
       SELECT a.tenant_id, 'ape_' || gen_random_uuid(), a.id, 'INVALIDATED', 'PROVIDER_ACCOUNT_REVISION_SUPERSEDED', $3, $4
         FROM approvals a
        WHERE a.tenant_id = $1 AND a.provider_account_revision_id = $2 AND a.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.tenant_id = a.tenant_id AND e.approval_id = a.id)
       ON CONFLICT (tenant_id, approval_id) DO NOTHING RETURNING approval_id`,
      [ctx.tenantId, rows[0].rev_id, actorOf(ctx).kind, actorOf(ctx).id],
    );
    await recordAudit(c, ctx, { ...meta, result: 'SUCCEEDED', metadata: { revision } });
    return { providerAccountRevisionId: revId, revision, invalidatedApprovalIds: inv.rows.map((r) => r.approval_id) };
  });
}

export interface ProviderAccountRecord {
  providerAccountId: ProviderAccountId;
  tenantId: TenantId;
  providerKey: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  current: {
    providerAccountRevisionId: ProviderAccountRevisionId;
    revision: number;
    capabilities: ProviderCapability[];
    paid: boolean;
    ownerService: 'M07_UNPAID' | 'KITE_BROKER_PAID';
    credentialRef: string;
    webhookVerifierRef: string | null;
    effectiveAt: UtcInstant;
    supersededAt: UtcInstant | null;
  };
}

export async function getProviderAccount(
  pool: Db,
  ctx: TenantContext,
  providerAccountId: ProviderAccountId,
): Promise<ProviderAccountRecord> {
  const meta = { action: 'provider_account.read', resourceType: 'provider_account', resourceId: providerAccountId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const { rows } = await c.query(
      `SELECT p.*, r.id AS rev_id, r.revision, r.capabilities, r.paid, r.owner_service, r.credential_ref,
              r.webhook_verifier_ref, r.effective_at, r.superseded_at
         FROM provider_accounts p
         JOIN provider_account_revisions r ON r.tenant_id = p.tenant_id AND r.id = p.current_revision_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [ctx.tenantId, providerAccountId],
    );
    const r = rows[0];
    if (!r) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.read', siteId: null });
    return {
      providerAccountId: r.id,
      tenantId: r.tenant_id,
      providerKey: r.provider_key,
      environment: r.environment,
      status: r.status,
      version: r.version,
      current: {
        providerAccountRevisionId: r.rev_id,
        revision: r.revision,
        capabilities: r.capabilities,
        paid: r.paid,
        ownerService: r.owner_service,
        credentialRef: r.credential_ref,
        webhookVerifierRef: r.webhook_verifier_ref,
        effectiveAt: isoNN(r.effective_at),
        supersededAt: iso(r.superseded_at),
      },
    };
  });
}

/** Server-derived webhook routing result. Only `resolveWebhookBinding` issues it. */
export interface WebhookBinding {
  readonly tenantId: TenantId;
  readonly providerAccountId: ProviderAccountId;
  readonly providerAccountRevisionId: ProviderAccountRevisionId;
  readonly webhookVerifierRef: string | null;
}
const issuedBindings = new WeakSet<object>();

/**
 * Resolve an opaque endpoint binding (the path segment of `/v1/provider-webhooks/{binding}`) to exactly one active
 * provider account and its current revision. Nothing in the request body or headers can select the tenant.
 */
export async function resolveWebhookBinding(
  pool: Db,
  binding: string,
  opts: { correlationId?: CorrelationId } = {},
): Promise<WebhookBinding> {
  const { rows } = await pool.query(
    `SELECT p.tenant_id, p.id, r.id AS rev_id, r.webhook_verifier_ref
       FROM provider_accounts p
       JOIN provider_account_revisions r ON r.tenant_id = p.tenant_id AND r.id = p.current_revision_id
       JOIN tenants t ON t.id = p.tenant_id
      WHERE p.webhook_binding_digest = $1 AND p.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
    [sha256Digest(binding)],
  );
  if (rows.length !== 1) {
    await recordSecurityAudit(pool, {
      principal: { kind: 'ANONYMOUS', id: null },
      action: 'webhook.resolve',
      requested: binding,
      result: 'DENIED',
      reasonCode: 'UNKNOWN_WEBHOOK_BINDING',
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    });
    throw new DomainError('UNAUTHENTICATED', 'Webhook endpoint is not recognised.');
  }
  const b: WebhookBinding = Object.freeze({
    tenantId: rows[0].tenant_id,
    providerAccountId: rows[0].id,
    providerAccountRevisionId: rows[0].rev_id,
    webhookVerifierRef: rows[0].webhook_verifier_ref,
  });
  issuedBindings.add(b);
  return b;
}

/**
 * Record a delivery. A VALID delivery owns the (tenant, account, provider event) replay key, so a replay returns the
 * original; INVALID deliveries are always recorded separately and can never pre-empt the genuine one.
 */
export async function recordWebhookDelivery(
  pool: Db,
  binding: WebhookBinding,
  input: { providerEventId: string; signatureValid: boolean; bodyDigest: string },
): Promise<{ deliveryId: WebhookDeliveryId; duplicate: boolean }> {
  if (!issuedBindings.has(binding))
    throw new DomainError('UNAUTHENTICATED', 'A server-resolved webhook binding is required.');
  return withTransaction(pool, (c) => recordWebhookDeliveryInTx(c, binding, input));
}

/**
 * The same as recordWebhookDelivery inside the caller's transaction (M13 security review S8), so a verified delivery
 * and its downstream job or quarantine commit together or not at all.
 */
export async function recordWebhookDeliveryInTx(
  c: Tx,
  binding: WebhookBinding,
  input: { providerEventId: string; signatureValid: boolean; bodyDigest: string },
): Promise<{ deliveryId: WebhookDeliveryId; duplicate: boolean }> {
  if (!issuedBindings.has(binding))
    throw new DomainError('UNAUTHENTICATED', 'A server-resolved webhook binding is required.');
  if (!/^[\x21-\x7E]{1,256}$/.test(input.providerEventId) || !Sha256DigestSchema.safeParse(input.bodyDigest).success)
    throw validation('INVALID_WEBHOOK_DELIVERY');
  {
    const deliveryId = newDataId('webhookDelivery') as WebhookDeliveryId;
    const params = [
      binding.tenantId,
      deliveryId,
      binding.providerAccountId,
      binding.providerAccountRevisionId,
      input.providerEventId,
      input.signatureValid ? 'VALID' : 'INVALID',
      input.bodyDigest,
    ];
    const insert = `INSERT INTO webhook_deliveries (tenant_id, id, provider_account_id, provider_account_revision_id,
                                                    provider_event_id, signature_result, body_digest)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    let id: WebhookDeliveryId = deliveryId;
    let duplicate = false;
    if (!input.signatureValid) {
      // An unauthenticated delivery is retained as evidence but never occupies the replay key.
      await c.query(insert, params);
    } else {
      const ins = await c.query<{ id: WebhookDeliveryId }>(
        `${insert} ON CONFLICT (tenant_id, provider_account_id, provider_event_id) WHERE signature_result = 'VALID'
           DO NOTHING RETURNING id`,
        params,
      );
      if (!ins.rows[0]) {
        duplicate = true;
        id = (
          await c.query<{ id: WebhookDeliveryId }>(
            `SELECT id FROM webhook_deliveries WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_event_id = $3
                AND signature_result = 'VALID'`,
            [binding.tenantId, binding.providerAccountId, input.providerEventId],
          )
        ).rows[0]!.id;
      }
    }
    await c.query(
      `INSERT INTO audit_entries (tenant_id, id, actor_kind, actor_id, action, resource_type, resource_id, result, reason_code, correlation_id)
       VALUES ($1, $2, 'WEBHOOK', $3, 'webhook.receive', 'webhook_delivery', $4, 'SUCCEEDED', $5, $6)`,
      [
        binding.tenantId,
        newDataId('audit'),
        binding.providerAccountId,
        id,
        duplicate ? 'DUPLICATE_DELIVERY' : input.signatureValid ? null : 'SIGNATURE_INVALID',
        newId('correlation'),
      ],
    );
    return { deliveryId: id, duplicate };
  }
}

export async function findWebhookDelivery(
  pool: Db,
  ctx: TenantContext,
  providerAccountId: ProviderAccountId,
  providerEventId: string,
): Promise<{ deliveryId: WebhookDeliveryId; signatureResult: 'VALID' | 'INVALID'; receivedAt: UtcInstant } | null> {
  assertTenantContext(ctx);
  const meta = { action: 'webhook_delivery.read', resourceType: 'provider_account', resourceId: providerAccountId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const acct = await c.query(`SELECT 1 FROM provider_accounts WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      providerAccountId,
    ]);
    if (acct.rowCount !== 1) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'registry.read', siteId: null });
    const { rows } = await c.query(
      `SELECT id, signature_result, received_at FROM webhook_deliveries
        WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_event_id = $3
        ORDER BY (signature_result = 'VALID') DESC, received_at DESC, id LIMIT 1`,
      [ctx.tenantId, providerAccountId, providerEventId],
    );
    return rows[0]
      ? { deliveryId: rows[0].id, signatureResult: rows[0].signature_result, receivedAt: isoNN(rows[0].received_at) }
      : null;
  });
}
