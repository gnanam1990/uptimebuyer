// T-059 (INV-12) demo video: the timeline in scripts/release/demo-video.mjs is the single source of the video's
// segments and captions and of docs/release/SUBTITLES.srt; the REAL slides are rendered only from the committed
// evidence records; every console frame says SIMULATED and no evidence slide does; nothing on screen carries a wallet
// address or an e-mail; the committed video is the file its manifest and the VIDEO_UPLOAD request describe.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('T-059 committed demo video', () => {
  const manifest = JSON.parse(read('docs/release/video/video-manifest.json'));
  const file = path.join(repoRoot, manifest.file);

  it('is the file its manifest names: digest, size under 25 MB, 1080p at 30 fps, the timeline length', () => {
    expect(manifest.file).toBe('docs/release/video/uptimebuyer-demo.mp4');
    const bytes = readFileSync(file);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
    expect(statSync(file).size).toBe(manifest.bytes);
    expect(manifest.bytes).toBeLessThan(25_000_000);
    expect(manifest).toMatchObject({ width: 1920, height: 1080, codec: 'h264', frameRate: '30/1' });
    expect(Math.abs(manifest.durationSeconds - plan.totalSeconds)).toBeLessThan(0.5);
    expect(manifest.segments.map((x: { id: string; label: string }) => `${x.id}:${x.label}`)).toEqual(
      dv.SEGMENTS.map((x: { id: string; label: string }) => `${x.id}:${x.label}`),
    );
  });

  it('is the file the VIDEO_UPLOAD request in GATE-REQUESTS.md names', () => {
    expect(read('docs/release/GATE-REQUESTS.md')).toContain(manifest.sha256);
  });
});

// PR #26 review: --skip-record reuses the console recording only. Every still and overlay must have been rendered from
// exactly the HTML the current timeline and evidence produce; otherwise the build stops before encoding anything.
describe('T-059 demo video --skip-record never re-encodes stale frames', () => {
  const htmlSha = (h: string) => createHash('sha256').update(h, 'utf8').digest('hex');
  const rendered = (parts: Part[]) => ({
    schema: 'demo-video-rendered.v1',
    stills: parts.map((p) => ({ png: path.basename((p as Part & { png: string }).png), htmlSha256: htmlSha(p.html) })),
  });

  it('staleStills is empty for frames rendered from the current HTML and names every changed or missing frame', () => {
    expect(dv.staleStills(plan.parts, rendered(plan.parts))).toEqual([]);
    const old = rendered(plan.parts);
    old.stills[3]!.htmlSha256 = htmlSha('an older caption');
    old.stills.splice(10, 1);
    const stale = dv.staleStills(plan.parts, old);
    expect(stale).toEqual([
      path.basename((plan.parts[3] as Part & { png: string }).png),
      path.basename((plan.parts[10] as Part & { png: string }).png),
    ]);
    expect(dv.staleStills(plan.parts, undefined)).toHaveLength(plan.parts.length);
  });

  it('the CLI refuses to compose from stale frames and writes no video, subtitles or manifest', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'ub-t059-skip-'));
    try {
      const srtBefore = read('docs/release/SUBTITLES.srt');
      const manifestBefore = read('docs/release/video/video-manifest.json');
      const workPlan = dv.buildPlan(repoRoot, work) as { parts: (Part & { png: string })[] };
      const old = rendered(workPlan.parts);
      old.stills[0]!.htmlSha256 = htmlSha('a caption that has since changed');
      writeFileSync(path.join(work, 'rendered.json'), JSON.stringify(old));
      for (const p of workPlan.parts) writeFileSync(p.png, 'not really a png');
      writeFileSync(path.join(work, 'console.webm'), 'not really a video');
      writeFileSync(
        path.join(work, 'console-marks.json'),
        JSON.stringify(
          dv.SEGMENTS.find((x: { id: string }) => x.id === 'console').steps.map((x: { step: string; s: number }) => ({
            step: x.step,
            start: 1,
            hold: x.s + 1.5,
          })),
        ),
      );
      const out = path.join(work, 'out.mp4');
      const r = run('node', ['scripts/release/demo-video.mjs', '--work', work, '--skip-record', '--out', out]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/stale/);
      expect(r.stderr).toContain(path.basename(workPlan.parts[0]!.png));
      expect(existsSync(out)).toBe(false);
      expect(read('docs/release/SUBTITLES.srt')).toBe(srtBefore);
      expect(read('docs/release/video/video-manifest.json')).toBe(manifestBefore);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
