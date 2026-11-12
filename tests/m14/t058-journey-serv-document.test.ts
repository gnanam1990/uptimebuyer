// T-058 (M14, FR-22, INV-12) recorded journey j-2026-11-12-serv-document: the document and reasoning parts run for
// real (published Dixell XR60CX manual, one SERV Reasoning run on serv-mini) at runner commit ca59099. This test
// re-derives every statement the docs make about it from the committed artifacts:
//   - evaluated at its own source commit the manifest gives document PASS and every other part NOT_RUN (the journey
//     overall stays NOT_RUN), and the recorded gate outputs say exactly that;
//   - evaluated at any other commit it FAILS (SOURCE_SHA_MISMATCH): the evidence is bound to the code that ran;
//   - the reasoning run reached SERV and its proposal was REJECTED by the product's citation validation, so no
//     reasoning part was offered to the gate and the reasoning part is not counted as PASS;
//   - the cost recorded is the cost of the usage SERV reported and is inside the run budget and the authorized cap;
//   - the two earlier requests SERV refused before any generation carry no usage.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const ev = await import(path.join(repoRoot, 'scripts', 'release', 'journey-evidence.mjs'));

const ID = 'j-2026-11-12-serv-document';
const dir = `evidence/journeys/${ID}`;
const read = (rel: string) => readFileSync(path.join(repoRoot, rel));
const readJson = (rel: string) => JSON.parse(read(rel).toString('utf8'));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const manifest = readJson(`${dir}/manifest.journey.json`);
const statuses = (r: { parts: { part: string; status: string }[] }) =>
  Object.fromEntries(r.parts.map((p) => [p.part, p.status]));
const ctx = (expectedSha: string) => ({
  artifactRoot: repoRoot,
  expectedSha,
  simulatedDigests: gate.loadSimulatedDigests(repoRoot),
  isAuthorized: () => false,
});
const NOT_RUN_PARTS = ['sensor', 'reasoning', 'payment', 'fulfillment', 'recovery', 'duplicate', 'timeout'];

