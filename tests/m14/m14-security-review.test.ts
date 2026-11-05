// M14 adversarial security review of the release tooling (T-058, T-059, T-060). Each case reproduces a finding:
//   R1 claim check: a broad qualifier list let "without", "never", "is not", "UNKNOWN" excuse a real-world assertion;
//   R2 claim check: a qualifier hidden in an HTML comment excused a visible assertion;
//   R3 journey gate: evidence artifacts were not bound to the journey's own evidence directory;
//   R4 release gate: an authorization could be valid for an unbounded window;
//   R5 release gate: single use was not enforced by the tooling (an AUTHORIZED decision did not consume the record);
//   R6 journey gate CLI: the database URL (with its password) was accepted on argv, visible in the process list.
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from '../m00/helpers.js';

const cc = await import(path.join(repoRoot, 'scripts', 'release', 'claim-check.mjs'));
const jg = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const rg = await import(path.join(repoRoot, 'scripts', 'release', 'release-gate.mjs'));
const ledger = { schema: 'claims-ledger.v1', drafts: [], claims: [] };
const rules = (f: { rule: string }[]) => f.map((x) => x.rule);

describe('M14 security review R1/R2: claim-check qualifiers', () => {
  it.each([
    'A real Kite payment completed without errors.',
    'The pilot customers use it daily and it never fails.',
    'Deployed to production; downtime is not expected.',
    'We paid the provider through Kite with no UNKNOWN outcomes.',
  ])('R1 refuses a real-world assertion excused only by a generic word: %s', (line) => {
    expect(rules(cc.checkDraftText('d.md', line, { ledger }))).toContain('UNQUALIFIED_ASSERTION');
  });

  it('R2 refuses a qualifier hidden in an HTML comment', () => {
    expect(
      rules(cc.checkDraftText('d.md', 'We paid a real provider through Kite. <!-- NOT_RUN -->', { ledger })),
    ).toContain('UNQUALIFIED_ASSERTION');
    expect(
      cc.checkDraftText('d.md', 'A real Kite payment is NOT_RUN. <!-- C-0 -->'.replace('C-0', 'x'), { ledger }),
    ).toEqual([]);
  });
});

