// T-049 — failure notices stay readable on the dark controller faceplate (WCAG 2.2 SC 1.4.3; PR #25 review).
// The Command Center fleet strip sits on the dark faceplate. When fleet health cannot be loaded (error notice with a
// retry) and when a later refresh fails (warning notice over the retained counts), the notice text must keep AA
// contrast against the notice's own light fill: an axe-core WCAG 2.2 AA scan of each state has no violations.
import { expect, test } from '@playwright/test';
import { expectAccessible, signIn } from './support/fixtures.js';

test('T-049 fleet failure notices on the controller faceplate pass the axe contrast scan', async ({ page }) => {
  test.setTimeout(120_000);
  const fleet = '**/v1/fleet**';
  // The first fleet load fails at the network: an error notice with a retry, inside the faceplate.
  await page.route(fleet, (route) => route.abort('failed'));
  await signIn(page, 'approver');
  const strip = page.getByRole('region', { name: 'Fleet health' });
  const error = strip.getByRole('alert').filter({ hasText: 'cannot be loaded' });
  await expect(error).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Retry loading fleet health' })).toBeVisible();
  await expectAccessible(page, 'fleet error notice on the faceplate');

  // Recover, then let the next poll fail: a warning notice over the retained counts.
  await page.unroute(fleet);
  await strip.getByRole('button', { name: 'Retry loading fleet health' }).click();
  await expect(strip.getByTestId('count-assetsFresh')).toBeVisible();
  await page.route(fleet, (route) => route.abort('failed'));
  await expect(strip.getByText('the latest refresh failed', { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(strip.getByTestId('count-assetsFresh')).toBeVisible();
  await expectAccessible(page, 'fleet stale-data notice on the faceplate');
  await page.unroute(fleet);
});
