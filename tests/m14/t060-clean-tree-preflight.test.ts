// T-060 clean-tree preflight (PR #26 review): RELEASE_TAG and REPO_PUBLICATION need a clean tree, but signing writes the
// authorization record into evidence/authorizations/ before the gate check. The preflight therefore tolerates exactly
// one untracked file, the record being used, and nothing else: any other untracked, modified, staged or deleted path,
// or another gate's record, keeps the tree dirty. It can also require HEAD to be the commit being released.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run, tempGitRepo } from '../m00/helpers.js';

const ct = await import(path.join(repoRoot, 'scripts', 'release', 'preflight-clean-tree.mjs'));
const RECORD = 'evidence/authorizations/RELEASE_TAG.auth-release-tag-20261114-abc123.json';
const z = (...entries: string[]) => entries.map((e) => `${e}\0`).join('');

describe('T-060 clean-tree preflight: porcelain status', () => {
  it('is clean with no changes, or with only the untracked record being used', () => {
    expect(ct.cleanTreeFromStatus('', {})).toEqual({ clean: true, offending: [] });
    expect(ct.cleanTreeFromStatus(z(`?? ${RECORD}`), { allowRecord: RECORD })).toEqual({ clean: true, offending: [] });
  });

  it('stays dirty for anything else, including the record without --allow-record or in another state', () => {
    expect(ct.cleanTreeFromStatus(z(`?? ${RECORD}`), {}).clean).toBe(false);
    expect(ct.cleanTreeFromStatus(z(`?? ${RECORD}`, '?? notes.txt'), { allowRecord: RECORD })).toEqual({
      clean: false,
      offending: ['?? notes.txt'],
    });
    for (const line of [
      ' M README.md',
      'M  README.md',
      ' D LICENSE',
      `A  ${RECORD}`,
      `?? evidence/authorizations/X_POST.auth-x-post-20261114-abc123.json`,
    ])
      expect(ct.cleanTreeFromStatus(z(line), { allowRecord: RECORD }).clean, line).toBe(false);
    // A rename carries a second path entry; both stay offending.
    expect(ct.cleanTreeFromStatus(z('R  new.md', 'old.md'), { allowRecord: RECORD }).offending).toEqual([
      'R  new.md <- old.md',
    ]);
  });

  it('allows only an authorization record path, never an arbitrary file', () => {
    for (const bad of [
      'README.md',
      'evidence/authorizations/consumed.json',
      'evidence/authorizations/../x.json',
      '/abs/RELEASE_TAG.a.json',
    ])
      expect(() => ct.cleanTreeFromStatus('', { allowRecord: bad }), bad).toThrow(/allow-record/);
  });
});

describe('T-060 clean-tree preflight: command line in a throwaway repository', () => {
  const script = path.join(repoRoot, 'scripts', 'release', 'preflight-clean-tree.mjs');
  const cli = (dir: string, args: string[]) => run('node', [script, '--repo', dir, ...args], dir);

  it('passes after signing (only the record is new) and at the released commit; fails on any other change', () => {
    const dir = tempGitRepo();
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(path.join(dir, 'evidence', 'authorizations'), { recursive: true });
    writeFileSync(path.join(dir, RECORD), '{}\n');
    const ok = cli(dir, ['--allow-record', RECORD, '--source-sha', head]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ 'clean-tree': true, head, offending: [] });
    const strict = cli(dir, []);
    expect(strict.code).toBe(1);
    expect(JSON.parse(strict.stdout)['clean-tree']).toBe(false);
    const wrongCommit = cli(dir, ['--allow-record', RECORD, '--source-sha', 'f'.repeat(40)]);
    expect(wrongCommit.code).toBe(1);
    expect(JSON.parse(wrongCommit.stdout)).toMatchObject({ 'clean-tree': false, reason: 'HEAD_IS_NOT_SOURCE' });
    writeFileSync(path.join(dir, 'tracked.txt'), 'changed\n');
    const dirty = cli(dir, ['--allow-record', RECORD, '--source-sha', head]);
    expect(dirty.code).toBe(1);
    expect(JSON.parse(dirty.stdout).offending).toEqual([' M tracked.txt']);
  });
});

describe('T-060 GATE-REQUESTS.md clean-tree step', () => {
  it('computes clean-tree with the preflight script, tolerating only the record being used', () => {
    const guide = readFileSync(path.join(repoRoot, 'docs/release/GATE-REQUESTS.md'), 'utf8');
    const section = guide.slice(guide.indexOf('## 1. RELEASE_TAG'), guide.indexOf('## 2. VIDEO_UPLOAD'));
    expect(section).toContain(
      'node scripts/release/preflight-clean-tree.mjs --source-sha "$SOURCE" --allow-record "evidence/authorizations/RELEASE_TAG.$AUTH_ID.json"',
    );
    expect(section).not.toMatch(/git status --short` empty/);
  });
});
