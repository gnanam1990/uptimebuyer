// M14 local demo (SIMULATED; T-059 screenshots, INV-12). Walks the operator console over the seeded harness:
// incident -> cited evidence -> advisory plan and approval bounds -> recorded-contract order -> recovery verification,
// plus an UNKNOWN external outcome left unresolved. Every input is synthetic: SIMULATOR sensors (SIMULATED_INPUT),
// a RECORDED_CONTRACT broker, a CONTRACT_FAKE CMMS, synthetic citations and a test identity provider. The environment
// label on every page names the simulation, every screenshot's digest is written to
// docs/release/demo/simulated-artifacts.json, and the real-input journey gate (T-058) refuses those artifacts. This run
// is never presentable as the real-input journey.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { manifest, signIn } from './support/fixtures.js';

const repo = resolve(import.meta.dirname, '..', '..', '..');
const shotsDir = join(repo, 'docs', 'release', 'screenshots');
const LABEL = /SIMULATED_INPUT/;

test.describe.configure({ mode: 'serial' });

test('M14 local SIMULATED demo walk-through with screenshots', async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(shotsDir, { recursive: true });
  const m = manifest();
  const shots: { file: string; step: string; shows: string }[] = [];
  const shot = async (p: Page, file: string, step: string, shows: string) => {
    // The environment label naming the simulation is visible on every captured page.
    await expect(p.getByRole('note', { name: 'Environment' })).toContainText(LABEL);
    await p.screenshot({ path: join(shotsDir, file), fullPage: false, animations: 'disabled' });
    shots.push({ file, step, shows });
  };

  await signIn(page, 'approver');
  await expect(page.getByRole('heading', { level: 1, name: /^Command Center/ })).toBeVisible();
  await shot(
    page,
    '01-command-center.png',
    'Fleet and incident register',
    'SIMULATED_INPUT sensor freshness, open incidents',
  );

  const approval = m.incidents.approval!;
  await page.goto(`/incidents/${approval.incidentId}`);
  await expect(page.getByRole('heading', { level: 1, name: `Incident ${approval.incidentId}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Incident status' })).toContainText('Awaiting approval');
  await shot(page, '02-incident.png', 'Incident', 'state, deadline from the pinned procedure, next safe action');

  await page.goto(`/incidents/${approval.incidentId}/evidence`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '03-evidence.png', 'Evidence', 'cited facts from synthetic documents (contract-fake reasoning)');

  await page.goto(`/incidents/${approval.incidentId}/plan`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(
    page,
    '04-plan-approval.png',
    'Plan and approval',
    'deterministic decision, advisory plan, bounded approval',
  );

  const recovered = m.incidents.recovered!;
  await page.goto(`/incidents/${recovered.incidentId}/spend`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '05-order-recorded-contract.png', 'Order', 'recorded-contract broker order and payment state');

  await page.goto(`/incidents/${recovered.incidentId}/verification`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(
    page,
    '06-recovery-verification.png',
    'Recovery verification',
    'stable window and authoritative close-out',
  );

  const unknown = m.incidents.unknownIntent!;
  await page.goto(`/incidents/${unknown.incidentId}/spend`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '07-unknown-outcome.png', 'Failure handling', 'post-egress UNKNOWN outcome kept unresolved');

  await page.goto('/ledger');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '08-ledger.png', 'Evidence ledger', 'append-only ledger entries');

  const artifacts = shots.map((s) => {
    const path = `docs/release/screenshots/${s.file}`;
    return {
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(repo, path)))
        .digest('hex'),
      ...s,
    };
  });
  writeFileSync(
    join(repo, 'docs', 'release', 'demo', 'simulated-artifacts.json'),
    `${JSON.stringify(
      {
        schema: 'simulated-artifacts.v1',
        label: 'SIMULATED_INPUT',
        note: 'Screenshots of the local SIMULATED demo (SIMULATOR sensors, RECORDED_CONTRACT broker, CONTRACT_FAKE CMMS and reasoning, synthetic tenant and citations, test identity provider). The real-input journey gate refuses any artifact listed here.',
        inputs: {
          sensors: 'SIMULATOR (SIMULATED_INPUT)',
          broker: 'RECORDED_CONTRACT',
          reasoning: 'CONTRACT_FAKE',
          cmms: 'CONTRACT_FAKE',
          identityProvider: 'local test OIDC provider',
          data: 'SEEDED_TEST_DATA',
        },
        capturedAt: new Date().toISOString(),
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  expect(artifacts.length).toBe(8);
});
