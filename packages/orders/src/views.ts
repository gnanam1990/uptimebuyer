// Read views (INV-12). The order/job state, the economic-intent state, the attempt's transport/outcome/capability axes
// and the reconciliation status are separate fields; a fulfillment state never stands in for a payment result, and
// nothing in the view proves recovery (`provesRecovery` is always false).
import type { Tx } from '@uptimebuyer/data';
import { KIND } from './internal.js';
import { TERMINAL_STATES, type ChangeKind, type OrderKind } from './vocabulary.js';

export interface OrderView {
  orderKind: OrderKind;
  orderId: string;
  tenantId: string;
  incidentId: string;
  siteId: string;
  planId: string;
  planActionId: string;
  candidateActionId: string;
  commercialIntentId: string;
  executionAuthorityId: string;
  approvalId: string;
  actionDigest: string;
  providerAccountId: string;
  /** The exact immutable provider-account revision pinned to the attempt; reconciliation uses only this one. */
  providerAccountRevisionId: string;
  /** Pre-egress client operation identity of the intent/attempt. */
  clientOperationId: string;
  providerRef: string | null;
  state: string;
  terminal: boolean;
  version: number;
  approved: { quantity: number; amountMinor: bigint; currency: string; etaAt: string | null };
  quantityFilled: number | null;
  scheduledStartAt: string | null;
  blockedReason: string | null;
  cancelRequested: boolean;
  noEffectProven: boolean;
  supersedesOrderId: string | null;
  economic: {
    state: string;
    reasonCode: string | null;
    transportState: string | null;
    externalOutcomeState: string | null;
    adapterCapability: string | null;
    nextReconcileAt: string | null;
    /** NONE, SCHEDULED (autonomous lookup pending) or MANUAL_REVIEW (no lookup / same-key replay; never retried). */
    reconciliation: 'NONE' | 'SCHEDULED' | 'MANUAL_REVIEW';
  };
  transitions: {
    sequence: number;
    from: string;
    to: string;
    reasonCode: string;
    observationId: string;
    source: string;
    at: string;
  }[];
  observations: {
    observationId: string;
    source: string;
    providerEventKey: string;
    providerAccountRevisionId: string;
    rawStatus: string;
    normalizedState: string | null;
    disposition: string;
    reasonCode: string | null;
    rawBodyDigest: string | null;
    observedAt: string;
  }[];
  changes: {
    changeProposalId: string;
    changeKind: ChangeKind;
    approved: Record<string, unknown>;
    proposed: Record<string, unknown>;
    requiresReentry: string[];
    autoAccepted: false;
    invalidatedPlanId: string | null;
    observationId: string | null;
  }[];
  provesRecovery: false;
}

const iso = (d: Date | string | null | undefined) => (d === null || d === undefined ? null : new Date(d).toISOString());

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadOrderViewInTx(
  c: Tx,
  tenantId: string,
  kind: OrderKind,
  id: string,
): Promise<OrderView | null> {
  const k = KIND[kind];
  const o = (await c.query(`SELECT * FROM ${k.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
  if (!o) return null;
  const i = (
    await c.query(`SELECT state, reason_code FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      o.commercial_intent_id,
    ])
  ).rows[0];
  const a = (
    await c.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [
      tenantId,
      o.commercial_intent_id,
    ])
  ).rows[0];
  const t = await c.query(
    `SELECT t.*, f.source FROM ${k.transitions} t JOIN fulfillment_observations f ON f.tenant_id = t.tenant_id
         AND f.id = t.observation_id
      WHERE t.tenant_id = $1 AND t.${k.fk} = $2 ORDER BY t.sequence`,
    [tenantId, id],
  );
  const ob = await c.query(
    `SELECT * FROM fulfillment_observations WHERE tenant_id = $1 AND ${k.fk} = $2 ORDER BY recorded_at, id`,
    [tenantId, id],
  );
  const ch = await c.query(
    `SELECT * FROM fulfillment_change_proposals WHERE tenant_id = $1 AND ${k.fk} = $2 ORDER BY created_at, id`,
    [tenantId, id],
  );
  const reconciliation: OrderView['economic']['reconciliation'] =
    i.state === 'UNKNOWN' ? (a?.adapter_capability === 'UNSUPPORTED' ? 'MANUAL_REVIEW' : 'SCHEDULED') : 'NONE';
  return {
    orderKind: kind,
    orderId: o.id,
    tenantId: o.tenant_id,
    incidentId: o.incident_id,
    siteId: o.site_id,
    planId: o.plan_id,
    planActionId: o.plan_action_id,
    candidateActionId: o.candidate_action_id,
    commercialIntentId: o.commercial_intent_id,
    executionAuthorityId: o.execution_authority_id,
    approvalId: o.approval_id,
    actionDigest: o.action_digest,
    providerAccountId: o.provider_account_id,
    providerAccountRevisionId: o.provider_account_revision_id,
    clientOperationId: o.client_operation_id,
    providerRef: o.provider_ref,
    state: o.state,
    terminal: TERMINAL_STATES[kind].includes(o.state),
    version: o.version,
    approved: {
      quantity: o.approved_quantity,
      amountMinor: BigInt(o.approved_amount_minor),
      currency: o.currency,
      etaAt: iso(o.approved_eta_at),
    },
    quantityFilled: kind === 'PURCHASE_ORDER' ? o.quantity_filled : null,
    scheduledStartAt: kind === 'SERVICE_JOB' ? iso(o.scheduled_start_at) : null,
    blockedReason: o.blocked_reason,
    cancelRequested: o.cancel_requested_at !== null,
    noEffectProven: o.no_effect_proven_at !== null,
    supersedesOrderId: o.supersedes_order_id,
    economic: {
      state: i.state,
      reasonCode: i.reason_code,
      transportState: a?.transport_state ?? null,
      externalOutcomeState: a?.external_outcome_state ?? null,
      adapterCapability: a?.adapter_capability ?? null,
      nextReconcileAt: iso(a?.next_reconcile_at),
      reconciliation,
    },
    transitions: t.rows.map((x: any) => ({
      sequence: x.sequence,
      from: x.from_state,
      to: x.to_state,
      reasonCode: x.reason_code,
      observationId: x.observation_id,
      source: x.source,
      at: new Date(x.created_at).toISOString(),
    })),
    observations: ob.rows.map((x: any) => ({
      observationId: x.id,
      source: x.source,
      providerEventKey: x.provider_event_key,
      providerAccountRevisionId: x.provider_account_revision_id,
      rawStatus: x.raw_status,
      normalizedState: x.normalized_state,
      disposition: x.disposition,
      reasonCode: x.reason_code,
      rawBodyDigest: x.raw_body_digest,
      observedAt: new Date(x.observed_at).toISOString(),
    })),
    changes: ch.rows.map((x: any) => ({
      changeProposalId: x.id,
      changeKind: x.change_kind,
      approved: x.approved,
      proposed: x.proposed,
      requiresReentry: x.requires_reentry,
      autoAccepted: false as const,
      invalidatedPlanId: x.invalidated_plan_id,
      observationId: x.observation_id,
    })),
    provesRecovery: false,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
