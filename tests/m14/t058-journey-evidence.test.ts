// T-058 (M14, FR-22, INV-12) document + reasoning journey runner, pure parts: SERV cost computation (agrees with the
// runtime ModelBudget that enforces the cap), the recording fetch (digests and model output only, never a header
// value), the redaction check over exported artifacts and the journey manifest (only document and reasoning parts,
// every other part left out so the gate reports it NOT_RUN). No test here calls SERV: model turns come from the
// contract-fake reasoner or an injected fetch.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const ev = await import(path.join(repoRoot, 'scripts', 'release', 'journey-evidence.mjs'));
const gate = await import(path.join(repoRoot, 'scripts', 'release', 'journey-gate.mjs'));
const evidence = await import(path.join(repoRoot, 'packages', 'evidence', 'src', 'index.ts'));
const resilience = await import(path.join(repoRoot, 'packages', 'resilience', 'src', 'index.ts'));

const runtimeKey = () =>
  ['k', 'test', Math.random().toString(36).slice(2), Date.now().toString(36), 'x'.repeat(24)].join('-');

describe('T-058 journey evidence: SERV cost', () => {
  it('prices serv-mini from the catalog ($1.00 / $6.00 per million) and rounds up like ModelBudget', () => {
    const p = ev.pricingMicros('serv-mini');
    expect(p).toEqual({ promptPerMillion: 1_000_000n, completionPerMillion: 6_000_000n });
    expect(ev.servCostMicros({ promptTokens: 1_000_000, completionTokens: 0 }, p)).toBe(1_000_000n);
    expect(ev.servCostMicros({ promptTokens: 0, completionTokens: 1_000_000 }, p)).toBe(6_000_000n);
    expect(ev.servCostMicros({ promptTokens: 1, completionTokens: 1 }, p)).toBe(7n);
    expect(ev.formatUsd(61_234n)).toBe('0.061234');
    expect(ev.formatUsd(1_000_000n)).toBe('1.000000');
    expect(ev.servCostMicros({ promptTokens: null, completionTokens: 5 }, p)).toBeNull();
    expect(() => ev.pricingMicros('serv-unknown')).toThrow(/no SERV catalog price/);
  });

  it('the recorded cost equals the cost the runtime budget charges for the same contract-fake turns', async () => {
    const p = ev.pricingMicros('serv-mini');
    const turns = [
      { promptTokens: 14_210, completionTokens: 1_377 },
      { promptTokens: 16_902, completionTokens: 2_048 },
    ];
    let i = 0;
    const fake = new evidence.ContractFakeReasoner(() => ({
      kind: 'FINAL',
      content: '{}',
      usage: turns[i++]!,
    }));
    const budget = new resilience.ModelBudget({
      maxPromptTokens: 120_000,
      maxCompletionTokens: 120_000,
      maxTotalTokens: 120_000,
      maxCostMicros: 250_000n,
      pricePerMillionPromptMicros: p.promptPerMillion,
      pricePerMillionCompletionMicros: p.completionPerMillion,
    });
    let last;
    for (let t = 0; t < turns.length; t++) last = budget.charge((await fake.complete({} as never)).usage);
    const total = {
      promptTokens: turns.reduce((n, t) => n + t.promptTokens, 0),
      completionTokens: turns.reduce((n, t) => n + t.completionTokens, 0),
    };
    expect(last.ok).toBe(true);
    expect(ev.servCostMicros(total, p)).toBe(last.costMicros);
    // The same budget refuses a turn that would exceed the $0.25 ceiling.
    expect(budget.charge({ promptTokens: 0, completionTokens: 40_000 })).toEqual({
      ok: false,
      reason: 'COST_BUDGET_EXCEEDED',
    });
  });
});

