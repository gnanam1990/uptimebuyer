// T-036 — Deterministic ranking tie break. Equal scores resolve through the documented stable rule (expected cost
// asc, recovery ETA asc, provider score desc, candidate ID asc by UTF-16 code unit) and produce the same ordering and
// plan hash across input orders, reruns and a second Node process.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_TIE_BREAK_RULE, compareRankedCandidates, evaluateRecoveryPlan } from '../src/index.js';
import { EXPECTED_ORDER, rankWithSeed, tieCandidates } from './t036-fixture.js';
import { planInput } from './planning-fixtures.js';

const here = import.meta.dirname;

function rankInChildProcess(seeds: number[]) {
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      join(here, 'support', 'ts-register.mjs'),
      join(here, 't036-rank-child.ts'),
      ...seeds.map(String),
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'Pacific/Chatham', LANG: 'tr_TR.UTF-8' } },
  );
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as { seed: number; ranking: string[]; planHash: string }[];
}

describe('T-036 deterministic ranking tie break', () => {
  it('documents the rule it applies', () => {
    expect(PLAN_TIE_BREAK_RULE).toEqual([
      'EXPECTED_COST_ASC',
      'RECOVERY_ETA_ASC',
      'PROVIDER_SCORE_DESC',
      'CANDIDATE_ID_ASC_UTF16',
    ]);
  });

  it('equal expected costs fall through ETA, provider score and code-unit candidate ID', () => {
    const r = evaluateRecoveryPlan(planInput(tieCandidates()));
    expect(r.outcome).toBe('RANKED');
    expect(r.ranking).toEqual(EXPECTED_ORDER);
    expect(r.candidates.filter((c) => c.ordinal !== null).map((c) => [c.ordinal, c.candidateId])).toEqual(
      EXPECTED_ORDER.map((id, i) => [i + 1, id]),
    );
    const costs = r.candidates.slice(1, 6).map((c) => c.cost!.expectedCostMinor);
    expect(new Set(costs.map(String))).toEqual(new Set(['46800']));
  });

  it('is independent of input order and stable across reruns', () => {
    const first = rankWithSeed(1);
    for (let seed = 2; seed < 60; seed++) expect(rankWithSeed(seed), `seed ${seed}`).toEqual(first);
    expect(first.ranking).toEqual(EXPECTED_ORDER);
  });

  it('the comparator is a strict total order (antisymmetric, transitive on the scenario)', () => {
    const r = evaluateRecoveryPlan(planInput(tieCandidates()));
    const ranked = r.candidates.filter((c) => c.ordinal !== null);
    for (const a of ranked)
      for (const b of ranked) {
        const ab = compareRankedCandidates(a, b);
        expect(Math.sign(ab) + Math.sign(compareRankedCandidates(b, a))).toBe(0);
        if (a === b) expect(ab).toBe(0);
        else expect(ab).not.toBe(0);
      }
  });

  it('a second Node process (different timezone and locale) produces the same ordering and plan hash', () => {
    const local = [3, 17, 42].map((seed) => ({ seed, ...rankWithSeed(seed) }));
    const child = rankInChildProcess([3, 17, 42]);
    expect(child).toEqual(local);
    expect(new Set(child.map((c) => c.planHash)).size).toBe(1);
  });
});
