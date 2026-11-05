// T-046 / INV-01 / INV-14 structural proof: RECOVERED is reachable only through M04's NON-EXPORTED recovery hook, and
// the only production caller of that hook is M11's sanctioned closeout (packages/recovery/src/closeout.ts), which
// passes its own module-private evaluator. The scan covers every TypeScript source in the workspace: nobody else
// imports the hook module, names the hook, hands RECOVERED to the transition helper, or writes the state in SQL; the
// packages export neither the hook nor any evaluator-accepting entry point, and the lint boundary names the hook.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as incidentsApi from '@uptimebuyer/incidents';
import * as recoveryApi from '../src/index.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
const HOOK = path.join(root, 'packages', 'incidents', 'src', 'recovery.ts');
const SANCTIONED = 'packages/recovery/src/closeout.ts';
const SELF = rel(path.join(import.meta.dirname, 't046-recovered-reachability.test.ts'));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.') || name.startsWith('tmp')) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.(ts|mts|cts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const ALL = ['packages', 'apps', 'edge', 'tests', 'scripts']
  .map((d) => path.join(root, d))
  .flatMap((d) => {
    try {
      return sources(d);
    } catch {
      return [];
    }
  });
const text = new Map(ALL.map((f) => [f, readFileSync(f, 'utf8')]));

/** M04's own source and its tests (the test-only fake evaluator) are the hook's home; M11's closeout is its one caller. */
const mayTouchHook = (file: string) =>
  rel(file).startsWith('packages/incidents/src/') ||
  rel(file).startsWith('packages/incidents/test/') ||
  rel(file) === SANCTIONED ||
  rel(file) === SELF;

function importsOf(file: string): string[] {
  const src = text.get(file)!;
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  return specs.filter((s) => s.startsWith('.')).map((s) => path.resolve(path.dirname(file), s.replace(/\.js$/, '.ts')));
}

describe('T-046 RECOVERED is reachable only through the sanctioned M11 closeout (structural)', () => {
  it('scans a non-trivial workspace', () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(text.has(HOOK)).toBe(true);
    expect(text.has(path.join(root, SANCTIONED))).toBe(true);
  });

  it('only M04 itself, its tests and the sanctioned closeout import the hook module', () => {
    const importers = ALL.filter((f) => importsOf(f).includes(HOOK)).map(rel);
    expect(importers.filter((f) => !mayTouchHook(path.join(root, f)))).toEqual([]);
    expect(importers).toContain(SANCTIONED);
    // Production code outside M04: exactly the one sanctioned importer.
    expect(importers.filter((f) => !f.startsWith('packages/incidents/'))).toEqual([SANCTIONED]);
  });

  it('nobody else names the hook, passes RECOVERED to the transition helper or writes it in SQL', () => {
    const naming = ALL.filter((f) => text.get(f)!.includes('recoverIncidentWithEvaluation')).filter(
      (f) => !mayTouchHook(f),
    );
    expect(naming.map(rel)).toEqual([]);

    const literalTarget = /transitionRow\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*'RECOVERED'/;
    expect(ALL.filter((f) => literalTarget.test(text.get(f)!)).map(rel)).toEqual([
      'packages/incidents/src/recovery.ts',
    ]);

    const sqlWrite = /UPDATE\s+incidents\b[^`]*?\bstate\s*=\s*'RECOVERED'/is;
    expect(ALL.filter((f) => sqlWrite.test(text.get(f)!)).map(rel)).toEqual([]);
    const sqlInsert = /INSERT\s+INTO\s+incident_transitions\b[^`]*?'RECOVERED'/is;
    expect(ALL.filter((f) => sqlInsert.test(text.get(f)!)).map(rel)).toEqual([]);

    const recoveredStamp = /recovered_at\s*=\s*clock_timestamp\(\)/;
    expect(
      ALL.filter((f) => recoveredStamp.test(text.get(f)!))
        .map(rel)
        .filter((f) => !f.startsWith('packages/incidents/src/')),
    ).toEqual([]);
  });

  it('neither package exports the hook or an evaluator-accepting recovery entry point', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages', 'incidents', 'package.json'), 'utf8'));
    expect(Object.keys(pkg.exports)).toEqual(['.']);
    const index = readFileSync(path.join(root, 'packages', 'incidents', 'src', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/recovery\.js/);
    expect(Object.keys(incidentsApi)).not.toContain('recoverIncidentWithEvaluation');

    const recoveryKeys = Object.keys(recoveryApi);
    for (const k of ['recoverIncidentWithEvaluation', 'closeoutEvaluator', 'recoveryEvaluator', 'closeIncident'])
      expect(recoveryKeys).not.toContain(k);
    const closeout = readFileSync(path.join(root, SANCTIONED), 'utf8');
    // The evaluator handed to the hook is module-private and the hook is called exactly once.
    expect(closeout.match(/recoverIncidentWithEvaluation\(/g)).toHaveLength(1);
    expect(closeout).not.toMatch(/export\s+(const|function|class|let)\s+\w*[Ee]valuator/);
    const rpkg = JSON.parse(readFileSync(path.join(root, 'packages', 'recovery', 'package.json'), 'utf8'));
    expect(Object.keys(rpkg.exports)).toEqual(['.']);
  });

  it('the lint boundary forbids importing the hook module outside M04 and the sanctioned closeout', () => {
    const eslint = readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8');
    expect(eslint).toContain('**/incidents/src/recovery');
    expect(eslint).toContain(SANCTIONED);
  });
});
