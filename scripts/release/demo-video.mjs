#!/usr/bin/env node
// Demo video for the SERV Hackathon 02 submission (T-059; docs/release/VIDEO-PLAN.md). Reproducible and offline:
//   1. the timeline below is the single source of the video's segments, captions and docs/release/SUBTITLES.srt;
//   2. the REAL evidence slides are rendered from the committed evidence records (evidence/journeys/*,
//      docs/release/evidence/*), never typed by hand, so a slide cannot say more than the record does;
//   3. Playwright (apps/web/playwright.video.config.ts) renders every still and records the operator console against
//      the local SIMULATED e2e stack (seeded throwaway database, SIMULATOR sensors, RECORDED_CONTRACT broker,
//      contract-fake reasoning and CMMS, test identity provider); the stack drops its database on exit;
//   4. ffmpeg composes the parts at 1920x1080, 30 fps, with the captions burned in (rendered as part of each frame:
//      this ffmpeg build has no libass/freetype), and writes docs/release/video/video-manifest.json.
// No network call beyond 127.0.0.1, no upload. Every console frame carries a persistent SIMULATED banner and every
// evidence slide a REAL label naming its record.
//   node scripts/release/demo-video.mjs [--out <mp4>] [--work <dir>] [--skip-record]   (needs DATABASE_URL)
//   node scripts/release/demo-video.mjs --srt      write docs/release/SUBTITLES.srt from the timeline
//   node scripts/release/demo-video.mjs --check    exit 1 if SUBTITLES.srt differs from the timeline
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_URL = 'github.com/gnanam1990/uptimebuyer';
export const SERV_JOURNEY = 'j-2026-11-12-serv-document-2';
export const SERV_JOURNEY_FIRST = 'j-2026-11-12-serv-document';
export const KITE_JOURNEY = 'j-2026-11-13-kite-payment-2';
export const KITE_JOURNEY_FIRST = 'j-2026-11-13-kite-payment';
export const FRAME = { width: 1920, height: 1080, fps: 30 };
/** Where the console recording sits inside the frame (16:9, below the SIMULATED banner, above the caption band). */
export const CONSOLE_RECT = { x: 176, y: 70, width: 1568, height: 882 };
/** Page zoom of the recorded console (a 1568-pixel viewport at 1.2 lays out like the console's usual 1280 pixels). */
export const CONSOLE_ZOOM = 1.2;

/**
 * The video, in order. label: CONTEXT (title, architecture, end card), SIMULATED (the local demo stack), REAL (committed
 * evidence of real runs) or NOT_RUN (what is not yet proven). Each caption is shown for `s` seconds, back to back.
 */
export const SEGMENTS = [
  {
    id: 'title',
    label: 'CONTEXT',
    kind: 'slide',
    slides: [
      {
        slide: 'title',
        captions: [
          {
            s: 8,
            text: 'UptimeBuyer: commercial-refrigeration recovery with cited evidence and bounded spending. SERV Hackathon 02, Kite track.',
          },
        ],
      },
    ],
  },
  {
    id: 'architecture',
    label: 'CONTEXT',
    kind: 'slide',
    slides: [
      {
        slide: 'architecture',
        captions: [
          {
            s: 8,
            text: 'SERV Reasoning reads the manual and proposes cited facts and candidate actions. A proposal has no authority.',
          },
          {
            s: 8,
            text: 'Deterministic code decides compatibility, safety and budget. A separate broker is the only process that can pay.',
          },
        ],
      },
    ],
  },
  {
    id: 'console',
    label: 'SIMULATED',
    kind: 'console',
    steps: [
      {
        step: 'command-center',
        s: 8,
        text: 'SIMULATED: the local demo stack. SIMULATOR sensors, a recorded-contract broker, contract-fake reasoning and CMMS, synthetic data.',
      },
      {
        step: 'incident',
        s: 7,
        text: 'SIMULATED: a temperature breach opens one incident, with its deadline and the next safe action.',
      },
      {
        step: 'evidence',
        s: 8,
        text: 'SIMULATED: cited facts from synthetic documents. In this part the reasoning adapter is a contract fake.',
      },
      {
        step: 'plan',
        s: 8,
        text: 'SIMULATED: code decides compatibility (ALLOW, HOLD or REJECT). The approval bounds amount, merchant and expiry.',
      },
      {
        step: 'order',
        s: 7,
        text: 'SIMULATED: a recorded-contract broker, not Kite, reports this session and order. No money moves in this part.',
      },
      {
        step: 'unknown',
        s: 7,
        text: 'SIMULATED: an ambiguous payment outcome stays UNKNOWN and is reconciled before any retry.',
      },
      {
        step: 'verification',
        s: 8,
        text: 'SIMULATED: a provider saying "done" cannot close the incident. It needs a stable sensor window and a sign-off.',
      },
      {
        step: 'ledger',
        s: 6,
        text: 'SIMULATED: every decision, approval and external attempt lands in the append-only ledger.',
      },
    ],
  },
  {
    id: 'real-serv',
    label: 'REAL',
    kind: 'slide',
    slides: [
      {
        slide: 'serv-run',
        captions: [
          {
            s: 7,
            text: 'REAL EVIDENCE: one SERV Reasoning run (serv-mini) over the published Dixell XR60CX manual. Cost $0.024365.',
          },
          {
            s: 6,
            text: 'The product re-opened all 7 citations against the stored manual and accepted the proposal. It carries no authority.',
          },
        ],
      },
      {
        slide: 'serv-gate',
        captions: [
          {
            s: 7,
            text: 'Journey gate: document PASS and reasoning PASS. Sensor, payment, recovery and timeout in this journey: NOT_RUN.',
          },
          {
            s: 6,
            text: 'The run before it was REJECTED by the citation validator; the PDF font decoding was fixed and the run repeated.',
          },
        ],
      },
    ],
  },
  {
    id: 'real-kite',
    label: 'REAL',
    kind: 'slide',
    slides: [
      {
        slide: 'kite-payment',
        captions: [
          {
            s: 7,
            text: 'REAL EVIDENCE: under a signed owner authorization, the broker made one 0.01 USDC x402 payment through Kite Passport.',
          },
          {
            s: 6,
            text: 'The Kite spending session was approved with a passkey and capped at one cent per call and in total.',
          },
        ],
      },
      {
        slide: 'kite-merchant',
        captions: [
          {
            s: 8,
            text: 'lionx402.com answered HTTP 200 with 7 refrigeration-repair businesses. A duplicate request caused no second charge.',
          },
        ],
      },
      {
        slide: 'kite-unknown',
        captions: [
          {
            s: 7,
            text: 'kpass reported settlement chain 2366, not Base (8453), so the broker recorded UNKNOWN and did not retry.',
          },
          {
            s: 8,
            text: 'The owner resolved it CAPTURED from out-of-band evidence: wallet 1.10 to 1.09 USDC, Kite activity, session spent 0.01.',
          },
          { s: 5, text: 'What chain 2366 denotes is still an open question for Kite.' },
        ],
      },
      {
        slide: 'kite-gate',
        captions: [
          {
            s: 7,
            text: 'Journey gate: payment, fulfillment and duplicate PASS. Sensor, recovery and timeout: NOT_RUN.',
          },
        ],
      },
    ],
  },
  {
    id: 'not-yet',
    label: 'NOT_RUN',
    kind: 'slide',
    slides: [
      {
        slide: 'not-yet',
        captions: [
          {
            s: 7,
            text: 'Not yet proven: a physical sensor, physical recovery evidence, the timeout case and a hosted deployment. All NOT_RUN.',
          },
          {
            s: 5,
            text: 'No single run has passed every part yet, so the complete real-input journey (T-058) is NOT_RUN.',
          },
        ],
      },
    ],
  },
  {
    id: 'end',
    label: 'CONTEXT',
    kind: 'slide',
    slides: [
      {
        slide: 'end',
        captions: [{ s: 7, text: `Code, evidence records and the claims ledger: ${REPO_URL}` }],
      },
    ],
  },
];

