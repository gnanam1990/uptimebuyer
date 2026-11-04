// Broker reconciliation state for the spike. SEND_STARTED is durable before egress; a missing outcome after it is UNKNOWN.
export const STATES = Object.freeze({
  SEND_STARTED: 'SEND_STARTED',
  CONFIRMED: 'CONFIRMED',
  FAILED_NO_EFFECT: 'FAILED_NO_EFFECT',
  UNKNOWN: 'UNKNOWN',
});

export function deriveStates(events) {
  const byKey = new Map();
  for (const e of events) {
    if (e.event === 'SEND_STARTED') {
      byKey.set(e.idempotencyKey, {
        intentId: e.intentId,
        idempotencyKey: e.idempotencyKey,
        requestDigest: e.requestDigest,
        state: STATES.SEND_STARTED,
        effectId: null,
        reason: null,
      });
      continue;
    }
    const cur = byKey.get(e.idempotencyKey);
    if (!cur) continue;
    if (e.event === 'OUTCOME' || e.event === 'RECONCILED' || e.event === 'RECOVERED') {
      cur.state = e.state;
      cur.effectId = e.effectId ?? cur.effectId;
      cur.reason = e.reason ?? null;
    }
  }
  return byKey;
}

// Entries whose outcome was never observed (broker died after SEND_STARTED) become UNKNOWN at boot.
export function recoverOnBoot(states) {
  return [...states.values()].filter((s) => s.state === STATES.SEND_STARTED);
}

export function decideOnSubmit(entry, requestDigest) {
  if (!entry) return 'EGRESS';
  if (entry.requestDigest !== requestDigest) return 'IDEMPOTENCY_CONFLICT';
  if (entry.state === STATES.CONFIRMED) return 'RETURN_STORED';
  if (entry.state === STATES.FAILED_NO_EFFECT) return 'RETURN_STORED';
  return 'RETURN_UNKNOWN_NO_RETRY';
}

// Classify an execute attempt. Only an explicit provider answer is definite; transport loss is UNKNOWN.
export function classifyExecute(result) {
  if (result.kind === 'response' && result.status === 200 && result.body?.effect?.effectId) {
    return { state: STATES.CONFIRMED, effectId: result.body.effect.effectId };
  }
  if (result.kind === 'response' && result.status >= 400 && result.status < 500 && result.status !== 408) {
    return { state: STATES.FAILED_NO_EFFECT, reason: `PROVIDER_REJECTED_${result.status}` };
  }
  return { state: STATES.UNKNOWN, reason: result.kind === 'response' ? `HTTP_${result.status}` : 'TRANSPORT_LOST' };
}

// Apply an authoritative lookup. Not-found and errors are never converted into failure.
export function applyLookup(entry, result) {
  if (result.kind === 'response' && result.status === 200) {
    if (result.body?.requestDigest !== entry.requestDigest)
      return { state: STATES.UNKNOWN, reason: 'DIGEST_MISMATCH_MANUAL_REVIEW' };
    return { state: STATES.CONFIRMED, effectId: result.body.effect.effectId };
  }
  if (result.kind === 'response' && result.status === 404)
    return { state: STATES.UNKNOWN, reason: 'NOT_FOUND_IS_NOT_PROOF' };
  return { state: STATES.UNKNOWN, reason: 'LOOKUP_INCONCLUSIVE' };
}
