// T-006 re-run over the M11 database guards. The recovery-evaluation SQL edge function must allow exactly the edges of
// the @uptimebuyer/domain RECOVERY_EVALUATION machine (every pair compared), and the CMMS write rows reuse M09's
// external-outcome function, which must still equal the EXTERNAL_ACTION machine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTERNAL_OUTCOME_STATES, RECOVERY_EVALUATION_STATES } from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import { createTestDatabase, dbScripts, type TestDatabase } from '../../data/test/helpers.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase('t006r');
  await (await dbScripts()).migrate(db.url);
});
afterAll(async () => db?.drop());

const CASES = [
  ['ub_recovery_evaluation_edge_ok', 'RECOVERY_EVALUATION', RECOVERY_EVALUATION_STATES],
  ['ub_external_outcome_edge_ok', 'EXTERNAL_ACTION', EXTERNAL_OUTCOME_STATES],
] as const;

describe('T-006 illegal transition rejection (M11 SQL guards match the domain machines)', () => {
  for (const [fn, machine, states] of CASES)
    it(`${fn} equals ${machine} for every pair`, async () => {
      const mismatches: string[] = [];
      for (const from of [...states, 'RECOVERED'])
        for (const to of [...states, 'RECOVERED']) {
          const { rows } = await db.pool.query(`SELECT ${fn}($1, $2) AS ok`, [from, to]);
          if (rows[0].ok !== isTransitionAllowed(machine, from, to)) mismatches.push(`${from}->${to}`);
        }
      expect(mismatches).toEqual([]);
    });

  it('the CMMS update and recovery-evaluation guards are the ones wired to the M11 tables', async () => {
    const { rows } = await db.pool.query(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
        WHERE p.proname IN ('ub_recovery_evaluation_guard', 'ub_cmms_update_guard')`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.proname, r.def as string]));
    expect(defs.ub_recovery_evaluation_guard).toContain('ub_recovery_evaluation_edge_ok');
    expect(defs.ub_cmms_update_guard).toContain('ub_external_outcome_edge_ok');
  });
});
