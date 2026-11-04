// T-006 re-run over the M09 database guards. The SQL edge functions that guard execution authorities, Kite sessions,
// external attempts and economic intents must allow exactly the edges of the @uptimebuyer/domain transition tables —
// every pair is compared, so a guard can neither be looser nor stricter than the canonical machine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTEMPT_TRANSPORT_STATES,
  ECONOMIC_INTENT_STATES,
  EXECUTION_AUTHORITY_STATES,
  EXTERNAL_OUTCOME_STATES,
} from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import { createTestDatabase, dbScripts, type TestDatabase } from '../../../packages/data/test/helpers.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase('t006k');
  await (await dbScripts()).migrate(db.url);
});
afterAll(async () => db?.drop());

const CASES = [
  ['ub_execution_authority_edge_ok', 'EXECUTION_AUTHORITY', EXECUTION_AUTHORITY_STATES],
  ['ub_external_outcome_edge_ok', 'EXTERNAL_ACTION', EXTERNAL_OUTCOME_STATES],
  ['ub_external_outcome_edge_ok', 'KITE_SESSION', EXTERNAL_OUTCOME_STATES],
  ['ub_attempt_transport_edge_ok', 'ATTEMPT_TRANSPORT', ATTEMPT_TRANSPORT_STATES],
  ['ub_economic_intent_edge_ok', 'ECONOMIC_INTENT', ECONOMIC_INTENT_STATES],
] as const;

describe('T-006 illegal transition rejection (M09 SQL guards match the domain machines)', () => {
  for (const [fn, machine, states] of CASES)
    it(`${fn} equals ${machine} for every state pair`, async () => {
      const mismatches: string[] = [];
      for (const from of states)
        for (const to of states) {
          const { rows } = await db.pool.query(`SELECT ${fn}($1, $2) AS ok`, [from, to]);
          if (rows[0].ok !== isTransitionAllowed(machine, from, to)) mismatches.push(`${from}->${to}`);
        }
      expect(mismatches).toEqual([]);
    });
});
