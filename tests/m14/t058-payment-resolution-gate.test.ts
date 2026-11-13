// T-058 payment part resolved after the run (INV-08, INV-12). When a paid outcome stays UNKNOWN (no lookup by client key)
// a finance approver resolves it manually, citing an evidence digest. The journey is then re-recorded with a
// `resolution` section: the run's own manifest is kept and cited by digest (`runSourceSha` = the code that ran the
// payment), `sourceSha` is the code that recorded the resolution (HEAD when the gate runs, as before), and the window
// ends after the resolution. Every existing rule still applies; these rules are added on top and only refuse:
// the resolution is bound to this sourceSha, inside the window, to an evidence file whose digest it cites and that the
// payment part lists, to the run manifest (same journey, authorization and intent, payment UNKNOWN there, its own
// sourceSha), to the captured amount, and, with the database, to the product's own manual-resolution receipt.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const ev = await import(path.join(repoRoot, 'scripts', 'release', 'journey-evidence.mjs'));

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
const JID = 'j-resolution-test';
const RUN_SHA = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const INTENT = 'cin_00000000-0000-4000-8000-000000000001';
const AUTH = 'auth-payment-20261113-abcdef';
const request = {
  merchant: 'lionx402.com',
  amountMinor: 1,
  currency: 'USD',
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  environment: 'kite-passport-prod',
  journeyId: JID,
};
const window = { startedAt: '2026-11-13T07:01:37.404Z', endedAt: '2026-11-13T08:30:00.000Z' };
const resolvedAt = '2026-11-13T08:10:00.000Z';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function world(mutate: (w: { files: Record<string, string>; manifest: Json }) => void = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ub-t058-resolution-'));
  roots.push(root);
  const rel = (f: string) => `evidence/journeys/${JID}/${f}`;
  const runManifest = {
    schema: 'real-input-journey.v1',
    journeyId: JID,
    sourceSha: RUN_SHA,
    startedAt: window.startedAt,
    endedAt: '2026-11-13T07:02:26.909Z',
    parts: {
      payment: {
        origin: 'KITE_PASSPORT',
        journeyId: JID,
        capturedAt: '2026-11-13T07:02:25.980Z',
        authorizationId: AUTH,
        artifacts: [],
        facts: {
          state: 'UNKNOWN',
          reconciled: false,
          amountMinor: 0,
          capMinor: 1,
          currency: 'USD',
          request,
          intentId: INTENT,
        },
      },
    },
  };
  const files: Record<string, string> = {
    'manifest-run.journey.json': JSON.stringify(runManifest),
    'reconciliation.json': JSON.stringify({
      schema: 'journey-payment-reconciliation.v1',
      journeyId: JID,
      intentId: INTENT,
    }),
    'payment-resolved.json': JSON.stringify({ state: 'CONFIRMED', capturedMinor: '1' }),
    'merchant-response.json': JSON.stringify({ origin: 'PROVIDER_LIVE', statusCode: 200 }),
    'duplicate.json': JSON.stringify({ sameIntentReturned: true }),
  };
  const digest = () => `sha256:${sha256(files['reconciliation.json']!)}`;
  const manifest: Json = {
    schema: 'real-input-journey.v1',
    journeyId: JID,
    sourceSha: SHA,
    runSourceSha: RUN_SHA,
    ...window,
    parts: {
      payment: {
        origin: 'KITE_PASSPORT',
        journeyId: JID,
        capturedAt: resolvedAt,
        authorizationId: AUTH,
        artifacts: ['payment-resolved.json', 'reconciliation.json'],
        facts: {
          state: 'CONFIRMED',
          reconciled: true,
          amountMinor: 1,
          capMinor: 1,
          currency: 'USD',
          merchant: 'lionx402.com',
          purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
          request,
          intentId: INTENT,
          resolution: {
            kind: 'MANUAL_FINANCE_RESOLUTION',
            resolution: 'CAPTURED',
            evidenceDigest: 'DIGEST',
            resolvedAt,
          },
        },
      },
      fulfillment: {
        origin: 'PROVIDER_LIVE',
        journeyId: JID,
        capturedAt: '2026-11-13T07:02:25.895Z',
        artifacts: ['merchant-response.json'],
        facts: { statusCode: 200 },
      },
      duplicate: {
        origin: 'KITE_PASSPORT',
        journeyId: JID,
        capturedAt: '2026-11-13T07:02:26.004Z',
        artifacts: ['duplicate.json'],
        facts: { sameIntentReturned: true },
      },
    },
    resolution: {
      kind: 'MANUAL_FINANCE_RESOLUTION',
      resolution: 'CAPTURED',
      capturedMinor: 1,
      intentId: INTENT,
      sourceSha: SHA,
      resolvedAt,
      reasonCode: 'OWNER_REVIEW_KITE_SETTLEMENT_CHAIN_UNVERIFIED',
      evidence: { path: rel('reconciliation.json'), sha256: 'FILE' },
      evidenceDigest: 'DIGEST',
      runManifest: { path: rel('manifest-run.journey.json'), sha256: 'FILE' },
    },
  };
  mutate({ files, manifest });
  mkdirSync(path.join(root, 'evidence', 'journeys', JID), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(root, rel(f)), body);
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string' && v.endsWith('.json') && !v.includes('/'))
      return { path: rel(v), sha256: sha256(files[v] ?? '') };
    return v;
  };
  for (const p of Object.values(manifest.parts) as Json[]) p.artifacts = p.artifacts.map(fill);
  const d = digest();
  if (manifest.resolution?.evidenceDigest === 'DIGEST') manifest.resolution.evidenceDigest = d;
  if (manifest.parts.payment.facts.resolution?.evidenceDigest === 'DIGEST')
    manifest.parts.payment.facts.resolution.evidenceDigest = d;
  for (const k of ['evidence', 'runManifest'])
    if (manifest.resolution?.[k]?.sha256 === 'FILE')
      manifest.resolution[k].sha256 = sha256(files[path.basename(manifest.resolution[k].path)] ?? '');
  return { root, manifest, digest: d };
}
const ctx = (root: string, over: Record<string, unknown> = {}) => ({
  artifactRoot: root,
  expectedSha: SHA,
  simulatedDigests: new Set<string>(),
  isAuthorized: () => true,
  ...over,
});
const partOf = (r: { parts: { part: string; status: string; reasons: string[] }[] }, part: string) =>
  r.parts.find((p) => p.part === part)!;

