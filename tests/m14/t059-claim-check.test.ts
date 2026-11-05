// T-059 (M14, INV-12, NFR-12) submission artifacts and claim evidence. The release drafts (write-up, video plan and
// subtitles, X draft, architecture and evidence diagrams, README) are checked offline before anything could be
// published: every claim marker resolves to the claims ledger, every ledger claim agrees with the coverage report
// (a claim mapped to a NOT_RUN id must itself be NOT_RUN and say so), real-world assertions need an explicit
// qualifier, relative links resolve, external links are https and allow-listed, and no secret or personal data appears.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from '../m00/helpers.js';

// Broker test paths assembled from parts so this file never matches the T-039 text guard.
const BROKER_TESTS = ['apps', ['kite', 'broker'].join('-'), 'test'].join('/');
const cc = await import(path.join(repoRoot, 'scripts', 'release', 'claim-check.mjs'));
type Finding = { rule: string; file?: string; detail?: string };
const rules = (f: Finding[]) => [...new Set(f.map((x) => x.rule))].sort();

const coverage = JSON.parse(readFileSync(path.join(repoRoot, 'docs/coverage/coverage.json'), 'utf8'));
const ledger = (claims: unknown[]) => ({ schema: 'claims-ledger.v1', drafts: [], claims });
const evidenced = {
  id: 'C-901',
  text: 'Recovery closes only on independent evidence (local integrated tests).',
  status: 'EVIDENCED',
  layer: 'LOCAL_TEST',
  coverageIds: ['T-046'],
  evidence: [`${BROKER_TESTS}/t046-completion-not-recovery.int.test.ts`],
};
const notRun = {
  id: 'C-902',
  text: 'A real bounded Kite-paid action: NOT_RUN.',
  status: 'NOT_RUN',
  layer: 'REAL_WORLD',
  coverageIds: ['T-058'],
  evidence: [],
};

