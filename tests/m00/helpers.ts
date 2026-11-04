import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export function tempGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ub-m00-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'fixture@example.invalid');
  g('config', 'user.name', 'Fixture');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
  g('add', '.');
  g('commit', '-q', '-m', 'fixture');
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

export function run(cmd: string, args: string[], cwd = repoRoot) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
