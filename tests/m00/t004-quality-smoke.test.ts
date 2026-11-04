// T-004 — Canonical quality-command smoke: every canonical command exists and returns nonzero on a seeded defect.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from './helpers.js';

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const scratch = mkdtempSync(path.join(repoRoot, 'tmp-t004-'));
const bin = (n: string) => path.join(repoRoot, 'node_modules', '.bin', n);

describe('T-004 canonical quality commands', () => {
  it('defines lint, format, typecheck, unit, integration, build and pack/contract commands', () => {
    for (const s of ['lint', 'format:check', 'typecheck', 'test', 'test:integration', 'build', 'check:pack'])
      expect(pkg.scripts[s]).toBeTruthy();
  });

  it('eslint fails on a seeded defect', () => {
    const f = path.join(scratch, 'bad-lint.ts');
    writeFileSync(f, 'export function f(a: any) { if (a == 1) { return 1 } }\n');
    expect(run(bin('eslint'), ['--no-ignore', f]).code).not.toBe(0);
  });

  it('prettier check fails on a seeded defect', () => {
    const f = path.join(scratch, 'bad-format.ts');
    writeFileSync(f, 'export   const x={a:1}\n');
    expect(run(bin('prettier'), ['--check', '--ignore-path', path.join(scratch, 'none'), f]).code).not.toBe(0);
  });

  it('typecheck fails on a seeded defect', () => {
    writeFileSync(path.join(scratch, 'bad-type.ts'), 'export const n: number = "nope";\n');
    writeFileSync(
      path.join(scratch, 'tsconfig.json'),
      JSON.stringify({
        extends: '../tsconfig.base.json',
        compilerOptions: { noEmit: true, composite: false, declaration: false, declarationMap: false },
        include: ['bad-type.ts'],
      }),
    );
    expect(run(bin('tsc'), ['-p', path.join(scratch, 'tsconfig.json')]).code).not.toBe(0);
  });

  it('vitest returns nonzero for a failing test', () => {
    writeFileSync(
      path.join(scratch, 'failing.spec.mjs'),
      "import {it,expect} from 'vitest'; it('x',()=>expect(1).toBe(2));\n",
    );
    expect(run(bin('vitest'), ['run', '--root', scratch, '--config', 'false']).code).not.toBe(0);
  });

  it('pack checker fails on a broken pack', () => {
    expect(run('node', ['docs/spec/scripts/check-build-pack.mjs', '--root', scratch]).code).not.toBe(0);
  });
});
