// T-058 (M14, FR-22, INV-12) recorded journey j-2026-11-12-serv-document-2: the second real journey over the same
// published Dixell XR60CX manual, made after the PDF font decoder fix (uptimebuyer-parser.v3) at runner commit 28d05f0,
// with one user-authorized SERV Reasoning run on serv-mini. This test re-derives every statement the docs make about it
// from the committed artifacts:
//   - evaluated at its own source commit the manifest gives document PASS and reasoning PASS and every other part
//     NOT_RUN (the journey overall stays NOT_RUN), and the recorded gate outputs (file-only and --database) say exactly
//     that; at any other commit both parts FAIL on the source binding;
//   - the manual was extracted by parser v3 with nothing withheld;
//   - the run COMPLETED: the product's citation validation accepted the proposal, it is a MODEL PROPOSAL with no
//     authority, and every citation it uses re-opened from the immutable object and verified;
//   - the cost recorded is the cost of the usage SERV reported, inside the run budget and the authorized cap;
//   - no request was refused, and the first journey's records are untouched.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const ev = await import(path.join(repoRoot, 'scripts', 'release', 'journey-evidence.mjs'));

const ID = 'j-2026-11-12-serv-document-2';
const SOURCE_SHA = '28d05f0da52e902f60d363fdf64034ba5c17b517';
const dir = `evidence/journeys/${ID}`;
const read = (rel: string) => readFileSync(path.join(repoRoot, rel));
const readJson = (rel: string) => JSON.parse(read(rel).toString('utf8'));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const manifest = readJson(`${dir}/manifest.journey.json`);
const reasoning = readJson(`${dir}/reasoning.json`);
const statuses = (r: { parts: { part: string; status: string }[] }) =>
  Object.fromEntries(r.parts.map((p) => [p.part, p.status]));
const ctx = (expectedSha: string) => ({
  artifactRoot: repoRoot,
  expectedSha,
  simulatedDigests: gate.loadSimulatedDigests(repoRoot),
  isAuthorized: () => false,
});
const NOT_RUN_PARTS = ['sensor', 'payment', 'fulfillment', 'recovery', 'duplicate', 'timeout'];

