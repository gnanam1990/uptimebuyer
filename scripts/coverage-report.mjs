#!/usr/bin/env node
// Requirement / invariant / test coverage report (M13; NFR-12). Maps every canonical FR, NFR, INV and T id in
// docs/spec/requirements.json to code and test evidence in this repository with an honest status:
//   PASS        every test file mapped to the test id ran and passed in the supplied results;
//   FAIL        at least one mapped test failed;
//   UNKNOWN     test files exist but the supplied results do not show them all passing (not run, skipped, absent);
//   NOT_RUN     no executable test exists for the id (for example M14 deployment/demo/release tests);
//   UNSUPPORTED reserved for capabilities proven unavailable (none are claimed here).
// A requirement or invariant takes the worst status of the tests of every module that owns it. `externalEvidence`
// is NOT_RUN wherever the claim needs real-world proof (real sensor, provider, payment, IdP, deployment, physical
// recovery): local tests never upgrade that. M14 adds `localStatus`, the status earned at the local layer: a test whose
// canonical proof needs external evidence (T-057..T-060) reads `status` = the worse of its local result and NOT_RUN,
// so local runs alone never make it PASS, while a local failure still surfaces as FAIL. Inputs are vitest/Playwright JSON reports; nothing leaves the machine.
//   node scripts/coverage-report.mjs --results unit.json --results integration.json --results e2e.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATUS_VOCABULARY = ['PASS', 'FAIL', 'NOT_RUN', 'UNKNOWN', 'UNSUPPORTED'];
const SEVERITY = { PASS: 0, UNSUPPORTED: 1, NOT_RUN: 2, UNKNOWN: 3, FAIL: 4 };

// Claims whose truth needs evidence outside this repository's local test runs.
const REAL_WORLD = new Set([
  'FR-02',
  'FR-07',
  'FR-08',
  'FR-11',
  'FR-12',
  'FR-13',
  'FR-14',
  'FR-15',
  'FR-17',
  'FR-20',
  'FR-22',
  'NFR-06',
  'NFR-08',
  'NFR-11',
  'INV-01',
  'INV-06',
  'T-057',
  'T-058',
  'T-059',
  'T-060',
]);
const SKIP = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.git']);

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

const isTest = (f) => /\.(test|spec)\.ts$/.test(f) || /\.int\.test\.ts$/.test(f);
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

function testFiles(root) {
  const dirs = ['packages', 'apps', 'edge', 'tests'].map((d) => path.join(root, d));
  return dirs.flatMap((d) =>
    walk(
      d,
      (f) =>
        (isTest(f) && /(\/test\/|\/e2e\/|^tests\/|\/tests\/)/.test(rel(root, f))) ||
        (isTest(f) && rel(root, f).startsWith('tests/')),
    ),
  );
}
function sourceFiles(root) {
  const out = [];
  for (const d of ['packages', 'apps', 'edge'])
    out.push(...walk(path.join(root, d), (f) => /\/src\/.*\.(ts|tsx|json)$/.test(rel(root, f))));
  out.push(...walk(path.join(root, 'packages', 'data', 'migrations'), (f) => f.endsWith('.sql')));
  out.push(...walk(path.join(root, 'scripts'), (f) => f.endsWith('.mjs')));
  out.push(...walk(path.join(root, 'config'), (f) => f.endsWith('.json')));
  return out;
}

