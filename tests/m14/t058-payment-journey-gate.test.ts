// T-058 / T-060 payment part of the real-input journey, gate layer (no network, no Kite, throwaway Ed25519 keys only).
// The live journey checks its PAYMENT authorization with `release-gate.mjs check` BEFORE any egress; that AUTHORIZED
// decision consumes the record (single use, M14 R5). The journey gate, run after the payment, must therefore accept a
// consumed authorization only when the recorded AUTHORIZED decision was made for exactly this journey's request (its
// canonical digest) inside the journey window; any other request, journey, window, signature or scope is refused.
// The journey manifest records only payment, fulfillment and duplicate from a payment run (sensor, document,
// reasoning, recovery and timeout stay NOT_RUN), and a dry run can only carry a non-real origin.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const rg = await import(path.join(repoRoot, 'scripts', 'release', 'release-gate.mjs'));
const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const ev = await import(path.join(repoRoot, 'scripts', 'release', 'journey-evidence.mjs'));

const keys = generateKeyPairSync('ed25519');
const authorizers = { 'owner-k1': keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
const scope = {
  merchant: 'lionx402.com',
  amountMinor: 1,
  currency: 'USD',
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  environment: 'kite-passport-prod',
};
const preflight = {
  'broker-isolation': true,
  'budget-bound': true,
  'reconciliation-ready': true,
  'kill-switch-ready': true,
};
const record = (over: Record<string, unknown> = {}) =>
  rg.signAuthorization(
    {
      schema: 'release-authorization.v1',
      gate: 'PAYMENT',
      authorizationId: 'auth-payment-20261113-a1b2c3',
      authorizedBy: 'repository-owner',
      authorizedAt: '2026-11-13T10:00:00.000Z',
      expiresAt: '2026-11-13T12:00:00.000Z',
      statement: 'I authorize one payment of at most 1 minor unit USD to lionx402.com for the stated purpose.',
      scope,
      ...over,
    },
    keys.privateKey,
    'owner-k1',
  );
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function gateRoot(records = [record()]) {
  const root = mkdtempSync(path.join(tmpdir(), 'ub-t058-pay-'));
  roots.push(root);
  cpSync(path.join(repoRoot, 'config'), path.join(root, 'config'), { recursive: true });
  writeFileSync(
    path.join(root, 'config', 'release', 'authorizers.json'),
    JSON.stringify({ schema: 'release-authorizers.v1', authorizers }),
  );
  mkdirSync(path.join(root, 'evidence', 'authorizations'), { recursive: true });
  for (const r of records)
    writeFileSync(
      path.join(root, 'evidence', 'authorizations', `PAYMENT.${r.authorizationId}.json`),
      JSON.stringify(r),
    );
  return root;
}
const request = (over: Record<string, unknown> = {}) => ({ ...scope, journeyId: 'j-2026-11-13-kite-payment', ...over });
const window = {
  journeyId: 'j-2026-11-13-kite-payment',
  startedAt: '2026-11-13T10:30:00.000Z',
  endedAt: '2026-11-13T10:50:00.000Z',
};
const decidedAt = new Date('2026-11-13T10:31:00.000Z');

describe('T-060 PAYMENT decisions are bound to the exact request they authorized', () => {
  it('checkAndRecord records the canonical request digest with the decision', () => {
    const root = gateRoot();
    const d = rg.checkAndRecord(root, 'PAYMENT', request(), { preflight, now: decidedAt });
    expect(d.decision).toBe('AUTHORIZED');
    const line = JSON.parse(
      readFileSync(path.join(root, 'evidence', 'authorizations', 'decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')[0]!,
    );
    expect(line.requestSha256).toBe(createHash('sha256').update(rg.canonical(request())).digest('hex'));
    expect(rg.authorizationDecidedFor(root, 'PAYMENT', 'auth-payment-20261113-a1b2c3', request())).toEqual({
      ok: true,
      decidedAt: decidedAt.toISOString(),
    });
    expect(
      rg.authorizationDecidedFor(root, 'PAYMENT', 'auth-payment-20261113-a1b2c3', request({ journeyId: 'other' })).ok,
    ).toBe(false);
    expect(
      rg.authorizationDecidedFor(root, 'PAYMENT', 'auth-payment-20261113-a1b2c3', request({ amountMinor: 2 })).ok,
    ).toBe(false);
  });

  it('a refused decision, a missing decision, a re-signed or foreign record never counts', () => {
    const root = gateRoot();
    expect(rg.authorizationDecidedFor(root, 'PAYMENT', 'auth-payment-20261113-a1b2c3', request()).ok).toBe(false);
    // Refused (preflight failed): logged, not consumed, not a decision for the request.
    rg.checkAndRecord(root, 'PAYMENT', request(), { preflight: {}, now: decidedAt });
    expect(rg.authorizationDecidedFor(root, 'PAYMENT', 'auth-payment-20261113-a1b2c3', request()).ok).toBe(false);
    // A record whose signature no longer verifies (scope edited after signing).
    const tampered = { ...record(), scope: { ...scope, amountMinor: 100 } };
    const root2 = gateRoot([tampered]);
    rg.checkAndRecord(root2, 'PAYMENT', request({ amountMinor: 100 }), { preflight, now: decidedAt });
    expect(
      rg.authorizationDecidedFor(root2, 'PAYMENT', tampered.authorizationId, request({ amountMinor: 100 })).ok,
    ).toBe(false);
    expect(rg.authorizationDecidedFor(root, 'DEPLOY', 'auth-payment-20261113-a1b2c3', request()).ok).toBe(false);
  });
});

describe('T-058 the journey gate accepts a consumed PAYMENT authorization only for its own decided request', () => {
  it('paymentAuthorized: unconsumed-and-valid now, or consumed by an AUTHORIZED decision for this request inside the window', () => {
    const root = gateRoot();
    const id = 'auth-payment-20261113-a1b2c3';
    const now = new Date('2026-11-13T10:55:00.000Z');
    // Before any decision: the existing rule (signed, in validity, unconsumed, scope covers) still holds.
    expect(gate.paymentAuthorized(root, id, request(), { ...window, now })).toBe(true);
    rg.checkAndRecord(root, 'PAYMENT', request(), { preflight, now: decidedAt });
    expect(rg.authorizationVerifies(root, 'PAYMENT', id, now, request())).toBe(false); // consumed
    expect(gate.paymentAuthorized(root, id, request(), { ...window, now })).toBe(true);
    // Another journey cannot borrow the decision; a decision outside the window does not count.
    expect(
      gate.paymentAuthorized(root, id, request({ journeyId: 'j-other' }), { ...window, journeyId: 'j-other', now }),
    ).toBe(false);
    expect(gate.paymentAuthorized(root, id, request(), { ...window, journeyId: 'j-other', now })).toBe(false);
    expect(gate.paymentAuthorized(root, id, request(), { ...window, startedAt: '2026-11-13T10:40:00.000Z', now })).toBe(
      false,
    );
    expect(gate.paymentAuthorized(root, id, request({ amountMinor: 2 }), { ...window, now })).toBe(false);
    expect(gate.paymentAuthorized(root, id, undefined, { ...window, now })).toBe(false);
  });
});

describe('T-058 payment journey manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ub-t058-pay-manifest-'));
  roots.push(root);
  const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
  const art = (name: string) => {
    const rel = `evidence/journeys/${window.journeyId}/${name}`;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    const body = `{"artifact":"${name}"}`;
    writeFileSync(path.join(root, rel), body);
    return { path: rel, sha256: sha256(body) };
  };
  const parts = () => ({
    payment: {
      capturedAt: '2026-11-13T10:40:00.000Z',
      authorizationId: 'auth-payment-20261113-a1b2c3',
      artifacts: [art('payment.json')],
      facts: {
        state: 'CONFIRMED',
        reconciled: true,
        amountMinor: 1,
        capMinor: 1,
        currency: 'USD',
        merchant: 'lionx402.com',
        purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
        request: request(),
      },
    },
    fulfillment: {
      capturedAt: '2026-11-13T10:40:00.000Z',
      artifacts: [art('merchant-response.json')],
      facts: { statusCode: 200 },
    },
    duplicate: {
      capturedAt: '2026-11-13T10:41:00.000Z',
      artifacts: [art('duplicate.json')],
      facts: { sameIntentReturned: true, secondEgress: false },
    },
  });
  const build = (over: Record<string, unknown> = {}) =>
    ev.buildJourneyManifest({
      journeyId: window.journeyId,
      sourceSha: 'a'.repeat(40),
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      parts: parts(),
      recordable: ev.PAYMENT_RECORDED_PARTS,
      ...over,
    });

  it('records payment (KITE_PASSPORT), fulfillment (PROVIDER_LIVE) and duplicate (KITE_PASSPORT) only', () => {
    const m = build();
    expect(Object.keys(m.parts).sort()).toEqual(['duplicate', 'fulfillment', 'payment']);
    expect(m.parts.payment).toMatchObject({ origin: 'KITE_PASSPORT', authorizationId: 'auth-payment-20261113-a1b2c3' });
    expect(m.parts.fulfillment.origin).toBe('PROVIDER_LIVE');
    expect(m.parts.duplicate.origin).toBe('KITE_PASSPORT');
    expect(m.notRecorded).toEqual(['sensor', 'document', 'reasoning', 'recovery', 'timeout']);
    expect(() => build({ parts: { ...parts(), sensor: parts().payment } })).toThrow(/cannot be recorded/);
    expect(() => build({ parts: { ...parts(), payment: { ...parts().payment, authorizationId: undefined } } })).toThrow(
      /authorizationId/,
    );
    // The default stays the document + reasoning run's parts (no payment from that runner).
    expect(() => ev.buildJourneyManifest({ ...build(), parts: parts(), recordable: undefined })).toThrow(
      /cannot be recorded/,
    );
  });

  it('a dry run may only label its parts with a non-real origin', () => {
    const m = build({ originOverride: 'RECORDED_CONTRACT' });
    for (const p of Object.values(m.parts) as { origin: string }[]) expect(p.origin).toBe('RECORDED_CONTRACT');
    expect(() => build({ originOverride: 'KITE_PASSPORT' })).toThrow(/non-real/);
    const r = gate.evaluateJourney(m, {
      artifactRoot: root,
      expectedSha: 'a'.repeat(40),
      simulatedDigests: new Set(),
      isAuthorized: () => true,
    });
    const status = Object.fromEntries(r.parts.map((p: { part: string; status: string }) => [p.part, p.status]));
    expect(status).toMatchObject({ payment: 'FAIL', fulfillment: 'FAIL', duplicate: 'FAIL', timeout: 'NOT_RUN' });
  });

  it('a real-labelled manifest whose payment authorization verifies passes those three parts', () => {
    const r = gate.evaluateJourney(build(), {
      artifactRoot: root,
      expectedSha: 'a'.repeat(40),
      simulatedDigests: new Set(),
      isAuthorized: (g: string, id: string, req: { journeyId?: string }) =>
        g === 'PAYMENT' && id === 'auth-payment-20261113-a1b2c3' && req?.journeyId === window.journeyId,
    });
    const status = Object.fromEntries(r.parts.map((p: { part: string; status: string }) => [p.part, p.status]));
    expect(status).toMatchObject({ payment: 'PASS', fulfillment: 'PASS', duplicate: 'PASS', sensor: 'NOT_RUN' });
    expect(r.result).toBe('NOT_RUN');
  });
});

