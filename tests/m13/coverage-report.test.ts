// M13 traceability (NFR-12) — the committed coverage report maps every canonical FR/NFR/INV/test ID in
// requirements.json to code and test evidence with an honest status (PASS, FAIL, NOT_RUN, UNKNOWN, UNSUPPORTED). This
// test fails when a canonical ID is missing from the report, when a status is outside the vocabulary, when a test's
// owning module disagrees with the registry, or when real-world evidence is claimed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const STATUSES = ['PASS', 'FAIL', 'NOT_RUN', 'UNKNOWN', 'UNSUPPORTED'];
const registry = JSON.parse(readFileSync(path.join(repoRoot, 'docs/spec/requirements.json'), 'utf8'));
const report = JSON.parse(readFileSync(path.join(repoRoot, 'docs/coverage/coverage.json'), 'utf8'));
const markdown = readFileSync(path.join(repoRoot, 'docs/coverage/COVERAGE.md'), 'utf8');
const gen = await import(path.join(repoRoot, 'scripts', 'coverage-report.mjs'));

const canonicalIds = (): string[] => [
  ...registry.definitions.functional.map((d: { id: string }) => d.id),
  ...registry.definitions.nonfunctional.map((d: { id: string }) => d.id),
  ...registry.definitions.invariants.map((d: { id: string }) => d.id),
  ...registry.tests.map((t: { id: string }) => t.id),
];

describe('M13 requirement/invariant/test coverage report', () => {
  it('contains every canonical ID exactly once, in JSON and Markdown', () => {
    const ids = canonicalIds();
    expect(ids.length).toBeGreaterThan(90);
    const entries = report.entries as { id: string }[];
    const seen = entries.map((e) => e.id);
    expect(new Set(seen).size).toBe(seen.length);
    const missing = ids.filter((id) => !seen.includes(id));
    expect(missing).toEqual([]);
    for (const id of ids) expect(markdown, id).toMatch(new RegExp(`\\|\\s*${id}\\s*\\|`));
  });

  it('uses only the honest status vocabulary and never claims real-world evidence', () => {
    for (const e of report.entries as { id: string; status: string; externalEvidence: string }[]) {
      expect(STATUSES, e.id).toContain(e.status);
      expect(['NOT_RUN', 'NOT_APPLICABLE'], e.id).toContain(e.externalEvidence);
    }
    expect(report.generatedFrom.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(STATUSES).toEqual(report.statusVocabulary);
  });

  it('agrees with the registry on test ownership and marks unbuilt M14 tests NOT_RUN', () => {
    const byId = new Map((report.entries as { id: string; module?: string; status: string }[]).map((e) => [e.id, e]));
    for (const m of registry.modules as { id: string; tests: string[] }[])
      for (const t of m.tests) expect(byId.get(t)?.module, t).toBe(m.id);
    for (const t of ['T-057', 'T-058', 'T-059', 'T-060']) expect(byId.get(t)?.status).toBe('NOT_RUN');
    for (const t of ['T-053', 'T-054', 'T-055', 'T-056'])
      expect((byId.get(t) as { testRefs?: string[] }).testRefs?.length, t).toBeGreaterThan(0);
  });

  it('the generator includes every canonical ID even with no test results at all', () => {
    const fresh = gen.buildCoverage({ root: repoRoot, results: [], commit: '0000000' });
    const ids = fresh.entries.map((e: { id: string }) => e.id);
    expect(canonicalIds().filter((id) => !ids.includes(id))).toEqual([]);
    for (const e of fresh.entries as { id: string; status: string }[])
      if (/^T-/.test(e.id)) expect(['NOT_RUN', 'UNKNOWN'], e.id).toContain(e.status);
  });
});