describe('T-058 recorded journey j-2026-11-12-serv-document-2', () => {
  it('evaluated at its source commit: document PASS, reasoning PASS, every other part NOT_RUN, journey NOT_RUN', () => {
    expect(manifest.journeyId).toBe(ID);
    expect(manifest.sourceSha).toBe(SOURCE_SHA);
    expect(Object.keys(manifest.parts).sort()).toEqual(['document', 'reasoning']);
    const r = gate.evaluateJourney(manifest, ctx(manifest.sourceSha));
    const s = statuses(r);
    expect(s.document).toBe('PASS');
    expect(s.reasoning).toBe('PASS');
    for (const p of NOT_RUN_PARTS) expect(s[p], p).toBe('NOT_RUN');
    expect(r.result).toBe('NOT_RUN');
    for (const f of [`t058-journey-${ID}.gate.json`, `t058-journey-${ID}.gate-database.json`])
      expect(readJson(`docs/release/evidence/${f}`), f).toEqual(r);
  });

  it('evaluated at any other commit both recorded parts fail on the source binding', () => {
    const r = gate.evaluateJourney(manifest, ctx('0'.repeat(40)));
    for (const part of ['document', 'reasoning']) {
      const p = r.parts.find((x: { part: string }) => x.part === part);
      expect(p.status, part).toBe('FAIL');
      expect(p.reasons, part).toContain('SOURCE_SHA_MISMATCH');
    }
  });

  it('the document is the published manual, byte for byte, extracted by parser v3 with nothing withheld', () => {
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
      parserVersion: 'uptimebuyer-parser.v3',
      textWithheld: [],
      pageCount: 5,
      extractedSpanCount: 12,
      injectionFlaggedSpanCount: 0,
    });
    expect(manifest.parts.document.facts).toMatchObject({ pageCount: 5, extractedSpanCount: 12 });
  });

  it('the SERV run COMPLETED: the product accepted a cited MODEL PROPOSAL with no authority', () => {
    expect(reasoning).toMatchObject({
      origin: 'SERV_REASONING',
      adapter: 'SERV_REASONING',
      resultOrigin: 'SERV_REASONING',
      endpoint: 'https://inference-api.openserv.ai/v1/chat/completions',
      modelRequested: 'serv-mini',
      reasoningEffort: null,
      modelEchoed: 'serv-mini',
      status: 'COMPLETED',
      disposition: 'PROPOSAL_ONLY',
      rejectionReasons: [],
      injectionFlags: [],
      failureReason: null,
      turns: 2,
      toolCalls: 2,
    });
    expect(reasoning.digests.promptTemplateDigest).toBe(
      'reasoning-prompt.v1:sha256:f83d9793740d648cf251485da8a96d90957508ea2e96b500fdf4243842083cce',
    );
    expect(reasoning.exchanges.map((x: { status: number }) => x.status)).toEqual([200, 200]);
    expect(reasoning.responseIds).toEqual(reasoning.exchanges.map((x: { response: { id: string } }) => x.response.id));
    expect(
      reasoning.exchanges.map((x: { response: { toolCalls: { name: string }[] } }) => x.response.toolCalls[0]!.name),
    ).toEqual(['get_asset_snapshot', 'submit_candidate_schema']);
    const p = reasoning.proposal;
    expect(p).toMatchObject({
      authority: 'NONE',
      label: 'MODEL PROPOSAL',
      lifecycle: 'CURRENT',
      verification: { proposalDigestMatches: true, candidateDigestsMatch: true },
      reviewReasons: [],
    });
    expect(p.proposalId).toBe(manifest.parts.reasoning.facts.proposalId);
    expect(reasoning.reasoningRunId).toBe(manifest.parts.reasoning.facts.runId);
    expect(manifest.parts.reasoning.facts.runStatus).toBe('COMPLETED');
    expect(
      p.body.candidateActions.every((a: { compatibilityClaim: string }) => a.compatibilityClaim === 'CANDIDATE_ONLY'),
    ).toBe(true);
    // Every cited locator is a manual page, and nothing cites the asset snapshot (it carries no citation).
    const fields = p.body.extractedFields as { field: string; citations: { locator: { kind: string } }[] }[];
    expect(fields.flatMap((f) => f.citations.map((c) => c.locator.kind))).toEqual(
      fields.flatMap((f) => f.citations.map(() => 'PAGE')),
    );
    expect(fields.map((f) => f.field)).not.toContain('SERIAL');
  });

  it('every citation the proposal uses re-opened from the immutable manual and verified', () => {
    const used = new Set<string>([
      ...reasoning.proposal.body.faultHypotheses.flatMap((h: { citationIds: string[] }) => h.citationIds),
      ...reasoning.proposal.body.extractedFields.flatMap((f: { citations: { citationId: string }[] }) =>
        f.citations.map((c) => c.citationId),
      ),
      ...reasoning.proposal.body.candidateActions.flatMap((a: { evidenceFor: string[]; evidenceAgainst: string[] }) => [
        ...a.evidenceFor,
        ...a.evidenceAgainst,
      ]),
    ]);
    const cited = reasoning.citations as {
      citationId: string;
      verified: boolean;
      sourceDigest: string;
      spanText: string;
    }[];
    expect(new Set(cited.map((c) => c.citationId))).toEqual(used);
    for (const c of cited) {
      expect(c.verified, c.citationId).toBe(true);
      expect(c.sourceDigest).toBe('sha256:5b6f58295e0bbb4ba547fdd6d3b80509f2d5ccf7e6879ddbcd077d8855fe095f');
      expect(c.spanText).not.toContain('�');
    }
  });

  it('records the reported usage and its cost, inside the $0.25 run budget and the $1.00 authorization', () => {
    const sum = (k: string) =>
      reasoning.exchanges.reduce(
        (n: number, x: { response: { usage: Record<string, number> } }) => n + x.response.usage[k]!,
        0,
      );
    expect(reasoning.usage).toEqual({ promptTokens: sum('prompt_tokens'), completionTokens: sum('completion_tokens') });
    const cost = ev.servCostMicros(reasoning.usage, ev.pricingMicros('serv-mini'));
    expect(String(cost)).toBe(reasoning.costMicros);
    expect(reasoning.costUsd).toBe(ev.formatUsd(cost));
    expect(reasoning.costUsd).toBe(manifest.parts.reasoning.facts.costUsd);
    expect(cost).toBeLessThanOrEqual(BigInt(reasoning.budget.maxCostMicros));
    expect(BigInt(reasoning.budget.maxCostMicros)).toBe(250_000n);
    expect(reasoning.budget.maxRunTokens).toBe(120_000);
    expect(reasoning.budget.authorizedCapUsd).toBe('1.000000');
  });

  it('the redaction check passed over every exported artifact and the product store; no request was refused', () => {
    const red = readJson(`${dir}/redaction-check.json`);
    expect(red.result).toBe('PASS');
    expect(red.secretValuesChecked).toEqual(['SERV_API_KEY']);
    expect(red.findings).toEqual([]);
    expect(red.productStore).toMatchObject({ result: 'PASS', findings: [] });
    for (const f of red.files as { path: string; sha256: string }[])
      expect(sha256(read(f.path)), f.path).toBe(f.sha256);
    expect(existsSync(path.join(repoRoot, dir, 'refused-requests.json'))).toBe(false);
  });

  it('the first journey (j-2026-11-12-serv-document) is unchanged: same manifest, same REJECTED run', () => {
    const first = 'evidence/journeys/j-2026-11-12-serv-document';
    expect(sha256(read(`${first}/document.json`))).toBe(
      '3aad9ba4f3a31a261f483549de5854599d15aa8e10886a61b6662076a3fcbe33',
    );
    expect(readJson(`${first}/manifest.journey.json`).sourceSha).toBe('ca590994435ba466545e6e2ca46ab0c57737ddb3');
    expect(readJson(`${first}/reasoning.json`)).toMatchObject({
      status: 'REJECTED',
      reasoningRunId: expect.stringMatching(/^rsn_409a231a-/),
    });
  });
});