/** Every caption with its absolute start and end (seconds), in order. */
export function captionTimeline(segments = SEGMENTS) {
  const out = [];
  let t = 0;
  for (const seg of segments) {
    const items =
      seg.kind === 'console'
        ? seg.steps.map((x) => ({ ...x, part: `console-${x.step}` }))
        : seg.slides.flatMap((sl) => sl.captions.map((c, i) => ({ ...c, part: `${sl.slide}-${i}`, slide: sl.slide })));
    for (const c of items) {
      out.push({ segment: seg.id, label: seg.label, part: c.part, start: t, end: t + c.s, text: c.text });
      t += c.s;
    }
  }
  return out;
}

export const totalSeconds = (segments = SEGMENTS) => captionTimeline(segments).at(-1).end;

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** SUBTITLES.srt, generated from the timeline (the burned-in captions are the same strings). */
export function toSrt(segments = SEGMENTS) {
  return `${captionTimeline(segments)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Evidence: read from the committed records only.

const readJson = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const short = (h, n = 12) => (typeof h === 'string' ? `${h.replace(/^sha256:/, '').slice(0, n)}…` : '');

export function loadEvidence(root = repo) {
  const sj = `evidence/journeys/${SERV_JOURNEY}`;
  const kj = `evidence/journeys/${KITE_JOURNEY}`;
  const doc = readJson(root, `${sj}/document.json`);
  const rsn = readJson(root, `${sj}/reasoning.json`);
  const first = readJson(root, `evidence/journeys/${SERV_JOURNEY_FIRST}/reasoning.json`);
  const servGate = readJson(root, `docs/release/evidence/t058-journey-${SERV_JOURNEY}.gate.json`);
  const kiteGate = readJson(root, `docs/release/evidence/t058-journey-${KITE_JOURNEY}.gate.json`);
  const manifest = readJson(root, `${kj}/manifest.journey.json`);
  const payment = readJson(root, `${kj}/payment.json`);
  const resolved = readJson(root, `${kj}/payment-resolved.json`);
  const recon = readJson(root, `${kj}/reconciliation.json`);
  const merchant = readJson(root, `${kj}/merchant-response.json`);
  const duplicate = readJson(root, `${kj}/duplicate.json`);
  const decision = readJson(root, `${kj}/gate-decision.json`);
  const request = readJson(root, `${kj}/gate-request.json`);
  const kiteFirst = readJson(root, `evidence/journeys/${KITE_JOURNEY_FIRST}/resolution.json`);
  const body = rsn.proposal?.body ?? {};
  return {
    serv: {
      journeyId: SERV_JOURNEY,
      sourceSha: servGate.sourceSha,
      document: {
        title: doc.title,
        publisher: doc.source?.publisher,
        revision: doc.documentRevision,
        sha256: doc.source?.sha256,
        bytes: doc.source?.bytes,
        pages: doc.pageCount,
        spans: doc.extractedSpanCount,
        parser: doc.parserVersion,
      },
      run: {
        runId: rsn.reasoningRunId,
        model: rsn.modelEchoed,
        status: rsn.status,
        disposition: rsn.disposition,
        turns: rsn.turns,
        promptTokens: rsn.usage?.promptTokens,
        completionTokens: rsn.usage?.completionTokens,
        costUsd: rsn.costUsd,
        maxCostUsd: rsn.budget?.maxCostUsd,
        latencyMs: rsn.latencyMs,
        endpointHost: new URL(rsn.endpoint).host,
        responseCount: (rsn.responseIds ?? []).length,
      },
      proposal: {
        label: rsn.proposal?.label,
        authority: rsn.proposal?.authority,
        hypotheses: (body.faultHypotheses ?? []).map((h) => h.code),
        candidates: (body.candidateActions ?? []).map((c) => `${c.kind}: ${c.component} (${c.compatibilityClaim})`),
        uncertainty: body.uncertainty ?? [],
        confidencePpm: body.confidencePpm,
      },
      citations: {
        total: (rsn.citations ?? []).length,
        verified: (rsn.citations ?? []).filter((c) => c.verified === true).length,
        pages: [...new Set((rsn.citations ?? []).map((c) => c.locator?.page))].sort(),
      },
      gate: servGate,
      firstAttempt: {
        journeyId: SERV_JOURNEY_FIRST,
        status: first.status,
        reasons: first.rejectionReasons ?? [],
        costUsd: first.costUsd,
      },
    },
    kite: {
      journeyId: KITE_JOURNEY,
      sourceSha: kiteGate.sourceSha,
      runSourceSha: manifest.runSourceSha,
      authorizationId: payment.authorizationId,
      decision: decision.decision,
      request,
      merchantHost: payment.merchant?.host,
      method: payment.merchant?.method,
      purpose: payment.purpose,
      capMinor: payment.capMinor,
      settlementAsset: payment.settlement?.asset,
      settlementAmount: payment.settlement?.amount,
      brokerState: payment.state,
      brokerReason: payment.attempt?.reasonCode,
      reportedChainId: recon.openQuestion?.reportedChainId,
      expectedChainId: recon.openQuestion?.expectedChainId,
      walletBefore: recon.observations?.walletBaseUsdc?.before,
      walletAfter: recon.observations?.walletBaseUsdc?.after,
      activityKind: recon.observations?.activity?.kind,
      activityStatus: recon.observations?.activity?.status,
      activityAmountRaw: recon.observations?.activity?.amountRaw,
      sessionSpent: recon.observations?.session?.spentTotal,
      resolution: resolved.resolution?.resolution,
      resolutionKind: resolved.resolution?.kind,
      capturedMinor: resolved.resolution?.capturedMinor,
      resolvedState: resolved.state,
      reSent: resolved.reSent,
      txHash: resolved.settlement?.reference,
      merchant: {
        statusCode: merchant.statusCode,
        resultCount: merchant.resultCount,
        query: new URL(merchant.url).searchParams.get('q'),
        results: (merchant.results ?? []).map((r) => {
          const parts = String(r.name)
            .split(',')
            .map((x) => x.trim());
          return { name: parts[0], country: parts.at(-1), type: r.type };
        }),
      },
      duplicate: {
        sameIntentReturned: duplicate.sameIntentReturned,
        secondEgress: duplicate.secondEgress,
        executeCallsAfterDuplicate: duplicate.executeCallsAfterDuplicate,
      },
      gate: kiteGate,
      firstAttempt: { journeyId: KITE_JOURNEY_FIRST, resolution: kiteFirst.resolution },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Frames.

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const BADGE = {
  CONTEXT: ['ctx', 'UPTIMEBUYER'],
  SIMULATED: ['sim', 'SIMULATED'],
  REAL: ['real', 'REAL EVIDENCE'],
  NOT_RUN: ['nr', 'NOT_RUN'],
};

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${FRAME.width}px;height:${FRAME.height}px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,"Noto Sans","Noto Sans Arabic","Geeza Pro",sans-serif;
  color:#e6ebf5;background:#0b1020;-webkit-font-smoothing:antialiased}
body.overlay{background:transparent}
.frame{position:absolute;inset:0;padding:44px 72px 0 72px}
.head{display:flex;align-items:center;gap:22px;margin-bottom:26px}
.head h1{font-size:46px;font-weight:700;letter-spacing:-0.5px}
.badge{display:inline-block;font-weight:800;font-size:24px;letter-spacing:1px;padding:8px 16px;border-radius:8px;white-space:nowrap}
.badge.ctx{background:#1e3a8a;color:#dbeafe}
.badge.sim{background:#f59e0b;color:#111}
.badge.real{background:#16a34a;color:#fff}
.badge.nr{background:#7f1d1d;color:#fee2e2}
.src{font-size:20px;color:#93a3c0;margin:-14px 0 22px 0;font-family:ui-monospace,Menlo,monospace}
.grid{display:grid;gap:24px}
.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:1fr 1fr 1fr}
.card{background:#131b31;border:1px solid #26314f;border-radius:14px;padding:22px 26px}
.card h2{font-size:26px;color:#9fb4dd;font-weight:700;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 22px;font-size:27px;line-height:1.3}
.kv .k{color:#93a3c0}.kv .v{color:#f1f5fb;font-weight:600}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:0.9em}
.big{font-size:30px;line-height:1.4}
table.gate{width:100%;border-collapse:collapse;font-size:30px}
table.gate td,table.gate th{padding:11px 18px;border-bottom:1px solid #26314f;text-align:left}
table.gate th{color:#93a3c0;font-weight:600;font-size:24px;text-transform:uppercase;letter-spacing:1px}
.pill{display:inline-block;padding:4px 16px;border-radius:999px;font-weight:800;font-size:24px}
.pill.PASS{background:#14532d;color:#bbf7d0;border:2px solid #22c55e}
.pill.NOT_RUN{background:#2a2f3d;color:#cbd5e1;border:2px dashed #94a3b8}
.pill.FAIL,.pill.REJECTED,.pill.UNKNOWN{background:#451a03;color:#fed7aa;border:2px solid #f97316}
.pill.OPEN{background:#3b0764;color:#f3e8ff;border:2px solid #a855f7}
.flow{display:flex;align-items:stretch;gap:14px}
.flow .step{flex:1;background:#131b31;border:1px solid #26314f;border-radius:14px;padding:18px 20px;font-size:24px;line-height:1.35}
.flow .step b{display:block;font-size:25px;color:#f1f5fb;margin-bottom:6px}
.flow .arrow{align-self:center;font-size:40px;color:#64748b}
.step.serv{border-color:#6366f1}.step.code{border-color:#22c55e}.step.broker{border-color:#f59e0b}.step.nr{border-style:dashed;border-color:#94a3b8}
.note{font-size:24px;color:#93a3c0;margin-top:18px;line-height:1.4}
ul.list{list-style:none;font-size:30px;line-height:1.5}
ul.list li{padding:8px 0 8px 0;border-bottom:1px solid #1e2742}
.cap{position:absolute;left:50%;transform:translateX(-50%);bottom:26px;max-width:1720px;width:max-content;
  background:rgba(4,7,15,0.92);border:1px solid #33405f;border-radius:12px;padding:14px 30px;font-size:34px;line-height:1.3;
  font-weight:600;color:#fff;text-align:center}
.cap .tag{font-weight:800}
.cap .tag.sim{color:#fbbf24}.cap .tag.real{color:#4ade80}.cap .tag.nr{color:#fca5a5}
`;

const capHtml = (text) => {
  const m = /^(SIMULATED:|REAL EVIDENCE:)\s*/.exec(text);
  if (!m) return `<div class="cap">${esc(text)}</div>`;
  const cls = m[1].startsWith('SIM') ? 'sim' : 'real';
  return `<div class="cap"><span class="tag ${cls}">${esc(m[1])}</span> ${esc(text.slice(m[0].length))}</div>`;
};

const page = (bodyClass, inner) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame</title><style>${CSS}</style></head><body class="${bodyClass}">${inner}</body></html>\n`;

const header = (label, title, src) => {
  const [cls, text] = BADGE[label];
  return `<div class="head"><span class="badge ${cls}">${text}</span><h1>${esc(title)}</h1></div>${src ? `<div class="src">${esc(src)}</div>` : ''}`;
};

const kv = (rows) =>
  `<div class="kv">${rows.map(([k, v, mono]) => `<div class="k">${esc(k)}</div><div class="v${mono ? ' mono' : ''}">${esc(v)}</div>`).join('')}</div>`;

const gateTable = (gate) =>
  `<table class="gate"><tr><th>Part</th><th>Status</th><th>Reason</th></tr>${gate.parts
    .map(
      (p) =>
        `<tr><td>${esc(p.part)}</td><td><span class="pill ${esc(p.status)}">${esc(p.status)}</span></td><td class="mono">${esc((p.reasons ?? []).join(', ') || '-')}</td></tr>`,
    )
    .join(
      '',
    )}<tr><td><b>journey overall</b></td><td><span class="pill ${esc(gate.result)}">${esc(gate.result)}</span></td><td class="mono">not every part in one run</td></tr></table>`;

/** The body of each slide (label, title, source line, inner HTML), from the evidence. */
export function slideContent(id, ev) {
  const s = ev.serv;
  const k = ev.kite;
  switch (id) {
    case 'title':
      return {
        label: 'CONTEXT',
        inner: `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 140px 140px">
          <div style="font-size:120px;font-weight:800;letter-spacing:-2px">UptimeBuyer</div>
          <div style="font-size:44px;color:#c7d2e8;margin-top:18px">From refrigeration failure to verified recovery, with bounded spending.</div>
          <div style="font-size:34px;color:#93a3c0;margin-top:34px">SERV Hackathon 02 &middot; Track 02: Kite &middot; SERV Reasoning</div>
          <div style="display:flex;gap:30px;margin-top:60px;font-size:28px;align-items:center;flex-wrap:wrap">
            <span><span class="badge sim">SIMULATED</span> local demo stack</span>
            <span><span class="badge real">REAL EVIDENCE</span> committed records of real runs</span>
            <span><span class="badge nr">NOT_RUN</span> not yet proven</span>
          </div></div>`,
      };
    case 'architecture':
      return {
        label: 'CONTEXT',
        inner: `${header('CONTEXT', 'How it works', 'docs/release/ARCHITECTURE.md')}
          <div class="flow">
            <div class="step"><b>Telemetry</b>signed sensor samples, freshness, dedup (SIMULATOR in local runs)</div><div class="arrow">&rarr;</div>
            <div class="step"><b>Incident</b>opened once, deadline from the pinned procedure</div><div class="arrow">&rarr;</div>
            <div class="step"><b>Evidence</b>exact manual revision, extracted spans</div><div class="arrow">&rarr;</div>
            <div class="step serv"><b>SERV Reasoning</b>proposes cited facts and candidate actions; no authority</div>
          </div>
          <div class="flow" style="margin-top:26px">
            <div class="step code"><b>Deterministic policy</b>citations re-checked; compatibility ALLOW / HOLD / REJECT; safety; budget</div><div class="arrow">&rarr;</div>
            <div class="step code"><b>Operator approval</b>signed authority: amount, merchant, purpose, expiry</div><div class="arrow">&rarr;</div>
            <div class="step broker"><b>kite-broker</b>only paid credential and paid egress; UNKNOWN reconciled before any retry</div><div class="arrow">&rarr;</div>
            <div class="step broker"><b>Kite Passport</b>passkey-approved session, x402 merchant call</div>
          </div>
          <div class="flow" style="margin-top:26px">
            <div class="step code" style="flex:0 0 58%"><b>Recovery verification</b>closes only on a stable sensor window plus an authoritative sign-off; a provider's "done" never closes</div>
            <div class="step" style="flex:1"><b>Ledger</b>append-only evidence of every decision, approval and external attempt</div>
          </div>`,
      };
    case 'serv-run':
      return {
        label: 'REAL',
        inner: `${header('REAL', 'One SERV Reasoning run on a real manual', `evidence/journeys/${s.journeyId}/ (document.json, reasoning.json) - recorded at ${s.sourceSha.slice(0, 7)}`)}
          <div class="grid g2">
            <div class="card"><h2>Document (published, OEM)</h2>${kv([
              ['Title', s.document.title],
              ['Publisher', s.document.publisher],
              ['Revision', s.document.revision],
              ['sha256', short(s.document.sha256, 16), true],
              ['Pages / spans', `${s.document.pages} pages, ${s.document.spans} extracted spans`],
              ['Parser', s.document.parser, true],
            ])}</div>
            <div class="card"><h2>SERV Reasoning run</h2>${kv([
              ['Run', short(s.run.runId, 13), true],
              ['Endpoint', s.run.endpointHost, true],
              ['Model', s.run.model],
              ['Status', `${s.run.status} (${s.run.turns} turns, ${s.run.responseCount} responses)`],
              [
                'Tokens',
                `${s.run.promptTokens.toLocaleString('en-US')} in / ${s.run.completionTokens.toLocaleString('en-US')} out`,
              ],
              ['Cost', `$${s.run.costUsd} (budget cap $${s.run.maxCostUsd})`],
              ['Latency', `${(s.run.latencyMs / 1000).toFixed(1)} s`],
            ])}</div>
          </div>
          <div class="card" style="margin-top:24px"><h2>Proposal: ${esc(s.proposal.label)}, authority ${esc(s.proposal.authority)}</h2>${kv(
            [
              ['Fault hypotheses', s.proposal.hypotheses.join(', '), true],
              ['Candidate', s.proposal.candidates.join('; ')],
              [
                'Citations',
                `${s.citations.verified} of ${s.citations.total} re-opened and verified against the stored manual (pages ${s.citations.pages.join(', ')})`,
              ],
              ['Uncertainty', s.proposal.uncertainty.join(', '), true],
            ],
          )}</div>`,
      };
    case 'serv-gate':
      return {
        label: 'REAL',
        inner: `${header('REAL', `Journey gate: ${s.journeyId}`, `docs/release/evidence/t058-journey-${s.journeyId}.gate.json`)}
          <div class="grid" style="grid-template-columns:1.25fr 1fr">
            <div class="card">${gateTable(s.gate)}</div>
            <div class="card"><h2>Recorded honestly before it</h2><div class="big">
              <b>${esc(s.firstAttempt.journeyId)}</b><br>SERV answered (serv-mini, $${esc(s.firstAttempt.costUsd)}); the product
              <span class="pill REJECTED">${esc(s.firstAttempt.status)}</span> the proposal:<br>
              <span class="mono">${esc(s.firstAttempt.reasons.join(', '))}</span><br><br>
              Cause: PDF text in Identity-H fonts was extracted as shifted glyph codes. The parser now decodes it through each
              font's ToUnicode CMap; the run was repeated.</div></div>
          </div>`,
      };
    case 'kite-payment':
      return {
        label: 'REAL',
        inner: `${header('REAL', 'One Kite Passport x402 payment through the broker', `evidence/journeys/${k.journeyId}/ - run at ${k.runSourceSha.slice(0, 7)}, recorded at ${k.sourceSha.slice(0, 7)}`)}
          <div class="flow">
            <div class="step code"><b>Signed authorization</b>owner's Ed25519 PAYMENT record <span class="mono">${esc(k.authorizationId)}</span>: at most ${esc(k.request.amountMinor)} minor unit ${esc(k.request.currency)} to ${esc(k.request.merchant)}, single use</div><div class="arrow">&rarr;</div>
            <div class="step code"><b>Release gate</b>PAYMENT ${esc(k.decision)}; four preflight checks passed; record consumed</div><div class="arrow">&rarr;</div>
            <div class="step broker"><b>Kite session</b>approved by the owner with a passkey; 0.01 per call, 0.01 total</div><div class="arrow">&rarr;</div>
            <div class="step broker"><b>x402 call</b>${esc(k.method)} ${esc(k.merchantHost)} business search; settled ${esc(k.settlementAmount)} ${esc(k.settlementAsset)}</div>
          </div>
          <div class="grid g2" style="margin-top:26px">
            <div class="card"><h2>Bounds held</h2>${kv([
              ['Purpose', k.purpose, true],
              ['Cap', `${k.capMinor} minor unit (USD 0.01)`],
              ['Broker code caps', '1 cent per call, 5 cents per session'],
              ['Paid egress', 'kite-broker only'],
            ])}</div>
            <div class="card"><h2>Duplicate protection</h2>${kv([
              ['Same intent returned', String(k.duplicate.sameIntentReturned)],
              ['Second egress', String(k.duplicate.secondEgress)],
              ['Paid calls in total, after the duplicate', String(k.duplicate.executeCallsAfterDuplicate)],
            ])}</div>
          </div>`,
      };
    case 'kite-merchant':
      return {
        label: 'REAL',
        inner: `${header('REAL', `Merchant response: HTTP ${k.merchant.statusCode}, ${k.merchant.resultCount} results`, `evidence/journeys/${k.journeyId}/merchant-response.json - OpenStreetMap business search, q="${k.merchant.query}"`)}
          <div class="card"><table class="gate">
            <tr><th>#</th><th>Business (first field of the OSM name)</th><th>Country</th><th>OSM type</th></tr>
            ${k.merchant.results.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.country)}</td><td class="mono">${esc(r.type)}</td></tr>`).join('')}
          </table></div>
          <div class="note">Public OpenStreetMap listings returned by the paid lookup, shown as recorded. The lookup is a diagnostic step; nobody was contacted.</div>`,
      };
    case 'kite-unknown':
      return {
        label: 'REAL',
        inner: `${header('REAL', 'UNKNOWN first, then a manual resolution', `evidence/journeys/${k.journeyId}/ (payment.json, reconciliation.json, payment-resolved.json)`)}
          <div class="flow">
            <div class="step broker"><b>Broker outcome</b><span class="pill UNKNOWN">${esc(k.brokerState)}</span><br><span class="mono">${esc(k.brokerReason)}</span>: kpass reported chain ${esc(k.reportedChainId)}, the merchant advertised Base (${esc(k.expectedChainId)}). Reservation kept, nothing re-sent.</div><div class="arrow">&rarr;</div>
            <div class="step"><b>Out-of-band evidence (read-only)</b>Base USDC ${esc(Number(k.walletBefore).toFixed(2))} &rarr; ${esc(Number(k.walletAfter).toFixed(2))}<br>Kite activity: ${esc(k.activityKind)} ${esc(k.activityStatus)}, ${esc(k.activityAmountRaw)} raw USDC<br>session spent_total ${esc(k.sessionSpent)}</div><div class="arrow">&rarr;</div>
            <div class="step code"><b>Owner as finance approver</b>${esc(k.resolution)} of ${esc(k.capturedMinor)} minor unit, through the product's ${esc(k.resolutionKind)} path; intent ${esc(k.resolvedState)}</div>
          </div>
          <div class="card" style="margin-top:26px"><h2><span class="pill OPEN">OPEN QUESTION</span> &nbsp;settlement chain id ${esc(k.reportedChainId)}</h2><div class="big">
            Both kpass and Kite's activity report chain id ${esc(k.reportedChainId)} for a payment whose asset is Base USDC. What ${esc(k.reportedChainId)} denotes is
            unverified. The adapter still refuses to confirm any chain other than ${esc(k.expectedChainId)} automatically.</div></div>`,
      };
    case 'kite-gate':
      return {
        label: 'REAL',
        inner: `${header('REAL', `Journey gate: ${k.journeyId}`, `docs/release/evidence/t058-journey-${k.journeyId}.gate.json`)}
          <div class="grid" style="grid-template-columns:1.25fr 1fr">
            <div class="card">${gateTable(k.gate)}</div>
            <div class="card"><h2>Recorded honestly before it</h2><div class="big">
              <b>${esc(k.firstAttempt.journeyId)}</b><br>No payment: the Kite session request was never approved
              (<span class="mono">${esc(k.firstAttempt.resolution)}</span>). The adapter recorded UNKNOWN and did not retry; its
              session-id parsing was fixed and a new signed authorization was required.</div></div>
          </div>`,
      };
    case 'not-yet':
      return {
        label: 'NOT_RUN',
        inner: `${header('NOT_RUN', 'Not yet proven', 'docs/coverage/COVERAGE.md, docs/release/claims.json')}
          <div class="card"><ul class="list">
            <li><span class="pill NOT_RUN">NOT_RUN</span> &nbsp;A real authenticated physical sensor opening the incident</li>
            <li><span class="pill NOT_RUN">NOT_RUN</span> &nbsp;Independent physical recovery evidence (sensor window plus CMMS or technician)</li>
            <li><span class="pill NOT_RUN">NOT_RUN</span> &nbsp;The timeout case after a real payment (Kite has no lookup by client key)</li>
            <li><span class="pill NOT_RUN">NOT_RUN</span> &nbsp;A hosted deployment (local compose only)</li>
            <li><span class="pill NOT_RUN">NOT_RUN</span> &nbsp;One complete real-input journey with every part in a single run (T-058)</li>
          </ul></div>
          <div class="note">Everything else is local evidence: unit, integration and browser tests against a throwaway database and
            contract fakes, plus a local production-like compose bring-up.</div>`,
      };
    case 'end':
      return {
        label: 'CONTEXT',
        inner: `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding-bottom:140px;text-align:center">
          <div style="font-size:96px;font-weight:800">UptimeBuyer</div>
          <div style="font-size:54px;margin-top:30px;font-family:ui-monospace,Menlo,monospace;color:#93c5fd">${esc(REPO_URL)}</div>
          <div style="font-size:32px;margin-top:40px;color:#c7d2e8">Evidence records: evidence/journeys/ &middot; Claims ledger: docs/release/claims.json</div>
          <div style="font-size:30px;margin-top:16px;color:#93a3c0">SERV Hackathon 02 &middot; Track 02: Kite &middot; MIT license</div></div>`,
      };
    default:
      throw new Error(`unknown slide ${id}`);
  }
}

