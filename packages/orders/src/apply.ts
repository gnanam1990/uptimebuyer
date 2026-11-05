// Applying observations (FR-13, NFR-02, NFR-03, INV-08, INV-12). The caller holds the order row lock (lockOrder).
// Every observation is first recorded immutably with its namespaced event key (tenant + provider account), so a
// duplicate webhook/poll/broker event is recognised and acts at most once; then a legal, non-stale observation moves
// the order/job by one edge of its own machine with an append-only transition and an outbox fact. A material change
// enters its explicit state, blocks the next action (set-once block), records a never-auto-accepted change proposal
// and invalidates the bound plan; the incident escalation follows through M04 (incident-driver.ts). The broker mirror
// maps the M09 economic intent onto the order without ever re-deciding payment: SUBMITTED/CONFIRMED is provider
// acceptance only, UNKNOWN stays UNKNOWN, FAILED is the intent's own definite-no-effect proof.
import { newId } from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import { appendOutboxEvent, dbNow, recordAudit, type TenantContext, type Tx } from '@uptimebuyer/data';
import { invalidatePlanForExecutionChange } from '@uptimebuyer/planning';
import { KIND, actorFields, newOrdersId } from './internal.js';
import {
  MATERIAL_CHANGE_STATES,
  TERMINAL_STATES,
  planObservation,
  reentryFor,
  type ChangeKind,
  type ObservationDetails,
  type ObservationPlan,
  type ObservationSource,
  type OrderKind,
} from './vocabulary.js';

export interface IncomingObservation {
  source: ObservationSource;
  /** Namespaced by tenant and provider account through the table's unique key; prefixed by source. */
  providerEventKey: string;
  rawStatus: string;
  observedAt: string;
  sequence: number | null;
  details: ObservationDetails;
  providerRef?: string | null;
  rawBody?: Uint8Array | null;
  rawBodyDigest?: string | null;
  webhookDeliveryId?: string | null;
  /** The provider-account revision that verified/produced this observation; must equal the order's pinned one. */
  providerAccountRevisionId: string;
  /** Broker mirror only: the target decided from the M09 intent, not from a provider word. */
  forced?: { target: string; noEffect: boolean; reasonCode: string; material: boolean } | null;
}

export interface ApplyResult {
  duplicate: boolean;
  observationId: string | null;
  disposition: string;
  transitioned: boolean;
  changeKind: ChangeKind | null;
}

