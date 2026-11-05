// Worker runtime configuration (M14). Only non-secret values come from the environment; secrets are read from files
// the deployment mounts (a 0600/0400 operations token, an optional CMMS token, an optional provider credential root),
// and the environment names only their paths. The database password comes from a 0600 pgpass file (PGPASSFILE), so
// DATABASE_URL carries no password. Invalid configuration names the offending keys, never their values.
import { FileSecretStore, readSecretFile } from '@uptimebuyer/data';
import { HttpsCmmsAdapter, type CmmsAdapter } from '@uptimebuyer/recovery';
import { z } from 'zod';

const Path = z.string().min(1).max(1024).startsWith('/');
export const WorkerConfigSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  UB_WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/)
    .default('worker'),
  UB_WORKER_OPS_HOST: z.string().min(1).max(64).default('127.0.0.1'),
  UB_WORKER_OPS_PORT: z.coerce.number().int().min(0).max(65535).default(9465),
  UB_WORKER_OPS_TOKEN_FILE: Path.optional(),
  UB_WORKER_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  UB_WORKER_DB_POOL_MAX: z.coerce.number().int().min(2).max(64).default(10),
  UB_CMMS_BASE_URL: z.url().optional(),
  UB_CMMS_TOKEN_FILE: Path.optional(),
  UB_PROVIDER_SECRET_ROOT: Path.optional(),
});
export type WorkerConfig = z.output<typeof WorkerConfigSchema>;

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const r = WorkerConfigSchema.safeParse(env);
  if (!r.success) {
    const keys = [...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new WorkerConfigError(`invalid worker configuration: ${keys}`);
  }
  if ((r.data.UB_CMMS_BASE_URL === undefined) !== (r.data.UB_CMMS_TOKEN_FILE === undefined))
    throw new WorkerConfigError('invalid worker configuration: UB_CMMS_BASE_URL and UB_CMMS_TOKEN_FILE go together');
  return r.data;
}

/** The CMMS adapter: HTTPS with a file-delivered token when configured, otherwise UNSUPPORTED (nothing is written). */
export function cmmsAdapterFrom(cfg: WorkerConfig): CmmsAdapter {
  if (!cfg.UB_CMMS_BASE_URL || !cfg.UB_CMMS_TOKEN_FILE) return HttpsCmmsAdapter.fromEnv({});
  let token: string;
  try {
    token = readSecretFile(cfg.UB_CMMS_TOKEN_FILE, { maxBytes: 4_096 }).toString('utf8').trim();
  } catch (e) {
    throw new WorkerConfigError(
      `unusable secret reference UB_CMMS_TOKEN_FILE: ${(e as { reasonCode?: string }).reasonCode ?? 'UNREADABLE'}`,
    );
  }
  return HttpsCmmsAdapter.fromEnv({ UB_CMMS_BASE_URL: cfg.UB_CMMS_BASE_URL, UB_CMMS_TOKEN: token });
}

export function operationsToken(cfg: WorkerConfig): string | null {
  if (!cfg.UB_WORKER_OPS_TOKEN_FILE) return null;
  let token: string;
  try {
    token = readSecretFile(cfg.UB_WORKER_OPS_TOKEN_FILE, { maxBytes: 4_096 }).toString('utf8').trim();
  } catch (e) {
    throw new WorkerConfigError(
      `unusable secret reference UB_WORKER_OPS_TOKEN_FILE: ${(e as { reasonCode?: string }).reasonCode ?? 'UNREADABLE'}`,
    );
  }
  if (token.length < 32) throw new WorkerConfigError('unusable secret reference UB_WORKER_OPS_TOKEN_FILE: TOO_SHORT');
  return token;
}

export function providerCredentials(cfg: WorkerConfig): FileSecretStore | undefined {
  if (!cfg.UB_PROVIDER_SECRET_ROOT) return undefined;
  try {
    return new FileSecretStore(cfg.UB_PROVIDER_SECRET_ROOT);
  } catch (e) {
    throw new WorkerConfigError(
      `unusable secret reference UB_PROVIDER_SECRET_ROOT: ${(e as { reasonCode?: string }).reasonCode ?? 'UNREADABLE'}`,
    );
  }
}