describe('T-058 journey evidence: recording fetch', () => {
  it('records digests, header names and the parsed model output but never a header value', async () => {
    const key = runtimeKey();
    const body = {
      id: 'chatcmpl-test-1',
      model: 'serv-mini-test',
      system_fingerprint: 'fp_test',
      choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    };
    const rec = ev.createRecordingFetch(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const adapter = evidence.ServReasoningAdapter.fromEnv(
      { SERV_API_KEY: key, SERV_REASONING_MODEL: 'serv-mini' },
      { fetch: rec.fetch },
    );
    const turn = await adapter.complete({
      system: 's',
      systemDigest: `reasoning-prompt.v1:sha256:${'1'.repeat(64)}`,
      packet: {},
      packetText: '{"packet":"x"}',
      inputDigest: `reasoning-input.v1:sha256:${'2'.repeat(64)}`,
      transcript: [],
      tools: evidence.REASONING_TOOLS,
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    });
    expect(turn).toMatchObject({ kind: 'FINAL', content: '{"a":1}', model: { responseId: 'chatcmpl-test-1' } });
    expect(rec.exchanges).toHaveLength(1);
    const x = rec.exchanges[0];
    expect(x).toMatchObject({
      url: 'https://inference-api.openserv.ai/v1/chat/completions',
      method: 'POST',
      status: 200,
      requestHeaderNames: ['accept', 'authorization', 'content-type'],
      response: { id: 'chatcmpl-test-1', model: 'serv-mini-test', usage: { prompt_tokens: 10, completion_tokens: 4 } },
    });
    expect(x.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rec.exchanges)).not.toContain(key);
  });

  it('keeps a bounded error body for a refused request and records a transport error by name only', async () => {
    const rec = ev.createRecordingFetch(
      async () => new Response('{"error":{"message":"bad schema"}}', { status: 400 }),
    );
    const res = await rec.fetch('https://inference-api.openserv.ai/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bad schema');
    expect(rec.exchanges[0]).toMatchObject({ status: 400, errorBody: '{"error":{"message":"bad schema"}}' });
    const broken = ev.createRecordingFetch(async () => {
      throw new TypeError('connect failed to secret-host');
    });
    await expect(broken.fetch('https://x.invalid', { body: '' })).rejects.toThrow();
    expect(broken.exchanges[0].transportError).toBe('TypeError');
    expect(JSON.stringify(broken.exchanges)).not.toContain('secret-host');
  });
});

describe('T-058 journey evidence: redaction check', () => {
  it('passes clean artifacts and names (never echoes) a leaked secret in any encoding', () => {
    const key = runtimeKey();
    const secrets = [{ name: 'SERV_API_KEY', value: key }];
    const clean = ev.redactionCheck(
      [
        { path: 'a.json', bytes: Buffer.from('{"model":"serv-mini","usage":{"prompt_tokens":1}}') },
        { path: 'm.pdf', bytes: Buffer.from('%PDF-1.4 binary'), binary: true },
      ],
      secrets,
    );
    expect(clean.result).toBe('PASS');
    expect(clean.secretValuesChecked).toEqual(['SERV_API_KEY']);
    for (const leaked of [key, Buffer.from(key).toString('base64'), Buffer.from(key).toString('hex')]) {
      const r = ev.redactionCheck([{ path: 'm.pdf', bytes: Buffer.from(`xx${leaked}xx`), binary: true }], secrets);
      expect(r.result).toBe('FAIL');
      expect(r.findings).toEqual([{ path: 'm.pdf', rule: 'SECRET_VALUE', secret: 'SERV_API_KEY' }]);
      expect(JSON.stringify(r)).not.toContain(key);
    }
  });

  it('flags authorization headers, bearer tokens, credentialed URLs, environment dumps and secret-scan patterns', () => {
    const rules = (text: string) =>
      ev
        .redactionCheck([{ path: 't.json', bytes: Buffer.from(text) }], [])
        .findings.map((f: { rule: string }) => f.rule);
    expect(rules('{"Authorization": "x"}')).toContain('AUTHORIZATION_HEADER');
    expect(rules(`Bearer ${'a'.repeat(30)}`)).toContain('BEARER_TOKEN');
    expect(rules('postgres://u:pw@localhost:5432/db')).toContain('CREDENTIALED_URL');
    expect(rules('SERV_API_KEY=abcdef')).toContain('ENV_DUMP');
    expect(rules('{"DATABASE_URL": "x"}')).toContain('ENV_DUMP');
    expect(rules(`-----BEGIN ${'PRIVATE'} KEY-----`)).toContain('SECRET_PATTERN:private-key');
    expect(rules('{"modelRequested":"serv-mini","origin":"SERV_REASONING"}')).toEqual([]);
  });
});

