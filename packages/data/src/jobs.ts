// Durable job table (NFR-02, NFR-03, ADR 0001 §3). Jobs are enqueued inside the domain transaction, claimed with a
// lease via `FOR UPDATE SKIP LOCKED`, and completed only by the current lease holder. A dead worker's lease expires
// and the job is reclaimed; a stale worker can never complete or fail it; exhausted jobs dead-letter. Each claimed
// job carries a worker TenantContext derived from its durable row, never from the payload.
import { CorrelationIdSchema, DomainError, newId, type CorrelationId, type TenantId } from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import { versionConflict, type Db, type Tx } from './db.js';
import { assertTenantContext, issueWorkerContext, type TenantContext } from './context.js';
import { newDataId, type JobId } from './ids.js';

const invalid = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Job failed contract validation.', { reasonCode });

export interface EnqueueJobInput {
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  runAfter?: string;
  maxAttempts?: number;
}

export async function enqueueJob(
  client: Tx,
  ctx: TenantContext,
  input: EnqueueJobInput,
): Promise<{ jobId: JobId; duplicate: boolean }> {
  assertTenantContext(ctx);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(input.kind)) throw invalid('JOB_KIND_INVALID');
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw invalid('MAX_ATTEMPTS_INVALID');
  let payload: string;
  try {
    payload = canonicalize(input.payload);
  } catch {
    throw invalid('PAYLOAD_NOT_CANONICAL');
  }
  const jobId = newDataId('job') as JobId;
  const { rows } = await client.query<{ id: JobId }>(
    `INSERT INTO jobs (tenant_id, id, kind, payload, dedupe_key, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, clock_timestamp()), $7)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, jobId, input.kind, payload, input.dedupeKey ?? null, input.runAfter ?? null, maxAttempts],
  );
  if (rows[0]) return { jobId: rows[0].id, duplicate: false };
  const existing = await client.query<{ id: JobId }>(`SELECT id FROM jobs WHERE tenant_id = $1 AND dedupe_key = $2`, [
    ctx.tenantId,
    input.dedupeKey,
  ]);
  return { jobId: existing.rows[0]!.id, duplicate: true };
}

export interface JobRecord {
  jobId: JobId;
  tenantId: TenantId;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface ClaimedJob {
  readonly job: JobRecord;
  readonly ctx: TenantContext;
  readonly workerId: string;
}

const claimed = new WeakSet<object>();

export async function claimJobs(
  pool: Db,
  opts: { workerId: string; kinds?: readonly string[]; limit?: number; leaseMs?: number },
): Promise<ClaimedJob[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(opts.workerId)) throw invalid('WORKER_ID_INVALID');
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 500));
  const leaseMs = Math.max(50, Math.min(opts.leaseMs ?? 30_000, 3_600_000));
  const kinds = opts.kinds ? [...opts.kinds] : null;
  // A job whose last lease expired after its final attempt is dead-lettered rather than retried forever.
  await pool.query(
    `UPDATE jobs SET state = 'DEAD', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = coalesce(last_error_code, 'LEASE_EXPIRED'), updated_at = clock_timestamp()
      WHERE state = 'RUNNING' AND lease_expires_at < clock_timestamp() AND attempts >= max_attempts
        AND ($1::text[] IS NULL OR kind = ANY($1))`,
    [kinds],
  );
  const { rows } = await pool.query(
    `UPDATE jobs j
        SET state = 'RUNNING', lease_owner = $1,
            lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000),
            attempts = j.attempts + 1, updated_at = clock_timestamp()
      WHERE j.id IN (
        SELECT id FROM jobs
         WHERE ((state = 'PENDING' AND run_after <= clock_timestamp())
             OR (state = 'RUNNING' AND lease_expires_at < clock_timestamp()))
           AND attempts < max_attempts
           AND ($3::text[] IS NULL OR kind = ANY($3))
         ORDER BY run_after, created_at
         LIMIT $4
         FOR UPDATE SKIP LOCKED)
      RETURNING j.*`,
    [opts.workerId, leaseMs, kinds, limit],
  );
  return rows.map((r) => {
    const job: JobRecord = Object.freeze({
      jobId: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    });
    const correlation = CorrelationIdSchema.safeParse(r.payload?.correlationId);
    const ctx = issueWorkerContext(
      r.tenant_id,
      { kind: 'WORKER', id: opts.workerId, source: 'JOB', sourceId: r.id },
      correlation.success ? (correlation.data as CorrelationId) : newId('correlation'),
    );
    const c = Object.freeze({ job, ctx, workerId: opts.workerId });
    claimed.add(c);
    return c;
  });
}

function assertClaimed(c: ClaimedJob): void {
  if (!claimed.has(c)) throw new DomainError('UNAUTHENTICATED', 'A server-issued job claim is required.');
}

const LEASE_GUARD = `tenant_id = $1 AND id = $2 AND state = 'RUNNING' AND lease_owner = $3 AND attempts = $4`;

/** Complete a job; only the current lease holder (same worker, same attempt) can. */
export async function completeJob(pool: Db, c: ClaimedJob): Promise<void> {
  assertClaimed(c);
  const r = await pool.query(
    `UPDATE jobs SET state = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE ${LEASE_GUARD}`,
    [c.job.tenantId, c.job.jobId, c.workerId, c.job.attempts],
  );
  if (r.rowCount !== 1) throw versionConflict('JOB_LEASE_LOST');
}

/** Record a failure: retry after `retryInMs`, or dead-letter once attempts are exhausted. */
export async function failJob(
  pool: Db,
  c: ClaimedJob,
  opts: { reasonCode: string; retryInMs?: number },
): Promise<'PENDING' | 'DEAD'> {
  assertClaimed(c);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(opts.reasonCode)) throw invalid('REASON_CODE_INVALID');
  const retry = Math.max(0, Math.min(opts.retryInMs ?? 1000, 86_400_000));
  const { rows } = await pool.query<{ state: 'PENDING' | 'DEAD' }>(
    `UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
            run_after = clock_timestamp() + make_interval(secs => $5::double precision / 1000),
            lease_owner = NULL, lease_expires_at = NULL, last_error_code = $6, updated_at = clock_timestamp()
      WHERE ${LEASE_GUARD} RETURNING state`,
    [c.job.tenantId, c.job.jobId, c.workerId, c.job.attempts, retry, opts.reasonCode],
  );
  if (!rows[0]) throw versionConflict('JOB_LEASE_LOST');
  return rows[0].state;
}
