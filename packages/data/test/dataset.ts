// A representative tenant dataset built only through the public repository API: sites, an asset whose identity was
// revised (two immutable revisions, current pointer advanced), a rebound device, a recalibrated channel, policy
// revisions, evidence (blob, revision, ledger with a linked correction), approvals (one invalidated by the asset
// revision), provider account with two revisions and a webhook delivery, outbox events, a job, audit and a legal
// hold. T-009 checks this survives forward migration; T-010 uses two of them to probe isolation.
import type pg from 'pg';
import { money, newId } from '@uptimebuyer/contracts';
import {
  appendLedgerEvidence,
  appendOutboxEvent,
  appendProviderAccountRevision,
  assignDeviceToAsset,
  assignRole,
  commitEvidenceRevision,
  createProviderAccount,
  createSensorChannel,
  createSite,
  enqueueJob,
  placeLegalHold,
  publishPolicyRevision,
  recordApproval,
  recordRegistryEdit,
  recordWebhookDelivery,
  registerAsset,
  registerDevice,
  registerEvidenceBlob,
  resolveWebhookBinding,
  reviseAssetIdentity,
  reviseSensorChannel,
  withTenantTransaction,
} from '../src/index.js';
import {
  fixtureIncident,
  humanContext,
  sha,
  vdigest,
  type SeededTenant,
  type TestIdentityProvider,
} from './helpers.js';

