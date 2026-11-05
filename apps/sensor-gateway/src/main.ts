// apps/sensor-gateway entry point (M14; T-057). Signed HTTPS telemetry ingestion (behind the edge's TLS termination)
// plus the freshness sweeper, in one deployable. Device credential keys are resolved from files under
// UB_DEVICE_SECRET_ROOT (FileSecretStore: `<root>/<namespace>/tenants/<tenantId>/<path>`, 0600/0400), never from the
// environment. The database password comes from a 0600 pgpass file (PGPASSFILE). Invalid configuration exits with
// EX_CONFIG (78) naming keys, never values; SIGTERM/SIGINT stop the sweeper, close the listener and the pool.
import { FileSecretStore, SecretFileError } from '@uptimebuyer/data';
import pg from 'pg';
import { z } from 'zod';
import { buildSensorGateway } from './app.js';
import { startFreshnessSweeper } from './sweeper.js';

const Schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  UB_GATEWAY_HOST: z.string().min(1).max(64).default('127.0.0.1'),
  UB_GATEWAY_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
  UB_DEVICE_SECRET_ROOT: z.string().min(1).max(1024).startsWith('/'),
  UB_GATEWAY_SWEEP_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  UB_TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

let cfg: z.output<typeof Schema>;
let credentials: FileSecretStore;
try {
  const r = Schema.safeParse(process.env);
  if (!r.success)
    throw new Error(
      `invalid sensor-gateway configuration: ${[...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ')}`,
    );
  cfg = r.data;
  try {
    credentials = new FileSecretStore(cfg.UB_DEVICE_SECRET_ROOT);
  } catch (e) {
    throw new Error(
      `unusable secret reference UB_DEVICE_SECRET_ROOT: ${e instanceof SecretFileError ? e.reasonCode : 'UNREADABLE'}`,
      { cause: e },
    );
  }
} catch (e) {
  process.stderr.write(
    `${JSON.stringify({ service: 'sensor-gateway', event: 'gateway.config_rejected', reason: (e as Error).message })}\n`,
  );
  process.exit(78);
}

const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 16 });
pool.on('error', () => {});
const gateway = await buildSensorGateway({ pool, credentials, trustProxy: cfg.UB_TRUST_PROXY === 'true' });
const sweeper = startFreshnessSweeper({ pool, intervalMs: cfg.UB_GATEWAY_SWEEP_MS });
const address = await gateway.app.listen({ host: cfg.UB_GATEWAY_HOST, port: cfg.UB_GATEWAY_PORT });
console.log(JSON.stringify({ service: 'sensor-gateway', event: 'gateway.listening', address }));

let exiting = false;
const stop = async () => {
  if (exiting) return;
  exiting = true;
  await sweeper.stop();
  await gateway.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
