// @uptimebuyer/providers — M07 provider discovery and communications: revision-routed provider accounts (unpaid
// revisions to M07 adapters, paid revisions to the commercial-intent broker port only), bounded durable searches with
// separate discovery source and approved-vendor status, immutable contact requests and idempotent attempts with
// separate transport / external outcome / capability / raw status axes, consent-bound minimized transcripts, quotes,
// signed provider webhooks and FR-20 notification routing. No paid credential, no paid egress; real provider and
// payment evidence is NOT_RUN.
export * from './ids.js';
export * from './errors.js';
export * from './normalize.js';
export * from './schemas.js';
export * from './ports.js';
export {
  HttpsProviderTransport,
  ProviderEgressError,
  guardedLookup,
  nodeHttpsRequester,
  systemDnsResolver,
  assertProviderUrlAllowed,
  assertResolvesPublic,
  assertSafePath,
  endpointPolicyDigest,
  isNonPublicAddress,
  type DnsResolver,
  type GuardedLookup,
  type HttpsRequester,
  type HttpsResponseLike,
  type EndpointPolicy,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderHttpTransport,
  type TransportCallOptions,
} from './egress.js';
export {
  AmbiguousResponseError,
  FixtureProviderTransport,
  StructuredProviderApiAdapter,
  rawResponseDigest,
  type FixtureHandler,
  type FixtureReply,
} from './adapters/structured-api.js';
export {
  ChannelContactAdapter,
  LocalChannelTransport,
  type ChannelMessage,
  type ChannelTransport,
} from './adapters/channel.js';
export {
  PAID_CANDIDATE_PROVIDERS,
  paidCandidateShell,
  type PaidCandidateProvider,
  type PaidCandidateShell,
} from './adapters/candidates.js';
export { RevisionRateLimiter } from './internal.js';
export * from './redaction.js';
export * from './events.js';
export { DISPLAY_STATUSES, displayStatusOf, type AttemptView, type DisplayStatus } from './attempts.js';
export {
  SEARCH_LIMITS,
  getProviderSearch,
  linkApprovedVendor,
  reviewContactPoint,
  runProviderSearch,
  type ProviderSearchView,
  type RunSearchInput,
  type SearchDeps,
  type SearchResultView,
} from './search.js';
export {
  CONTACT_DISPATCH_JOB,
  CONTACT_PURPOSES,
  RECORDING_DISCLOSURE_TEXT,
  dispatchContactAttempt,
  executeContactRequest,
  getContactRequest,
  invalidateSupersededContactWork,
  prepareContactRequest,
  reconcileContactAttempt,
  runContactDispatch,
  sweepContactAttempts,
  type ContactRequestView,
  type DispatchDeps,
  type ExecuteContactInput,
  type ExecuteContactResult,
  type ExecuteDeps,
  type PrepareContactInput,
  type PreparedContactRequest,
  type ReconcileDeps,
} from './contacts.js';
export {
  BROKER_RESULT_CONSUMER,
  applyBrokerEvent,
  handleBrokerResultEvent,
  paidIdempotencyKey,
  type BrokerEventDisposition,
  type PaidAuthority,
} from './broker.js';
export {
  COMMUNICATION_LIMITS,
  eraseCommunicationBody,
  exportCommunications,
  getCommunication,
  prepareModelExcerpt,
  promoteExcerptToEvidence,
  recordCommunication,
  recordConsent,
  type CommunicationView,
  type RecordCommunicationInput,
} from './communications.js';
export { QUOTE_SCOPES, listIncidentQuotes, recordQuote, type QuoteView, type RecordQuoteInput } from './quotes.js';
export {
  WEBHOOK_APPLY_JOB,
  WEBHOOK_LIMITS,
  ingestProviderWebhook,
  runWebhookApply,
  signProviderWebhook,
  type WebhookResult,
} from './webhooks.js';
export {
  NOTIFICATION_CONSUMER,
  NOTIFICATION_LIMITS,
  NOTIFICATION_ROUTING_VERSION,
  ROUTING_V1,
  TRIGGER_KINDS,
  LocalNotificationInbox,
  dispatchNotifications,
  enqueueNotificationTrigger,
  handleNotificationEvent,
  listMyNotifications,
  type NotificationDeliveryPort,
  type NotificationMessage,
  type NotificationTrigger,
  type NotificationView,
  type TriggerKind,
} from './notifications.js';