describe('T-058 journey evidence: manifest', () => {
  const sha = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const base = () => ({
    journeyId: 'j-test-doc',
    sourceSha: sha,
    startedAt: '2026-11-12T10:00:00.000Z',
    endedAt: '2026-11-12T10:10:00.000Z',
    parts: {
      document: {
        capturedAt: '2026-11-12T10:01:00.000Z',
        artifacts: [{ path: 'evidence/journeys/j-test-doc/document.json', sha256: digest }],
      },
      reasoning: {
        capturedAt: '2026-11-12T10:05:00.000Z',
        artifacts: [{ path: 'evidence/journeys/j-test-doc/reasoning.json', sha256: digest }],
        facts: { runId: 'rsn_test-1' },
      },
    },
  });

  it('records only document (PUBLISHED_DOCUMENT) and reasoning (SERV_REASONING); every other part reads NOT_RUN', () => {
    const m = ev.buildJourneyManifest(base());
    expect(Object.keys(m.parts)).toEqual(['document', 'reasoning']);
    expect(m.parts.document.origin).toBe('PUBLISHED_DOCUMENT');
    expect(m.parts.reasoning.origin).toBe('SERV_REASONING');
    expect(m.notRecorded).toEqual(['sensor', 'payment', 'fulfillment', 'recovery', 'duplicate', 'timeout']);
    const r = gate.evaluateJourney(m, {
      artifactRoot: '/nonexistent-root',
      expectedSha: sha,
      simulatedDigests: new Set(),
      isAuthorized: () => false,
    });
    const s = Object.fromEntries(r.parts.map((p: { part: string; status: string }) => [p.part, p.status]));
    for (const p of ['sensor', 'payment', 'fulfillment', 'recovery', 'duplicate', 'timeout'])
      expect(s[p], p).toBe('NOT_RUN');
    // Artifacts are absent under this root, so the recorded parts are UNKNOWN (never PASS) here.
    expect(s.document).toBe('UNKNOWN');
    expect(s.reasoning).toBe('UNKNOWN');
    expect(r.result).toBe('UNKNOWN');
  });

  it('refuses other parts, an out-of-window capture, a foreign artifact path, a bad id or SHA and a run without runId', () => {
    const bad = (patch: (m: ReturnType<typeof base>) => void) => {
      const m = base();
      patch(m);
      return () => ev.buildJourneyManifest(m);
    };
    expect(bad((m) => Object.assign(m.parts, { sensor: { capturedAt: m.startedAt, artifacts: [] } }))).toThrow(
      /sensor/,
    );
    expect(bad((m) => (m.parts.document.capturedAt = '2026-11-12T11:00:00.000Z'))).toThrow(/window/);
    expect(bad((m) => (m.parts.document.artifacts[0]!.path = 'evidence/journeys/other/x.json'))).toThrow(/outside/);
    expect(bad((m) => (m.parts.document.artifacts[0]!.path = 'evidence/journeys/j-test-doc/../x/y'))).toThrow(
      /outside/,
    );
    expect(bad((m) => (m.journeyId = 'J_Upper'))).toThrow(/journeyId/);
    expect(bad((m) => (m.sourceSha = 'abc'))).toThrow(/sourceSha/);
    expect(bad((m) => ((m.parts.reasoning as { facts?: unknown }).facts = {}))).toThrow(/runId/);
    expect(bad((m) => (m.endedAt = '2026-11-12T09:00:00.000Z'))).toThrow(/precedes/);
  });
});
