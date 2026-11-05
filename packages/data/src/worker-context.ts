// Platform worker fan-out (M14; INV-06, T-057). This module is exposed only as the `@uptimebuyer/data/worker` subpath,
// which ESLint lets only the worker application source import; a structural test proves no other source file
// reaches it. It issues one worker context per ACTIVE tenant, derived from the tenant row (never from input), for the
// tenant-scoped sweeps the worker schedules (deadline expiry, recovery monitoring, CMMS writes, contact sweeps,
// fulfillment polling, policy activation). Like an outbox/job worker context it grants only worker-permitted actions.
import { DomainError, type TenantId } from '@uptimebuyer/contracts';
import { issueWorkerContext, type TenantContext } from './context.js';
import type { Db } from './db.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface TenantFanOutResult {
  tenants: number;
  failed: { tenantId: string; code: string }[];
}

/**
 * Run `fn` once per ACTIVE tenant, sequentially, each under its own worker context. A failing tenant is recorded (by
 * error code only) and does not stop the others. `signal` stops the fan-out between tenants.
 */
export async function forEachActiveTenant(
  pool: Db,
  worker: { workerId: string; runner: string; signal?: AbortSignal },
  fn: (ctx: TenantContext) => Promise<unknown>,
): Promise<TenantFanOutResult> {
  if (!NAME.test(worker.workerId) || !NAME.test(worker.runner))
    throw new DomainError('VALIDATION_FAILED', 'Invalid worker identity.', { reasonCode: 'WORKER_ID_INVALID' });
  const { rows } = await pool.query<{ id: TenantId }>(`SELECT id FROM tenants WHERE status = 'ACTIVE' ORDER BY id`);
  const failed: TenantFanOutResult['failed'] = [];
  let tenants = 0;
  for (const t of rows) {
    if (worker.signal?.aborted) break;
    tenants++;
    const ctx = issueWorkerContext(t.id, {
      kind: 'WORKER',
      id: worker.workerId,
      source: 'JOB',
      sourceId: `${worker.runner}:${t.id.slice(4, 40)}`,
    });
    try {
      await fn(ctx);
    } catch (e) {
      failed.push({ tenantId: t.id, code: e instanceof DomainError ? e.code : 'INTERNAL' });
    }
  }
  return { tenants, failed };
}