describe('T-058 a manually resolved payment, recorded with a resolution section', () => {
  it('passes payment, fulfillment and duplicate when every rule holds (file-only and with the database receipt)', () => {
    const { root, manifest, digest } = world();
    const r = gate.evaluateJourney(manifest, ctx(root));
    for (const p of ['payment', 'fulfillment', 'duplicate']) expect(partOf(r, p), p).toMatchObject({ status: 'PASS' });
    const db = {
      payment: {
        origin: 'KITE_PASSPORT',
        real: true,
        manual: [{ intentId: INTENT, evidenceDigest: digest, kind: 'PAYMENT_SETTLEMENT' }],
      },
    };
    expect(partOf(gate.evaluateJourney(manifest, ctx(root, { databaseFacts: db })), 'payment').status).toBe('PASS');
  });

  it.each([
    [
      'the resolution names another source commit',
      (w: any) => (w.manifest.resolution.sourceSha = 'c'.repeat(40)),
      'RESOLUTION_SOURCE_SHA_MISMATCH',
    ],
    [
      'the resolution is outside the window',
      (w: any) => (w.manifest.resolution.resolvedAt = '2026-11-13T09:00:00.000Z'),
      'RESOLUTION_OUTSIDE_WINDOW',
    ],
    [
      'the evidence digest is not the evidence file',
      (w: any) => (w.manifest.resolution.evidenceDigest = `sha256:${'0'.repeat(64)}`),
      'RESOLUTION_EVIDENCE_MISMATCH',
    ],
    [
      'the evidence file was edited',
      (w: any) => (w.files['reconciliation.json'] = '{"edited":true}'),
      'RESOLUTION_EVIDENCE_MISMATCH',
    ],
    [
      'the payment part does not list the evidence',
      (w: any) => (w.manifest.parts.payment.artifacts = ['payment-resolved.json']),
      'RESOLUTION_EVIDENCE_NOT_CITED',
    ],
    [
      'the run manifest was edited',
      (w: any) => (w.files['manifest-run.journey.json'] = '{}'),
      'RESOLUTION_RUN_MANIFEST_MISMATCH',
    ],
    [
      'the run manifest is missing',
      (w: any) => delete w.files['manifest-run.journey.json'],
      'RESOLUTION_RUN_MANIFEST_MISMATCH',
    ],
    [
      'the run had already confirmed the payment',
      (w: any) => {
        const run = JSON.parse(w.files['manifest-run.journey.json']);
        run.parts.payment.facts.state = 'CONFIRMED';
        w.files['manifest-run.journey.json'] = JSON.stringify(run);
      },
      'RESOLUTION_RUN_NOT_UNKNOWN',
    ],
    [
      'the run manifest names another intent',
      (w: any) => {
        const run = JSON.parse(w.files['manifest-run.journey.json']);
        run.parts.payment.facts.intentId = 'cin_00000000-0000-4000-8000-000000000009';
        w.files['manifest-run.journey.json'] = JSON.stringify(run);
      },
      'RESOLUTION_RUN_MANIFEST_MISMATCH',
    ],
    [
      'the run ran under another commit than runSourceSha',
      (w: any) => (w.manifest.runSourceSha = 'd'.repeat(40)),
      'RESOLUTION_RUN_SOURCE_SHA_MISMATCH',
    ],
    [
      'the run window started elsewhere',
      (w: any) => (w.manifest.startedAt = '2026-11-13T07:00:00.000Z'),
      'RESOLUTION_RUN_MANIFEST_MISMATCH',
    ],
    [
      'the captured amount differs from the recorded payment',
      (w: any) => (w.manifest.resolution.capturedMinor = 2),
      'RESOLUTION_AMOUNT_MISMATCH',
    ],
    [
      'the payment facts do not repeat the resolution',
      (w: any) => delete w.manifest.parts.payment.facts.resolution,
      'RESOLUTION_FACTS_MISMATCH',
    ],
    [
      'the payment facts claim a resolution the manifest lacks',
      (w: any) => delete w.manifest.resolution,
      'RESOLUTION_UNDECLARED',
    ],
    [
      'the resolution was NO_EFFECT_PROVED, not a capture',
      (w: any) => (w.manifest.resolution.resolution = 'NO_EFFECT_PROVED'),
      'RESOLUTION_FACTS_MISMATCH',
    ],
  ])('fails the payment when %s', (_n, mutate, reason) => {
    const { root, manifest } = world(mutate as never);
    const p = partOf(gate.evaluateJourney(manifest, ctx(root)), 'payment');
    expect(p.status).toBe('FAIL');
    expect(p.reasons).toContain(reason);
  });

  it('with the database: the manual receipt must exist for this intent with exactly this evidence digest', () => {
    const { root, manifest, digest } = world();
    const at = (manual: unknown[]) =>
      partOf(
        gate.evaluateJourney(
          manifest,
          ctx(root, { databaseFacts: { payment: { origin: 'KITE_PASSPORT', real: true, manual } } }),
        ),
        'payment',
      );
    expect(at([]).reasons).toContain('DATABASE_RESOLUTION_MISSING');
    expect(
      at([{ intentId: INTENT, evidenceDigest: `sha256:${'0'.repeat(64)}`, kind: 'PAYMENT_SETTLEMENT' }]).reasons,
    ).toContain('DATABASE_RESOLUTION_MISMATCH');
    expect(at([{ intentId: INTENT, evidenceDigest: digest, kind: 'NO_EFFECT_PROOF' }]).reasons).toContain(
      'DATABASE_RESOLUTION_MISMATCH',
    );
    // A manually resolved intent recorded without its resolution section is refused.
    const plain = world((w) => {
      delete w.manifest.resolution;
      delete w.manifest.parts.payment.facts.resolution;
    });
    const p = partOf(
      gate.evaluateJourney(
        plain.manifest,
        ctx(plain.root, {
          databaseFacts: {
            payment: {
              origin: 'KITE_PASSPORT',
              real: true,
              manual: [{ intentId: INTENT, evidenceDigest: digest, kind: 'PAYMENT_SETTLEMENT' }],
            },
          },
        }),
      ),
      'payment',
    );
    expect(p.status).toBe('FAIL');
    expect(p.reasons).toContain('DATABASE_RESOLUTION_UNDECLARED');
  });
});

