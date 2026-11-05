// apps/worker entry point (M14; T-057). Usage: node --import <register-dist> dist/main.js (see infra/docker/Dockerfile).
// Configuration from the environment (non-secret values and secret file references only), a bounded PostgreSQL pool,
// every runner scheduled with a per-runner advisory lock, the operations listener on a private address, and graceful
// shutdown bound to one root AbortController: SIGTERM/SIGINT stop new ticks, in-flight ticks drain up to the bound, and
// the pool closes last. Invalid configuration exits with EX_CONFIG (78) naming keys, never values.
import {
  HealthRegistry,
  MetricsRegistry,
  SecretRegistry,
  StructuredLogger,
  platformMetrics,
} from '@uptimebuyer/observability';
import { readinessChecks } from '@uptimebuyer/operations';
import pg from 'pg';
import {
  WorkerConfigError,
  cmmsAdapterFrom,
  loadWorkerConfig,
  operationsToken,
  providerCredentials,
} from './config.js';
import { buildWorkerOpsServer, registerSchedulerChecks } from './ops.js';
import { RUNNER_NAMES, buildRunners } from './runners.js';
import { PgAdvisoryLocks, Scheduler, workerMetrics } from './scheduler.js';

let setup;
try {
  const cfg = loadWorkerConfig(process.env);
  setup = { cfg, cmms: cmmsAdapterFrom(cfg), token: operationsToken(cfg), credentials: providerCredentials(cfg) };
} catch (e) {
  const reason = e instanceof WorkerConfigError ? e.message : 'invalid worker configuration';
  process.stderr.write(`${JSON.stringify({ service: 'worker', event: 'worker.config_rejected', reason })}\n`);
  process.exit(78);
}
const { cfg, cmms, token, credentials } = setup;

const secrets = new SecretRegistry();
secrets.register(cfg.DATABASE_URL);
if (token) secrets.register(token);
const logger = new StructuredLogger({ service: 'worker', secrets, base: { workerId: cfg.UB_WORKER_ID } });
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.UB_WORKER_DB_POOL_MAX });
pool.on('error', () => logger.warn('worker.pool_error'));
const metrics = new MetricsRegistry();
const pm = platformMetrics(metrics);
const root = new AbortController();
const scheduler = new Scheduler({
  runners: buildRunners({
    pool,
    workerId: cfg.UB_WORKER_ID,
    cmms,
    platformMetrics: pm,
    ...(credentials ? { credentials } : {}),
  }),
  locks: new PgAdvisoryLocks(pool),
  signal: root.signal,
  metrics: workerMetrics(metrics, RUNNER_NAMES),
  logger,
  drainTimeoutMs: cfg.UB_WORKER_DRAIN_TIMEOUT_MS,
});
const health = new HealthRegistry();
readinessChecks(health, pool);
registerSchedulerChecks(health, scheduler);
const ops = buildWorkerOpsServer({ health, metrics, scheduler, token });
await new Promise<void>((resolve) => ops.listen(cfg.UB_WORKER_OPS_PORT, cfg.UB_WORKER_OPS_HOST, resolve));
scheduler.start();
logger.info('worker.started', {
  runners: RUNNER_NAMES.length,
  cmms: cmms.capability(),
  opsPort: cfg.UB_WORKER_OPS_PORT,
});

let exiting = false;
const stop = async (sig: string) => {
  if (exiting) return;
  exiting = true;
  logger.info('worker.stopping', { signal: sig });
  root.abort();
  const { drained } = await scheduler.stop();
  await new Promise<void>((r) => ops.close(() => r()));
  await pool.end().catch(() => {});
  logger.info('worker.stopped', { drained });
  process.exit(drained ? 0 : 1);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
