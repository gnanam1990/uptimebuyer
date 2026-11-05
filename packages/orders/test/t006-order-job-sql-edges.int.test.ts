// T-006 re-run over the M10 database guards. The purchase-order and service-job SQL edge functions must allow exactly
// the edges of the @uptimebuyer/domain PURCHASE_ORDER and SERVICE_JOB machines: every pair is compared, and neither
// function accepts any edge of the other machine's vocabulary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURCHASE_ORDER_STATES, SERVICE_JOB_STATES } from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import { createTestDatabase, dbScripts, type TestDatabase } from '../../data/test/helpers.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase('t006o');
  await (await dbScripts()).migrate(db.url);
});
afterAll(async () => db?.drop());

const ALL = [...new Set<string>([...PURCHASE_ORDER_STATES, ...SERVICE_JOB_STATES])];
const CASES = [
  ['ub_purchase_order_edge_ok', 'PURCHASE_ORDER'],
  ['ub_service_job_edge_ok', 'SERVICE_JOB'],
] as const;

describe('T-006 illegal transition rejection (M10 SQL guards match the domain machines)', () => {
  for (const [fn, machine] of CASES)
    it(`${fn} equals ${machine} for every pair over both vocabularies`, async () => {
      const mismatches: string[] = [];
      for (const from of ALL)
        for (const to of ALL) {
          const { rows } = await db.pool.query(`SELECT ${fn}($1, $2) AS ok`, [from, to]);
          if (rows[0].ok !== isTransitionAllowed(machine, from, to)) mismatches.push(`${from}->${to}`);
        }
      expect(mismatches).toEqual([]);
    });
});
