// T-040 — Unknown payment reconciliation before retry (real process kills). The kite-broker runs as a separate
// process against the LOCAL_STAND_IN HTTPS endpoint and is SIGKILLed at each named point: inside the linearization
// transaction before commit, right after the durable SEND_STARTED marker (before any network handoff), after the
// stand-in committed the effect but before the result is persisted, and during reconciliation lookup. A restarted
// broker converges by the ORIGINAL client operation/idempotency key: no duplicate charge, no fabricated REQUESTED, no
// failure without proof. LOCAL_STAND_IN is not Kite; no real payment is made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KiteBrokerPort, authorityReference, intentRequestFor, issueReference } from '@uptimebuyer/commerce';
import {
  attemptOf,
  attemptOutcomeHistory,
  conservation,
  createBrokerWorld,
  issue,
  paidPlanAction,
  rowOf,
  sleep,
  transitionsOf,
  type BrokerWorld,
} from './helpers.js';
import {
  launchBroker,
  launchStandIn,
  mintSecrets,
  type BrokerProc,
  type Secrets,
  type StandIn,
} from './support/procs.js';

let w: BrokerWorld;
let secrets: Secrets;
let standIn: StandIn;
let live: BrokerProc | null = null;

beforeAll(async () => {
  w = await createBrokerWorld('t040p');
  secrets = mintSecrets();
  standIn = await launchStandIn(secrets);
});
afterAll(async () => {
  await live?.stop();
  await standIn?.stop();
  await w?.close();
});

async function start(testFaults: string[] = [], reconcileBaseMs = 200) {
  await live?.stop();
  live = await launchBroker(w, secrets, { standIn, testFaults, sendLeaseMs: 3_000, reconcileBaseMs });
  return live;
}
const portOf = (b: BrokerProc) =>
  new KiteBrokerPort(w.db.pool, {
    socketPath: b.socketPath,
    referenceSigner: w.referenceSigner,
    contextFor: () => w.operator,
  });
const ref = (intentId: string) =>
  issueReference(w.referenceSigner, w.tenant.tenantId, {
    kind: 'COMMERCIAL_INTENT',
    commercialIntentId: intentId,
  } as never);

/** A CREATED intent whose authority's Kite session the (non-faulting) broker already confirmed. */
async function prepared(b: BrokerProc) {
  const p = await paidPlanAction(w);
  const auth = await issue(w, p);
  await portOf(b).activateSession(
    authorityReference(w.referenceSigner, w.tenant.tenantId, auth.authority.executionAuthorityId),
  );
  const created = await portOf(b).createIntent(intentRequestFor(auth, w.operator, w.key('intent')));
  return created.intent.commercialIntentId as string;
}

async function until(intentId: string, states: string[], ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = (await rowOf(w, 'commercial_intents', intentId)).state;
    if (states.includes(s)) return s;
    if (Date.now() > end) throw new Error(`intent stuck in ${s}`);
    await sleep(100);
  }
}

