// The worker's runner set (M14; T-057). Every runner M13 left unscheduled (docs/handoffs/M13.json nextModuleInputs) is
// built here with a bounded default interval: the outbox publisher with every handle*Event consumer, the job runners,
// the tenant-scoped sweeps (one worker context per ACTIVE tenant through @uptimebuyer/data/worker), and the platform
// runners (retention, token-use pruning, platform signals). The worker holds no Kite credential and never reaches the
// broker: nothing here imports it, and the paid path stays behind the broker's own sweep and socket.
// Adapters are explicit dependencies. Without a configured provider adapter, contact dispatch records the attempt as
// UNSUPPORTED (ADAPTER_NOT_CONFIGURED, definite no effect); without status credentials, fulfillment polling is
// UNSUPPORTED; without CMMS credentials, CMMS writes are UNSUPPORTED pre-egress. None of these is ever shown as success.
import {
  COMPATIBILITY_INVALIDATION_CONSUMER,
  activateEffectivePolicy,
  handleInvalidationEvent,
} from '@uptimebuyer/compatibility';
import type { DomainEventEnvelope } from '@uptimebuyer/contracts';
import {
  OutboxPublisher,
  RetentionSweeper,
  pruneExpiredTokenUses,
  type CredentialResolver,
  type OutboxSink,
} from '@uptimebuyer/data';
import { forEachActiveTenant } from '@uptimebuyer/data/worker';
import { INCIDENT_ENGINE_CONSUMER, expireIncidentDeadlines, handleTelemetryEvent } from '@uptimebuyer/incidents';
import type { PlatformMetrics } from '@uptimebuyer/observability';
import { collectPlatformSignals } from '@uptimebuyer/operations';
import {
  FulfillmentAdapterRegistry,
  ORDERS_FACT_CONSUMER,
  ORDERS_INTENT_CONSUMER,
  handleCommercialIntentEvent,
  handleOrderStateEvent,
  pollFulfillmentStatus,
  runFulfillmentObservationJobs,
} from '@uptimebuyer/orders';
import { PLANNING_CONSUMER, handlePlanningEvent, runPlanRevalidationJobs } from '@uptimebuyer/planning';
import {
  BROKER_RESULT_CONSUMER,
  NOTIFICATION_CONSUMER,
  StaticAdapterRegistry,
  handleBrokerResultEvent,
  handleNotificationEvent,
  runContactDispatch,
  runWebhookApply,
  sweepContactAttempts,
  type ProviderAdapterRegistry,
} from '@uptimebuyer/providers';
import {
  HttpsCmmsAdapter,
  RECOVERY_FACT_CONSUMER,
  RECOVERY_REOPEN_CONSUMER,
  handleIncidentReopenedEvent,
  handleOrderFactEvent,
  monitorRecoveredIncidents,
  runCmmsWrites,
  type CmmsAdapter,
} from '@uptimebuyer/recovery';
import type pg from 'pg';
import type { RunnerSpec } from './scheduler.js';

export const RUNNER_NAMES = Object.freeze([
  'outbox.publish',
  'jobs.fulfillment_observation',
  'jobs.webhook_apply',
  'jobs.plan_revalidation',
  'jobs.contact_dispatch',
  'tenants.contact_sweep',
  'tenants.fulfillment_poll',
  'tenants.cmms_writes',
  'tenants.recovery_monitor',
  'tenants.deadline_expiry',
  'tenants.policy_activation',
  'platform.retention_sweep',
  'platform.token_prune',
  'platform.signals',
] as const);
export type RunnerName = (typeof RUNNER_NAMES)[number];

/** Default intervals (ms), each within the scheduler's [1 s, 24 h] bound. */
export const DEFAULT_INTERVALS: Readonly<Record<RunnerName, number>> = Object.freeze({
  'outbox.publish': 1_000,
  'jobs.fulfillment_observation': 2_000,
  'jobs.webhook_apply': 2_000,
  'jobs.plan_revalidation': 5_000,
  'jobs.contact_dispatch': 5_000,
  'tenants.contact_sweep': 30_000,
  'tenants.fulfillment_poll': 30_000,
  'tenants.cmms_writes': 15_000,
  'tenants.recovery_monitor': 60_000,
  'tenants.deadline_expiry': 15_000,
  'tenants.policy_activation': 60_000,
  'platform.retention_sweep': 3_600_000,
  'platform.token_prune': 600_000,
  'platform.signals': 30_000,
});

