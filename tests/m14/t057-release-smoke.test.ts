// T-057 (M14) clean-environment bring-up script, unit layer. `pnpm release:smoke` clones the committed HEAD into a
// fresh temporary directory, generates throwaway secrets there, builds the images, migrates, starts every service in
// a fresh compose project on fresh loopback ports, runs the smoke checks and always tears down. This test drives the
// script's plan with a recording executor (no Docker) and proves the isolation, ordering, teardown and redaction
// rules; the real run's output is recorded under docs/release/evidence/.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const smoke = await import(path.join(repoRoot, 'scripts', 'release', 'smoke.mjs'));

describe('T-057 release smoke plan', () => {
  it('uses a fresh compose project and fresh loopback ports that never collide with the dev database', () => {
    const a = smoke.planSmoke({ repo: repoRoot, workRoot: '/tmp/x', seed: 1 });
    const b = smoke.planSmoke({ repo: repoRoot, workRoot: '/tmp/x', seed: 2 });
    expect(a.project).toMatch(/^ubsmoke[0-9a-z]{6,}$/);
    expect(a.project).not.toBe(b.project);
    expect(a.project).not.toBe('infra');
    const ports = Object.values(a.ports) as number[];
    expect(new Set(ports).size).toBe(ports.length);
    for (const p of ports) {
      expect(p).not.toBe(55432);
      expect(p).toBeGreaterThanOrEqual(20_000);
      expect(p).toBeLessThan(60_000);
    }
    expect(a.cloneDir.startsWith(a.workDir)).toBe(true);
  });

  it('orders the steps clone -> secrets -> build -> migrate -> up -> checks -> drill -> teardown', () => {
    const p = smoke.planSmoke({ repo: repoRoot, workRoot: '/tmp/x', seed: 3 });
    expect(p.steps).toEqual([
      'clone',
      'secrets',
      'build',
      'identify',
      'migrate',
      'provision',
      'up',
      'health',
      'readiness',
      'authenticated-api',
      'web',
      'worker-ticks',
      'broker',
      'backup-restore',
      'rollback',
      'teardown',
    ]);
  });

  it('always tears down (compose down -v, work dir removed) even when a check fails, and reports FAIL', async () => {
    const calls: string[][] = [];
    const removed: string[] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('readiness-probe')) throw new Error('not ready');
      return { stdout: '{}', stderr: '' };
    };
    const plan = smoke.planSmoke({ repo: repoRoot, workRoot: '/tmp/x', seed: 4 });
    const report = await smoke.runSmoke(plan, {
      exec,
      steps: { readiness: async () => exec('probe', ['readiness-probe']) },
      removeDir: async (d: string) => void removed.push(d),
      log: () => {},
    });
    expect(report.result).toBe('FAIL');
    expect(report.steps.find((s: { name: string }) => s.name === 'readiness').status).toBe('FAIL');
    const down = calls.find((c) => c.includes('down'));
    expect(down).toBeDefined();
    expect(down).toEqual(expect.arrayContaining(['-p', plan.project, 'down', '-v']));
    expect(removed).toEqual([plan.workDir]);
    // Later checks are not attempted after a failure, but teardown is.
    expect(report.steps.map((s: { name: string }) => s.name)).toContain('teardown');
    expect(report.steps.find((s: { name: string }) => s.name === 'web').status).toBe('NOT_RUN');
  });

  it('records immutable build identifiers: the git SHA and every image ID as a sha256 digest', () => {
    const ids = smoke.buildIdentifiers({
      sha: 'a'.repeat(40),
      images: { api: `sha256:${'1'.repeat(64)}`, worker: `sha256:${'2'.repeat(64)}` },
    });
    expect(ids.gitSha).toMatch(/^[0-9a-f]{40}$/);
    for (const v of Object.values(ids.imageIds) as string[]) expect(v).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => smoke.buildIdentifiers({ sha: 'main', images: {} })).toThrow();
    expect(() => smoke.buildIdentifiers({ sha: 'a'.repeat(40), images: { api: 'ub-api:latest' } })).toThrow();
  });

  it('redacts generated secrets from everything it records', () => {
    const r = smoke.redactor(['s3cr3t-value-123456', 'other-token-abcdef']);
    expect(r('DATABASE password s3cr3t-value-123456 and other-token-abcdef')).toBe(
      'DATABASE password [REDACTED] and [REDACTED]',
    );
  });

  it('classifies a hosted deployment as NOT_RUN in every report', () => {
    const plan = smoke.planSmoke({ repo: repoRoot, workRoot: '/tmp/x', seed: 5 });
    expect(smoke.emptyReport(plan).hostedDeployment).toBe('NOT_RUN');
    expect(smoke.emptyReport(plan).layer).toBe('LOCAL_COMPOSE');
  });
});