/** One still frame: a slide with its caption burned in. */
export function stillHtml(slideId, caption, ev) {
  const c = slideContent(slideId, ev);
  return page('', `<div class="frame">${c.inner}</div>${capHtml(caption)}`);
}

/** The console overlay: opaque frame with a transparent hole for the recording, the SIMULATED banner and the caption. */
export function consoleFrameHtml(caption) {
  const r = CONSOLE_RECT;
  return page(
    'overlay',
    `<div style="position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;box-shadow:0 0 0 3000px #0b1020;border-radius:2px"></div>
     <div style="position:absolute;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #f59e0b;border-radius:4px"></div>
     <div style="position:absolute;left:0;right:0;top:0;height:${r.y - 10}px;background:#f59e0b;color:#111;display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:800;letter-spacing:0.3px">
       SIMULATED &middot; local demo stack &middot; SIMULATOR sensors (SIMULATED_INPUT) &middot; recorded-contract broker &middot; contract-fake reasoning and CMMS &middot; synthetic data</div>
     ${capHtml(caption)}`,
  );
}

/** The build plan: every still and console step, in video order, with the files Playwright writes. */
export function buildPlan(root = repo, work) {
  const ev = loadEvidence(root);
  const parts = [];
  const timeline = captionTimeline();
  let i = 0;
  for (const seg of SEGMENTS) {
    const segParts = timeline.filter((c) => c.segment === seg.id);
    segParts.forEach((c, j) => {
      const n = String(i++).padStart(2, '0');
      const base = {
        index: n,
        segment: seg.id,
        label: seg.label,
        seconds: c.end - c.start,
        start: c.start,
        caption: c.text,
        fadeIn: j === 0,
        fadeOut: j === segParts.length - 1,
      };
      if (seg.kind === 'console') {
        const step = c.part.replace(/^console-/, '');
        parts.push({
          ...base,
          kind: 'console',
          step,
          html: consoleFrameHtml(c.text),
          htmlFile: path.join(work, `frame-${n}.html`),
          png: path.join(work, `frame-${n}.png`),
        });
      } else {
        const slide = c.part.replace(/-\d+$/, '');
        parts.push({
          ...base,
          kind: 'still',
          slide,
          html: stillHtml(slide, c.text, ev),
          htmlFile: path.join(work, `still-${n}.html`),
          png: path.join(work, `still-${n}.png`),
        });
      }
    });
  }
  return { parts, evidence: ev, totalSeconds: totalSeconds() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Build.

const FFMPEG = process.env.FFMPEG ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed (${r.status}):\n${(r.stderr ?? '').slice(-3000)}`);
  return r.stdout ?? '';
}

const ENCODE = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FRAME.fps)];

function encodePart(p, marks, consoleVideo, out) {
  const fades = [
    p.fadeIn ? `fade=t=in:st=0:d=0.35` : null,
    p.fadeOut ? `fade=t=out:st=${(p.seconds - 0.35).toFixed(2)}:d=0.35` : null,
  ]
    .filter(Boolean)
    .join(',');
  if (p.kind === 'still') {
    sh(FFMPEG, [
      '-y',
      '-loop',
      '1',
      '-framerate',
      String(FRAME.fps),
      '-t',
      String(p.seconds),
      '-i',
      p.png,
      '-vf',
      ['setsar=1,format=yuv420p', fades].filter(Boolean).join(','),
      ...ENCODE,
      '-preset',
      'veryfast',
      '-crf',
      '12',
      '-t',
      String(p.seconds),
      out,
    ]);
    return;
  }
  const m = marks.find((x) => x.step === p.step);
  if (!m) throw new Error(`no console mark for step ${p.step}`);
  if (m.hold < p.seconds) throw new Error(`console step ${p.step} held ${m.hold}s, needs ${p.seconds}s`);
  const r = CONSOLE_RECT;
  const start = (m.start + 0.5).toFixed(3);
  sh(FFMPEG, [
    '-y',
    '-i',
    consoleVideo,
    '-loop',
    '1',
    '-framerate',
    String(FRAME.fps),
    '-i',
    p.png,
    '-filter_complex',
    `[0:v]trim=start=${start}:duration=${p.seconds},setpts=PTS-STARTPTS,fps=${FRAME.fps},scale=${r.width}:${r.height}:flags=lanczos,setsar=1,` +
      `pad=${FRAME.width}:${FRAME.height}:${r.x}:${r.y}:color=0x0b1020[v];[v][1:v]overlay=0:0:shortest=1,format=yuv420p${fades ? `,${fades}` : ''}[o]`,
    '-map',
    '[o]',
    ...ENCODE,
    '-preset',
    'veryfast',
    '-crf',
    '12',
    '-t',
    String(p.seconds),
    out,
  ]);
}

export function probe(file) {
  const out = sh(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height,r_frame_rate,codec_name',
    '-of',
    'json',
    file,
  ]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.width) ?? {};
  return {
    durationSeconds: Number(Number(j.format.duration).toFixed(2)),
    width: v.width,
    height: v.height,
    codec: v.codec_name,
    frameRate: v.r_frame_rate,
  };
}

function build({ out, work, skipRecord }) {
  mkdirSync(work, { recursive: true });
  const plan = buildPlan(repo, work);
  for (const p of plan.parts) writeFileSync(p.htmlFile, p.html);
  const consoleVideo = path.join(work, 'console.webm');
  const marksFile = path.join(work, 'console-marks.json');
  const steps = plan.parts.filter((p) => p.kind === 'console').map((p) => ({ step: p.step, hold: p.seconds + 1.5 }));
  writeFileSync(
    path.join(work, 'plan.json'),
    `${JSON.stringify(
      {
        stills: plan.parts.map((p) => ({ html: p.htmlFile, png: p.png, transparent: p.kind === 'console' })),
        console: { steps, video: consoleVideo, marks: marksFile, zoom: CONSOLE_ZOOM, size: CONSOLE_RECT },
      },
      null,
      2,
    )}\n`,
  );
  if (!skipRecord) {
    if (!process.env.DATABASE_URL)
      throw new Error('DATABASE_URL must be set (the console part records the local stack)');
    if (!existsSync(path.join(repo, 'apps', 'web', 'dist', 'index.html')))
      throw new Error('apps/web/dist is missing: run pnpm build first');
    const r = spawnSync(
      'pnpm',
      ['--filter', '@uptimebuyer/web', 'exec', 'playwright', 'test', '-c', 'playwright.video.config.ts'],
      { cwd: repo, stdio: 'inherit', env: { ...process.env, UB_VIDEO_WORK: work } },
    );
    if (r.status !== 0) throw new Error(`Playwright recording failed (${r.status})`);
  }
  const marks = JSON.parse(readFileSync(marksFile, 'utf8'));
  const list = [];
  for (const p of plan.parts) {
    const partFile = path.join(work, `part-${p.index}.mp4`);
    encodePart(p, marks, consoleVideo, partFile);
    list.push(`file '${partFile.replace(/'/g, "'\\''")}'`);
  }
  const listFile = path.join(work, 'parts.txt');
  writeFileSync(listFile, `${list.join('\n')}\n`);
  mkdirSync(path.dirname(out), { recursive: true });
  sh(FFMPEG, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    ...ENCODE,
    '-preset',
    'slow',
    '-crf',
    '22',
    '-tune',
    'stillimage',
    '-movflags',
    '+faststart',
    '-metadata',
    'title=UptimeBuyer - SERV Hackathon 02 demo',
    out,
  ]);
  const bytes = readFileSync(out);
  const info = probe(out);
  const sourceSha = sh('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim();
  const segments = SEGMENTS.map((seg) => {
    const cs = captionTimeline().filter((c) => c.segment === seg.id);
    return { id: seg.id, label: seg.label, start: cs[0].start, end: cs.at(-1).end };
  });
  const manifest = {
    schema: 'demo-video-manifest.v1',
    file: path.relative(repo, out).startsWith('..') ? path.basename(out) : path.relative(repo, out),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...info,
    builtFromSha: sourceSha,
    builtAt: new Date().toISOString(),
    builder: 'scripts/release/demo-video.mjs',
    subtitles: 'docs/release/SUBTITLES.srt (captions are burned in)',
    segments,
    simulatedInputs:
      'console segment: local e2e stack (seeded throwaway database, SIMULATOR sensors SIMULATED_INPUT, RECORDED_CONTRACT broker, CONTRACT_FAKE reasoning and CMMS, local test identity provider)',
    realEvidence: [
      `evidence/journeys/${SERV_JOURNEY}/`,
      `evidence/journeys/${KITE_JOURNEY}/`,
      `docs/release/evidence/t058-journey-${SERV_JOURNEY}.gate.json`,
      `docs/release/evidence/t058-journey-${KITE_JOURNEY}.gate.json`,
    ],
  };
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const srtFile = path.join(repo, 'docs', 'release', 'SUBTITLES.srt');
  try {
    if (args.includes('--srt')) {
      writeFileSync(srtFile, toSrt());
      console.log(`wrote ${path.relative(repo, srtFile)} (${captionTimeline().length} captions, ${totalSeconds()} s)`);
    } else if (args.includes('--check')) {
      const same = existsSync(srtFile) && readFileSync(srtFile, 'utf8') === toSrt();
      console.log(same ? 'SUBTITLES.srt matches the timeline' : 'SUBTITLES.srt differs from the timeline (run --srt)');
      process.exitCode = same ? 0 : 1;
    } else {
      const out = path.resolve(val('--out') ?? path.join(repo, 'docs', 'release', 'video', 'uptimebuyer-demo.mp4'));
      const work = path.resolve(val('--work') ?? mkdtempSync(path.join(tmpdir(), 'ub-demo-video-')));
      const m = build({ out, work, skipRecord: args.includes('--skip-record') });
      writeFileSync(srtFile, toSrt());
      const manifestFile = path.join(repo, 'docs', 'release', 'video', 'video-manifest.json');
      mkdirSync(path.dirname(manifestFile), { recursive: true });
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
      console.log(JSON.stringify({ out, work, ...m, sizeMB: Number((statSync(out).size / 1e6).toFixed(2)) }, null, 2));
    }
  } catch (e) {
    console.error(`demo-video: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
