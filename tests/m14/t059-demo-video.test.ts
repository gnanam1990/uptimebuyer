// T-059 (INV-12) demo video: the timeline in scripts/release/demo-video.mjs is the single source of the video's
// segments and captions and of docs/release/SUBTITLES.srt; the REAL slides are rendered only from the committed
// evidence records; every console frame says SIMULATED and no evidence slide does; nothing on screen carries a wallet
// address or an e-mail.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from '../m00/helpers.js';

const dv = await import(path.join(repoRoot, 'scripts', 'release', 'demo-video.mjs'));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

type Part = {
  kind: 'still' | 'console';
  label: string;
  segment: string;
  caption: string;
  html: string;
  seconds: number;
  slide?: string;
};
const plan = dv.buildPlan(repoRoot, '/nonexistent-work-dir') as { parts: Part[]; totalSeconds: number };

describe('T-059 demo video timeline', () => {
  it('runs the planned segments in order, about two to three minutes long', () => {
    expect(dv.SEGMENTS.map((s: { id: string }) => s.id)).toEqual([
      'title',
      'architecture',
      'console',
      'real-serv',
      'real-kite',
      'not-yet',
      'end',
    ]);
    expect(plan.totalSeconds).toBeGreaterThanOrEqual(120);
    expect(plan.totalSeconds).toBeLessThanOrEqual(180);
    expect(plan.parts.reduce((t, p) => t + p.seconds, 0)).toBe(plan.totalSeconds);
  });

  it('SUBTITLES.srt is exactly the timeline (the burned-in captions are the same strings)', () => {
    expect(read('docs/release/SUBTITLES.srt')).toBe(dv.toSrt());
    const r = run('node', ['scripts/release/demo-video.mjs', '--check']);
    expect(r.code).toBe(0);
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    for (const p of plan.parts) expect(p.html).toContain(esc(p.caption.replace(/^(SIMULATED:|REAL EVIDENCE:)\s*/, '')));
  });

  it('labels every simulated part SIMULATED and never labels an evidence slide so', () => {
    const consoleParts = plan.parts.filter((p) => p.kind === 'console');
    expect(consoleParts.length).toBe(8);
    for (const p of consoleParts) {
      expect(p.label).toBe('SIMULATED');
      expect(p.caption).toMatch(/^SIMULATED: /);
      expect(p.html).toContain('SIMULATED &middot; local demo stack');
      expect(p.html).toContain('SIMULATED_INPUT');
      expect(p.html).not.toContain('REAL EVIDENCE');
    }
    const real = plan.parts.filter((p) => p.segment.startsWith('real-'));
    expect(real.length).toBeGreaterThanOrEqual(6);
    for (const p of real) {
      expect(p.label).toBe('REAL');
      expect(p.html).toContain('badge real');
      expect(p.html).not.toContain('badge sim');
      expect(p.caption).not.toMatch(/^SIMULATED/);
    }
    const notYet = plan.parts.filter((p) => p.segment === 'not-yet');
    for (const p of notYet) expect(p.html).toMatch(/NOT_RUN/);
  });

  it('renders the REAL slides from the committed evidence records', () => {
    const html = (slide: string) =>
      plan.parts
        .filter((p) => p.slide === slide)
        .map((p) => p.html)
        .join('\n');
    const rsn = JSON.parse(read('evidence/journeys/j-2026-11-12-serv-document-2/reasoning.json'));
    expect(html('serv-run')).toContain(rsn.costUsd);
    expect(html('serv-run')).toContain(rsn.modelEchoed);
    expect(html('serv-run')).toContain('7 of 7 re-opened and verified');
    const servGate = JSON.parse(read('docs/release/evidence/t058-journey-j-2026-11-12-serv-document-2.gate.json'));
    for (const part of servGate.parts) expect(html('serv-gate')).toContain(`<td>${part.part}</td>`);
    expect(html('serv-gate')).toContain('REJECTED');
    const merchant = JSON.parse(read('evidence/journeys/j-2026-11-13-kite-payment-2/merchant-response.json'));
    expect(html('kite-merchant')).toContain(`HTTP ${merchant.statusCode}, ${merchant.resultCount} results`);
    expect((html('kite-merchant').match(/<tr><td>\d<\/td>/g) ?? []).length).toBe(merchant.resultCount);
    expect(html('kite-unknown')).toContain('2366');
    expect(html('kite-unknown')).toContain('OPEN QUESTION');
    expect(html('kite-unknown')).toContain('CAPTURED');
    const kiteGate = JSON.parse(read('docs/release/evidence/t058-journey-j-2026-11-13-kite-payment-2.gate.json'));
    const passed = kiteGate.parts
      .filter((p: { status: string }) => p.status === 'PASS')
      .map((p: { part: string }) => p.part);
    expect(passed.sort()).toEqual(['duplicate', 'fulfillment', 'payment']);
    expect(html('kite-gate')).toContain('journey overall</b></td><td><span class="pill NOT_RUN">');
  });

  it('puts no wallet address, e-mail or full account id on screen', () => {
    for (const p of plan.parts) {
      expect(p.html, p.segment).not.toMatch(/0x[a-fA-F0-9]{40}/);
      expect(p.html, p.segment).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(p.html, p.segment).not.toMatch(/ten_[0-9a-f-]{36}|agent_session_req_/);
    }
  });
});