describe('M14 security review R3: journey artifacts belong to their journey', () => {
  it('an artifact under another journey directory fails the part', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ub-m14-r3-'));
    try {
      const rel = 'evidence/journeys/jrn-other/sensor.json';
      mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(root, rel), 'x');
      const sha = 'c'.repeat(40);
      const digest = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
      const r = jg.evaluateJourney(
        {
          schema: 'real-input-journey.v1',
          journeyId: 'jrn-this',
          sourceSha: sha,
          startedAt: '2026-11-10T10:00:00.000Z',
          endedAt: '2026-11-10T12:00:00.000Z',
          parts: {
            sensor: {
              origin: 'PHYSICAL_SENSOR',
              capturedAt: '2026-11-10T10:30:00.000Z',
              artifacts: [{ path: rel, sha256: digest }],
              facts: { authenticated: true },
            },
          },
        },
        { artifactRoot: root, expectedSha: sha, simulatedDigests: new Set(), isAuthorized: () => false },
      );
      const p = r.parts.find((x: { part: string }) => x.part === 'sensor');
      expect(p.status).toBe('FAIL');
      expect(p.reasons).toContain('ARTIFACT_FROM_OTHER_JOURNEY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const keys = generateKeyPairSync('ed25519');
const authorizers = { 'owner-k1': keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
const scope = { tag: 'v0.1.0', sourceSha: 'f'.repeat(40) };
const record = (over: Record<string, unknown> = {}) =>
  rg.signAuthorization(
    {
      schema: 'release-authorization.v1',
      gate: 'RELEASE_TAG',
      authorizationId: 'auth-tag-1',
      authorizedBy: 'repository-owner',
      authorizedAt: '2026-11-12T11:00:00.000Z',
      expiresAt: '2026-11-12T13:00:00.000Z',
      statement: 'Authorize RELEASE_TAG with exactly this scope.',
      scope,
      ...over,
    },
    keys.privateKey,
    'owner-k1',
  );
const preflight = Object.fromEntries(
  (rg.loadGateConfig(repoRoot).gates.RELEASE_TAG.preflight as string[]).map((c) => [c, true]),
);

describe('M14 security review R4/R5: authorization lifetime and single use', () => {
  it('R4 refuses a validity window longer than the gate allows', () => {
    const d = rg.evaluateGate('RELEASE_TAG', scope, {
      authorizations: [record({ expiresAt: '2026-12-12T11:00:00.000Z' })],
      authorizers,
      consumed: new Set(),
      now: new Date('2026-11-12T12:00:00.000Z'),
      preflight,
    });
    expect(d.decision).toBe('REFUSED');
    expect(d.reasons).toContain('VALIDITY_TOO_LONG');
  });

  it('R5 an AUTHORIZED decision consumes the record, so a second use is refused', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ub-m14-r5-'));
    try {
      cpSync(path.join(repoRoot, 'config'), path.join(root, 'config'), { recursive: true });
      mkdirSync(path.join(root, 'evidence', 'authorizations'), { recursive: true });
      writeFileSync(
        path.join(root, 'config', 'release', 'authorizers.json'),
        JSON.stringify({ schema: 'release-authorizers.v1', authorizers }),
      );
      writeFileSync(
        path.join(root, 'evidence', 'authorizations', 'RELEASE_TAG.auth-tag-1.json'),
        JSON.stringify(record()),
      );
      const now = new Date('2026-11-12T12:00:00.000Z');
      const first = rg.checkAndRecord(root, 'RELEASE_TAG', scope, { preflight, now });
      expect(first.decision).toBe('AUTHORIZED');
      const consumed = JSON.parse(readFileSync(path.join(root, 'evidence', 'authorizations', 'consumed.json'), 'utf8'));
      expect(consumed.consumed).toContain('auth-tag-1');
      const second = rg.checkAndRecord(root, 'RELEASE_TAG', scope, { preflight, now });
      expect(second.decision).toBe('REFUSED');
      expect(second.reasons).toContain('AUTHORIZATION_ALREADY_USED');
      const log = readFileSync(path.join(root, 'evidence', 'authorizations', 'decisions.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(log.map((l) => JSON.parse(l).decision)).toEqual(['AUTHORIZED', 'REFUSED']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('M14 security review R6: no database URL on argv', () => {
  it('the journey gate CLI refuses --database-url and reads the URL from the environment instead', () => {
    const r = run('node', [
      'scripts/release/journey-gate.mjs',
      '--database-url',
      'postgres://u:secretpw@127.0.0.1:1/x',
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/JOURNEY_DATABASE_URL/);
    expect(r.stdout + r.stderr).not.toContain('secretpw');
  });
});

const smoke = await import(path.join(repoRoot, 'scripts', 'release', 'smoke.mjs'));

describe('M14 security review R7: an interrupted smoke run still cleans up', () => {
  it('interruptCleanup removes the compose project (with volumes) and the work directory holding throwaway keys', async () => {
    const calls: string[][] = [];
    const removed: string[] = [];
    const plan = smoke.planSmoke({ repo: repoRoot, workRoot: path.join(tmpdir(), 'ub-m14-r7'), seed: 7 });
    await smoke.interruptCleanup(plan, {
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { stdout: '', stderr: '' };
      },
      removeDir: async (d: string) => void removed.push(d),
    });
    expect(calls.find((c) => c.includes('down'))).toEqual(expect.arrayContaining(['-p', plan.project, 'down', '-v']));
    expect(removed).toEqual([plan.workDir]);
  });
});

describe('M14 security review R8: the payment cap comes from the authorization, not the manifest', () => {
  it('authorizationVerifies checks the requested payment against the signed scope', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ub-m14-r8-'));
    try {
      cpSync(path.join(repoRoot, 'config'), path.join(root, 'config'), { recursive: true });
      mkdirSync(path.join(root, 'evidence', 'authorizations'), { recursive: true });
      writeFileSync(
        path.join(root, 'config', 'release', 'authorizers.json'),
        JSON.stringify({ schema: 'release-authorizers.v1', authorizers }),
      );
      const pay = rg.signAuthorization(
        {
          schema: 'release-authorization.v1',
          gate: 'PAYMENT',
          authorizationId: 'auth-pay-1',
          authorizedBy: 'repository-owner',
          authorizedAt: '2026-11-12T11:00:00.000Z',
          expiresAt: '2026-11-12T13:00:00.000Z',
          statement: 'Authorize one PAYMENT with exactly this scope.',
          scope: { merchant: 'm-1', amountMinor: 1000, currency: 'USD', purpose: 'diagnostic', environment: 'pilot' },
        },
        keys.privateKey,
        'owner-k1',
      );
      writeFileSync(path.join(root, 'evidence', 'authorizations', 'PAYMENT.auth-pay-1.json'), JSON.stringify(pay));
      const now = new Date('2026-11-12T12:00:00.000Z');
      const within = {
        merchant: 'm-1',
        amountMinor: 900,
        currency: 'USD',
        purpose: 'diagnostic',
        environment: 'pilot',
      };
      expect(rg.authorizationVerifies(root, 'PAYMENT', 'auth-pay-1', now, within)).toBe(true);
      expect(rg.authorizationVerifies(root, 'PAYMENT', 'auth-pay-1', now, { ...within, amountMinor: 1500 })).toBe(
        false,
      );
      expect(rg.authorizationVerifies(root, 'PAYMENT', 'auth-pay-1', now, { ...within, merchant: 'm-2' })).toBe(false);
      expect(rg.authorizationVerifies(root, 'PAYMENT', 'auth-pay-1', now)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// R9 (coordinator review): comments were stripped one line at a time, so a multi-line or unclosed `<!--` could hold a
// qualifier the rendered draft never shows. Other constructs that hide or disguise text fail closed.
describe('M14 security review R9: only rendered-visible text qualifies a claim', () => {
  const findings = (text: string) => cc.checkDraftText('d.md', text, { ledger });

  it('rejects a qualifier inside a multi-line comment', () => {
    const f = findings('We paid a real provider through Kite. <!-- this\nis NOT_RUN\n-->');
    expect(rules(f)).toContain('UNQUALIFIED_ASSERTION');
    // The qualifier sits on the claim line but inside a comment that closes on a later line.
    expect(rules(findings('We paid a real provider through Kite. <!-- NOT_RUN\n-->'))).toContain(
      'UNQUALIFIED_ASSERTION',
    );
    const g = findings('<!--\nNOT_RUN\n-->We paid a real provider through Kite.');
    expect(rules(g)).toContain('UNQUALIFIED_ASSERTION');
  });

  it('rejects a qualifier after an unclosed comment opener', () => {
    const f = findings('We paid a real provider through Kite. <!-- NOT_RUN');
    expect(rules(f)).toContain('UNQUALIFIED_ASSERTION');
    // Everything after an unclosed opener is invisible, including later qualifiers.
    expect(rules(findings('<!--\nA real Kite payment completed.\nThe sensor is real.'))).toContain('UNCLOSED_COMMENT');
  });

  it('rejects a qualifier disguised with zero-width characters or encoded entities', () => {
    expect(rules(findings('We paid a real provider through Kite (N​OT_RUN).'))).toEqual(
      expect.arrayContaining(['INVISIBLE_CHARACTER', 'UNQUALIFIED_ASSERTION']),
    );
    expect(rules(findings('We paid a real provider through Kite (&#78;OT_RUN).'))).toEqual(
      expect.arrayContaining(['ENCODED_TEXT', 'UNQUALIFIED_ASSERTION']),
    );
  });

  it('fails closed on collapsed details, raw HTML and link reference definitions holding qualifiers', () => {
    expect(rules(findings('We paid a real provider.\n<details><summary>x</summary>NOT_RUN</details>'))).toEqual(
      expect.arrayContaining(['HIDDEN_CONTENT', 'UNQUALIFIED_ASSERTION']),
    );
    expect(rules(findings('We paid a real provider. <span hidden>NOT_RUN</span>'))).toContain('HIDDEN_CONTENT');
    expect(rules(findings('We paid a real provider [x].\n\n[x]: ./a.md "NOT_RUN"'))).toContain('UNQUALIFIED_ASSERTION');
  });

  it('accepts a visible qualifier on the claim line', () => {
    expect(findings('A real Kite-paid action is NOT_RUN.')).toEqual([]);
    expect(findings('Intro <!-- a\ncomment -->\nA real Kite-paid action is NOT_RUN.')).toEqual([]);
  });

  it('keeps line numbers correct after a multi-line comment', () => {
    const f = findings('line one\n<!-- a\nb\nc -->\nWe paid a real provider through Kite.');
    const hit = f.find((x: { rule: string; line?: number }) => x.rule === 'UNQUALIFIED_ASSERTION');
    expect(hit?.line).toBe(5);
  });
});