export interface OutboxConsumer {
  name: string;
  handle(pool: pg.Pool, envelope: DomainEventEnvelope): Promise<string>;
  /** Event types the consumer accepts; absent = it filters every type itself (returns IGNORED or no-ops). */
  eventTypes?: readonly string[];
}

/**
 * Every idempotent outbox consumer, in the order they see each event. Each one ignores event types it does not own
 * and records a receipt for the ones it does, so re-delivery is a no-op (consumeOnce). The names are the consumers'
 * durable receipt names.
 */
export const DEFAULT_CONSUMERS: readonly OutboxConsumer[] = Object.freeze([
  { name: INCIDENT_ENGINE_CONSUMER, handle: handleTelemetryEvent },
  { name: COMPATIBILITY_INVALIDATION_CONSUMER, handle: handleInvalidationEvent },
  { name: PLANNING_CONSUMER, handle: handlePlanningEvent },
  // The broker-result mirror validates its one event type strictly, so only that type is routed to it.
  { name: BROKER_RESULT_CONSUMER, handle: handleBrokerResultEvent, eventTypes: ['commercial_intent.state_changed.v1'] },
  { name: NOTIFICATION_CONSUMER, handle: handleNotificationEvent },
  { name: ORDERS_INTENT_CONSUMER, handle: handleCommercialIntentEvent },
  { name: ORDERS_FACT_CONSUMER, handle: handleOrderStateEvent },
  { name: RECOVERY_FACT_CONSUMER, handle: handleOrderFactEvent },
  { name: RECOVERY_REOPEN_CONSUMER, handle: handleIncidentReopenedEvent },
]);

/**
 * Delivers one event to every consumer. A consumer failure fails the delivery, so the publisher releases its leases
 * and the event (still unpublished) is retried in order on the next tick; consumers that already processed it answer
 * DUPLICATE. A poison event therefore holds the queue and raises the outbox-age alert rather than being skipped:
 * durable events are never dropped (OBSERVABILITY-OPERATIONS §8, outbox backlog runbook).
 */
export class ConsumerSink implements OutboxSink {
  constructor(
    private readonly pool: pg.Pool,
    private readonly consumers: readonly OutboxConsumer[] = DEFAULT_CONSUMERS,
  ) {}

  async publish(event: DomainEventEnvelope): Promise<void> {
    for (const c of this.consumers)
      if (!c.eventTypes || c.eventTypes.includes(event.eventType)) await c.handle(this.pool, event);
  }
}

export interface WorkerDeps {
  pool: pg.Pool;
  workerId: string;
  providerAdapters?: ProviderAdapterRegistry;
  fulfillmentAdapters?: FulfillmentAdapterRegistry;
  cmms?: CmmsAdapter;
  credentials?: CredentialResolver;
  platformMetrics?: PlatformMetrics;
  intervals?: Partial<Record<RunnerName, number>>;
  consumers?: readonly OutboxConsumer[];
  /** Outbox batches drained per tick (bounded). */
  outboxBatchesPerTick?: number;
}

const failIfAny = (r: { tenants: number; failed: { tenantId: string; code: string }[] }) => {
  if (r.failed.length > 0)
    throw Object.assign(new Error(`${r.failed.length} of ${r.tenants} tenants failed`), {
      code: r.failed[0]!.code,
    });
  return { work: r.tenants };
};

