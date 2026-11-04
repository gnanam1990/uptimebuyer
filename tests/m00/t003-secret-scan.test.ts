// T-003 — Secret baseline and history scan. Synthetic secrets are assembled at runtime so none is committed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run, tempGitRepo, write } from './helpers.js';

const fakeGithub = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const fakeAws = 'AKIA' + 'Z7Y6X5W4V3U2T1S0';
const fakeGeneric = 'kite' + '_token = "' + 'q'.repeat(12) + 'Z9z8Y7x6W5v4' + '"';
const scan = (dir: string, history = true) =>
  run('node', [path.join(repoRoot, 'scripts/secret-scan.mjs'), '--repo', dir, ...(history ? ['--history'] : [])]);

describe('T-003 secret scan', () => {
  it('detects synthetic secrets in tracked, untracked, build and history surfaces without echoing them', () => {
    const dir = tempGitRepo();
    write(dir, 'config.ts', `export const t = '${fakeGithub}';\n`);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'leak']);
    write(dir, 'config.ts', 'export const t = process.env.T;\n');
    execFileSync('git', ['-C', dir, 'commit', '-q', '-am', 'remove leak']);
    write(dir, 'scratch.env.txt', `${fakeGeneric}\n`);
    write(dir, 'packages/x/dist/bundle.js', `var k="${fakeAws}";`);

    const r = scan(dir);
    expect(r.code).toBe(1);
    const { findings } = JSON.parse(r.stdout);
    const surfaces = new Set(findings.map((f: { surface: string }) => f.surface));
    expect(surfaces).toEqual(new Set(['history', 'untracked', 'build']));
    expect(r.stdout).not.toContain(fakeGithub);
    expect(r.stdout).not.toContain(fakeAws);
  });

  it('finds secrets introduced inside a merge commit and in commit messages', () => {
    const dir = tempGitRepo();
    const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    g('switch', '-q', '-c', 'side');
    write(dir, 'side.txt', 'side\n');
    g('add', '.');
    g('commit', '-q', '-m', 'side');
    g('switch', '-q', 'main');
    write(dir, 'main.txt', 'main\n');
    g('add', '.');
    g('commit', '-q', '-m', 'main');
    g('merge', '--no-ff', '--no-commit', 'side');
    write(dir, 'merge-only.txt', `${fakeAws}\n`);
    g('add', '.');
    g('commit', '-q', '-m', 'merge');
    g('rm', '-q', 'merge-only.txt');
    g('commit', '-q', '-m', `cleanup ${fakeGithub}`);
    const r = scan(dir);
    expect(r.code).toBe(1);
    const { findings } = JSON.parse(r.stdout);
    expect(findings.some((f: { path: string }) => f.path === 'merge-only.txt')).toBe(true);
    expect(findings.some((f: { path: string }) => f.path === '<commit-message>')).toBe(true);
  });

  it('allowlists only an exact path plus fingerprint', () => {
    const dir = tempGitRepo();
    write(dir, 'docs/example.md', `${fakeGeneric}\n`);
    const value = 'q'.repeat(12) + 'Z9z8Y7x6W5v4';
    const fp = createHash('sha256').update(value).digest('hex').slice(0, 16);
    write(dir, '.secretscan-allow.json', JSON.stringify([{ path: 'docs/example.md', fingerprint: fp }]));
    expect(scan(dir, false).code).toBe(0);
    write(dir, 'docs/other.md', `${fakeGeneric}\n`);
    expect(scan(dir, false).code).toBe(1);
  });

  it('passes on this repository, including its history', () => {
    expect(scan(repoRoot).code).toBe(0);
  });
});
