// T-051 — Honest stale, unknown and unsupported states (INV-11, INV-12, FR-19, FR-20).
// Every external and freshness state is seeded through the real packages (see m12-e2e-stack.ts) and read back from the
// API; the UI must show the same value on each SEPARATE axis (freshness, local authority, Kite session, transport,
// external outcome, adapter capability, economic intent, purchase order vs service job, recovery) with a text label,
// an icon shape and an accessible description, never green for stale/unknown/unsupported, a post-egress UNKNOWN that
// stays UNKNOWN when capability is UNSUPPORTED, and disabled unsafe actions that explain their blocking evidence.
// Notifications are role-routed, deep-linked with a recovery path, deduplicated and never announce stale, unknown or
// unsupported as success.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { GREEN, announcements, apiGet, badge, expectAccessible, manifest, signIn } from './support/fixtures.js';

test.describe.configure({ mode: 'serial' });

const SUCCESS_WORDS = /\b(success|successful|succeeded|completed successfully|all good|healthy)\b/i;

async function expectBadge(
  scope: Page | Locator,
  axis: string,
  value: string,
  label: string | RegExp,
  healthy: boolean,
) {
  const b = badge(scope, axis, value).first();
  await expect(b, `${axis}=${value}`).toBeVisible();
  await expect(b.locator('.axis-label')).toHaveText(label);
  await expect(b.locator('svg[data-shape]')).toHaveCount(1);
  await expect(b.locator('.sr-only')).toContainText(typeof label === 'string' ? label : '');
  const tone = await b.getAttribute('data-tone');
  const colors = await b.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.color, s.backgroundColor, s.borderColor];
  });
  if (healthy) expect(tone, `${axis}=${value} tone`).toBe('healthy');
  else {
    expect(tone, `${axis}=${value} tone`).not.toBe('healthy');
    for (const c of colors) expect(c, `${axis}=${value} color`).not.toBe(GREEN);
  }
}

async function openIncident(page: Page, incidentId: string, tab: string) {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }).click();
  await page
    .getByRole('link', { name: `Open incident ${incidentId}` })
    .first()
    .click();
  await page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: tab }).click();
}

test('T-051 freshness: stale, offline, invalid and no-signal never read as healthy', async ({ page }) => {
  const m = manifest();
  await signIn(page, 'operator');
  const fleet = await apiGet<{
    counts: Record<string, number>;
    sites: { assets: { assetId: string; freshness: string }[] }[];
  }>('operator', '/v1/fleet');
  const truth = new Map(fleet.sites.flatMap((s) => s.assets.map((a) => [a.assetId, a.freshness])));
  const expected: [keyof typeof m.assets, string, string, boolean][] = [
    ['fresh', 'FRESH', 'Fresh', true],
    ['stale', 'STALE', 'Stale', false],
    ['offline', 'OFFLINE', 'Offline', false],
    ['invalid', 'INVALID', 'Invalid', false],
    ['noSignal', 'NO_SIGNAL', 'No signal', false],
  ];
  for (const [key, value, label, healthy] of expected) {
    const assetId = m.assets[key]!;
    expect(truth.get(assetId), `API freshness of ${key}`).toBe(value);
    const row = page.locator(`[data-asset-id="${assetId}"]`).first();
    await expectBadge(row, 'freshness', value, label, healthy);
    if (key !== 'noSignal') await expect(row).toContainText('SIMULATED_INPUT');
  }
  const strip = page.getByRole('region', { name: 'Fleet health' });
  await expect(strip.getByTestId('count-assetsFresh')).toHaveText(String(fleet.counts.assetsFresh));
  await expect(strip.getByTestId('count-assetsStale')).toHaveText(String(fleet.counts.assetsStale));
  await expect(strip.getByTestId('count-assetsOffline')).toHaveText(String(fleet.counts.assetsOffline));
  await expect(strip.getByTestId('count-assetsInvalid')).toHaveText(String(fleet.counts.assetsInvalid));
  await expect(strip.getByTestId('count-assetsNoSignal')).toHaveText(String(fleet.counts.assetsNoSignal));
  await expect(strip).toContainText('As of');
  await expectAccessible(page, 'fleet freshness');
});

