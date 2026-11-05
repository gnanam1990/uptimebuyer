// Shared helpers for the M12 browser tests: the seeded manifest, keyboard-only navigation (Tab until the target holds
// focus, then a key — never a mouse click), sign-in through the test OIDC popup, API truth reads with a token obtained
// through the same authorization-code + PKCE flow, live-region reads and an axe-core WCAG 2.2 AA scan.
import { createHash, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

/** Seeded ids per scenario; a scenario carries only the ids that apply to it. */
export interface SeededIncident {
  incidentId: string;
  assetId: string;
  planId: string;
  approvalRequestId: string;
  merchantId: string;
  purpose: string;
  amountMinor: string;
  currency: string;
  orderId: string;
  authorityId: string;
}
export interface Manifest {
  tenantId: string;
  siteId: string;
  idp: { authorizationEndpoint: string; tokenEndpoint: string; clientId: string };
  users: Record<string, { userId: string }>;
  incidents: Record<string, SeededIncident>;
  assets: Record<string, string>;
}

export const manifest = (): Manifest => {
  const raw = process.env.UB_E2E_MANIFEST;
  if (!raw) throw new Error('UB_E2E_MANIFEST is not set (global setup did not run).');
  return JSON.parse(raw) as Manifest;
};
export const base = (): string => {
  const b = process.env.UB_E2E_BASE_URL;
  if (!b) throw new Error('UB_E2E_BASE_URL is not set (global setup did not run).');
  return b;
};

/** Press Tab until `target` is focused (proves it is in the keyboard order), failing after `max` presses. */
export async function tabTo(page: Page, target: Locator, max = 250): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) throw new Error('tabTo: target not found');
  for (let i = 0; i < max; i++) {
    if (await handle.evaluate((el) => el === document.activeElement)) {
      await expect(target).toBeFocused();
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('tabTo: target never received keyboard focus');
}

/** Keyboard activation of a control reached by Tab. */
export async function press(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** Select a radio in a group with the keyboard: Tab into the group, then arrow keys until `label` is checked. */
export async function chooseRadio(page: Page, group: Locator, label: string | RegExp): Promise<void> {
  const radio = group.getByRole('radio', { name: label });
  const first = group.getByRole('radio').first();
  const checked = group.getByRole('radio', { checked: true });
  await tabTo(page, (await checked.count()) > 0 ? checked.first() : first);
  for (let i = 0; i < 40; i++) {
    if (await radio.isChecked()) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`chooseRadio: could not reach ${String(label)}`);
}

export async function announcements(page: Page): Promise<string> {
  return (await page.locator('#announcer').textContent()) ?? '';
}

export async function signIn(page: Page, login: string, path = '/'): Promise<void> {
  await page.goto(`${base()}${path}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to UptimeBuyer Operations' })).toBeVisible();
  await tabTo(page, page.getByRole('textbox', { name: 'Login hint (optional)' }));
  await page.keyboard.type(login);
  const popup = page.waitForEvent('popup');
  await press(page, page.getByRole('button', { name: 'Sign in with identity provider' }));
  await (await popup).waitForEvent('close');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** An access token for API truth reads, through the same authorization-code + PKCE flow the browser uses. */
export async function tokenFor(login: string): Promise<string> {
  const m = manifest();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(m.idp.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', m.idp.clientId);
  u.searchParams.set('redirect_uri', `${base()}/auth/callback`);
  u.searchParams.set('state', 'api-truth');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('login_hint', login);
  const r = await fetch(u, { redirect: 'manual' });
  const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(m.idp.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: `${base()}/auth/callback`,
      client_id: m.idp.clientId,
    }),
  });
  return ((await t.json()) as { access_token: string }).access_token;
}

export async function apiGet<T = Record<string, unknown>>(login: string, path: string): Promise<T> {
  const r = await fetch(`${base()}${path}`, { headers: { authorization: `Bearer ${await tokenFor(login)}` } });
  if (!r.ok) throw new Error(`API ${path} -> ${r.status}`);
  return (await r.json()) as T;
}

export async function apiPost(login: string, path: string, body: unknown, version?: number) {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await tokenFor(login)}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-${randomBytes(8).toString('hex')}`,
      ...(version !== undefined ? { 'if-match': `"${version}"` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** axe-core WCAG 2.0/2.1/2.2 A and AA scan of the current page; any violation fails with its rule ids. */
export async function expectAccessible(page: Page, context: string): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(
    r.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
    context,
  ).toEqual([]);
}

/** The status badge contract: separate axis, closed value, text label, icon shape and an accessible description. */
export function badge(scope: Page | Locator, axis: string, value?: string): Locator {
  return scope.locator(`[data-axis="${axis}"]${value ? `[data-value="${value}"]` : ''}`);
}

export const GREEN = 'rgb(34, 197, 94)';
