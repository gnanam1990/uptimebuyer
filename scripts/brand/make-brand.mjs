#!/usr/bin/env node
// UptimeBuyer brand assets (docs/brand/). The mark is the console's cooler faceplate: one temperature trace that breaches
// the dashed threshold (drawn hot above it) and settles back (coolant below it), above the console's thermal scale with
// its threshold tick; colours are the console's tokens (apps/web/src/styles.css). Writes the icon as SVG and renders the
// icon and the logo lockups to PNG with Playwright Chromium. The lockups set their text in the console's own fonts
// (@fontsource Barlow Semi Condensed and Atkinson Hyperlegible Next, OFL), embedded only in a temporary SVG for rendering.
//   node scripts/brand/make-brand.mjs [<out dir>]   (default docs/brand)
/* global document -- page.evaluate bodies run in the browser */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(process.argv[2] ?? path.join(repo, 'docs', 'brand'));
const tmp = mkdtempSync(path.join(tmpdir(), 'ub-brand-'));
mkdirSync(out, { recursive: true });
const req = createRequire(path.join(repo, 'apps', 'web', 'package.json'));
const font = (pkg, file) =>
  readFileSync(path.join(path.dirname(req.resolve(`${pkg}/package.json`)), 'files', file)).toString('base64');
const BARLOW = font('@fontsource/barlow-semi-condensed', 'barlow-semi-condensed-latin-600-normal.woff2');
const ATK = font('@fontsource/atkinson-hyperlegible-next', 'atkinson-hyperlegible-next-latin-400-normal.woff2');
const FACES = `@font-face{font-family:'UB Display';src:url(data:font/woff2;base64,${BARLOW}) format('woff2');font-weight:600}
@font-face{font-family:'UB Text';src:url(data:font/woff2;base64,${ATK}) format('woff2');font-weight:400}`;

const C = {
  cabinet: '#0c1a23',
  raised: '#15293a',
  line: '#2c4858',
  well: '#071219',
  text: '#e6eef2',
  muted: '#a3b7c2',
  ink: '#102028',
  steel: '#4a5b66',
  coolant: '#6fe0f2',
  ice: '#7cc8f0',
  cool: '#3e9bd6',
  warm: '#f2b33d',
  hot: '#e2543a',
};

/** The mark, drawn on a 512 grid: a cooler faceplate whose trace breaches the threshold and settles back (failure to
 *  recovery), above the console's thermal scale with its threshold tick. */
function mark(id) {
  // trace points (x, y) inside the display window 88..424 x 104..280; threshold at y = 168
  const trace =
    'M112 238 C 150 238 162 232 184 232 S 214 236 226 228 L 250 140 Q 266 104 282 140 L 300 236 C 318 246 346 226 372 232 S 396 236 400 234';
  return `
  <defs>
    <linearGradient id="${id}-cab" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.raised}"/><stop offset="1" stop-color="${C.cabinet}"/>
    </linearGradient>
    <linearGradient id="${id}-scale" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.ice}"/><stop offset="1" stop-color="${C.cool}"/>
    </linearGradient>
    <clipPath id="${id}-above"><rect x="88" y="104" width="336" height="64"/></clipPath>
    <clipPath id="${id}-below"><rect x="88" y="168" width="336" height="112"/></clipPath>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="112" fill="url(#${id}-cab)" stroke="${C.line}" stroke-width="6"/>
  <rect x="88" y="104" width="336" height="176" rx="30" fill="${C.well}"/>
  <path d="M112 168 H400" stroke="${C.warm}" stroke-width="5" stroke-dasharray="12 10" stroke-linecap="round" opacity="0.9"/>
  <path d="${trace}" fill="none" stroke="${C.coolant}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${id}-below)"/>
  <path d="${trace}" fill="none" stroke="${C.hot}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${id}-above)"/>
  <rect x="88" y="330" width="336" height="48" rx="24" fill="${C.well}"/>
  <rect x="88" y="330" width="208" height="48" rx="24" fill="url(#${id}-scale)"/>
  <rect x="322" y="314" width="10" height="80" rx="5" fill="${C.text}"/>`;
}

const icon = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="UptimeBuyer">${mark('i')}</svg>\n`;

function lockup({ dark, tagline }) {
  const W = 1600;
  const H = tagline ? 520 : 440;
  const bg = dark ? C.cabinet : '#ffffff';
  const fg = dark ? C.text : C.ink;
  const sub = dark ? C.muted : C.steel;
  const markSize = 320;
  const my = (H - markSize) / 2;
  const tx = 60 + markSize + 72;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="UptimeBuyer">
  <style>${FACES}</style>
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g transform="translate(60 ${my}) scale(${markSize / 512})">${mark(dark ? 'd' : 'l')}</g>
  <text x="${tx}" y="${tagline ? H / 2 + 18 : H / 2 + 62}" font-family="'UB Display'" font-weight="600" font-size="184" letter-spacing="-1" fill="${fg}">UptimeBuyer</text>
  ${tagline ? `<text x="${tx + 6}" y="${H / 2 + 104}" font-family="'UB Text'" font-size="46" fill="${sub}">Refrigeration recovery with bounded spending</text>` : ''}
</svg>\n`;
}

writeFileSync(path.join(out, 'uptimebuyer-icon.svg'), icon(512));
const sources = {
  'uptimebuyer-icon.svg': path.join(out, 'uptimebuyer-icon.svg'),
  'uptimebuyer-logo-dark.svg': path.join(tmp, 'logo-dark.svg'),
  'uptimebuyer-logo-light.svg': path.join(tmp, 'logo-light.svg'),
  'uptimebuyer-wordmark-dark.svg': path.join(tmp, 'wordmark-dark.svg'),
};
writeFileSync(sources['uptimebuyer-logo-dark.svg'], lockup({ dark: true, tagline: true }));
writeFileSync(sources['uptimebuyer-logo-light.svg'], lockup({ dark: false, tagline: true }));
writeFileSync(sources['uptimebuyer-wordmark-dark.svg'], lockup({ dark: true, tagline: false }));

const { chromium } = req('@playwright/test');
const browser = await chromium.launch();
const shoot = async (svgFile, png, w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const svg = readFileSync(sources[svgFile], 'utf8').replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(out, png), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
};
await shoot('uptimebuyer-icon.svg', 'uptimebuyer-icon-1024.png', 1024, 1024);
await shoot('uptimebuyer-icon.svg', 'uptimebuyer-icon-512.png', 512, 512);
await shoot('uptimebuyer-icon.svg', 'uptimebuyer-icon-64.png', 64, 64);
await shoot('uptimebuyer-logo-dark.svg', 'uptimebuyer-logo-dark.png', 1600, 520);
await shoot('uptimebuyer-logo-light.svg', 'uptimebuyer-logo-light.png', 1600, 520);
await shoot('uptimebuyer-wordmark-dark.svg', 'uptimebuyer-wordmark-dark.png', 1600, 440);
await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(out);
