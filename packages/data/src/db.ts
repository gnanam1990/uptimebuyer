// Thin `pg` helpers: transactions, typed error inspection, time and digest utilities shared by repositories.
import { createHash } from 'node:crypto';
import { DomainError, type UtcInstant } from '@uptimebuyer/contracts';
import type pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function withTransaction<T>(pool: Db, fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const pgCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;

export const FK_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const APPEND_ONLY_VIOLATION = 'UB001';

/** Database `clock_timestamp()` truncated to milliseconds, so every stored interval bound round-trips exactly. */
export async function dbNow(q: Queryable): Promise<UtcInstant> {
  const { rows } = await q.query<{ now: string }>(
    `SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
  );
  return rows[0]!.now as UtcInstant;
}

export const iso = (d: Date | null): UtcInstant | null => (d === null ? null : (d.toISOString() as UtcInstant));
export const isoNN = (d: Date): UtcInstant => d.toISOString() as UtcInstant;

/** Strictly later of `now` and `after + 1 ms`, so consecutive effective-dated intervals are never empty. */
export function laterThan(now: UtcInstant, after: Date | string): UtcInstant {
  const floor = new Date(after).getTime() + 1;
  return (Date.parse(now) >= floor ? now : new Date(floor).toISOString()) as UtcInstant;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const sha256Digest = (text: string): `sha256:${string}` => `sha256:${sha256Hex(text)}`;

/** Serialize work per key inside the current transaction (released at commit/rollback). */
export async function lockKey(client: Tx, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

export const versionConflict = (reasonCode = 'VERSION_CONFLICT') =>
  new DomainError('VERSION_CONFLICT', 'The resource changed; reload and retry.', { reasonCode });

export const toBigInt = (v: string | number | bigint): bigint => BigInt(v);