const DISPOSITION = {
  APPLY: 'APPLIED',
  STALE: 'STALE',
  ILLEGAL: 'ILLEGAL',
  UNMAPPED: 'UNMAPPED',
  NO_CHANGE: 'NO_CHANGE',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function approvedTermsOf(o: any) {
  return {
    quantity: o.approved_quantity,
    amountMinor: BigInt(o.approved_amount_minor),
    currency: o.currency,
    etaAt: o.approved_eta_at ? new Date(o.approved_eta_at).toISOString() : null,
  };
}

async function insertObservation(
  c: Tx,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
  obs: IncomingObservation,
  normalized: string | null,
  disposition: string,
  reasonCode: string | null,
): Promise<string | null> {
  const actor = actorFields(ctx);
  const id = newOrdersId('observation');
  const r = await c.query(
    `INSERT INTO fulfillment_observations (tenant_id, id, order_kind, purchase_order_id, service_job_id,
       provider_account_id, provider_account_revision_id, source, provider_event_key, webhook_delivery_id, raw_status,
       normalized_state, raw_body, raw_body_digest, details, observed_at, provider_sequence, disposition, reason_code,
       actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (tenant_id, provider_account_id, provider_event_key) DO NOTHING RETURNING id`,
    [
      ctx.tenantId,
      id,
      kind,
      kind === 'PURCHASE_ORDER' ? o.id : null,
      kind === 'SERVICE_JOB' ? o.id : null,
      o.provider_account_id,
      obs.providerAccountRevisionId,
      obs.source,
      obs.providerEventKey,
      obs.webhookDeliveryId ?? null,
      obs.rawStatus.slice(0, 256),
      normalized,
      obs.rawBody ? Buffer.from(obs.rawBody) : null,
      obs.rawBodyDigest ?? null,
      JSON.stringify(obs.details ?? {}),
      obs.observedAt,
      obs.sequence,
      disposition,
      reasonCode,
      actor.kind,
      actor.id,
    ],
  );
  return r.rows[0]?.id ?? null;
}

export async function emitOrderStateChanged(
  c: Tx,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
  from: string,
  rawProviderStatus: string | null,
): Promise<void> {
  const k = KIND[kind];
  await appendOutboxEvent(c, ctx, {
    eventType: k.eventType,
    aggregateType: k.aggregateType,
    aggregateId: o.id,
    aggregateVersion: o.version,
    payload: {
      [k.payloadKey]: o.id,
      from,
      to: o.state,
      rawProviderStatus: rawProviderStatus === null ? null : rawProviderStatus.slice(0, 256),
      rawEvidence: null,
    },
    correlationId: ctx.correlationId,
    causationId: newId('command'),
  } as never);
}

/** Record a material change: proposal (never auto-accepted), and invalidation of the plan bound to the order. */
export async function recordMaterialChange(
  c: Tx,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
  changeKind: ChangeKind,
  observationId: string | null,
  proposed: Record<string, unknown>,
  opts: { invalidatePlan: boolean },
): Promise<void> {
  let invalidatedPlanId: string | null = null;
  if (opts.invalidatePlan) {
    const inv = await invalidatePlanForExecutionChange(c, ctx, o.incident_id, o.plan_id);
    invalidatedPlanId = inv.invalidatedPlanIds[0] ?? null;
  }
  const actor = actorFields(ctx);
  const approved = approvedTermsOf(o);
  await c.query(
    `INSERT INTO fulfillment_change_proposals (tenant_id, id, order_kind, purchase_order_id, service_job_id,
       observation_id, change_kind, approved, proposed, requires_reentry, invalidated_plan_id, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
    [
      ctx.tenantId,
      newOrdersId('changeProposal'),
      kind,
      kind === 'PURCHASE_ORDER' ? o.id : null,
      kind === 'SERVICE_JOB' ? o.id : null,
      observationId,
      changeKind,
      JSON.stringify({ ...approved, amountMinor: approved.amountMinor.toString() }),
      JSON.stringify(proposed),
      reentryFor(changeKind),
      invalidatedPlanId,
      actor.kind,
      actor.id,
    ],
  );
  await recordAudit(c, ctx, {
    action: 'orders.material_change',
    resourceType: KIND[kind].aggregateType,
    resourceId: o.id,
    result: 'SUCCEEDED',
    reasonCode: changeKind,
  });
}

/** Apply one observation to a LOCKED order/job row. */
export async function applyObservationInTx(
  c: Tx,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
  obs: IncomingObservation,
): Promise<ApplyResult> {
  const k = KIND[kind];
  let plan: ObservationPlan;
  let refused: string | null = null;
  if (obs.providerAccountRevisionId !== o.provider_account_revision_id) refused = 'REVISION_MISMATCH';
  else if (obs.providerRef && o.provider_ref && obs.providerRef !== o.provider_ref) refused = 'PROVIDER_REF_CONFLICT';
  else if (obs.providerRef && !o.provider_ref && (await providerRefTaken(c, ctx.tenantId, o, obs.providerRef)))
    refused = 'PROVIDER_REF_CONFLICT'; // bound to another order of the account: never adopted (no cross-order mapping)
  else if (obs.source === 'WEBHOOK' || obs.source === 'POLL') {
    // Nothing can have reached the provider before the intent's attempt exists: a provider statement now is drift.
    const sent = await c.query(`SELECT 1 FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [
      ctx.tenantId,
      o.commercial_intent_id,
    ]);
    if (sent.rowCount === 0) refused = 'NOTHING_SENT';
  }
  if (obs.forced) {
    plan = isTransitionAllowed(kind, o.state, obs.forced.target)
      ? {
          disposition: 'APPLY',
          target: obs.forced.target,
          changeKind: null,
          reasonCode: obs.forced.reasonCode,
        }
      : { disposition: 'NO_CHANGE', target: obs.forced.target, changeKind: null, reasonCode: 'STATE_UNCHANGED' };
  } else
    plan = planObservation({
      kind,
      current: o.state,
      approved: approvedTermsOf(o),
      lastObservedAt: o.last_observed_at ? new Date(o.last_observed_at).toISOString() : null,
      lastSequence: o.last_provider_sequence === null ? null : Number(o.last_provider_sequence),
      source: obs.source,
      obs: { rawStatus: obs.rawStatus, observedAt: obs.observedAt, sequence: obs.sequence, details: obs.details },
    });
  if (refused) {
    await recordAudit(c, ctx, {
      action: 'orders.observation',
      resourceType: k.aggregateType,
      resourceId: o.id,
      result: 'DENIED',
      reasonCode: refused,
    });
    // Under a foreign revision the observation cannot attach to the order at all (its FK pins the order's revision);
    // otherwise the refused evidence is kept immutably and never applied.
    const id =
      refused === 'REVISION_MISMATCH' ? null : await insertObservation(c, ctx, kind, o, obs, null, 'REFUSED', refused);
    return { duplicate: false, observationId: id, disposition: 'REFUSED', transitioned: false, changeKind: null };
  }
  const disposition = DISPOSITION[plan.disposition];
  const observationId = await insertObservation(
    c,
    ctx,
    kind,
    o,
    obs,
    plan.disposition === 'UNMAPPED' ? null : plan.target,
    disposition,
    plan.reasonCode && plan.disposition !== 'APPLY' ? plan.reasonCode : null,
  );
  if (!observationId)
    return { duplicate: true, observationId: null, disposition: 'DUPLICATE', transitioned: false, changeKind: null };
  if (plan.disposition !== 'APPLY')
    return { duplicate: false, observationId, disposition, transitioned: false, changeKind: null };

  const target = plan.target!;
  let changeKind = plan.changeKind;
  if (obs.forced?.material) changeKind = materialKindOf(kind, target);
  const material = changeKind !== null;
  const terminal = TERMINAL_STATES[kind].includes(target);
  const now = await dbNow(c);
  const observedAt =
    o.last_observed_at && Date.parse(o.last_observed_at) > Date.parse(obs.observedAt)
      ? o.last_observed_at
      : obs.observedAt;
  const sets = [
    'state = $3',
    'version = version + 1',
    'last_observation_id = $4',
    'last_observed_at = $5',
    'last_provider_sequence = coalesce($6, last_provider_sequence)',
    'provider_ref = coalesce(provider_ref, $7)',
    'blocked_reason = coalesce(blocked_reason, $8)',
    'no_effect_proven_at = CASE WHEN $9 THEN coalesce(no_effect_proven_at, $10::timestamptz) ELSE no_effect_proven_at END',
    'next_poll_at = CASE WHEN $11 THEN NULL ELSE next_poll_at END',
    'updated_at = clock_timestamp()',
  ];
  const params: unknown[] = [
    ctx.tenantId,
    o.id,
    target,
    observationId,
    observedAt,
    obs.sequence,
    obs.providerRef ?? null,
    material ? changeKind : null,
    obs.forced?.noEffect === true,
    now,
    terminal,
  ];
  if (kind === 'PURCHASE_ORDER' && typeof obs.details.quantityFilled === 'number') {
    params.push(obs.details.quantityFilled);
    sets.push(`quantity_filled = greatest(quantity_filled, $${params.length})`);
  }
  if (kind === 'SERVICE_JOB' && typeof obs.details.scheduledStartAt === 'string') {
    params.push(obs.details.scheduledStartAt);
    sets.push(`scheduled_start_at = $${params.length}`);
  }
  const up = (
    await c.query(`UPDATE ${k.table} SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`, params)
  ).rows[0];
  const actor = actorFields(ctx);
  await c.query(
    `INSERT INTO ${k.transitions} (tenant_id, id, ${k.fk}, sequence, from_state, to_state, observation_id, reason_code,
       actor_kind, actor_id)
     SELECT $1, $2, $3, coalesce(max(sequence), 0) + 1, $4, $5, $6, $7, $8, $9 FROM ${k.transitions}
      WHERE tenant_id = $1 AND ${k.fk} = $3`,
    [
      ctx.tenantId,
      newOrdersId(kind === 'PURCHASE_ORDER' ? 'purchaseOrderTransition' : 'serviceJobTransition'),
      o.id,
      o.state,
      target,
      observationId,
      plan.reasonCode ?? (changeKind ? `CHANGE_${changeKind}` : `OBSERVED_${obs.source}`),
      actor.kind,
      actor.id,
    ],
  );
  await emitOrderStateChanged(c, ctx, kind, up, o.state, obs.source === 'BROKER' ? null : obs.rawStatus);
  if (material) {
    // Only a change after possible egress reopens policy; a pre-egress no-effect failure leaves the plan approved so
    // a fresh authority may create the linked successor (INV-07).
    await recordMaterialChange(c, ctx, kind, up, changeKind!, observationId, proposedOf(obs), {
      invalidatePlan: obs.forced?.noEffect !== true || obs.forced.material,
    });
  }
  Object.assign(o, up);
  return { duplicate: false, observationId, disposition, transitioned: true, changeKind };
}

