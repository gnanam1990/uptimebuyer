// T-029 database backstop for the M07 contact-point destination-hijack fix: the provider_contact_requests insert
// guard (ub_contact_point_usable_guard) must fail CLOSED. Rows are inserted directly through SQL, bypassing the M07
// service check, so only the database decides. A guard of the form `IF NOT (<cond>) THEN RAISE` skips the RAISE when
// <cond> is NULL (three-valued logic), which an unreviewed point, a NULL source revision or a missing row produce.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareContactRequest } from '../src/index.js';
import { createProviderWorld, discover, pointOf, type ProviderWorld } from './helpers.js';

let w: ProviderWorld;
let template: string;
let providerId: string;

const suffix = () => randomBytes(6).toString('hex');
const digest = (prefix: string) => `${prefix}${randomBytes(32).toString('hex')}`;

/** A contact point of the template's provider on the template's channel (API), with chosen provenance. */
async function point(opts: { intake: 'DISCOVERED' | 'PENDING_REVIEW'; sourceRevisionId: string | null }) {
  const id = `spc_guard-${suffix()}`;
  await w.db.pool.query(
    `INSERT INTO service_provider_contact_points (tenant_id, id, service_provider_id, channel, value, value_digest,
       source_provider_account_revision_id, intake_state)
     VALUES ($1, $2, $3, 'API', $4, $5, $6, $7)`,
    [
      w.tenant.tenantId,
      id,
      providerId,
      `https://api.coldline.example/${suffix()}`,
      digest('sha256:'),
      opts.sourceRevisionId,
      opts.intake,
    ],
  );
  return id;
}

async function review(contactPointId: string, decision: 'VERIFIED' | 'REJECTED') {
  await w.db.pool.query(
    `INSERT INTO service_provider_contact_point_reviews (tenant_id, id, contact_point_id, decision, reviewed_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [w.tenant.tenantId, `spv_guard-${suffix()}`, contactPointId, decision, w.tenant.adminUserId],
  );
}

/** Copy the valid template request onto another contact point, straight through SQL. */
function insertRequest(contactPointId: string) {
  return w.db.pool.query(
    `INSERT INTO provider_contact_requests (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id,
       evidence_revision_id, policy_revision_id, service_provider_id, contact_point_id, provider_account_id,
       provider_account_revision_id, channel, purpose_code, request_digest, message_template, recording_disclosure,
       processing_consent, retention_class, paid, action_digest, plan_hash, merchant_id, max_cost_minor, currency,
       timeout_ms, created_by_kind, created_by_id)
     SELECT tenant_id, $3, incident_id, site_id, asset_id, asset_revision_id, evidence_revision_id, policy_revision_id,
       service_provider_id, $4, provider_account_id, provider_account_revision_id, channel, purpose_code, $5,
       message_template, recording_disclosure, processing_consent, retention_class, paid, action_digest, plan_hash,
       merchant_id, max_cost_minor, currency, timeout_ms, created_by_kind, created_by_id
       FROM provider_contact_requests WHERE tenant_id = $1 AND id = $2`,
    [
      w.tenant.tenantId,
      template,
      `pcr_guard-${suffix()}`,
      contactPointId,
      digest('provider-contact-request.v1:sha256:'),
    ],
  );
}

describe('T-029 contact-point insert guard fails closed on NULL', () => {
  beforeAll(async () => {
    w = await createProviderWorld('m07guard');
    // Unreviewed discovery under the unpaid account revision: the API point is usable from that same revision.
    const { byRef } = await discover(w, w.operator.ctx, { verify: false });
    providerId = byRef['nw-330']!;
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: providerId,
      contactPointId: pointOf(providerId, 'API'),
      providerAccountId: w.unpaid.providerAccountId,
      channel: 'API',
      purposeCode: 'AVAILABILITY',
      idempotencyKey: w.key('guard'),
    });
    template = prepared.contactRequestId;
  });
  afterAll(async () => {
    await w?.close();
  });

  it('(a) refuses an unreviewed PENDING_REVIEW point', async () => {
    const id = await point({ intake: 'PENDING_REVIEW', sourceRevisionId: w.unpaid.providerAccountRevisionId });
    await expect(insertRequest(id)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('(b) refuses an unreviewed DISCOVERED point whose source revision is NULL (legacy / pre-0013 row)', async () => {
    const id = await point({ intake: 'DISCOVERED', sourceRevisionId: null });
    await expect(insertRequest(id)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('(c) refuses an unreviewed DISCOVERED point from a different account revision', async () => {
    const id = await point({ intake: 'DISCOVERED', sourceRevisionId: w.paid.providerAccountRevisionId });
    await expect(insertRequest(id)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('(d) refuses a point whose latest review is REJECTED', async () => {
    const id = await point({ intake: 'DISCOVERED', sourceRevisionId: w.unpaid.providerAccountRevisionId });
    await review(id, 'REJECTED');
    await expect(insertRequest(id)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('refuses a contact point that does not exist (the guard sees only NULL fields)', async () => {
    await expect(insertRequest(`spc_guard-missing-${suffix()}`)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('a later REJECTED review overrides an earlier VERIFIED one (latest wins)', async () => {
    const id = await point({ intake: 'PENDING_REVIEW', sourceRevisionId: null });
    await review(id, 'VERIFIED');
    await review(id, 'REJECTED');
    await expect(insertRequest(id)).rejects.toMatchObject({ code: 'UB075' });
  });

  it('control: a VERIFIED point is usable whatever its intake state or source revision', async () => {
    const id = await point({ intake: 'PENDING_REVIEW', sourceRevisionId: null });
    await review(id, 'VERIFIED');
    await expect(insertRequest(id)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('control: an unreviewed DISCOVERED point from the request account revision is usable', async () => {
    const id = await point({ intake: 'DISCOVERED', sourceRevisionId: w.unpaid.providerAccountRevisionId });
    await expect(insertRequest(id)).resolves.toMatchObject({ rowCount: 1 });
  });
});
