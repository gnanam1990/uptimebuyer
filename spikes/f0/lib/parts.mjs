// F0-D part decision: exact manufacturer + MPN identity with a citation is the only path out of HELD.
// Similarity scores are recorded but never consulted for approval.
export function decidePart(cited, candidate) {
  if (!cited?.citation?.docDigest || !cited?.citation?.page) return { decision: 'HELD', reason: 'NO_CITED_FACT' };
  if (!candidate.manufacturer || !candidate.mpn) return { decision: 'HELD', reason: 'MISSING_IDENTIFIER' };
  if (candidate.manufacturer !== cited.manufacturer) return { decision: 'HELD', reason: 'MANUFACTURER_DIFFERS' };
  if (candidate.mpn !== cited.mpn) return { decision: 'HELD', reason: 'MPN_DIFFERS' };
  return {
    decision: cited.isFixture ? 'EXACT_MATCH_FIXTURE_ONLY' : 'EXACT_MATCH',
    reason: 'MANUFACTURER_AND_MPN_EQUAL',
  };
}

// Response deadline comes only from a versioned SOP; a spoilage estimate is non-authoritative and ignored.
export function responseDeadline(sop, _spoilageEstimate) {
  if (!sop || !sop.sopId || !sop.version || !Number.isInteger(sop.containmentDeadlineMinutes)) {
    return { decision: 'HELD', reason: 'NO_VERSIONED_SOP' };
  }
  return {
    decision: 'DEADLINE_FROM_SOP',
    sopRef: `${sop.sopId}@${sop.version}`,
    minutes: sop.containmentDeadlineMinutes,
  };
}