describe('T-058 the manifest builder records a resolution only with its run manifest and evidence', () => {
  const art = (root: string, f: string, body: string) => {
    const rel = `evidence/journeys/${JID}/${f}`;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
    return { path: rel, sha256: sha256(body) };
  };
  it('builds the resolution section and refuses a malformed one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ub-t058-resolution-b-'));
    roots.push(root);
    const recon = art(root, 'reconciliation.json', '{"r":1}');
    const run = art(root, 'manifest-run.journey.json', '{"m":1}');
    const resolution = {
      kind: 'MANUAL_FINANCE_RESOLUTION',
      resolution: 'CAPTURED',
      capturedMinor: 1,
      intentId: INTENT,
      sourceSha: SHA,
      resolvedAt,
      reasonCode: 'OWNER_REVIEW_KITE_SETTLEMENT_CHAIN_UNVERIFIED',
      evidence: recon,
      evidenceDigest: `sha256:${recon.sha256}`,
      runManifest: run,
    };
    const facts = {
      state: 'CONFIRMED',
      reconciled: true,
      amountMinor: 1,
      capMinor: 1,
      currency: 'USD',
      merchant: 'lionx402.com',
      purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
      request,
      intentId: INTENT,
      resolution: {
        kind: 'MANUAL_FINANCE_RESOLUTION',
        resolution: 'CAPTURED',
        evidenceDigest: `sha256:${recon.sha256}`,
        resolvedAt,
      },
    };
    const build = (over: Record<string, unknown> = {}) =>
      ev.buildJourneyManifest({
        journeyId: JID,
        sourceSha: SHA,
        runSourceSha: RUN_SHA,
        ...window,
        recordable: ev.PAYMENT_RECORDED_PARTS,
        parts: { payment: { capturedAt: resolvedAt, authorizationId: AUTH, artifacts: [recon], facts } },
        resolution,
        ...over,
      });
    const m = build();
    expect(m.resolution).toEqual(resolution);
    expect(m.runSourceSha).toBe(RUN_SHA);
    expect(() => build({ runSourceSha: undefined })).toThrow(/runSourceSha/);
    expect(() => build({ resolution: { ...resolution, sourceSha: RUN_SHA } })).toThrow(/resolution/);
    expect(() => build({ resolution: { ...resolution, evidenceDigest: 'sha256:00' } })).toThrow(/resolution/);
    expect(() => build({ resolution: { ...resolution, resolvedAt: '2026-11-13T09:00:00.000Z' } })).toThrow(
      /resolution/,
    );
  });
});