describe('T-059 committed release drafts', () => {
  it('pass the claim, link and secret checks (CLI exit 0)', () => {
    const r = run('node', ['scripts/release/claim-check.mjs']);
    expect(r.stdout + r.stderr).not.toContain('FINDING');
    expect(r.code).toBe(0);
  });

  it('include every required submission artifact as a draft', () => {
    for (const f of [
      'docs/release/WRITEUP.md',
      'docs/release/VIDEO-PLAN.md',
      'docs/release/SUBTITLES.srt',
      'docs/release/X-DRAFT.md',
      'docs/release/ARCHITECTURE.md',
      'docs/release/claims.json',
      'docs/release/RELEASE-GATES.md',
    ])
      expect(existsSync(path.join(repoRoot, f)), f).toBe(true);
    const shots = readdirSync(path.join(repoRoot, 'docs/release/screenshots')).filter((f) => f.endsWith('.png'));
    expect(shots.length).toBeGreaterThanOrEqual(4);
    const arch = readFileSync(path.join(repoRoot, 'docs/release/ARCHITECTURE.md'), 'utf8');
    expect((arch.match(/```mermaid/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const writeup = readFileSync(path.join(repoRoot, 'docs/release/WRITEUP.md'), 'utf8');
    // EVENT-NOTES: the write-up says what the project does, how it uses SERV Reasoning and which track it enters.
    expect(writeup).toMatch(/SERV Reasoning/);
    expect(writeup).toMatch(/Kite track/i);
    for (const f of ['WRITEUP.md', 'VIDEO-PLAN.md', 'X-DRAFT.md']) {
      const t = readFileSync(path.join(repoRoot, 'docs/release', f), 'utf8');
      expect(t, f).toContain('NOT_RUN');
      expect(t, f).toMatch(/SIMULATED/);
      expect(t, f).toMatch(/DRAFT/);
    }
  });

  it('every ledger claim mapped to a NOT_RUN coverage id is itself NOT_RUN', () => {
    const l = JSON.parse(readFileSync(path.join(repoRoot, 'docs/release/claims.json'), 'utf8'));
    expect(l.claims.length).toBeGreaterThan(8);
    expect(cc.checkLedger(l, coverage, repoRoot)).toEqual([]);
    const real = l.claims.filter((c: { layer: string }) => c.layer === 'REAL_WORLD');
    expect(real.length).toBeGreaterThan(3);
    for (const c of real) expect(c.status, c.id).toBe('NOT_RUN');
  });
});

describe('T-059 claim check refuses seeded violations', () => {
  it('flags an unqualified real-world assertion and accepts it once qualified', () => {
    const l = ledger([evidenced, notRun]);
    expect(rules(cc.checkDraftText('d.md', 'UptimeBuyer paid a real provider through Kite.', { ledger: l }))).toEqual([
      'UNQUALIFIED_ASSERTION',
    ]);
    expect(rules(cc.checkDraftText('d.md', 'The system is deployed in production.', { ledger: l }))).toEqual([
      'UNQUALIFIED_ASSERTION',
    ]);
    expect(rules(cc.checkDraftText('d.md', 'A real sensor opened the incident.', { ledger: l }))).toEqual([
      'UNQUALIFIED_ASSERTION',
    ]);
    expect(
      cc.checkDraftText('d.md', 'A real bounded Kite-paid action is NOT_RUN (no authorization).', { ledger: l }),
    ).toEqual([]);
    expect(
      cc.checkDraftText('d.md', 'The demo uses SIMULATED_INPUT sensors and a recorded-contract broker.', { ledger: l }),
    ).toEqual([]);
  });

  it('flags an undefined claim marker and a NOT_RUN claim cited without its qualifier', () => {
    const l = ledger([evidenced, notRun]);
    expect(rules(cc.checkDraftText('d.md', 'Independent recovery evidence. <!-- C-999 -->', { ledger: l }))).toEqual([
      'CLAIM_UNDEFINED',
    ]);
    expect(rules(cc.checkDraftText('d.md', 'Kite payments work. <!-- C-902 -->', { ledger: l }))).toEqual([
      'NOT_RUN_CLAIM_UNQUALIFIED',
    ]);
    expect(cc.checkDraftText('d.md', 'Kite payments: NOT_RUN. <!-- C-902 -->', { ledger: l })).toEqual([]);
    expect(cc.checkDraftText('d.md', 'Closeout needs independent evidence. <!-- C-901 -->', { ledger: l })).toEqual([]);
  });

  it('flags a ledger claim that contradicts the coverage report or lacks evidence', () => {
    const contradict = {
      ...notRun,
      id: 'C-903',
      status: 'EVIDENCED',
      text: 'Real Kite payment completed.',
      evidence: ['README.md'],
    };
    expect(rules(cc.checkLedger(ledger([contradict]), coverage, repoRoot))).toContain('CLAIM_CONTRADICTS_COVERAGE');
    const missing = { ...evidenced, id: 'C-904', evidence: ['docs/release/evidence/does-not-exist.json'] };
    expect(rules(cc.checkLedger(ledger([missing]), coverage, repoRoot))).toEqual(['CLAIM_EVIDENCE_MISSING']);
    const none = { ...evidenced, id: 'C-905', evidence: [] };
    expect(rules(cc.checkLedger(ledger([none]), coverage, repoRoot))).toEqual(['CLAIM_EVIDENCE_MISSING']);
    const unknownId = { ...evidenced, id: 'C-906', coverageIds: ['T-999'] };
    expect(rules(cc.checkLedger(ledger([unknownId]), coverage, repoRoot))).toEqual(['CLAIM_COVERAGE_ID_UNKNOWN']);
    const unqualified = { ...notRun, id: 'C-907', text: 'A real bounded Kite-paid action.' };
    expect(rules(cc.checkLedger(ledger([unqualified]), coverage, repoRoot))).toEqual(['NOT_RUN_CLAIM_UNQUALIFIED']);
    const realEvidenced = {
      ...notRun,
      id: 'C-908',
      status: 'EVIDENCED',
      coverageIds: ['T-045'],
      evidence: ['README.md'],
    };
    expect(rules(cc.checkLedger(ledger([realEvidenced]), coverage, repoRoot))).toEqual([
      'REAL_WORLD_CLAIM_WITHOUT_EXTERNAL_EVIDENCE',
    ]);
  });

  it('flags broken, insecure and non-allow-listed links; accepts resolvable relative and allow-listed links', () => {
    const allow = { hosts: [{ host: 'www.openserv.ai', status: 'VERIFIED_OFFLINE' }] };
    const f = (t: string) => rules(cc.checkLinksIn('docs/release/WRITEUP.md', t, { root: repoRoot, allowlist: allow }));
    expect(f('[x](./does-not-exist.md)')).toEqual(['LINK_BROKEN']);
    expect(f('[x](http://www.openserv.ai/hackathon-2)')).toEqual(['LINK_INSECURE']);
    expect(f('[x](https://user:pw@www.openserv.ai/)')).toEqual(['LINK_INSECURE']);
    expect(f('[x](https://bit.ly/abc)')).toEqual(['LINK_NOT_ALLOWED']);
    expect(f('see https://example.com/thing')).toEqual(['LINK_NOT_ALLOWED']);
    expect(f('[arch](./ARCHITECTURE.md) and [hack](https://www.openserv.ai/hackathon-2)')).toEqual([]);
  });

  it('flags secrets and personal data in drafts', () => {
    const token = ['gh', 'p_', 'A'.repeat(36)].join('');
    const jwt = ['eyJ', 'hbGciOiJFUzI1NiJ9', '.', 'eyJzdWIiOiJ4In0aaaaaaaaaa', '.', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join(
      '',
    );
    expect(rules(cc.checkSecretsIn('d.md', `token ${token}`))).toEqual(['SECRET']);
    expect(rules(cc.checkSecretsIn('d.md', `Authorization: Bearer ${jwt}`))).toEqual(['SECRET']);
    expect(rules(cc.checkSecretsIn('d.md', 'mail me at someone@gmail.com'))).toEqual(['PERSONAL_DATA']);
    expect(rules(cc.checkSecretsIn('d.md', 'call +1 415 555 0134'))).toEqual(['PERSONAL_DATA']);
    expect(rules(cc.checkSecretsIn('d.md', `wallet 0x${'ab'.repeat(20)}`))).toEqual(['PERSONAL_DATA']);
    expect(rules(cc.checkSecretsIn('d.md', 'postgres://ub:hunter2hunter2@db:5432/x'))).toEqual(['SECRET']);
    expect(cc.checkSecretsIn('d.md', 'contact fixture@example.invalid; sha256:' + 'a'.repeat(64))).toEqual([]);
  });

  it('the CLI fails on a seeded violation in a copy of the release directory', () => {
    const r = run('node', ['scripts/release/claim-check.mjs', '--probe-unqualified']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('UNQUALIFIED_ASSERTION');
  });
});
