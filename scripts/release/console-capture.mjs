#!/usr/bin/env node
// Console capture for the demo video (T-059; docs/release/VIDEO-PLAN.md). Drives the operator console of the local
// SIMULATED stack with real pointer moves and clicks (register, section tabs, citation drawer, approval dialog) and
// captures it through the Chrome DevTools screencast at twice the frame size (the page zoom doubles with it, so the
// layout is the console's usual one), so the clip stays sharp when the editor zooms in. Writes, into --out:
//   frames/NNNNN.jpg + frames.json   every screencast frame with its capture time
//   console-marks.json               when each console step of the video timeline starts and how long it is held
//   cursor.json                      the pointer path in Recordly's telemetry format (move / click / mouseup)
//   focus.json                       per step, the region the editor zooms to (normalised to the viewport)
// The stack is the one `apps/web/e2e/support/stack.ts` starts (seeded throwaway database, SIMULATOR sensors,
// RECORDED_CONTRACT broker, contract-fake reasoning and CMMS, test identity provider); pass its origin and manifest.
//   node scripts/release/console-capture.mjs --origin http://127.0.0.1:PORT --manifest manifest.json --out <dir>
/* global document, window, PopStateEvent -- page.evaluate and init-script bodies run in the browser */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS, CONSOLE_RECT, CONSOLE_ZOOM } from './demo-video.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = createRequire(path.join(repo, 'apps', 'web', 'package.json'))('@playwright/test');

const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const origin = val('--origin');
const out = path.resolve(val('--out') ?? '.');
const m = JSON.parse(readFileSync(val('--manifest'), 'utf8'));
if (!origin || !m.incidents) throw new Error('usage: --origin <url> --manifest <file> --out <dir>');

const SCALE = 2;
const VIEW = { width: CONSOLE_RECT.width * SCALE, height: CONSOLE_RECT.height * SCALE };
const LEAD = 1.5; // seconds held beyond each caption, as the composer expects
const steps = SEGMENTS.find((s) => s.id === 'console').steps.map((s) => ({ step: s.step, seconds: s.s }));
const secondsOf = (step) => steps.find((s) => s.step === step).seconds;

mkdirSync(path.join(out, 'frames'), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
await context.addInitScript((zoom) => {
  const apply = () => document.documentElement.style.setProperty('zoom', String(zoom));
  if (document.documentElement) apply();
  else document.addEventListener('DOMContentLoaded', apply);
}, CONSOLE_ZOOM * SCALE);
const page = await context.newPage();

// --- screencast: every frame with its own capture time (seconds since the capture started).
const cdp = await context.newCDPSession(page);
const frames = [];
let t0 = 0;
let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const t = f.metadata.timestamp;
  if (!t0) t0 = t;
  const file = `frames/${String(n++).padStart(5, '0')}.jpg`;
  writeFileSync(path.join(out, file), Buffer.from(f.data, 'base64'));
  frames.push({ file, t: t - t0 });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
const clock = () => (t0 ? Date.now() / 1000 - t0 : 0);

// --- pointer: real mouse moves and clicks, logged as Recordly telemetry (normalised to the viewport).
const cursor = [];
let pos = { x: VIEW.width * 0.62, y: VIEW.height * 0.55 };
const log = (type, p) =>
  cursor.push({
    timeMs: Math.max(0, Math.round(clock() * 1000)),
    cx: +(p.x / VIEW.width).toFixed(5),
    cy: +(p.y / VIEW.height).toFixed(5),
    interactionType: type,
    cursorType: type === 'move' ? 'arrow' : 'pointer',
  });
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
async function glide(to, ms = 650) {
  const from = { ...pos };
  const k = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= k; i++) {
    const u = ease(i / k);
    pos = { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
    await page.mouse.move(pos.x, pos.y);
    log('move', pos);
    await page.waitForTimeout(ms / k);
  }
}
async function centre(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}
async function click(locator, ms) {
  const c = await centre(locator);
  await glide(c, ms);
  await page.mouse.down();
  log('click', pos);
  await page.waitForTimeout(90);
  await page.mouse.up();
  log('mouseup', pos);
  return c;
}
async function idle(ms) {
  // a small drift so the cursor does not freeze while the viewer reads
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(120);
    log('move', pos);
  }
}
const ready = async () => {
  // The environment label naming the simulation is on every captured page.
  const env = await page.getByRole('note', { name: 'Environment' }).textContent();
  if (!/SIMULATED_INPUT/.test(env ?? '')) throw new Error(`environment label does not name SIMULATED_INPUT: ${env}`);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page
    .getByRole('main')
    .getByText(/loading/i)
    .first()
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => {});
  await page.waitForTimeout(350);
};
const go = async (to) => {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo(0, 0);
  }, to);
  await ready();
};
async function signIn(login) {
  await page.goto(`${origin}/`);
  await page.getByRole('heading', { level: 1, name: 'Sign in to UptimeBuyer Operations' }).waitFor();
  await page.getByRole('textbox', { name: 'Login hint (optional)' }).fill(login);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with identity provider' }).click();
  await (await popup).waitForEvent('close');
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await ready();
}
/** A padded box, normalised to the viewport and kept inside it (x + w and y + h never exceed 1). */
const norm = (b, pad = 24 * SCALE) => {
  const w = Math.min(1, (b.width + 2 * pad) / VIEW.width);
  const h = Math.min(1, (b.height + 2 * pad) / VIEW.height);
  const x = Math.min(Math.max(0, (b.x - pad) / VIEW.width), 1 - w);
  const y = Math.min(Math.max(0, (b.y - pad) / VIEW.height), 1 - h);
  return { x, y, w, h };
};