// PR #21 review 9: the authorized request, not the manifest's own capMinor, bounds the recorded payment.
describe('T-058 PR #21 review 9: the recorded payment stays inside the authorized request', () => {
  const base = () => ({
    state: 'CONFIRMED',
    reconciled: true,
    amountMinor: 1,
    capMinor: 5,
    currency: 'USD',
    merchant: 'lionx402.com',
    purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
    request: request(),
  });
  const root = mkdtempSync(path.join(tmpdir(), 'ub-t058-pay-r9-'));
  roots.push(root);
  const art = () => {
    const rel = `evidence/journeys/${window.journeyId}/payment.json`;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), '{}');
    return { path: rel, sha256: createHash('sha256').update('{}').digest('hex') };
  };
  const manifest = (facts: Record<string, unknown>) => ({
    schema: 'real-input-journey.v1',
    journeyId: window.journeyId,
    sourceSha: 'a'.repeat(40),
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    parts: {
      payment: {
        origin: 'KITE_PASSPORT',
        journeyId: window.journeyId,
        capturedAt: '2026-11-13T10:40:00.000Z',
        authorizationId: 'auth-payment-20261113-a1b2c3',
        artifacts: [art()],
        facts,
      },
    },
  });
  const paymentOf = (facts: Record<string, unknown>) =>
    gate
      .evaluateJourney(manifest(facts), {
        artifactRoot: root,
        expectedSha: 'a'.repeat(40),
        simulatedDigests: new Set(),
        isAuthorized: () => true,
      })
      .parts.find((p: { part: string }) => p.part === 'payment');

  it.each([
    ['an amount above the authorized request (even under capMinor)', { amountMinor: 2 }, 'PAYMENT_OVER_AUTHORIZED'],
    ['another currency', { currency: 'EUR' }, 'PAYMENT_OUTSIDE_AUTHORIZATION:currency'],
    ['another merchant', { merchant: 'other.example' }, 'PAYMENT_OUTSIDE_AUTHORIZATION:merchant'],
    ['another purpose', { purpose: 'OTHER_PURPOSE' }, 'PAYMENT_OUTSIDE_AUTHORIZATION:purpose'],
    ['no authorized request', { request: undefined }, 'PAYMENT_REQUEST_MISSING'],
  ])('the journey gate fails %s', (_n, over, reason) => {
    const p = paymentOf({ ...base(), ...over });
    expect(p.status).toBe('FAIL');
    expect(p.reasons).toContain(reason);
  });

  it('the gate passes the payment inside the request, and the manifest builder refuses one outside it', () => {
    expect(paymentOf(base()).status).toBe('PASS');
    const build = (facts: Record<string, unknown>) =>
      ev.buildJourneyManifest({
        journeyId: window.journeyId,
        sourceSha: 'a'.repeat(40),
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        recordable: ev.PAYMENT_RECORDED_PARTS,
        parts: {
          payment: {
            capturedAt: '2026-11-13T10:40:00.000Z',
            authorizationId: 'auth-payment-20261113-a1b2c3',
            artifacts: [art()],
            facts,
          },
        },
      });
    expect(() => build(base())).not.toThrow();
    expect(() => build({ ...base(), amountMinor: 2 })).toThrow(/authorized request/);
    expect(() => build({ ...base(), currency: 'EUR' })).toThrow(/authorized request/);
    expect(() => build({ ...base(), merchant: 'other.example' })).toThrow(/authorized request/);
    expect(() => build({ ...base(), purpose: 'X_Y' })).toThrow(/authorized request/);
  });
});