export async function seedRepresentativeDataset(
  pool: pg.Pool,
  idp: TestIdentityProvider,
  tenant: SeededTenant,
  label: string,
) {
  // The fixture administrator also holds tenant-wide approver and operator roles so that approvals and evidence
  // submissions pass authority checks (an administrator alone may do neither).
  for (const role of ['maintenance_approver', 'operator'] as const)
    await assignRole(pool, tenant.admin, {
      principal: { kind: 'HUMAN', userId: tenant.adminUserId },
      role,
      siteId: null,
    });
  const admin = await humanContext(pool, idp, tenant.adminSubject, tenant.tenantId);
  // A denied tenant-header probe leaves a platform security audit record.
  await humanContext(pool, idp, tenant.adminSubject, 'ten_not-a-member-0000').catch(() => undefined);
  const site = await createSite(pool, admin, { name: `${label} store 1`, timezone: 'Europe/London', source: 'API' });
  const site2 = await createSite(pool, admin, { name: `${label} store 2`, timezone: 'America/Chicago', source: 'API' });
  const asset = await registerAsset(pool, admin, {
    siteId: site.siteId,
    identity: {
      manufacturer: 'True',
      model: 'T-49',
      serial: `${label}-SN-0001`,
      safetyClass: 'STANDARD',
      bomRevision: 'BOM-3',
    },
    source: 'API',
  });
  const device = await registerDevice(pool, admin, {
    siteId: site.siteId,
    credentialRef: `secretref:device/tenants/${admin.tenantId}/${label}-1`,
    source: 'API',
  });
  const assignment = await assignDeviceToAsset(pool, admin, {
    deviceId: device.deviceId,
    assetId: asset.assetId,
    source: 'API',
  });
  const channel = await createSensorChannel(pool, admin, {
    deviceId: device.deviceId,
    kind: 'TEMPERATURE',
    unit: 'MILLI_CELSIUS',
    sourceUnit: 'FAHRENHEIT',
    calibrationRevision: 1,
    calibrationOffsetMilli: 0,
    source: 'API',
  });
  const channelRev2 = await reviseSensorChannel(pool, admin, channel.channelId, {
    kind: 'TEMPERATURE',
    unit: 'MILLI_CELSIUS',
    sourceUnit: 'FAHRENHEIT',
    calibrationRevision: 2,
    calibrationOffsetMilli: -150,
    source: 'API',
  });

  const authority = await publishPolicyRevision(pool, admin, {
    policyKey: 'AUTHORITY',
    body: {
      approvalLimits: [
        {
          approvalKind: 'PLAN_ACTION',
          actionClass: 'STANDARD',
          role: 'maintenance_approver',
          currency: 'USD',
          maxAmountMinor: 50_000n,
          siteIds: null,
        },
        {
          approvalKind: 'BUDGET_ADJUSTMENT',
          actionClass: 'STANDARD',
          role: 'finance_approver',
          currency: 'USD',
          maxAmountMinor: 200_000n,
          siteIds: null,
        },
        {
          approvalKind: 'PLAN_ACTION',
          actionClass: 'SUBSTITUTE',
          role: 'engineer',
          currency: 'USD',
          maxAmountMinor: 50_000n,
          siteIds: null,
        },
      ],
    },
    source: 'API',
  });
  const retention = await publishPolicyRevision(pool, admin, {
    policyKey: 'RETENTION',
    body: { telemetryDays: 400, communicationDays: 90, auditDays: 2555 },
    source: 'API',
  });

  const blob = await registerEvidenceBlob(pool, admin, {
    sha256: sha(`${label}-manual`),
    mediaType: 'application/pdf',
    sizeBytes: 1024,
    trustLevel: 'AUTHORITATIVE',
  });
  const inc = await fixtureIncident(pool, {
    tenantId: admin.tenantId,
    assetId: asset.assetId,
    userId: tenant.adminUserId,
    label: `${label}-1`,
  });
  const evidence = await commitEvidenceRevision(pool, admin, {
    incidentId: inc,
    assetRevisionId: asset.assetRevisionId,
    items: [{ blobId: blob.blobId, role: 'MANUAL', sourceAt: '2026-11-01T00:00:00.000Z' }],
  });
  const first = await appendLedgerEvidence(pool, admin, {
    kind: 'MATERIAL_INPUT',
    trust: 'OPERATOR_ATTESTED',
    subject: { aggregateType: 'evidence_revision', aggregateId: evidence.evidenceRevisionId },
    incidentId: inc,
    payloadSchema: 'evidence.manifest.v1',
    payloadDigest: sha(`${label}-payload-1`),
    payloadRef: blob.blobId,
    supersedesEvidenceId: null,
  });
  const correction = await appendLedgerEvidence(pool, admin, {
    kind: 'MATERIAL_INPUT',
    trust: 'OPERATOR_ATTESTED',
    subject: { aggregateType: 'evidence_revision', aggregateId: evidence.evidenceRevisionId },
    incidentId: inc,
    payloadSchema: 'evidence.manifest.v1',
    payloadDigest: sha(`${label}-payload-2`),
    payloadRef: null,
    supersedesEvidenceId: first.evidenceId,
  });

  const provider = await createProviderAccount(pool, admin, {
    providerKey: 'bitrefill',
    environment: 'SANDBOX',
    revision: {
      capabilities: ['PURCHASE', 'WEBHOOK'],
      paid: true,
      ownerService: 'KITE_BROKER_PAID',
      credentialRef: `secretref:provider/tenants/${admin.tenantId}/${label}-bitrefill`,
      endpointPolicyDigest: sha(`${label}-endpoint-policy`),
      webhookVerifierRef: `secretref:webhook/tenants/${admin.tenantId}/${label}-bitrefill`,
    },
    source: 'API',
  });
  const providerRev2 = await appendProviderAccountRevision(pool, admin, provider.providerAccountId, {
    revision: {
      capabilities: ['PURCHASE', 'WEBHOOK', 'QUOTE'],
      paid: true,
      ownerService: 'KITE_BROKER_PAID',
      credentialRef: `secretref:provider/tenants/${admin.tenantId}/${label}-bitrefill-2`,
      endpointPolicyDigest: sha(`${label}-endpoint-policy-2`),
      webhookVerifierRef: `secretref:webhook/tenants/${admin.tenantId}/${label}-bitrefill-2`,
    },
    source: 'API',
  });
  const binding = await resolveWebhookBinding(pool, provider.webhookBinding);
  const delivery = await recordWebhookDelivery(pool, binding, {
    providerEventId: 'evt-provider-0001',
    signatureValid: true,
    bodyDigest: sha(`${label}-webhook-body`),
  });

  const approvalInput = {
    approvalKind: 'PLAN_ACTION' as const,
    incidentId: inc,
    siteId: site.siteId,
    assetRevisionId: asset.assetRevisionId,
    evidenceRevisionId: evidence.evidenceRevisionId,
    policyRevisionId: authority.policyRevisionId,
    planHash: vdigest('plan', `${label}-plan`),
    actionDigest: vdigest('action', `${label}-action`),
    actionClass: 'STANDARD' as const,
    paid: true,
    providerAccountRevisionId: providerRev2.providerAccountRevisionId,
    targetExecutionAuthorityId: null,
    maxAmount: money(48_200n, 'USD'),
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const approval = await recordApproval(pool, admin, approvalInput);

  const revised = await reviseAssetIdentity(
    pool,
    admin,
    asset.assetId,
    { manufacturer: 'True', model: 'T-49', serial: `${label}-SN-0002`, safetyClass: 'STANDARD', bomRevision: 'BOM-4' },
    { expectedVersion: asset.version, source: 'API' },
  );
  await recordRegistryEdit(pool, admin, {
    entityKind: 'FOOD_AT_RISK',
    entityId: asset.assetId,
    body: { value: { amountMinor: 1_250_000n, currency: 'USD' }, basis: 'INVENTORY_COUNT' },
    source: 'API',
  });
  await recordRegistryEdit(pool, admin, {
    entityKind: 'WARRANTY',
    entityId: asset.assetId,
    body: { provider: 'True Manufacturing', expiresOn: '2028-06-30', termsBlobId: blob.blobId },
    source: 'API',
  });
  const vendor = await recordRegistryEdit(pool, admin, {
    entityKind: 'APPROVED_VENDOR',
    entityId: null,
    body: { vendorName: `${label} Refrigeration Co`, status: 'APPROVED', siteIds: [site.siteId] },
    source: 'API',
  });

  const events = await withTenantTransaction(pool, admin, async (client) => {
    const ids = [];
    for (let v = 1; v <= 3; v++)
      ids.push(
        await appendOutboxEvent(client, admin, {
          eventType: 'telemetry.accepted.v1',
          aggregateType: 'device',
          aggregateId: device.deviceId,
          aggregateVersion: v,
          payload: { fixture: label, version: v },
          correlationId: newId('correlation'),
          causationId: newId('command'),
        }),
      );
    const job = await enqueueJob(client, admin, {
      kind: 'fixture.noop',
      payload: { label },
      dedupeKey: `${label}-fixture-job`,
    });
    return { ids, jobId: job.jobId };
  });
  const hold = await placeLegalHold(pool, admin, {
    scopeType: 'ASSET',
    scopeId: asset.assetId,
    reasonCode: 'LITIGATION',
  });

  return {
    admin,
    site,
    site2,
    asset,
    revised,
    device,
    assignment,
    channel,
    channelRev2,
    authority,
    retention,
    blob,
    evidence,
    ledger: { first, correction },
    provider,
    providerRev2,
    delivery,
    approval,
    approvalInput,
    vendor,
    outboxEventIds: events.ids,
    jobId: events.jobId,
    hold,
    incidentId: inc,
  };
}
export type RepresentativeDataset = Awaited<ReturnType<typeof seedRepresentativeDataset>>;