test('T-051 Kite session, authority, transport and capability are separate honest axes', async ({ page }) => {
  const m = manifest();
  await signIn(page, 'operator');
  const cases: [string, string][] = [
    ['sessionUnknown', 'UNKNOWN'],
    ['sessionFailed', 'FAILED'],
    ['sessionPending', ''],
    ['verifying', 'CONFIRMED'],
  ];
  for (const [key, outcome] of cases) {
    const incidentId = m.incidents[key]!.incidentId!;
    const api = await apiGet<{
      authorities: {
        authority: { executionAuthorityId: string; status: string };
        session: {
          externalOutcomeState: string;
          transportState: string;
          adapterCapability: string;
          providerSessionRef: string | null;
        };
      }[];
    }>('operator', `/v1/incidents/${incidentId}/execution-authorities`);
    const a = api.authorities[0]!;
    if (outcome) expect(a.session.externalOutcomeState, key).toBe(outcome);
    await openIncident(page, incidentId, 'Spend & orders');
    const card = page.locator(`[data-authority-id="${a.authority.executionAuthorityId}"]`);
    await expect(card).toBeVisible();
    const confirmed = a.session.externalOutcomeState === 'CONFIRMED';
    await expectBadge(card, 'kite-session', a.session.externalOutcomeState, /.+/, confirmed);
    await expectBadge(card, 'transport', a.session.transportState, /.+/, false);
    await expectBadge(card, 'adapter-capability', a.session.adapterCapability, /.+/, false);
    await expectBadge(card, 'local-authority', a.authority.status, /.+/, false);
    // Local ACTIVE authority never reads as a confirmed Kite session; a provider-session reference is not confirmation.
    if (!confirmed) {
      await expect(card).toContainText('Kite session not confirmed');
      await expect(card).not.toContainText('Session confirmed');
    }
    if (a.session.externalOutcomeState === 'UNKNOWN') {
      await expect(card).toContainText('Reconciliation required');
      await expect(card).toContainText('No new spending until the session outcome is reconciled');
    }
  }
  await expectAccessible(page, 'authority and session');
});

test('T-051 payment and fulfillment: post-egress UNKNOWN stays UNKNOWN under UNSUPPORTED; purchase vs service labels', async ({
  page,
}) => {
  const m = manifest();
  await signIn(page, 'operator');
  type Orders = {
    orders: {
      orderId: string;
      orderKind: string;
      state: string;
      economic: {
        state: string;
        externalOutcomeState: string | null;
        adapterCapability: string | null;
        transportState: string | null;
        reconciliation: string;
      };
    }[];
  };

  // Post-egress UNKNOWN with UNSUPPORTED reconciliation capability.
  const unk = m.incidents.unknownIntent!;
  const u = (await apiGet<Orders>('operator', `/v1/incidents/${unk.incidentId}/orders`)).orders[0]!;
  expect(u.economic.state).toBe('UNKNOWN');
  expect(u.economic.externalOutcomeState).toBe('UNKNOWN');
  expect(u.economic.adapterCapability).toBe('UNSUPPORTED');
  await openIncident(page, unk.incidentId, 'Spend & orders');
  const uo = page.locator(`[data-order-id="${u.orderId}"]`);
  await expect(uo.getByRole('heading', { name: `Purchase order ${u.orderId}` })).toBeVisible();
  await expectBadge(uo, 'economic-intent', 'UNKNOWN', 'Unknown', false);
  await expectBadge(uo, 'external-outcome', 'UNKNOWN', 'Unknown', false);
  await expectBadge(uo, 'adapter-capability', 'UNSUPPORTED', 'Unsupported', false);
  await expectBadge(uo, 'purchase-order', u.state, /.+/, false);
  await expect(uo).not.toContainText('Failed');
  await expect(uo.getByRole('button', { name: 'Retry purchase' })).toBeDisabled();
  await expect(uo).toContainText('Retry is disabled');
  await expect(uo).toContainText(u.economic.reconciliation === 'MANUAL_REVIEW' ? 'Manual review' : 'Reconciliation');
  expect(await announcements(page)).not.toMatch(SUCCESS_WORDS);

  // A declined payment: definite failure, no fulfillment.
  const dec = m.incidents.declined!;
  const d = (await apiGet<Orders>('operator', `/v1/incidents/${dec.incidentId}/orders`)).orders[0]!;
  expect(d.economic.state).toBe('FAILED');
  await openIncident(page, dec.incidentId, 'Spend & orders');
  const dorder = page.locator(`[data-order-id="${d.orderId}"]`);
  await expectBadge(dorder, 'economic-intent', 'FAILED', 'Failed', false);

  // Service job: its own lifecycle and label.
  const job = m.incidents.serviceJob!;
  const j = (await apiGet<Orders>('operator', `/v1/incidents/${job.incidentId}/orders`)).orders[0]!;
  expect(j.orderKind).toBe('SERVICE_JOB');
  await openIncident(page, job.incidentId, 'Spend & orders');
  const jo = page.locator(`[data-order-id="${j.orderId}"]`);
  await expect(jo.getByRole('heading', { name: `Service job ${j.orderId}` })).toBeVisible();
  await expectBadge(jo, 'service-job', j.state, /.+/, false);
  await expect(jo.locator('[data-axis="purchase-order"]')).toHaveCount(0);

  // Confirmed payment with a receiving-verified purchase order: payment is not fulfillment, neither is recovery.
  const ver = m.incidents.verifying!;
  const v = (await apiGet<Orders>('operator', `/v1/incidents/${ver.incidentId}/orders`)).orders[0]!;
  expect(v.economic.state).toBe('CONFIRMED');
  await openIncident(page, ver.incidentId, 'Spend & orders');
  const vo = page.locator(`[data-order-id="${v.orderId}"]`);
  await expectBadge(vo, 'economic-intent', 'CONFIRMED', 'Payment confirmed', true);
  await expectBadge(vo, 'purchase-order', v.state, /.+/, false);
  await expect(vo).toContainText('A payment receipt or delivery never proves recovery');
  await expectAccessible(page, 'orders and payments');
});

