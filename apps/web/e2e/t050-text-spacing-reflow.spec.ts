// T-050 — long identifiers and wider text never push an action off screen (WCAG 2.2 SC 1.4.10 Reflow and SC 1.4.12
// Text Spacing; PR #25 CI failure at 1024 px).
// CI's Linux Chromium measured the Command Center "Open incident <uuid>" link 156 px past the right edge of a 1024 px
// viewport, while the same build fitted on macOS: text metrics vary by platform, so the layout must not depend on them.
// This applies the WCAG 1.4.12 text-spacing overrides (letter 0.12em, word 0.16em, line 1.5, paragraph 2em), which
// widen every run of text well beyond any platform difference, at 1024 and 768 CSS px, and checks every link and
// button the views offer — including those inside tables with long, unbreakable seeded ids — is visible, fully inside
// the viewport and at least 44 x 44 CSS px, and that the page itself never scrolls horizontally. The override
// stylesheet is injected by the test, so this context bypasses the page CSP for that one stylesheet only.
import { expect, test, type Page } from '@playwright/test';
import { manifest, signIn } from './support/fixtures.js';

const TEXT_SPACING = `
  * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; }
  p { margin-bottom: 2em !important; }
`;

async function everyActionInside(page: Page, context: string) {
  // Wait for API truth, not a loading placeholder.
  await expect(page.getByRole('main')).not.toContainText(/loading/i, { timeout: 30_000 });
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll, `${context}: page scrollWidth`).toBeLessThanOrEqual(vw);
  // Stricter than T-050's page check: at these widths nothing may extend past the viewport, not even inside a table's
  // scroll region, because a control half inside a scroll region is neither scrolled to nor fully visible.
  const outside = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('main *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > w + 1 || r.left < -1)
        offenders.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 60)}" right=${Math.round(r.right)}`,
        );
    }
    return offenders.slice(0, 5);
  });
  expect(outside, `${context}: elements past the viewport edge`).toEqual([]);
  const actions = page.getByRole('main').locator('a[href], button');
  const n = await actions.count();
  expect(n, `${context}: actions found`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = actions.nth(i);
    if (!(await el.isVisible())) continue;
    const name = ((await el.textContent()) ?? '').trim().slice(0, 80);
    await el.scrollIntoViewIfNeeded();
    const box = (await el.boundingBox())!;
    expect(box.x, `${context}: "${name}" left`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${context}: "${name}" right`).toBeLessThanOrEqual(vw + 1);
    expect(box.height, `${context}: "${name}" target height`).toBeGreaterThanOrEqual(44);
    expect(box.width, `${context}: "${name}" target width`).toBeGreaterThanOrEqual(44);
  }
}

for (const vp of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test(`T-050 text spacing and long ids keep every action on screen at ${vp.width} px`, async ({ browser }) => {
    test.setTimeout(180_000);
    const m = manifest();
    const context = await browser.newContext({ viewport: vp, bypassCSP: true });
    const page = await context.newPage();
    await signIn(page, 'approver');
    await page.addStyleTag({ content: TEXT_SPACING });
    const ctx = `${vp.width} px`;

    await expect(page.getByRole('region', { name: 'Fleet health' })).toBeVisible();
    await expect(page.getByTestId('count-assetsFresh')).toBeVisible();
    await everyActionInside(page, `${ctx} command center`);

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Incidents' })).toBeVisible();
    await everyActionInside(page, `${ctx} incident register`);

    await page
      .getByRole('link', { name: `Open incident ${m.incidents.approval2!.incidentId}` })
      .first()
      .click();
    await expect(page.getByRole('img', { name: /^Temperature chart/ })).toBeVisible();
    await everyActionInside(page, `${ctx} incident overview`);
    await page
      .getByRole('navigation', { name: 'Incident sections' })
      .getByRole('link', { name: 'Recovery plan' })
      .click();
    await expect(page.getByRole('group', { name: 'Spending session bounds' })).toBeVisible();
    await everyActionInside(page, `${ctx} recovery plan`);

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: /^Notifications/ })
      .click();
    await expect(page.getByRole('list', { name: 'Notifications' })).toBeVisible();
    await everyActionInside(page, `${ctx} notifications`);
    await context.close();
  });
}
