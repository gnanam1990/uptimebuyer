// T-051 — a failed telemetry refresh is never shown as a live, fresh reading (INV-11; PR #25 review).
// The incident faceplate heads every incident section. Once the asset's telemetry refresh starts failing, the faceplate
// must say the retained value is the last known one and not live, show the refresh error, and stop showing the
// retained FRESH freshness — on the overview and on every other tab. The failure is a real network failure of the
// telemetry request in the browser; the API itself is untouched.
import { expect, test } from '@playwright/test';
import { expectAccessible, manifest, signIn } from './support/fixtures.js';

test.describe.configure({ mode: 'serial' });

const TABS = ['Evidence', 'Recovery plan', 'Spend & orders', 'Verification', 'Timeline'];

test('T-051 faceplate: a failed telemetry refresh reads as last known, not live, on every tab', async ({ page }) => {
  test.setTimeout(120_000);
  const m = manifest();
  const inc = m.incidents.approval!;
  await signIn(page, 'operator');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
  await page
    .getByRole('link', { name: `Open incident ${inc.incidentId}` })
    .first()
    .click();
  const status = page.getByRole('region', { name: 'Incident status' });
  // Precondition: the first load succeeded and the faceplate shows a reading with its freshness.
  await expect(status.locator('[data-axis="freshness"]')).toHaveCount(1);
  await expect(status).not.toContainText('refresh failed', { ignoreCase: true });

  // From now on every telemetry refresh fails at the network.
  await page.route(`**/v1/assets/${inc.assetId}/telemetry**`, (route) => route.abort('failed'));
  await expect(status).toContainText('Last known temperature, not live', { timeout: 20_000 });

  const assertNotLive = async (where: string) => {
    await expect(status, where).toContainText('Last known temperature, not live');
    await expect(status, where).toContainText(/refresh failed/i);
    await expect(status, where).toContainText('could not be completed');
    await expect(status.locator('[data-axis="freshness"][data-value="FRESH"]'), where).toHaveCount(0);
    await expect(status.locator('[data-tone="healthy"]'), where).toHaveCount(0);
  };
  await assertNotLive('overview');
  await expectAccessible(page, 'faceplate after a failed refresh');
  for (const tab of TABS) {
    await page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: tab }).click();
    await expect(page).toHaveURL(new RegExp(`/incidents/${inc.incidentId}/`));
    await assertNotLive(tab);
  }
  await page.unroute(`**/v1/assets/${inc.assetId}/telemetry**`);
});
