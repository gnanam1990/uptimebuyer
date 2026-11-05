// T-050 — Responsive operations views (FR-19, NFR-07; WCAG 2.2 SC 1.4.10 Reflow).
// Critical views at 320, 375, 768, 1024 and 1440 CSS px, at 200% zoom (a 1440 px window at 2x = 720 CSS px) and with
// 400% zoom reflow (1280 px at 4x = 320 CSS px): no horizontal page overflow, the incident state, deadline, blocker and
// next safe action stay visible, and no action is hidden — every primary control of the view is visible, inside the
// viewport horizontally and has at least a 44x44 CSS px target. Wide tables may scroll inside their own labelled
// region (UI-SPEC §12), never the page.
import { expect, test, type Page } from '@playwright/test';
import { manifest, signIn } from './support/fixtures.js';

const VIEWPORTS = [
  { label: '320', width: 320, height: 720, scale: 1 },
  { label: '375', width: 375, height: 812, scale: 1 },
  { label: '768', width: 768, height: 1024, scale: 1 },
  { label: '1024', width: 1024, height: 768, scale: 1 },
  { label: '1440', width: 1440, height: 900, scale: 1 },
  { label: '200% zoom', width: 720, height: 450, scale: 2 },
  { label: '400% zoom reflow', width: 320, height: 256, scale: 4 },
];

async function noPageOverflow(page: Page, context: string) {
  const o = await page.evaluate(() => {
    const doc = document.documentElement;
    // Elements wider than the viewport that are not inside a deliberate horizontal scroll region.
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (el.closest('[data-scroll-region]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > doc.clientWidth + 1 || r.left < -1)
        offenders.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
    }
    return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders: offenders.slice(0, 5) };
  });
  expect(o.scroll, `${context}: page scrollWidth`).toBeLessThanOrEqual(o.client);
  expect(o.offenders, `${context}: elements outside the viewport`).toEqual([]);
}

async function actionsUsable(page: Page, names: (string | RegExp)[], context: string) {
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  for (const name of names) {
    const el = page.getByRole('button', { name }).or(page.getByRole('link', { name })).first();
    await el.scrollIntoViewIfNeeded();
    await expect(el, `${context}: ${String(name)}`).toBeVisible();
    const box = (await el.boundingBox())!;
    expect(box.x, `${context}: ${String(name)} left`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${context}: ${String(name)} right`).toBeLessThanOrEqual(vw + 1);
    expect(box.width, `${context}: ${String(name)} target width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${context}: ${String(name)} target height`).toBeGreaterThanOrEqual(44);
  }
}

test('T-050 responsive operations views at every width and zoom level', async ({ browser }) => {
  test.setTimeout(300_000);
  const m = manifest();
  const inc = m.incidents.approval!;
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await context.newPage();
    await signIn(page, 'approver');
    const ctx = `viewport ${vp.label}`;

    // Command Center.
    await expect(page.getByRole('heading', { level: 1, name: /^Command Center/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fleet health' })).toBeVisible();
    await noPageOverflow(page, `${ctx} command center`);
    await actionsUsable(page, ['Sign out', `Open incident ${inc.incidentId}`], `${ctx} command center`);

    // Incident overview: state, deadline, blocker and next safe action stay visible above everything else.
    await page
      .getByRole('link', { name: `Open incident ${inc.incidentId}` })
      .first()
      .click();
    const status = page.getByRole('region', { name: 'Incident status' });
    for (const text of ['Current deadline', 'Blocker', 'Next safe action'])
      await expect(status.getByText(text, { exact: false }).first(), `${ctx}: ${text}`).toBeVisible();
    await expect(status.locator('[data-axis="incident-state"]')).toBeVisible();
    await noPageOverflow(page, `${ctx} incident overview`);
    await actionsUsable(page, ['Assign incident…', 'Pause live updates'], `${ctx} incident overview`);

    // Recovery plan with a pending approval panel (the second seeded request is never approved by any test).
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
    await page
      .getByRole('link', { name: `Open incident ${m.incidents.approval2!.incidentId}` })
      .first()
      .click();
    await page
      .getByRole('navigation', { name: 'Incident sections' })
      .getByRole('link', { name: 'Recovery plan' })
      .click();
    await expect(page.getByRole('group', { name: 'Spending session bounds' })).toBeVisible();
    await noPageOverflow(page, `${ctx} recovery plan`);
    await actionsUsable(page, [/^Approve up to .* for incident /, 'Hold approval…'], `${ctx} recovery plan`);

    // Spend & orders on an incident with an UNKNOWN payment (disabled retry stays visible with its reason).
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
    await page
      .getByRole('link', { name: `Open incident ${m.incidents.unknownIntent!.incidentId}` })
      .first()
      .click();
    await page
      .getByRole('navigation', { name: 'Incident sections' })
      .getByRole('link', { name: 'Spend & orders' })
      .click();
    await expect(page.getByRole('region', { name: 'Orders and payments' })).toBeVisible();
    await noPageOverflow(page, `${ctx} spend`);
    const retry = page.getByRole('button', { name: 'Retry purchase' }).first();
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeVisible();
    await expect(retry).toBeDisabled();
    await expect(page.getByText('Retry is disabled', { exact: false }).first()).toBeVisible();

    // Verification and notifications.
    await page
      .getByRole('navigation', { name: 'Incident sections' })
      .getByRole('link', { name: 'Verification' })
      .click();
    await expect(page.getByRole('region', { name: 'Recovery verification' })).toBeVisible();
    await noPageOverflow(page, `${ctx} verification`);
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: /^Notifications/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: /^Notifications/ })).toBeVisible();
    await noPageOverflow(page, `${ctx} notifications`);
    await context.close();
  }
});
