// @uptimebuyer/orders — M10 order, service-job and external-outcome reconciliation: purchase-order and service-job
// command handlers over their SEPARATE machines, one order/job per stable action digest and immutable execution
// authority (composing with M09's commercial-intent uniqueness), verified fulfillment webhooks and bounded polling
// pinned to the exact provider-account revision of the attempt, UNKNOWN reconciliation only through the exclusive
// broker, material changes that block the next action and reopen evidence/compatibility/approval, the egress
// linearization point for revocation, and replay-safe order/job facts on the outbox for the M11 CMMS adapter.
// Credential-free and recovery-free: nothing here reaches paid egress or proves, closes or releases anything.
export * from './vocabulary.js';
export { ORDERS_ID_PREFIXES, kindOfId } from './internal.js';
export type { OrderView } from './views.js';
export {
  getFulfillmentGate,
  getOrder,
  listIncidentOrders,
  requestOrder,
  type FulfillmentGate,
  type RequestOrderResult,
} from './orders.js';
export { dispatchOrder, mirrorOrder, reconcileOrder, type DispatchDeps, type OrderBrokerPort } from './dispatch.js';
export { recordFulfillmentVerification, revokeOrder } from './changes.js';
export {
  FULFILLMENT_OBSERVATION_JOB,
  FULFILLMENT_WEBHOOK_LIMITS,
  ingestFulfillmentWebhook,
  parseFulfillmentEvent,
  runFulfillmentObservationJobs,
  signFulfillmentWebhook,
  verifyFulfillmentSignature,
  type FulfillmentEvent,
  type FulfillmentWebhookResult,
  type SignatureCheck,
} from './webhooks.js';
export {
  FulfillmentAdapterRegistry,
  HttpsFulfillmentStatusAdapter,
  POLL_LIMITS,
  RecordedFulfillmentAdapter,
  pollFulfillmentStatus,
  type FulfillmentLookupResult,
  type FulfillmentStatusAdapter,
  type FulfillmentTarget,
  type PolledObservation,
} from './polling.js';
export {
  ORDERS_FACT_CONSUMER,
  ORDERS_INTENT_CONSUMER,
  handleCommercialIntentEvent,
  handleOrderStateEvent,
  syncIncidentForOrder,
  type IncidentSyncResult,
} from './incident-driver.js';