test('T-051 recovery: only the canonical closeout reads as recovered', async ({ page }) => {
  const m = manifest();
  await signIn(page, 'operator');
  for (const [key, recovered] of [
    ['verifying', false],
    ['reopened', false],
    ['recovered', true],
  ] as const) {
    const id = m.incidents[key]!.incidentId!;
    const api = await apiGet<{ gate: { recovered: boolean }; evaluations: { state: string }[] }>(
      'operator',
      `/v1/incidents/${id}/recovery`,
    );
    expect(api.gate.recovered, key).toBe(recovered);
    await openIncident(page, id, 'Verification');
    const region = page.getByRole('region', { name: 'Recovery verification' });
    if (recovered) await expectBadge(region, 'recovery', 'RECOVERED', 'Recovered', true);
    else {
      await expectBadge(region, 'recovery', 'NOT_RECOVERED', 'Not recovered', false);
      await expect(region).not.toContainText(/\bRecovered\b(?! —)/);
    }
    for (const e of api.evaluations)
      await expect(region.locator(`[data-axis="recovery-evaluation"][data-value="${e.state}"]`).first()).toBeVisible();
  }
});

test('T-051 notifications are role-routed, deep-linked, deduplicated and never announce unknown as success', async ({
  browser,
}) => {
  const m = manifest();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, 'approver');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: /^Notifications/ })
    .click();
  const list = page.getByRole('list', { name: 'Notifications' });
  await expect(list).toBeVisible();
  const api = await apiGet<{
    notifications: { notificationId: string; triggerKind: string; state: string; deepLink: string }[];
  }>('approver', '/v1/notifications');
  for (const kind of [
    'APPROVAL_REQUIRED',
    'CRITICAL_INCIDENT',
    'SPEND_EXCEPTION',
    'PROVIDER_CHANGE',
    'RECOVERY',
    'INCIDENT_REOPENED',
    'EVIDENCE_GAP',
  ])
    expect(
      api.notifications.some((n) => n.triggerKind === kind),
      `API routes ${kind} to the approver`,
    ).toBe(true);

  // Two approval-required notifications for the same request collapse into one item.
  const approvals = list.locator('[data-trigger-kind="APPROVAL_REQUIRED"]');
  await expect(approvals).toHaveCount(1);
  await expect(approvals).toContainText('2 updates');
  const link = approvals.getByRole('link', { name: /^Open incident/ });
  await expect(link).toHaveAttribute('href', `/incidents/${m.incidents.approval!.incidentId}/plan`);
  await expect(approvals).toContainText('Review approval');

  // Unknown outcomes and unknown delivery are never phrased or colored as success.
  const spend = list.locator('[data-trigger-kind="SPEND_EXCEPTION"]');
  await expect(spend).toContainText('Spend outcome unknown');
  await expect(spend).not.toContainText(SUCCESS_WORDS);
  const gap = list.locator('[data-trigger-kind="EVIDENCE_GAP"]');
  await expectBadge(gap, 'notification-delivery', 'UNKNOWN', 'Delivery unknown', false);
  for (const item of await list.getByRole('listitem').all()) {
    const kind = await item.getAttribute('data-trigger-kind');
    if (kind !== 'RECOVERY') await expect(item.locator('[data-tone="healthy"]')).toHaveCount(0);
  }
  expect(await announcements(page)).not.toMatch(SUCCESS_WORDS);

  // The deep link opens the incident context inside the app.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/incidents/${m.incidents.approval!.incidentId}/plan$`));
  await expect(page.getByRole('region', { name: 'Approval' })).toBeVisible();
  await expectAccessible(page, 'deep-linked plan');
  await ctx.close();

  // A viewer receives none of the operational notifications (routing by role).
  const vctx = await browser.newContext();
  const vpage = await vctx.newPage();
  await signIn(vpage, 'viewer');
  await vpage
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: /^Notifications/ })
    .click();
  await expect(vpage.locator('[data-trigger-kind="APPROVAL_REQUIRED"]')).toHaveCount(0);
  await expect(vpage.getByText('No notifications for your roles', { exact: false })).toBeVisible();
  await vctx.close();
});