describe('T-040 crash points with a separately running broker process', () => {
  it('SIGKILL inside the linearization transaction: nothing committed, nothing sent; the restart executes once', async () => {
    const intentId = await prepared(await start());
    const before = await standIn.command({ cmd: 'stats' });
    const faulty = await start(['IN_LINEARIZATION_BEFORE_COMMIT']);
    await expect(portOf(faulty).execute(ref(intentId))).rejects.toMatchObject({ code: 'DEPENDENCY_OUTCOME_UNKNOWN' });
    await faulty.exited;
    expect((await rowOf(w, 'commercial_intents', intentId)).state).toBe('CREATED');
    expect(await attemptOf(w, intentId)).toBeUndefined();
    const b = await start();
    expect((await portOf(b).execute(ref(intentId))).intent.state).toBe('CONFIRMED');
    const after = await standIn.command({ cmd: 'stats' });
    expect([after.executeCalls - before.executeCalls, after.effectsCreated - before.effectsCreated]).toEqual([1, 1]);
  });

  it('SIGKILL after SEND_STARTED before handoff: UNKNOWN (never REQUESTED), reserve held, lookup by the original key proves no effect', async () => {
    const intentId = await prepared(await start());
    const before = await standIn.command({ cmd: 'stats' });
    const faulty = await start(['AFTER_SEND_STARTED']);
    await expect(portOf(faulty).execute(ref(intentId))).rejects.toMatchObject({ code: 'DEPENDENCY_OUTCOME_UNKNOWN' });
    await faulty.exited;
    const marker = await attemptOf(w, intentId);
    expect([marker.transport_state, marker.external_outcome_state]).toEqual(['SEND_STARTED', 'AUTHORIZED']);
    expect(BigInt((await rowOf(w, 'commercial_intents', intentId)).open_reserved_minor)).toBe(18_500n);
    expect((await standIn.command({ cmd: 'stats' })).executeCalls).toBe(before.executeCalls);
    await start(); // boot + periodic sweep
    expect(await until(intentId, ['FAILED'])).toBe('FAILED');
    expect(await transitionsOf(w, intentId)).toEqual([
      '->CREATED',
      'CREATED>RESERVED',
      'RESERVED>UNKNOWN',
      'UNKNOWN>FAILED',
    ]);
    const history = await attemptOutcomeHistory(w, intentId);
    expect(history).toContain('external_attempt.unknown.v1:UNKNOWN');
    expect(history.some((h) => h.endsWith(':REQUESTED'))).toBe(false);
    const a = await attemptOf(w, intentId);
    expect(a.client_operation_id).toBe(marker.client_operation_id);
    expect(BigInt((await rowOf(w, 'commercial_intents', intentId)).open_reserved_minor)).toBe(0n);
    const after = await standIn.command({ cmd: 'stats' });
    expect([after.executeCalls, after.effectsCreated]).toEqual([before.executeCalls, before.effectsCreated]);
  });

  it('SIGKILL after the provider effect before persistence: the restart reconciles CONFIRMED with exactly one charge', async () => {
    const intentId = await prepared(await start());
    const before = await standIn.command({ cmd: 'stats' });
    const faulty = await start(['AFTER_EFFECT_BEFORE_PERSIST']);
    await expect(portOf(faulty).execute(ref(intentId))).rejects.toMatchObject({ code: 'DEPENDENCY_OUTCOME_UNKNOWN' });
    await faulty.exited;
    const a = await attemptOf(w, intentId);
    expect([a.transport_state, a.provider_ref]).toEqual(['SEND_STARTED', null]);
    await start();
    expect(await until(intentId, ['CONFIRMED'])).toBe('CONFIRMED');
    const done = await attemptOf(w, intentId);
    expect(done.provider_ref).toMatch(/^sfx_/);
    expect(done.idempotency_key).toBe(a.idempotency_key);
    const after = await standIn.command({ cmd: 'stats' });
    expect([after.executeCalls - before.executeCalls, after.effectsCreated - before.effectsCreated]).toEqual([1, 1]);
  });

  it('SIGKILL during lookup: still UNKNOWN; the next broker converges without re-sending', async () => {
    // A slow reconciliation schedule so this broker cannot resolve the UNKNOWN before it is replaced.
    const b0 = await start([], 4_000);
    const intentId = await prepared(b0);
    const before = await standIn.command({ cmd: 'stats' });
    await standIn.command({ cmd: 'mode', mode: 'DROP_RESPONSE' });
    const lost = await portOf(b0).execute(ref(intentId));
    await standIn.command({ cmd: 'mode', mode: 'SETTLE' });
    expect(lost.intent.state).toBe('UNKNOWN');
    const faulty = await start(['DURING_LOOKUP']);
    await faulty.exited; // its own sweep looked the payment up and was killed before persisting the result
    expect((await rowOf(w, 'commercial_intents', intentId)).state).toBe('UNKNOWN');
    await start();
    expect(await until(intentId, ['CONFIRMED'])).toBe('CONFIRMED');
    const after = await standIn.command({ cmd: 'stats' });
    expect([after.executeCalls - before.executeCalls, after.effectsCreated - before.effectsCreated]).toEqual([1, 1]);
    expect((await conservation(w)).problems).toEqual([]);
  });
});
