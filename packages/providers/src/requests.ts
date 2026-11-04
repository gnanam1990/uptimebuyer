// Contact-request row shape and loader shared by the contact, broker, communication and quote modules.
import type { Tx } from '@uptimebuyer/data';

export interface RequestRow {
  tenant_id: string;
  id: string;
  incident_id: string;
  site_id: string;
  asset_id: string;
  asset_revision_id: string;
  evidence_revision_id: string;
  policy_revision_id: string | null;
  service_provider_id: string;
  contact_point_id: string;
  provider_account_id: string;
  provider_account_revision_id: string;
  channel: 'PHONE' | 'EMAIL' | 'API';
  purpose_code: string;
  request_digest: string;
  message_template: string;
  recording_disclosure: 'REQUIRED' | 'NOT_APPLICABLE';
  processing_consent: 'REQUIRED' | 'NOT_REQUIRED';
  retention_class: string;
  paid: boolean;
  action_digest: string | null;
  plan_hash: string | null;
  merchant_id: string | null;
  max_cost_minor: string;
  currency: string;
  timeout_ms: number;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
}

export async function loadRequest(c: Tx, tenantId: string, id: string, lock = false): Promise<RequestRow | undefined> {
  const { rows } = await c.query<RequestRow>(
    `SELECT * FROM provider_contact_requests WHERE tenant_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  return rows[0];
}