export function buildRunners(deps: WorkerDeps): RunnerSpec[] {
  const { pool, workerId } = deps;
  const providerAdapters = deps.providerAdapters ?? new StaticAdapterRegistry([]);
  const fulfillmentAdapters = deps.fulfillmentAdapters ?? new FulfillmentAdapterRegistry([]);
  const cmms = deps.cmms ?? HttpsCmmsAdapter.fromEnv({});
  const interval = (n: RunnerName) => deps.intervals?.[n] ?? DEFAULT_INTERVALS[n];
  const tenants = (runner: RunnerName, signal: AbortSignal, fn: Parameters<typeof forEachActiveTenant>[2]) =>
    forEachActiveTenant(pool, { workerId, runner, signal }, fn).then(failIfAny);
  const publisher = new OutboxPublisher(pool, new ConsumerSink(pool, deps.consumers ?? DEFAULT_CONSUMERS), {
    workerId: `${workerId}.outbox`.slice(0, 64),
    batchSize: 100,
  });
  const batches = Math.max(1, Math.min(deps.outboxBatchesPerTick ?? 20, 200));
  const retention = new RetentionSweeper(pool, { workerId: `${workerId}.retention`.slice(0, 64) });

  const specs: Record<RunnerName, RunnerSpec['run']> = {
    'outbox.publish': async (signal) => {
      let published = 0;
      for (let i = 0; i < batches && !signal.aborted; i++) {
        const r = await publisher.runOnce();
        published += r.published;
        if (r.claimed === 0) break;
      }
      return { work: published };
    },
    'jobs.fulfillment_observation': async () => ({
      work: (await runFulfillmentObservationJobs(pool, { workerId, limit: 50 })).applied,
    }),
    'jobs.webhook_apply': async () => ({ work: (await runWebhookApply(pool, { workerId, limit: 50 })).applied }),
    'jobs.plan_revalidation': async () => ({
      work: (await runPlanRevalidationJobs(pool, { workerId, limit: 50 })).processed,
    }),
    'jobs.contact_dispatch': async () => ({
      work: (
        await runContactDispatch(pool, {
          adapters: providerAdapters,
          workerId,
          limit: 10,
          ...(deps.credentials ? { credentials: deps.credentials } : {}),
        })
      ).dispatched,
    }),
    'tenants.contact_sweep': (signal) =>
      tenants('tenants.contact_sweep', signal, (ctx) =>
        sweepContactAttempts(
          pool,
          ctx,
          { adapters: providerAdapters, ...(deps.credentials ? { credentials: deps.credentials } : {}) },
          { limit: 100 },
        ),
      ),
    'tenants.fulfillment_poll': (signal) =>
      tenants('tenants.fulfillment_poll', signal, (ctx) =>
        pollFulfillmentStatus(pool, ctx, { adapters: fulfillmentAdapters }),
      ),
    'tenants.cmms_writes': (signal) =>
      tenants('tenants.cmms_writes', signal, (ctx) => runCmmsWrites(pool, ctx, { adapter: cmms, workerId, limit: 50 })),
    'tenants.recovery_monitor': (signal) =>
      tenants('tenants.recovery_monitor', signal, (ctx) => monitorRecoveredIncidents(pool, ctx, { limit: 200 })),
    'tenants.deadline_expiry': (signal) =>
      tenants('tenants.deadline_expiry', signal, (ctx) => expireIncidentDeadlines(pool, ctx, { limit: 200 })),
    'tenants.policy_activation': (signal) =>
      tenants('tenants.policy_activation', signal, (ctx) => activateEffectivePolicy(pool, ctx)),
    'platform.retention_sweep': async () => {
      const r = await retention.runOnce();
      const failed = r.filter((x) => x.error !== null);
      if (failed.length > 0)
        throw Object.assign(new Error(`${failed.length} tenants failed retention`), { code: failed[0]!.error });
      return { work: r.length };
    },
    'platform.token_prune': async () => ({ work: (await pruneExpiredTokenUses(pool)).deleted }),
    'platform.signals': async () => {
      if (deps.platformMetrics) await collectPlatformSignals(pool, deps.platformMetrics);
      return { work: 0 };
    },
  };
  return RUNNER_NAMES.map((name) => ({ name, intervalMs: interval(name), run: specs[name] }));
}
