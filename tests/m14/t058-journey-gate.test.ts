// T-058 (M14, FR-22, INV-12) real-input recovery journey gate, unit layer. The journey needs a real authenticated
// sensor, a real document, a real SERV Reasoning (OpenServ) run, a bounded real Kite-paid action, downstream
// fulfillment, independent recovery evidence, a duplicate request returning the existing intent and an injected timeout
// that becomes UNKNOWN and reconciles before any retry. The gate classifies each part PASS/FAIL/NOT_RUN/UNKNOWN/
// UNSUPPORTED and refuses simulated, replayed, fixture, demo and recorded-contract evidence. The real run is NOT_RUN:
// none of those inputs is available or authorized here, and nothing in this repository fabricates them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot, run } from '../m00/helpers.js';

const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));

const root = mkdtempSync(path.join(tmpdir(), 'ub-m14-journey-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = 'c'.repeat(40);
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const artifact = (name: string, body = `artifact ${name} ${Math.random()}`) => {
  const rel = `evidence/journeys/jrn-test/${name}`;
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
  return { path: rel, sha256: sha256(body) };
};
const at = '2026-11-10T10:30:00.000Z';
const realPart = (part: string) => ({
  origin: gate.REAL_ORIGINS[part],
  capturedAt: at,
  artifacts: [artifact(`${part}.json`)],
});
const realManifest = () => ({
  schema: 'real-input-journey.v1',
  journeyId: 'jrn-test',
  sourceSha: sha,
  startedAt: '2026-11-10T10:00:00.000Z',
  endedAt: '2026-11-10T12:00:00.000Z',
  parts: {
    sensor: { ...realPart('sensor'), facts: { authenticated: true } },
    document: realPart('document'),
    reasoning: { ...realPart('reasoning'), facts: { runId: 'serv-run-1' } },
    payment: {
      ...realPart('payment'),
      authorizationId: 'auth-payment-1',
      facts: { state: 'CONFIRMED', reconciled: true, amountMinor: 1500, capMinor: 2000, currency: 'USD' },
    },
    fulfillment: realPart('fulfillment'),
    recovery: { ...realPart('recovery'), facts: { evaluation: 'PASSED', independentEvidence: true } },
    duplicate: { ...realPart('duplicate'), facts: { sameIntentReturned: true } },
    timeout: {
      ...realPart('timeout'),
      facts: { injectedTimeout: true, stateAfterTimeout: 'UNKNOWN', reconciledBeforeRetry: true },
    },
  },
});
const opts = (over: Record<string, unknown> = {}) => ({
  artifactRoot: root,
  expectedSha: sha,
  simulatedDigests: new Set<string>(),
  isAuthorized: (g: string, id: string) => g === 'PAYMENT' && id === 'auth-payment-1',
  ...over,
});
const statusOf = (r: { parts: { part: string; status: string }[] }) =>
  Object.fromEntries(r.parts.map((p) => [p.part, p.status]));

describe('T-058 journey gate classification', () => {
  it('names the eight journey parts', () => {
    expect([...gate.JOURNEY_PARTS]).toEqual([
      'sensor',
      'document',
      'reasoning',
      'payment',
      'fulfillment',
      'recovery',
      'duplicate',
      'timeout',
    ]);
  });

  it('without a journey manifest every part is NOT_RUN', () => {
    const r = gate.evaluateJourney(null, opts());
    expect(r.result).toBe('NOT_RUN');
    expect(Object.values(statusOf(r))).toEqual(Array(8).fill('NOT_RUN'));
  });

  it('a complete, genuine, authorized, source-bound manifest passes (the gate is satisfiable, not rigged)', () => {
    const r = gate.evaluateJourney(realManifest(), opts());
    expect(statusOf(r)).toEqual(Object.fromEntries(gate.JOURNEY_PARTS.map((p: string) => [p, 'PASS'])));
    expect(r.result).toBe('PASS');
  });

  it.each([
    ['sensor', 'SIMULATED_INPUT'],
    ['sensor', 'SIMULATOR'],
    ['reasoning', 'CONTRACT_FAKE'],
    ['payment', 'RECORDED_CONTRACT'],
    ['payment', 'LOCAL_STAND_IN'],
    ['document', 'FIXTURE'],
    ['fulfillment', 'SEEDED_TEST_DATA'],
    ['recovery', 'DEMO'],
    ['timeout', 'REPLAY'],
  ])('rejects %s evidence of origin %s', (part, origin) => {
    const m = realManifest();
    (m.parts as Record<string, { origin: string }>)[part]!.origin = origin;
    const r = gate.evaluateJourney(m, opts());
    const p = r.parts.find((x: { part: string }) => x.part === part);
    expect(p.status).toBe('FAIL');
    expect(p.reasons.join(' ')).toMatch(/NON_REAL_ORIGIN/);
    expect(r.result).toBe('FAIL');
  });

  it('rejects replayed evidence, artifacts registered as simulated, and evidence captured outside the run window', () => {
    const replay = realManifest();
    (replay.parts.sensor as Record<string, unknown>).replayOf = 'jrn-earlier';
    expect(statusOf(gate.evaluateJourney(replay, opts())).sensor).toBe('FAIL');

    const known = realManifest();
    const digest = known.parts.document.artifacts[0]!.sha256;
    const r = gate.evaluateJourney(known, opts({ simulatedDigests: new Set([digest]) }));
    expect(statusOf(r).document).toBe('FAIL');
    expect(r.parts.find((p: { part: string }) => p.part === 'document').reasons).toContain('KNOWN_SIMULATED_ARTIFACT');

    const late = realManifest();
    late.parts.recovery.capturedAt = '2026-11-11T00:00:00.000Z';
    expect(statusOf(gate.evaluateJourney(late, opts())).recovery).toBe('FAIL');
  });

  it('a missing artifact is UNKNOWN, a tampered one is FAIL, and a path outside the evidence root is FAIL', () => {
    const m = realManifest();
    m.parts.fulfillment.artifacts = [{ path: 'evidence/journeys/jrn-test/absent.json', sha256: 'a'.repeat(64) }];
    m.parts.document.artifacts[0]!.sha256 = 'b'.repeat(64);
    m.parts.reasoning.artifacts = [{ path: '../../etc/hosts', sha256: 'c'.repeat(64) }];
    const s = statusOf(gate.evaluateJourney(m, opts()));
    expect(s.fulfillment).toBe('UNKNOWN');
    expect(s.document).toBe('FAIL');
    expect(s.reasoning).toBe('FAIL');
    const none = realManifest();
    none.parts.sensor.artifacts = [];
    expect(statusOf(gate.evaluateJourney(none, opts())).sensor).toBe('UNKNOWN');
  });

  it('a payment needs a recorded PAYMENT authorization and stays within its cap; an unreconciled outcome is UNKNOWN', () => {
    const noAuth = realManifest();
    noAuth.parts.payment.authorizationId = 'auth-deploy-1';
    expect(statusOf(gate.evaluateJourney(noAuth, opts())).payment).toBe('FAIL');
    const overCap = realManifest();
    overCap.parts.payment.facts.amountMinor = 5000;
    expect(statusOf(gate.evaluateJourney(overCap, opts())).payment).toBe('FAIL');
    const ambiguous = realManifest();
    ambiguous.parts.payment.facts.state = 'UNKNOWN';
    ambiguous.parts.payment.facts.reconciled = false;
    expect(statusOf(gate.evaluateJourney(ambiguous, opts())).payment).toBe('UNKNOWN');
  });

  it('the timeout part must show UNKNOWN then reconciliation before retry; the duplicate part the same intent', () => {
    const m = realManifest();
    m.parts.timeout.facts.reconciledBeforeRetry = false;
    m.parts.duplicate.facts.sameIntentReturned = false;
    const s = statusOf(gate.evaluateJourney(m, opts()));
    expect(s.timeout).toBe('FAIL');
    expect(s.duplicate).toBe('FAIL');
  });

  it('database facts override the manifest: a SIMULATED_INPUT sensor in the database fails a PHYSICAL claim', () => {
    const r = gate.evaluateJourney(
      realManifest(),
      opts({
        databaseFacts: {
          sensor: { origin: 'SIMULATED_INPUT', real: false },
          payment: { origin: 'KITE_PASSPORT', real: true },
        },
      }),
    );
    expect(statusOf(r).sensor).toBe('FAIL');
    expect(r.parts.find((p: { part: string }) => p.part === 'sensor').reasons.join(' ')).toMatch(/DATABASE_ORIGIN/);
    expect(statusOf(r).payment).toBe('PASS');
  });

  it('every part must come from the same source-bound run', () => {
    expect(gate.evaluateJourney(realManifest(), opts({ expectedSha: 'd'.repeat(40) })).result).toBe('FAIL');
    const m = realManifest();
    (m.parts.sensor as Record<string, unknown>).journeyId = 'jrn-other';
    expect(statusOf(gate.evaluateJourney(m, opts())).sensor).toBe('FAIL');
  });

  it('a part declared UNSUPPORTED with a reason stays UNSUPPORTED and the journey cannot PASS', () => {
    const m = realManifest();
    (m.parts as Record<string, unknown>).fulfillment = { status: 'UNSUPPORTED', reasonCode: 'NO_PROVIDER_ADAPTER' };
    const r = gate.evaluateJourney(m, opts());
    expect(statusOf(r).fulfillment).toBe('UNSUPPORTED');
    expect(r.result).not.toBe('PASS');
  });
});

describe('T-058 repository state: the real-input journey is NOT_RUN', () => {
  it('the gate CLI finds no real journey, reports every part NOT_RUN and exits non-zero', () => {
    const r = run('node', ['scripts/release/journey-gate.mjs', '--json']);
    expect(r.code).not.toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.result).toBe('NOT_RUN');
    for (const p of report.parts) expect(p.status, p.part).toBe('NOT_RUN');
  });

  it('the recorded gate result says NOT_RUN for every part', () => {
    const rec = JSON.parse(readFileSync(path.join(repoRoot, 'docs/release/evidence/t058-journey-gate.json'), 'utf8'));
    expect(rec.result).toBe('NOT_RUN');
    expect(rec.parts.map((p: { status: string }) => p.status)).toEqual(Array(8).fill('NOT_RUN'));
  });

  it('every simulated demo artifact is registered so the gate refuses it', () => {
    const reg = JSON.parse(readFileSync(path.join(repoRoot, 'docs/release/demo/simulated-artifacts.json'), 'utf8'));
    expect(reg.label).toBe('SIMULATED_INPUT');
    expect(reg.artifacts.length).toBeGreaterThan(0);
    for (const a of reg.artifacts as { path: string; sha256: string }[]) {
      const file = path.join(repoRoot, a.path);
      expect(existsSync(file), a.path).toBe(true);
      expect(sha256(readFileSync(file)), a.path).toBe(a.sha256);
    }
    const loaded = gate.loadSimulatedDigests(repoRoot);
    for (const a of reg.artifacts as { sha256: string }[]) expect(loaded.has(a.sha256)).toBe(true);
  });
});
