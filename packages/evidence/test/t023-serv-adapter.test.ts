// T-023 / NFR-11 — the SERV Reasoning adapter is the only model egress and it is fixed, narrow and honest. Without a
// key (or model) it reports UNSUPPORTED and performs no network call. With configuration it sends exactly one
// documented OpenAI-compatible Chat Completions request to the allowlisted SERV origin. Responses below come from
// an injected fetch: they prove request/response mapping against the documented contract, not a real SERV run.
import { describe, expect, it, vi } from 'vitest';
import {
  REASONING_TOOLS,
  SERV_CHAT_COMPLETIONS_URL,
  ServReasoningAdapter,
  type ReasonerRequest,
} from '../src/index.js';
import { canary } from './helpers.js';

const request = (): ReasonerRequest =>
  ({
    system: 'system prompt',
    systemDigest: `reasoning-prompt.v1:sha256:${'1'.repeat(64)}`,
    packet: {} as never,
    packetText: '{"packet":"x"}',
    inputDigest: `reasoning-input.v1:sha256:${'2'.repeat(64)}`,
    transcript: [],
    tools: REASONING_TOOLS,
    maxOutputTokens: 1000,
    timeoutMs: 5_000,
  }) as ReasonerRequest;

const okBody = (message: Record<string, unknown>, finish = 'stop') => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5.4-mini',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('T-023 SERV reasoning adapter capability and egress boundary', () => {
  it('without an API key it is UNSUPPORTED and never touches the network', async () => {
    const fetchSpy = vi.fn();
    const adapter = ServReasoningAdapter.fromEnv({}, { fetch: fetchSpy as never });
    expect(adapter.assess()).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'SERV_API_KEY_ABSENT' });
    await expect(adapter.complete(request())).rejects.toMatchObject({ details: { reasonCode: 'ADAPTER_UNSUPPORTED' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a key without a configured model is still UNSUPPORTED (no guessed model id)', () => {
    const adapter = ServReasoningAdapter.fromEnv({ SERV_API_KEY: canary('serv') }, { fetch: vi.fn() as never });
    expect(adapter.assess()).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'SERV_MODEL_NOT_CONFIGURED' });
  });

  it('accepts the documented SERV_API_KEY and the OPENSERV_API_KEY alias', () => {
    for (const name of ['SERV_API_KEY', 'OPENSERV_API_KEY'])
      expect(
        ServReasoningAdapter.fromEnv({ [name]: canary('a'), SERV_REASONING_MODEL: 'gpt-5.4-mini' }).assess(),
      ).toEqual({ kind: 'ELIGIBLE' });
  });

  it('sends one documented chat-completions request to the fixed SERV origin', async () => {
    const key = canary('serv');
    const fetchSpy = vi.fn(async () => jsonResponse(200, okBody({ content: '{"ok":true}' })));
    const adapter = ServReasoningAdapter.fromEnv(
      { SERV_API_KEY: key, SERV_REASONING_MODEL: 'gpt-5.4-mini', SERV_BASE_URL: 'https://evil.example' },
      { fetch: fetchSpy as never },
    );
    const turn = await adapter.complete(request());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(SERV_CHAT_COMPLETIONS_URL).toBe('https://inference-api.openserv.ai/v1/chat/completions');
    expect(url).toBe(SERV_CHAT_COMPLETIONS_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5.4-mini');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(body.messages[1]).toEqual({ role: 'user', content: '{"packet":"x"}' });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual([
      'get_asset_snapshot',
      'search_evidence',
      'submit_candidate_schema',
    ]);
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.stream).toBe(false);
    expect(turn).toMatchObject({
      kind: 'FINAL',
      content: '{"ok":true}',
      model: { adapter: 'SERV_REASONING', modelId: 'gpt-5.4-mini', responseId: 'chatcmpl-1' },
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  it('maps tool calls and finish reasons; truncation and refusal are failures', async () => {
    const calls = [{ id: 'call_1', type: 'function', function: { name: 'search_evidence', arguments: '{"query":"fan"}' } }];
    const mk = (body: unknown, status = 200) =>
      ServReasoningAdapter.fromEnv(
        { SERV_API_KEY: canary('k'), SERV_REASONING_MODEL: 'm' },
        { fetch: (async () => jsonResponse(status, body)) as never },
      );
    expect(await mk(okBody({ content: null, tool_calls: calls }, 'tool_calls')).complete(request())).toMatchObject({
      kind: 'TOOL_CALLS',
      calls: [{ id: 'call_1', name: 'search_evidence', arguments: '{"query":"fan"}' }],
    });
    await expect(mk(okBody({ content: '{' }, 'length')).complete(request())).rejects.toMatchObject({
      details: { reasonCode: 'MODEL_OUTPUT_TRUNCATED' },
    });
    await expect(mk(okBody({ content: '' }, 'content_filter')).complete(request())).rejects.toMatchObject({
      details: { reasonCode: 'MODEL_REFUSED' },
    });
  });

  it('maps HTTP errors without echoing the key or the response body', async () => {
    const key = canary('secret');
    for (const [status, code] of [
      [401, 'SERV_AUTH_FAILED'],
      [429, 'SERV_RATE_LIMITED'],
      [400, 'SERV_BAD_REQUEST'],
      [503, 'SERV_UPSTREAM_ERROR'],
    ] as const) {
      const adapter = ServReasoningAdapter.fromEnv(
        { SERV_API_KEY: key, SERV_REASONING_MODEL: 'm' },
        {
          fetch: (async () =>
            jsonResponse(status, { error: { type: 'x', message: `echo ${key} leaked` } })) as never,
        },
      );
      const err = await adapter.complete(request()).catch((e: unknown) => e);
      expect(err).toMatchObject({ details: { reasonCode: code } });
      expect(JSON.stringify(err)).not.toContain(key);
      expect(String((err as Error).message)).not.toContain(key);
    }
  });

  it('bounds response size and time', async () => {
    const big = ServReasoningAdapter.fromEnv(
      { SERV_API_KEY: canary('k'), SERV_REASONING_MODEL: 'm' },
      { fetch: (async () => new Response('x'.repeat(2 * 1024 * 1024), { status: 200 })) as never },
    );
    await expect(big.complete(request())).rejects.toMatchObject({ details: { reasonCode: 'MODEL_OUTPUT_TOO_LARGE' } });
    const slow = ServReasoningAdapter.fromEnv(
      { SERV_API_KEY: canary('k'), SERV_REASONING_MODEL: 'm' },
      {
        fetch: ((_u: string, init: RequestInit) =>
          new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as never,
      },
    );
    await expect(slow.complete({ ...request(), timeoutMs: 50 })).rejects.toMatchObject({
      details: { reasonCode: 'MODEL_TIMEOUT' },
    });
  });
});