const marks = [];
const focus = [];
/** A step: `start` is when the cut begins (the composer adds 0.5 s), held for its caption plus LEAD. */
async function step(name, body) {
  const s = secondsOf(name);
  const start = clock() - 0.5;
  marks.push({ step: name, start: +start.toFixed(3), hold: s + LEAD });
  const f = await body(s);
  if (f) focus.push({ step: name, ...f });
  const left = start + s + LEAD - clock();
  // The composer cuts exactly the planned window: a step whose actions run past it would lose its ending.
  if (left < 0) throw new Error(`console step ${name} ran ${(-left).toFixed(2)} s past its planned hold`);
  await idle(left * 1000);
}
const section = (label) =>
  page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: label, exact: true });

await signIn('approver');
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 92,
  maxWidth: VIEW.width,
  maxHeight: VIEW.height,
  everyNthFrame: 1,
});
await page.mouse.move(pos.x, pos.y);
await page.waitForTimeout(800);
log('move', pos);
const approval = m.incidents.approval.incidentId;
const recovered = m.incidents.recovered.incidentId;
const unknown = m.incidents.unknownIntent.incidentId;

await step('command-center', async (s) => {
  const fleet = page.getByRole('main').locator('section, .sheet, [role=region]').first();
  const fb = (await fleet.boundingBox()) ?? { x: 300, y: 100, width: 900, height: 300 };
  await glide({ x: fb.x + fb.width * 0.55, y: fb.y + fb.height * 0.45 }, 900);
  await idle(s * 1000 * 0.35);
  await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
  return { at: 1.2, until: s * 0.45, ...norm(fb) };
});

await step('incident', async (s) => {
  await click(page.getByRole('link', { name: `Open incident ${approval}` }).first(), 750);
  await ready();
  const plate = page.getByRole('region', { name: 'Incident status' });
  const pb = await plate.boundingBox();
  // rest beside the reading, never over its SIMULATED_INPUT tag
  await glide({ x: pb.x + pb.width * 0.27, y: pb.y + pb.height * 0.3 }, 700);
  return { at: 1.6, until: s - 0.6, ...norm({ ...pb, width: pb.width * 0.55 }) };
});

await step('evidence', async (s) => {
  await click(section('Evidence'), 650);
  await ready();
  const cite = page.getByRole('button', { name: /^Open citation/ }).first();
  await click(cite, 800);
  const dlg = page.getByRole('dialog', { name: 'Citation' });
  await dlg.waitFor();
  await page.waitForTimeout(300);
  const db = await dlg.boundingBox();
  await glide({ x: db.x + db.width * 0.5, y: db.y + db.height * 0.35 }, 600);
  return { at: 2.6, until: s + 0.4, ...norm(db, 12 * SCALE) };
});
await page.keyboard.press('Escape');

await step('plan', async (s) => {
  await click(section('Recovery plan'), 650);
  await ready();
  await click(page.getByRole('button', { name: /^Approve up to / }), 900);
  const dlg = page.getByRole('dialog', { name: 'Confirm spending approval' });
  await dlg.waitFor();
  await page.waitForTimeout(300);
  const db = await dlg.boundingBox();
  await glide({ x: db.x + db.width * 0.5, y: db.y + db.height * 0.4 }, 600);
  return { at: 2.6, until: s + 0.4, ...norm(db, 12 * SCALE) };
});
await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

async function spendStep(name, incident, pick) {
  await go(`/incidents/${incident}`);
  await step(name, async (s) => {
    await click(section('Spend & orders'), 700);
    await ready();
    const target = pick();
    const tb = await centre(target);
    // rest just above the right end of the subject, so no status text is covered
    await glide({ x: tb.box.x + tb.box.width * 0.9, y: tb.box.y - 34 * SCALE }, 800);
    return { at: 1.8, until: s - 0.5, ...norm(tb.box) };
  });
}
await spendStep('order', recovered, () => page.getByRole('main').getByRole('region').nth(1));
await spendStep('unknown', unknown, () => page.getByRole('main').getByText('UNKNOWN', { exact: false }).first());

await go(`/incidents/${recovered}`);
await step('verification', async (s) => {
  await click(section('Verification'), 700);
  await ready();
  const r = page.getByRole('main').getByRole('region').nth(1);
  const rb = await centre(r);
  await glide({ x: rb.x, y: rb.box.y + 40 * SCALE }, 800);
  return { at: 1.8, until: s - 0.5, ...norm(rb.box) };
});

// The tenant ledger is an administrator view: sign in as the administrator, then open it from the navigation.
await cdp.send('Page.stopScreencast');
await signIn('admin');
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 92,
  maxWidth: VIEW.width,
  maxHeight: VIEW.height,
  everyNthFrame: 1,
});
await page.waitForTimeout(500);
await step('ledger', async (s) => {
  await click(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Evidence ledger' }), 800);
  await ready();
  const t = page.getByRole('main').getByRole('table').first();
  const tb = await centre(t);
  await glide({ x: tb.box.x + tb.box.width * 0.3, y: tb.box.y + 60 * SCALE }, 700);
  return { at: 1.6, until: s, ...norm({ ...tb.box, height: Math.min(tb.box.height, VIEW.height * 0.6) }) };
});
await cdp.send('Page.stopScreencast');
await browser.close();

writeFileSync(path.join(out, 'frames.json'), `${JSON.stringify(frames)}\n`);
writeFileSync(path.join(out, 'console-marks.json'), `${JSON.stringify(marks, null, 2)}\n`);
writeFileSync(path.join(out, 'cursor.json'), `${JSON.stringify({ version: 2, samples: cursor })}\n`);
writeFileSync(path.join(out, 'focus.json'), `${JSON.stringify(focus, null, 2)}\n`);
console.log(JSON.stringify({ frames: frames.length, seconds: frames.at(-1)?.t, marks }, null, 2));