describe('T-058 recorded journey j-2026-11-12-serv-document', () => {
  it('evaluated at its source commit: document PASS, every other part NOT_RUN, journey NOT_RUN', () => {
    expect(manifest.journeyId).toBe(ID);
    expect(manifest.sourceSha).toBe('ca590994435ba466545e6e2ca46ab0c57737ddb3');
    expect(Object.keys(manifest.parts)).toEqual(['document']);
    const r = gate.evaluateJourney(manifest, ctx(manifest.sourceSha));
    const s = statuses(r);
    expect(s.document).toBe('PASS');
    for (const p of NOT_RUN_PARTS) expect(s[p], p).toBe('NOT_RUN');
    expect(r.result).toBe('NOT_RUN');
    for (const f of [`t058-journey-${ID}.gate.json`, `t058-journey-${ID}.gate-database.json`])
      expect(readJson(`docs/release/evidence/${f}`), f).toEqual(r);
  });

  it('evaluated at any other commit it fails on the source binding', () => {
    const r = gate.evaluateJourney(manifest, ctx('0'.repeat(40)));
    const doc = r.parts.find((p: { part: string }) => p.part === 'document');
    expect(doc.status).toBe('FAIL');
    expect(doc.reasons).toContain('SOURCE_SHA_MISMATCH');
  });

  it('the document is the published manual, byte for byte, ingested through the product', () => {
    expect(sha256(read(`${dir}/XR60CX-GB.pdf`))).toBe(
      '5b6f58295e0bbb4ba547fdd6d3b80509f2d5ccf7e6879ddbcd077d8855fe095f',
    );
    const d = readJson(`${dir}/document.json`);
    expect(d).toMatchObject({
      origin: 'PUBLISHED_DOCUMENT',
      source: {
        url: 'https://webapps.copeland.com/Dixell/Content/Pages/Manuals/XR-CX/XR60CX/XR60CX-GB.pdf',
        bytes: 1_022_749,
      },
      sha256: 'sha256:5b6f58295e0bbb4ba547fdd6d3b80509f2d5ccf7e6879ddbcd077d8855fe095f',
      sourceKind: 'OEM_PUBLICATION',
      extractionMethod: 'PDF_TEXT',
      pageCount: 5,
      extractedSpanCount: 14,
    });
    expect(manifest.parts.document.facts).toMatchObject({ pageCount: 5, extractedSpanCount: 14 });
  });

  it('the SERV run is real, its proposal was REJECTED, and it is therefore not a reasoning PASS', () => {
    const r = readJson(`${dir}/reasoning.json`);
    expect(r).toMatchObject({
      origin: 'SERV_REASONING',
      adapter: 'SERV_REASONING',
      resultOrigin: 'SERV_REASONING',
      endpoint: 'https://inference-api.openserv.ai/v1/chat/completions',
      modelRequested: 'serv-mini',
      modelEchoed: 'serv-mini',
      status: 'REJECTED',
      disposition: 'REJECTED',
      rejectionReasons: ['CITATION_OUT_OF_RANGE', 'CITATION_QUOTE_MISMATCH'],
      proposal: null,
      citations: [],
    });
    expect(r.reasoningRunId).toMatch(/^rsn_/);
    expect(r.exchanges.map((x: { status: number }) => x.status)).toEqual([200, 200]);
    expect(r.responseIds).toEqual(r.exchanges.map((x: { response: { id: string } }) => x.response.id));
    for (const x of r.exchanges) {
      expect(x.url).toBe('https://inference-api.openserv.ai/v1/chat/completions');
      expect(x.requestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(x.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The model's own submission is readable in the last exchange (the product rejected it before recording a proposal).
    const submitted = JSON.parse(r.exchanges[1].response.toolCalls[0].arguments).proposal;
    expect(r.exchanges[1].response.toolCalls[0].name).toBe('submit_candidate_schema');
    expect(submitted.incidentId).toMatch(/^inc_/);
    expect(manifest.parts.reasoning).toBeUndefined();
    expect(manifest.context.reasoningOutcome).toMatch(/REJECTED/);
  });

  it('records the reported usage and its cost, inside the $0.25 run budget and the $1.00 authorization', () => {
    const r = readJson(`${dir}/reasoning.json`);
    const sum = (k: string) =>
      r.exchanges.reduce(
        (n: number, x: { response: { usage: Record<string, number> } }) => n + x.response.usage[k]!,
        0,
      );
    expect(r.usage).toEqual({ promptTokens: sum('prompt_tokens'), completionTokens: sum('completion_tokens') });
    const cost = ev.servCostMicros(r.usage, ev.pricingMicros('serv-mini'));
    expect(String(cost)).toBe(r.costMicros);
    expect(r.costUsd).toBe(ev.formatUsd(cost));
    expect(cost).toBeLessThanOrEqual(BigInt(r.budget.maxCostMicros));
    expect(BigInt(r.budget.maxCostMicros)).toBeLessThanOrEqual(1_000_000n);
    expect(r.budget.maxRunTokens).toBe(120_000);
  });

  it('the redaction check passed over every exported artifact and the product store', () => {
    const red = readJson(`${dir}/redaction-check.json`);
    expect(red.result).toBe('PASS');
    expect(red.secretValuesChecked).toEqual(['SERV_API_KEY']);
    expect(red.findings).toEqual([]);
    expect(red.productStore).toMatchObject({ result: 'PASS', findings: [] });
    for (const f of red.files as { path: string; sha256: string }[])
      expect(sha256(read(f.path)), f.path).toBe(f.sha256);
  });

  it('the two earlier requests SERV refused before any generation carry no usage and no response id', () => {
    const refused = readJson(`${dir}/refused-requests.json`);
    expect(refused.attempts).toHaveLength(2);
    for (const a of refused.attempts) {
      expect(a.exchange.status).toBe(400);
      expect(a.exchange.errorBody).toMatch(/invalid_request_error/);
      expect(a.usage).toEqual({ promptTokens: null, completionTokens: null });
      expect(a.costUsd).toBeNull();
    }
  });
});
