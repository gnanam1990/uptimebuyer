#!/usr/bin/env node
// Secret scanner for tracked, untracked, build-output and history surfaces. Reports redacted fingerprints only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const PATTERNS = [
  { id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g },
  { id: 'slack-token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  {
    id: 'generic-assigned-secret',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|kite[_-]?(?:key|token|credential))\b["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/gi,
  },
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);
const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function loadAllowlist(repo) {
  const file = path.join(repo, '.secretscan-allow.json');
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8'));
  // Narrow allowlist: each entry must name both an exact path and an exact fingerprint.
  return list.filter((e) => typeof e.path === 'string' && typeof e.fingerprint === 'string');
}

export function scanText(text, where, allow) {
  const findings = [];
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0];
      const fp = fingerprint(value);
      if (allow.some((a) => a.path === where.path && a.fingerprint === fp)) continue;
      findings.push({ rule: id, ...where, fingerprint: fp, preview: `${value.slice(0, 4)}…` });
    }
  }
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.size < 5 * 1024 * 1024) out.push(full);
  }
  return out;
}

export function scanRepository(repo, { history = false } = {}) {
  const allow = loadAllowlist(repo);
  const findings = [];
  const read = (rel) => {
    try {
      return readFileSync(path.join(repo, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const tracked = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  for (const f of tracked) findings.push(...scanText(read(f), { surface: 'tracked', path: f }, allow));
  for (const f of untracked) findings.push(...scanText(read(f), { surface: 'untracked', path: f }, allow));
  for (const buildDir of ['dist', 'apps', 'packages']) {
    const base = path.join(repo, buildDir);
    if (!existsSync(base)) continue;
    for (const full of walk(base)) {
      if (!full.split(path.sep).includes('dist')) continue;
      const rel = path.relative(repo, full);
      findings.push(...scanText(readFileSync(full, 'utf8'), { surface: 'build', path: rel }, allow));
    }
  }
  if (history) {
    let commits;
    try {
      commits = git(repo, ['rev-list', '--all']).split('\n').filter(Boolean);
    } catch {
      commits = [];
    }
    for (const sha of commits) {
      const patch = git(repo, ['show', '--format=', '--unified=0', '--no-color', sha]);
      let current = null;
      for (const line of patch.split('\n')) {
        if (line.startsWith('+++ b/')) current = line.slice(6);
        else if (line.startsWith('+') && !line.startsWith('+++') && current)
          findings.push(
            ...scanText(line.slice(1), { surface: 'history', path: current, commit: sha.slice(0, 12) }, allow),
          );
      }
    }
  }
  return findings;
}

if (process.argv[1]?.endsWith('secret-scan.mjs')) {
  const idx = process.argv.indexOf('--repo');
  const repo = idx > -1 ? process.argv[idx + 1] : process.cwd();
  const findings = scanRepository(repo, { history: process.argv.includes('--history') });
  process.stdout.write(JSON.stringify({ result: findings.length ? 'FAIL' : 'PASS', findings }, null, 2) + '\n');
  process.exitCode = findings.length ? 1 : 0;
}
