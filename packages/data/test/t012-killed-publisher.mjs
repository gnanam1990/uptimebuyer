// T-012 helper process: opens a transaction, row-locks unpublished outbox events like a publisher mid-claim, reports
// the locked ids on stdout and then hangs until the parent SIGKILLs it. Plain JS so it runs without a TS loader.
import pg from 'pg';

const [url, limit] = process.argv.slice(2);
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('BEGIN');
const { rows } = await client.query(
  `SELECT id FROM outbox_events
    WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < now())
    ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
  [Number(limit)],
);
process.stdout.write(`${JSON.stringify({ pid: process.pid, locked: rows.map((r) => r.id) })}\n`);
setInterval(() => {}, 1_000);