async function providerRefTaken(c: Tx, tenantId: string, o: any, providerRef: string): Promise<boolean> {
  for (const t of [KIND.PURCHASE_ORDER.table, KIND.SERVICE_JOB.table]) {
    const r = await c.query(
      `SELECT 1 FROM ${t} WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_ref = $3 AND id <> $4`,
      [tenantId, o.provider_account_id, providerRef, o.id],
    );
    if (r.rowCount) return true;
  }
  return false;
}

function proposedOf(obs: IncomingObservation): Record<string, unknown> {
  return { rawStatus: obs.rawStatus, observedAt: obs.observedAt, ...obs.details };
}

const MATERIAL_KIND: Record<string, ChangeKind> = {
  CANCELLED: 'CANCELLATION',
  FAILED: 'PROVIDER_FAILURE',
  REJECTED: 'REJECTION',
};
function materialKindOf(kind: OrderKind, state: string): ChangeKind | null {
  return MATERIAL_CHANGE_STATES[kind].includes(state) ? (MATERIAL_KIND[state] ?? null) : null;
}

/**
 * Mirror the M09 economic intent onto a LOCKED order/job (idempotent: it reads the current intent/attempt state, so
 * replayed or out-of-order intent events converge). Never decides payment; never fabricates a provider fact.
 */
