// LOCAL_STAND_IN provider ledger: same-key idempotent execute plus lookup by idempotency key.
// It stands in for a paid endpoint's authoritative state. It is not Kite and proves nothing about Kite.
import { randomBytes } from 'node:crypto';

export function createLedger() {
  const byKey = new Map();
  return {
    execute(idempotencyKey, requestDigest, body) {
      const prior = byKey.get(idempotencyKey);
      if (prior) {
        prior.executeCalls += 1;
        if (prior.requestDigest !== requestDigest) return { status: 422, code: 'IDEMPOTENCY_KEY_REUSED' };
        return { status: 200, replayed: true, effect: prior.effect };
      }
      const effect = {
        effectId: `sfx_${randomBytes(8).toString('hex')}`,
        amountMinor: body.amountMinor,
        currency: body.currency,
        label: 'LOCAL_STAND_IN',
      };
      byKey.set(idempotencyKey, { requestDigest, effect, executeCalls: 1, effectsCreated: 1 });
      return { status: 200, replayed: false, effect };
    },
    lookup(idempotencyKey) {
      const prior = byKey.get(idempotencyKey);
      if (!prior) return { status: 404, code: 'NOT_FOUND' };
      return { status: 200, effect: prior.effect, requestDigest: prior.requestDigest };
    },
    snapshot() {
      return Object.fromEntries(
        [...byKey].map(([k, v]) => [
          k,
          { effectId: v.effect.effectId, executeCalls: v.executeCalls, effectsCreated: v.effectsCreated },
        ]),
      );
    },
  };
}
