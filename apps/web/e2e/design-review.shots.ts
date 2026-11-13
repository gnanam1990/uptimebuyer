// Design review captures for docs/design (before/after the console redesign). Walks every main view at 1440 and 375
// CSS px over the seeded SIMULATED harness: sign-in, Command Center, incident register, each incident workspace
// section (overview with telemetry, ownership and deadline; evidence and the citation drawer; recovery plan; spend &
// orders including an UNKNOWN outcome; verification; timeline), notifications, and the admin-only ledger and
// policies. Navigation stays inside the app (the bearer token lives in memory only). Not part of `pnpm verify`.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { base, manifest, signIn } from './support/fixtures.js';

const repo = resolve(import.meta.dirname, '..', '..', '..');
// UB_SHOTS_OUT (an absolute folder) overrides docs/design/<UB_SHOTS_DIR>; UB_SHOTS_WIDTHS (comma-separated CSS px)
// overrides the default 1440 and 375; UB_SHOTS_MOTION=full captures with motion allowed (default: reduced).
const outDir = process.env.UB_SHOTS_OUT ?? join(repo, 'docs', 'design', process.env.UB_SHOTS_DIR ?? 'after');
const HEIGHTS: Record<number, number> = { 1920: 1080, 1440: 900, 1024: 768, 768: 1024, 375: 812, 320: 720 };
const WIDTHS = (process.env.UB_SHOTS_WIDTHS ?? '1440,375').split(',').map((v) => {
  const width = Number(v.trim());
  return { label: String(width), width, height: HEIGHTS[width] ?? 900 };
});
const REDUCED = process.env.UB_SHOTS_MOTION === 'full' ? 'no-preference' : 'reduce';

test.describe.configure({ mode: 'serial' });

async function settle(page: Page) {
  await expect(page.getByRole('main')).not.toContainText(/loading/i, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await settle(page);
}

test('design review screenshots', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(outDir, { recursive: true });
  const m = manifest();
  const approval = m.incidents.approval!;
  const recovered = m.incidents.recovered!;
  const unknown = m.incidents.unknownIntent!;
  for (const w of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: w.width, height: w.height },
      reducedMotion: REDUCED,
    });
    const page = await context.newPage();
    const shot = async (name: string) => {
      await page.screenshot({ path: join(outDir, `${name}-${w.label}.png`), fullPage: true, animations: 'disabled' });
    };
    const region = async (name: string, label: string) => {
      const r = page.getByRole('region', { name: label, exact: true }).first();
      await r.scrollIntoViewIfNeeded();
      await r.screenshot({ path: join(outDir, `${name}-${w.label}.png`), animations: 'disabled' });
    };

    await page.goto(base());
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to UptimeBuyer Operations' })).toBeVisible();
    await page.waitForTimeout(400);
    await shot('01-sign-in');

    await signIn(page, 'approver');
    await settle(page);
    await shot('02-command-center');
    await go(page, '/incidents');
    await shot('03-incident-register');

    await go(page, `/incidents/${approval.incidentId}`);
    await expect(page.getByRole('img', { name: /^Temperature chart/ })).toBeVisible();
    await shot('04-incident-overview');
    await region('05-incident-telemetry', 'Telemetry');
    await region('06-incident-ownership', 'Ownership');
    await region('07-incident-deadline', 'Response deadline');

    await go(page, `/incidents/${approval.incidentId}/evidence`);
    await shot('08-incident-evidence');
    await page
      .getByRole('button', { name: /^Open citation/ })
      .first()
      .click();
    await expect(page.getByRole('dialog', { name: 'Citation' })).toContainText('Verified against the stored document');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `09-citation-drawer-${w.label}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');

    await go(page, `/incidents/${approval.incidentId}/plan`);
    await shot('10-incident-plan');
    await page.getByRole('button', { name: /^Approve up to / }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm spending approval' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `11-approval-confirmation-${w.label}.png`), animations: 'disabled' });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await go(page, `/incidents/${recovered.incidentId}/spend`);
    await shot('12-incident-spend');
    await go(page, `/incidents/${unknown.incidentId}/spend`);
    await shot('13-incident-spend-unknown');
    await go(page, `/incidents/${recovered.incidentId}/verification`);
    await shot('14-incident-verification');
    await go(page, `/incidents/${approval.incidentId}/timeline`);
    await shot('15-incident-timeline');
    await go(page, '/notifications');
    await shot('16-notifications');

    await signIn(page, 'admin');
    await go(page, '/ledger');
    await shot('17-evidence-ledger');
    await go(page, '/policies');
    await shot('18-policies');
    await context.close();
  }
});
