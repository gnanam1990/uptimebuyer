// T-002 — Dirty worktree intake stop.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run, tempGitRepo, write } from './helpers.js';

describe('T-002 dirty worktree intake', () => {
  it('records modified and untracked user files and changes nothing', () => {
    const dir = tempGitRepo();
    write(dir, 'tracked.txt', 'user edit\n');
    write(dir, 'notes/untracked.md', 'user draft\n');
    const before = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    const headBefore = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    const r = run('node', [path.join(repoRoot, 'scripts/intake.mjs'), '--repo', dir]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.dirty).toBe(true);
    expect(report.modified).toEqual([{ code: 'M', file: 'tracked.txt' }]);
    expect(report.untracked).toEqual(['notes/untracked.md']);
    expect(report.destructiveActionsPerformed).toEqual([]);

    expect(
      execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }),
    ).toBe(before);
    expect(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(headBefore);
    expect(readFileSync(path.join(dir, 'tracked.txt'), 'utf8')).toBe('user edit\n');
    expect(execFileSync('git', ['-C', dir, 'stash', 'list'], { encoding: 'utf8' })).toBe('');
  });

  it('contains no destructive git subcommand', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/intake.mjs'), 'utf8');
    for (const verb of ["'reset'", "'checkout'", "'stash'", "'clean'", "'restore'", '--amend', "'rebase'", "'push'"])
      expect(src).not.toContain(verb);
  });
});
