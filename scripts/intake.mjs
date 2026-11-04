#!/usr/bin/env node
// Read-only repository intake. Never resets, checks out, stashes, amends or deletes anything.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function git(repo, args, { keepLeading = false } = {}) {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Porcelain status lines start with a significant space (" M file"); only trim the trailing newline there.
    return keepLeading ? out.replace(/\n+$/, '') : out.trim();
  } catch {
    return null;
  }
}
const redact = (url) => (url ? url.replace(/\/\/[^@/]+@/, '//<redacted>@') : url);

export function intake(repo = process.cwd()) {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  if (!root) return { repo: path.resolve(repo), isGitRepository: false };
  const status = (git(root, ['status', '--porcelain=v1', '--untracked-files=all'], { keepLeading: true }) ?? '')
    .split('\n')
    .filter(Boolean);
  const modified = [];
  const untracked = [];
  for (const line of status) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked.push(file);
    else modified.push({ code: code.trim(), file });
  }
  const remotes = (git(root, ['remote', '-v']) ?? '')
    .split('\n')
    .filter((l) => l.endsWith('(fetch)'))
    .map((l) => {
      const [name, url] = l.split(/\s+/);
      return { name, url: redact(url) };
    });
  const worktrees = (git(root, ['worktree', 'list', '--porcelain']) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
  return {
    repo: root,
    isGitRepository: true,
    branch: git(root, ['branch', '--show-current']) || null,
    head: git(root, ['rev-parse', 'HEAD']),
    upstream: git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    remotes,
    worktrees,
    dirty: modified.length > 0 || untracked.length > 0,
    modified,
    untracked,
    toolchain: { node: process.version },
    destructiveActionsPerformed: [],
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('intake.mjs')) {
  const idx = process.argv.indexOf('--repo');
  const report = intake(idx > -1 ? process.argv[idx + 1] : process.cwd());
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
