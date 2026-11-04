// F0-D observation classifier. Temperatures are integer milli-degrees Celsius; times are UTC epoch ms.
// Condition status is computed independently of the source label; a healthy claim additionally needs a
// LIVE_AUTHENTICATED source, which SIMULATED_INPUT can never satisfy.
export const SOURCES = Object.freeze({ SIMULATED_INPUT: 'SIMULATED_INPUT', LIVE_AUTHENTICATED: 'LIVE_AUTHENTICATED' });

export function classifyObservation(obs, prevSeq, nowMs, policy) {
  if (!Number.isInteger(obs.valueMilliC)) return 'INVALID';
  if (prevSeq !== null && obs.seq <= prevSeq) return 'OUT_OF_ORDER_OR_REPLAY';
  if (obs.sourceTimeMs > nowMs + policy.maxClockSkewMs) return 'FUTURE_TIMESTAMP';
  if (nowMs - obs.sourceTimeMs > policy.maxAgeMs) return 'STALE';
  if (obs.valueMilliC < policy.minMilliC || obs.valueMilliC > policy.maxMilliC) return 'BREACH';
  return 'FRESH_IN_RANGE';
}

export function assess(observations, nowMs, policy) {
  let prevSeq = null;
  const rows = [];
  for (const obs of observations) {
    const status = classifyObservation(obs, prevSeq, nowMs, policy);
    if (status !== 'OUT_OF_ORDER_OR_REPLAY') prevSeq = obs.seq;
    rows.push({ seq: obs.seq, source: obs.source, status });
  }
  const latest = rows.at(-1);
  const conditionStatus = latest ? latest.status : 'NO_DATA';
  const healthyClaimAllowed = conditionStatus === 'FRESH_IN_RANGE' && latest.source === SOURCES.LIVE_AUTHENTICATED;
  return { rows, conditionStatus, healthyClaimAllowed };
}