export async function mirrorIntentInTx(
  c: Tx,
  ctx: TenantContext,
  kind: OrderKind,
  o: any,
): Promise<ApplyResult | null> {
  const i = (
    await c.query(`SELECT * FROM commercial_intents WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      o.commercial_intent_id,
    ])
  ).rows[0];
  const a = (
    await c.query(`SELECT * FROM external_attempts WHERE tenant_id = $1 AND intent_id = $2`, [ctx.tenantId, i.id])
  ).rows[0];
  // Start bounded polling once something may have been sent (by provider reference or the pre-egress key).
  if (a && o.next_poll_at === null && o.poll_count === 0 && !TERMINAL_STATES[kind].includes(o.state)) {
    await c.query(
      `UPDATE ${KIND[kind].table} SET next_poll_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, o.id],
    );
    o.next_poll_at = new Date();
  }
  let forced: IncomingObservation['forced'] = null;
  let key = '';
  if (
    ['SUBMITTED', 'CONFIRMED', 'REFUNDED', 'REVERSED'].includes(i.state) &&
    ['REQUESTED', 'UNKNOWN'].includes(o.state)
  ) {
    forced = { target: 'ACCEPTED', noEffect: false, reasonCode: 'PROVIDER_ACCEPTED_PAYMENT_OBSERVED', material: false };
    key = 'accepted';
  } else if (i.state === 'UNKNOWN' && ['REQUESTED', 'ACCEPTED'].includes(o.state)) {
    forced = { target: 'UNKNOWN', noEffect: false, reasonCode: 'BROKER_OUTCOME_UNKNOWN', material: false };
    key = `unknown.v${i.version}`;
  } else if (i.state === 'FAILED' && ['REQUESTED', 'UNKNOWN', 'ACCEPTED'].includes(o.state)) {
    const cancelled = o.cancel_requested_at !== null;
    const target = cancelled ? 'CANCELLED' : o.state === 'ACCEPTED' ? 'FAILED' : a ? 'REJECTED' : 'FAILED';
    forced = {
      target,
      noEffect: true,
      reasonCode: `INTENT_FAILED_${i.reason_code ?? 'NO_EFFECT'}`.slice(0, 64),
      material: !!a,
    };
    key = 'failed';
  }
  if (!forced) return null;
  return applyObservationInTx(c, ctx, kind, o, {
    source: 'BROKER',
    providerEventKey: `broker:${i.id}:${key}`,
    rawStatus: `intent:${i.state}${a?.raw_provider_status ? `:${a.raw_provider_status}` : ''}`.slice(0, 256),
    observedAt: new Date().toISOString(),
    sequence: null,
    details: {},
    providerRef: forced.target === 'ACCEPTED' ? (a?.provider_ref ?? null) : null,
    providerAccountRevisionId: o.provider_account_revision_id,
    forced,
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