// PR #21 review 10: completed-payment evidence counts only with the consumed, request-bound AUTHORIZED decision made
// inside the journey window and recorded for this journey id (decision: the journey id is bound in the decision record,
// not in the signed scope; see docs/release/RELEASE-GATES.md).
describe('T-058 PR #21 review 10: completed-payment evidence needs the decision recorded for this journey', () => {
  const id = 'auth-payment-20261113-a1b2c3';
  const now = new Date('2026-11-13T10:55:00.000Z');

  it('an unconsumed, valid record alone is not evidence of a completed payment', () => {
    const root = gateRoot();
    expect(gate.paymentAuthorized(root, id, request(), { ...window, now })).toBe(true);
    expect(gate.paymentEvidenceAuthorized(root, id, request(), { ...window, now })).toBe(false);
    expect(gate.evidenceAuthorizer(root, () => now)('PAYMENT', id, request(), window)).toBe(false);
  });

  it('the decision records the journey id; only that journey, inside its window, may use it', () => {
    const root = gateRoot();
    rg.checkAndRecord(root, 'PAYMENT', request(), { preflight, now: decidedAt });
    const line = JSON.parse(
      readFileSync(path.join(root, 'evidence', 'authorizations', 'decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')[0]!,
    );
    expect(line.journeyId).toBe(window.journeyId);
    expect(gate.paymentEvidenceAuthorized(root, id, request(), { ...window, now })).toBe(true);
    expect(gate.evidenceAuthorizer(root, () => now)('PAYMENT', id, request(), window)).toBe(true);
    expect(gate.evidenceAuthorizer(root, () => now)('DEPLOY', id, request(), window)).toBe(false);
    expect(
      gate.paymentEvidenceAuthorized(root, id, request(), { ...window, endedAt: '2026-11-13T10:30:30.000Z', now }),
    ).toBe(false);
    // A decision whose recorded journey id disagrees with the request is refused even if the digest were forged.
    const f = path.join(root, 'evidence', 'authorizations', 'decisions.jsonl');
    writeFileSync(f, `${JSON.stringify({ ...line, journeyId: 'j-other' })}\n`);
    expect(gate.paymentEvidenceAuthorized(root, id, request(), { ...window, now })).toBe(false);
  });
});
