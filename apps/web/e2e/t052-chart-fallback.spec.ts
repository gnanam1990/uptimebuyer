// T-052 — Chart table fallback and reduced motion (NFR-07, INV-11; UI-SPEC §5.4, §8.1, §13).
// The live telemetry chart on the incident overview has: a text current-value summary (value, unit, sample time,
// ingestion class, quality and freshness) that matches the API; an equivalent data table (time, value, unit,
// ingestion, quality, origin, anomaly) reachable by keyboard; a pause/resume control that really stops polling and
// resumes from the server; anomaly cues that are distinct in shape and text, not color alone; and no animation or
// transition under prefers-reduced-motion.
import { expect, test } from '@playwright/test';
import { apiGet, expectAccessible, manifest, press, signIn, tabTo } from './support/fixtures.js';

test.describe.configure({ mode: 'serial' });

async function toOverview(page: import('@playwright/test').Page, incidentId: string) {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
  await page
    .getByRole('link', { name: `Open incident ${incidentId}` })
    .first()
    .click();
}

test('T-052 accessible table, current-value summary, pause/resume and anomaly cues', async ({ page }) => {
  test.setTimeout(120_000);
  const m = manifest();
  const inc = m.incidents.approval!;
  await signIn(page, 'operator');
  await toOverview(page, inc.incidentId);
  const panel = page.getByRole('region', { name: 'Telemetry' });
  const chart = panel.getByRole('img', { name: /^Temperature chart/ });
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAccessibleName(/threshold 8\.0 °C/);

  // Current value summary as text, consistent with the API.
  const api = await apiGet<{
    devices: {
      freshness: string;
      series: { samples: { valueInt: number; eventAt: string; ingestionClass: string }[] }[];
    }[];
  }>('operator', `/v1/assets/${inc.assetId}/telemetry`);
  const samples = api.devices[0]!.series[0]!.samples;
  expect(samples.length).toBeGreaterThan(10);
  const current = panel.getByTestId('current-value');
  await expect(current).toContainText('°C');
  await expect(current).toContainText('UTC');
  await expect(current).toContainText('LIVE');
  await expect(current).toContainText(api.devices[0]!.freshness === 'FRESH' ? 'Fresh' : /Stale|Offline|Invalid/);
  await expect(current).toContainText('SIMULATED_INPUT');

  // The equivalent data table, by keyboard.
  const toggle = panel.getByRole('button', { name: 'Show data table' });
  await press(page, toggle);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const table = panel.getByRole('table', { name: 'Telemetry samples' });
  await expect(table).toBeVisible();
  for (const col of ['Time (UTC)', 'Value', 'Unit', 'Ingestion', 'Quality', 'Origin', 'Anomaly'])
    await expect(table.getByRole('columnheader', { name: col })).toBeVisible();
  expect(await table.getByRole('row').count()).toBeGreaterThanOrEqual(samples.length - 5);
  // Anomaly cues: distinct shape in the chart and explicit text in the table.
  await expect(table.getByRole('cell', { name: 'Above threshold' }).first()).toBeVisible();
  const anomalies = chart.locator('[data-anomaly="above-threshold"]');
  expect(await anomalies.count()).toBeGreaterThan(0);
  const shapes = new Set(
    await anomalies.evaluateAll((els) => els.map((e) => e.tagName.toLowerCase() + ':' + e.getAttribute('data-shape'))),
  );
  const normal = new Set(
    await chart
      .locator('[data-point]:not([data-anomaly])')
      .evaluateAll((els) => els.map((e) => e.tagName.toLowerCase() + ':' + e.getAttribute('data-shape'))),
  );
  for (const s of shapes) expect(normal.has(s), `anomaly marker shape ${s} must differ from normal points`).toBe(false);
  await expect(chart.locator('[data-threshold-line]')).toHaveCount(1);
  await expectAccessible(page, 'telemetry with table');

  // Pause really stops polling; resume fetches again.
  const pause = panel.getByRole('button', { name: 'Pause live updates' });
  await tabTo(page, pause);
  await expect(pause).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  const resume = panel.getByRole('button', { name: 'Resume live updates' });
  await expect(resume).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#announcer')).toContainText('Live updates paused');
  let calls = 0;
  const count = (r: import('@playwright/test').Request) => {
    if (r.url().includes(`/v1/assets/${inc.assetId}/telemetry`)) calls++;
  };
  page.on('request', count);
  await page.waitForTimeout(7_000);
  expect(calls, 'no telemetry polling while paused').toBe(0);
  await press(page, resume);
  await expect(page.locator('#announcer')).toContainText('Live updates resumed');
  await expect.poll(() => calls, { timeout: 15_000 }).toBeGreaterThan(0);
  page.off('request', count);
});

test('T-052 reduced motion disables chart transitions; default motion keeps them', async ({ browser }) => {
  const m = manifest();
  const inc = m.incidents.approval!;
  for (const [reducedMotion, expectMotion] of [
    ['no-preference', true],
    ['reduce', false],
  ] as const) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await signIn(page, 'operator');
    await toOverview(page, inc.incidentId);
    const chart = page.getByRole('region', { name: 'Telemetry' }).getByRole('img', { name: /^Temperature chart/ });
    await expect(chart).toBeVisible();
    const motion = await chart.evaluate((svg) => {
      const els = [svg, ...Array.from(svg.querySelectorAll('*'))] as Element[];
      return els.some((el) => {
        const s = getComputedStyle(el);
        const t = s.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
        const a = s.animationName !== 'none' && s.animationDuration.split(',').some((d) => parseFloat(d) > 0);
        return t || a;
      });
    });
    expect(motion, `motion with prefers-reduced-motion: ${reducedMotion}`).toBe(expectMotion);
    // Critical alerts never pulse continuously in either mode.
    const pulsing = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="alert"], [data-tone="critical"]')).some(
        (el) => getComputedStyle(el).animationIterationCount === 'infinite',
      ),
    );
    expect(pulsing).toBe(false);
    await ctx.close();
  }
});
