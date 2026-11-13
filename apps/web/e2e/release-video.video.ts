// Demo video parts (T-059, INV-12; scripts/release/demo-video.mjs writes the plan into UB_VIDEO_WORK). Two steps:
//   1. render every still frame of the video (slides with burned-in captions, the console overlay) from local HTML;
//   2. record the operator console walk-through against the local SIMULATED stack as a Playwright video, holding each
//      step for its planned duration and writing when each hold started, so the composer cuts exact windows.
// Every console input is synthetic: SIMULATOR sensors (SIMULATED_INPUT), a RECORDED_CONTRACT broker, CONTRACT_FAKE CMMS
// and reasoning, synthetic citations and a test identity provider. The environment label naming the simulation is
// asserted on every recorded page, and the composer adds a persistent SIMULATED banner around the recording.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { manifest, signIn } from './support/fixtures.js';

interface Plan {
  stills: { html: string; png: string; transparent: boolean }[];
  console: {
    steps: { step: string; hold: number }[];
    video: string;
    marks: string;
    zoom: number;
    size: { width: number; height: number };
  };
}
const work = process.env.UB_VIDEO_WORK;
const plan = (): Plan => {
  if (!work) throw new Error('UB_VIDEO_WORK is not set: run node scripts/release/demo-video.mjs');
  return JSON.parse(readFileSync(`${work}/plan.json`, 'utf8')) as Plan;
};
const LABEL = /SIMULATED_INPUT/;

test.describe.configure({ mode: 'serial' });

test('demo video: render the still frames', async ({ browser }) => {
  const p = plan();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  for (const s of p.stills) {
    await page.goto(pathToFileURL(s.html).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: s.png, omitBackground: s.transparent, animations: 'disabled' });
  }
  await context.close();
  expect(p.stills.length).toBeGreaterThan(10);
});

test('demo video: record the SIMULATED operator console walk-through', async ({ browser }) => {
  test.setTimeout(600_000);
  const p = plan();
  const m = manifest();
  // The recording is made at the size it is shown in the frame (no rescaling); the page is zoomed like a browser zoom
  // so its layout matches the console's usual 1280-pixel width and the text stays readable at 1080p.
  const size = { width: p.console.size.width, height: p.console.size.height };
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    recordVideo: { dir: `${work}/raw-video`, size },
  });
  await context.addInitScript((zoom) => {
    const apply = () => document.documentElement.style.setProperty('zoom', String(zoom));
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  }, p.console.zoom);
  const t0 = Date.now();
  const page = await context.newPage();
  const marks: { step: string; start: number; hold: number }[] = [];

  // Bearer tokens live in memory only, so a full page load would sign out: move within the app through history.
  const go = async (to: string) => {
    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.scrollTo(0, 0);
    }, to);
  };
  const ready = async (pg: Page) => {
    await expect(pg.getByRole('note', { name: 'Environment' })).toContainText(LABEL);
    await expect(pg.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(pg.getByRole('main')).not.toContainText(/loading/i, { timeout: 30_000 });
    await pg.waitForTimeout(400);
  };
  const hold = async (step: string, scroll = 0) => {
    const s = p.console.steps.find((x) => x.step === step);
    if (!s) throw new Error(`step ${step} is not in the plan`);
    await ready(page);
    marks.push({ step, start: (Date.now() - t0) / 1000, hold: s.hold });
    const ms = s.hold * 1000;
    if (scroll > 0) {
      await page.waitForTimeout(ms * 0.45);
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), scroll);
      await page.waitForTimeout(ms * 0.55);
    } else await page.waitForTimeout(ms);
  };

  await signIn(page, 'approver');
  await expect(page.getByRole('heading', { level: 1, name: /^Command Center/ })).toBeVisible();
  await hold('command-center', 260);

  const approval = m.incidents.approval!;
  await go(`/incidents/${approval.incidentId}`);
  await expect(page.getByRole('region', { name: 'Incident status' })).toContainText('Awaiting approval');
  await hold('incident');
  await go(`/incidents/${approval.incidentId}/evidence`);
  await hold('evidence', 420);
  await go(`/incidents/${approval.incidentId}/plan`);
  await hold('plan', 420);

  const recovered = m.incidents.recovered!;
  await go(`/incidents/${recovered.incidentId}/spend`);
  await hold('order', 300);
  const unknown = m.incidents.unknownIntent!;
  await go(`/incidents/${unknown.incidentId}/spend`);
  await hold('unknown', 300);
  await go(`/incidents/${recovered.incidentId}/verification`);
  await hold('verification', 360);

  // The tenant ledger is an administrator view.
  await signIn(page, 'admin');
  await go('/ledger');
  await hold('ledger', 240);

  const video = page.video();
  await context.close();
  if (!video) throw new Error('no video was recorded');
  await video.saveAs(p.console.video);
  writeFileSync(p.console.marks, `${JSON.stringify(marks, null, 2)}\n`);
  expect(marks.map((x) => x.step)).toEqual(p.console.steps.map((x) => x.step));
});