/** Test ids a test file proves: tNNN tokens in its name and T-NNN ids in describe titles. */
function testIdsOf(file, text) {
  const ids = new Set();
  for (const m of path.basename(file).matchAll(/(?:^|-)t(\d{3})(?=-|\.)/g)) ids.add(`T-${m[1]}`);
  for (const m of text.matchAll(/describe(?:\.each\([^)]*\))?\(\s*[`'"]([^`'"]*)/g))
    for (const t of m[1].matchAll(/\bT-(\d{3})\b/g)) ids.add(`T-${t[1]}`);
  return [...ids];
}

/** Per-file outcomes from vitest JSON and Playwright JSON reports. */
export function parseResults(root, reports) {
  const files = new Map();
  const bump = (abs, status) => {
    const key = path.isAbsolute(abs) ? rel(root, abs) : abs.split(path.sep).join('/');
    const e = files.get(key) ?? { passed: 0, failed: 0, other: 0 };
    if (status === 'passed' || status === 'expected') e.passed++;
    else if (status === 'failed' || status === 'unexpected' || status === 'timedOut') e.failed++;
    else e.other++;
    files.set(key, e);
  };
  for (const r of reports) {
    if (Array.isArray(r.testResults))
      for (const f of r.testResults) {
        if (!f.assertionResults?.length && f.status === 'failed') bump(f.name, 'failed');
        for (const a of f.assertionResults ?? []) bump(f.name, a.status);
      }
    if (Array.isArray(r.suites)) {
      const visit = (s, file) => {
        const fileName = s.file ?? file;
        for (const spec of s.specs ?? [])
          for (const t of spec.tests ?? [])
            bump(path.join(r.config?.rootDir ?? root, spec.file ?? fileName), t.status ?? t.results?.at(-1)?.status);
        for (const c of s.suites ?? []) visit(c, fileName);
      };
      for (const s of r.suites) visit(s, s.file);
    }
  }
  return files;
}

const worst = (statuses) => statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'PASS');

export function buildCoverage({ root = repo, results = [], commit }) {
  const registry = JSON.parse(readFileSync(path.join(root, 'docs', 'spec', 'requirements.json'), 'utf8'));
  const outcomes = parseResults(root, results);
  const tests = testFiles(root).map((f) => {
    const text = readFileSync(f, 'utf8');
    return { file: rel(root, f), text, ids: testIdsOf(f, text) };
  });
  const sources = sourceFiles(root).map((f) => ({ file: rel(root, f), text: readFileSync(f, 'utf8') }));
  const ownerOf = new Map();
  for (const m of registry.modules) for (const t of m.tests) ownerOf.set(t, m.id);
  const modulesOwning = (id) =>
    registry.modules
      .filter((m) => [...m.requirements, ...m.nonfunctional, ...m.invariants].includes(id))
      .map((m) => m.id);

  const testEntry = (t) => {
    const files = tests.filter((x) => x.ids.includes(t.id)).map((x) => x.file);
    let localStatus;
    if (files.length === 0) localStatus = 'NOT_RUN';
    else {
      const o = files.map((f) => outcomes.get(f));
      if (o.some((x) => x && x.failed > 0)) localStatus = 'FAIL';
      else if (o.every((x) => x && x.passed > 0)) localStatus = 'PASS';
      else localStatus = 'UNKNOWN';
    }
    const status = REAL_WORLD.has(t.id) ? worst([localStatus, 'NOT_RUN']) : localStatus;
    const passed = files.reduce((n, f) => n + (outcomes.get(f)?.passed ?? 0), 0);
    const failed = files.reduce((n, f) => n + (outcomes.get(f)?.failed ?? 0), 0);
    return {
      id: t.id,
      kind: 'TEST',
      title: t.title,
      module: ownerOf.get(t.id) ?? null,
      status,
      localStatus,
      externalEvidence: REAL_WORLD.has(t.id) ? 'NOT_RUN' : 'NOT_APPLICABLE',
      testRefs: files,
      codeRefs: [],
      results: { passed, failed },
    };
  };
  const testEntries = registry.tests.map(testEntry);
  const byTest = new Map(testEntries.map((e) => [e.id, e]));
  const idRe = (id) => new RegExp(`\\b${id}\\b`);
  const defEntry = (kind) => (d) => {
    const owners = modulesOwning(d.id);
    const ownedTests = registry.modules.filter((m) => owners.includes(m.id)).flatMap((m) => m.tests);
    const status = ownedTests.length ? worst(ownedTests.map((t) => byTest.get(t)?.status ?? 'NOT_RUN')) : 'UNKNOWN';
    const localStatus = ownedTests.length
      ? worst(ownedTests.map((t) => byTest.get(t)?.localStatus ?? 'NOT_RUN'))
      : 'UNKNOWN';
    return {
      id: d.id,
      kind,
      title: d.title,
      modules: owners,
      status,
      localStatus,
      externalEvidence: REAL_WORLD.has(d.id) ? 'NOT_RUN' : 'NOT_APPLICABLE',
      codeRefs: sources
        .filter((s) => idRe(d.id).test(s.text))
        .map((s) => s.file)
        .slice(0, 12),
      testRefs: tests
        .filter((x) => idRe(d.id).test(x.text))
        .map((x) => x.file)
        .slice(0, 12),
      governingTests: ownedTests,
    };
  };
  const entries = [
    ...registry.definitions.functional.map(defEntry('FR')),
    ...registry.definitions.nonfunctional.map(defEntry('NFR')),
    ...registry.definitions.invariants.map(defEntry('INV')),
    ...testEntries,
  ];
  const counts = Object.fromEntries(STATUS_VOCABULARY.map((s) => [s, entries.filter((e) => e.status === s).length]));
  return {
    schema: 'coverage-report.v1',
    generatedFrom: { commit, resultFiles: results.length, testFilesWithResults: outcomes.size },
    statusVocabulary: STATUS_VOCABULARY,
    truth:
      'Local automated evidence only. PASS means the mapped tests passed on this commit against local fakes, recorded contracts, simulated sensors and a throwaway database; externalEvidence NOT_RUN marks every claim that still needs real-world proof.',
    counts,
    entries,
  };
}

export function renderMarkdown(report) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [
    '# Requirement, invariant and test coverage',
    '',
    `Generated by \`scripts/coverage-report.mjs\` from commit \`${report.generatedFrom.commit}\` (${report.generatedFrom.resultFiles} result files, ${report.generatedFrom.testFilesWithResults} test files with results).`,
    '',
    report.truth,
    '',
    `Statuses: ${report.statusVocabulary.map((s) => `${s} ${report.counts[s]}`).join(', ')}.`,
    '',
    '| ID | Kind | Title | Owner | Status | Local status | External evidence | Tests | Code |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of report.entries) {
    const owner = e.kind === 'TEST' ? (e.module ?? '-') : e.modules.join(', ') || '-';
    const testsCol =
      e.kind === 'TEST'
        ? `${e.testRefs.length} files (${e.results.passed} passed, ${e.results.failed} failed)`
        : `${e.testRefs.length} files; governed by ${e.governingTests.join(', ') || '-'}`;
    lines.push(
      `| ${e.id} | ${e.kind} | ${esc(e.title)} | ${owner} | ${e.status} | ${e.localStatus} | ${e.externalEvidence} | ${esc(testsCol)} | ${e.codeRefs.length} files |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const results = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === '--results') results.push(JSON.parse(readFileSync(args[++i], 'utf8')));
  const ci = args.indexOf('--commit');
  const commit =
    ci >= 0
      ? args[ci + 1]
      : execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const report = buildCoverage({ root: repo, results, commit });
  const out = path.join(repo, 'docs', 'coverage');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'coverage.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'COVERAGE.md'), renderMarkdown(report));
  console.log(JSON.stringify(report.counts));
}
