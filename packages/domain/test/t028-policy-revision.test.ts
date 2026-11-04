// T-028 — Policy revision forces reevaluation (FR-21, INV-03, INV-10), pure layer. A different governing policy
// revision is a different tuple (new input digest) and can change the outcome, while the historical decision stays
// reproducible from its stored wire input and the policy body that governed it.
import { decodeWire, encodeWire } from '@uptimebuyer/contracts';
import { describe, expect, it } from 'vitest';
import {
  CompatibilityInputSchema,
  evaluateCompatibility,
  exactMatchInput,
  fixtureGoverningPolicy,
} from '../src/index.js';

describe('T-028 policy revision forces reevaluation (pure)', () => {
  it('a new policy revision is a new tuple and its rules decide the new outcome', () => {
    const p1 = fixtureGoverningPolicy();
    const before = evaluateCompatibility(exactMatchInput(), p1);
    const p2 = fixtureGoverningPolicy({
      policyRevisionId: 'pol_fixture-0002',
      bodyDigest: `policy.v1:sha256:${'2'.repeat(64)}`,
    });
    p2.compatibility!.requiredCertifications = [
      ...p2.compatibility!.requiredCertifications,
      { code: 'NSF 7', components: null },
    ];
    const input = exactMatchInput();
    input.binding.policyRevisionId = 'pol_fixture-0002' as never;
    const after = evaluateCompatibility(input, p2);
    expect(after.inputDigest).not.toBe(before.inputDigest);
    expect(before.decision).toBe('ALLOW');
    expect(after.decision).toBe('HOLD');
    expect(after.missingFields).toContain('certification:NSF 7');
  });

  it('the old input bound to the new policy is refused (binding mismatch), never silently re-labelled', () => {
    const p2 = fixtureGoverningPolicy({ policyRevisionId: 'pol_fixture-0002' });
    const r = evaluateCompatibility(exactMatchInput(), p2);
    expect(r.decision).toBe('HOLD');
    expect(r.blockingReasons).toContain('POLICY_REVISION_NOT_EFFECTIVE');
  });

  it('a stored wire input reproduces the historical decision byte-for-byte', () => {
    const p1 = fixtureGoverningPolicy();
    const original = evaluateCompatibility(exactMatchInput(), p1);
    const stored = JSON.parse(JSON.stringify(encodeWire(CompatibilityInputSchema, exactMatchInput())));
    const replayed = evaluateCompatibility(decodeWire(CompatibilityInputSchema, stored), p1);
    expect(replayed).toEqual(original);
  });
});
