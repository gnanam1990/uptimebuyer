// T-036 shared tie-break scenario: candidates whose expected costs tie exactly, so ordering falls through the
// documented rule (expected cost asc, recovery ETA asc, provider score desc, candidate ID asc by UTF-16 code unit).
// Imported by the in-process test and by the second Node process (t036-rank-child.ts).
import { evaluateRecoveryPlan, type RecoveryPlanEvaluation } from '../src/index.js';
import { candidate, planInput, shuffled } from './planning-fixtures.js';

export function tieCandidates() {
  return [
    // Same cost (46800), same ETA (25 min), same provider score: only the candidate ID decides.
    candidate('cand_tie-b', 18_500n, 25),
    candidate('cand_tie-a', 18_500n, 25),
    candidate('cand_Tie-c', 18_500n, 25), // 'T' (0x54) sorts before 'a' (0x61) by code unit, unlike a locale sort
    // Same cost as above via a different split (price +1500, ETA -15 min), so the shorter ETA wins.
    candidate('cand_tie-fast', 20_000n, 10),
    // Same cost and ETA as cand_tie-a but a lower provider score, so it sorts after the score-1e6 group.
    candidate('cand_tie-low-score', 18_500n, 25, { providerScore: 500_000 }),
    // Strictly cheaper and strictly dearer anchors.
    candidate('cand_cheapest', 10_000n, 25),
    candidate('cand_dearest', 90_000n, 25),
  ];
}

export const EXPECTED_ORDER = [
  'cand_cheapest',
  'cand_tie-fast',
  'cand_Tie-c',
  'cand_tie-a',
  'cand_tie-b',
  'cand_tie-low-score',
  'cand_dearest',
];

export function rankWithSeed(seed: number): Pick<RecoveryPlanEvaluation, 'ranking' | 'planHash'> {
  const r = evaluateRecoveryPlan(planInput(shuffled(tieCandidates(), seed)));
  return { ranking: r.ranking, planHash: r.planHash };
}
