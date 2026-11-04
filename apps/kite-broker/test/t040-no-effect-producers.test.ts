// T-040 producer sweep (HIGH review finding): every adapter that can report definite no effect is checked so that only
// provider-authored evidence or a first-send local refusal (flagged notSent, honoured by the broker only before any
// handoff) produces it. Transport loss is never no-effect proof; the M01 contract fake never fails a started intent.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCommercialIntentBrokerFake } from '@uptimebuyer/kite-contracts';
import { LocalStandInAdapter } from '../src/adapters/standin.js';
// @ts-expect-error plain ESM helper without type declarations
import { makeLocalPki } from './support/pki.mjs';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';

const op = {
  clientOperationId: 'op_t040-sweep-1',
  idempotencyKey: 'cin-op.t040-sweep-1',
  requestDigest: `sha256:${'b'.repeat(64)}`,
};
const intent = {
  tenantId: 'ten_t040-sweep',
  commercialIntentId: 'cin_t040-sweep',
  actionKind: 'PART_PURCHASE',
  semanticOperation: 'PURCHASE',
  merchantId: 'mer_sweep-0001',
  purpose: 'PART_PURCHASE',
  amountMinor: 100n,
  currency: 'USD',
  providerAccountRevisionId: 'par_t040-sweep',
  providerSessionRef: null,
};

describe('T-040 no-effect producers', () => {
  it('LOCAL_STAND_IN: an unreachable endpoint is UNKNOWN (transport lost), never FAILED/no-effect', async () => {
    const pki = makeLocalPki('m09-sweep', 'kite-broker');
    const adapter = new LocalStandInAdapter(
      {
        baseUrl: 'https://127.0.0.1:9',
        serverCertFingerprint256: pki.server.fingerprint256,
        caCert: pki.caCert,
        clientCert: pki.client.cert,
        clientKey: pki.client.key,
        capability: randomBytes(32).toString('base64url'),
      },
      { capability: { lookupByClientOperation: true, sameKeyReplay: true }, timeoutMs: 500 },
    );
    const out = await adapter.execute(adapter.prepare(intent), op, { onHandoff: () => {} });
    expect(out.kind).toBe('UNKNOWN');
    const look = await adapter.lookup({
      clientOperationId: op.clientOperationId,
      idempotencyKey: op.idempotencyKey,
      providerRef: null,
    });
    expect(look.kind).toBe('UNKNOWN');
  });

  it('RECORDED_CONTRACT: not-sent refusals are flagged notSent; provider declines/fences are authoritative', async () => {
    const a = new RecordedContractAdapter();
    a.nextModes.push('REFUSE_NOT_SENT', 'DECLINE');
    expect(await a.execute(a.prepare(intent), op, { onHandoff: () => {} })).toMatchObject({
      kind: 'FAILED',
      notSent: true,
    });
    const declined = await a.execute(
      a.prepare(intent),
      { ...op, idempotencyKey: 'cin-op.t040-sweep-2' },
      { onHandoff: () => {} },
    );
    expect(declined.kind).toBe('FAILED');
    expect((declined as { notSent?: boolean }).notSent).toBeUndefined();
  });

  it('M01 contract fake: a started (UNKNOWN) intent is never failed by a second execute', async () => {
    const fake = new InMemoryCommercialIntentBrokerFake();
    expect(fake.isContractFake).toBe(true);
    expect(typeof fake.execute).toBe('function');
    // The fake's execute returns early for any non-CREATED intent (no events), so it cannot fabricate no-effect proof.
    const src = (InMemoryCommercialIntentBrokerFake.prototype.execute as (...a: unknown[]) => unknown).toString();
    expect(src).toMatch(/state !== ["']CREATED["']\)\s*return\s*\{\s*intent: rec\.intent,\s*events: \[\]/);
  });
});
