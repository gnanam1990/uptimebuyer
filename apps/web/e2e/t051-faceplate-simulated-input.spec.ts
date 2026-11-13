// T-051 — a simulated sensor value is never presented as a live operational reading (INV-11, INV-12; PR #25 review).
// The incident faceplate reads the same device and series as the Telemetry panel and labels a SIMULATOR device's value
// SIMULATED_INPUT next to the number, exactly as the panel does; the value is not styled as live however fresh it is.
import { expect, test } from '@playwright/test';
import { apiGet, manifest, signIn } from './support/fixtures.js';

test('T-051 faceplate: a SIMULATOR reading is labelled SIMULATED_INPUT and never styled as live', async ({ page }) => {
  const m = manifest();
  const inc = m.incidents.approval!;
  const api = await apiGet<{ devices: { inputClass: string; freshness: string }[] }>(
    'operator',
    `/v1/assets/${inc.assetId}/telemetry`,
  );
  // The seeded feed for this asset is a labelled simulator.
  expect(api.devices[0]!.inputClass).toBe('SIMULATOR');

  await signIn(page, 'operator');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
  await page
    .getByRole('link', { name: `Open incident ${inc.incidentId}` })
    .first()
    .click();
  const panel = page.getByRole('region', { name: 'Telemetry' });
  await expect(panel).toContainText('SIMULATED_INPUT');

  const status = page.getByRole('region', { name: 'Incident status' });
  const readout = status.locator('.readout');
  await expect(readout).toBeVisible();
  await expect(readout.locator('.readout-value')).toContainText('°C');
  // Labelled at the number itself, not only somewhere else on the faceplate.
  await expect(readout).toContainText('SIMULATED_INPUT');
  await expect(readout).toContainText(/simulated/i);
  await expect(readout).not.toContainText(/^Newest temperature$/m);
  await expect(readout.locator('.readout-value')).not.toHaveAttribute('data-live', 'true');
});
