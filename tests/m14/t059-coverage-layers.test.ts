// T-059 / NFR-12 (M14) coverage layers. The M13 coverage report gives each id one status; M14 adds the evidence layer
// it was earned at. A test whose canonical proof needs external evidence (T-057..T-060: a hosted deployment, real
// inputs, published artifacts, authorized external actions) can never read PASS from local runs alone: its status is
// the worse of its local result and NOT_RUN, and `localStatus` reports what the local layer proved. A local failure
// still surfaces as FAIL.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const gen = await import(path.join(repoRoot, 'scripts', 'coverage-report.mjs'));
const vitestReport = (files: Record<string, 'passed' | 'failed'>) => ({
  testResults: Object.entries(files).map(([name, status]) => ({
    name: path.join(repoRoot, name),
    status,
    assertionResults: [{ status }],
  })),
});
const entry = (report: { entries: { id: string }[] }, id: string) =>
  report.entries.find((e) => e.id === id) as unknown as {
    status: string;
    localStatus: string;
    externalEvidence: string;
  };

describe('T-059 coverage layers', () => {
  it('a passing local T-058 test leaves T-058 NOT_RUN with localStatus PASS', () => {
    const r = gen.buildCoverage({
      root: repoRoot,
      commit: 'abcdef0',
      results: [
        vitestReport({
          'tests/m14/t058-journey-gate.test.ts': 'passed',
          'apps/kite-broker/test/t058-journey-gate-db.int.test.ts': 'passed',
        }),
      ],
    });
    const t = entry(r, 'T-058');
    expect(t.localStatus).toBe('PASS');
    expect(t.status).toBe('NOT_RUN');
    expect(t.externalEvidence).toBe('NOT_RUN');
  });

  it('a failing local test still surfaces as FAIL', () => {
    const r = gen.buildCoverage({
      root: repoRoot,
      commit: 'abcdef0',
      results: [vitestReport({ 'tests/m14/t060-release-gates.test.ts': 'failed' })],
    });
    expect(entry(r, 'T-060').status).toBe('FAIL');
  });

  it('ids that need no external evidence keep their local status, and every entry carries localStatus', () => {
    const r = gen.buildCoverage({
      root: repoRoot,
      commit: 'abcdef0',
      results: [vitestReport({ 'tests/m00/t003-secret-scan.test.ts': 'passed' })],
    });
    expect(entry(r, 'T-003').status).toBe('PASS');
    for (const e of r.entries as { id: string; localStatus?: string }[])
      expect(['PASS', 'FAIL', 'NOT_RUN', 'UNKNOWN', 'UNSUPPORTED'], e.id).toContain(e.localStatus);
    expect(gen.renderMarkdown(r)).toMatch(/\| Local status \|/);
  });
});
