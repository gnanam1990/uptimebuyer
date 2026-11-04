// OpenServ SERV Reasoning adapter (KITE-OPENSERV-INTEGRATION §6, ADR 0002). SERV Reasoning is documented as an
// inference API that is wire-compatible with the OpenAI Chat Completions API: `POST /v1/chat/completions` on
// https://inference-api.openserv.ai with `Authorization: Bearer $SERV_API_KEY`, a mandatory system message, standard
// function tools and `response_format: json_schema`. This adapter sends exactly that request to the fixed origin and
// nothing else. It holds only the SERV key (never a Kite credential); without a key or an explicitly configured model
// it is UNSUPPORTED and performs no I/O. Nothing here has run against the real service in this environment.
import { DomainError, type AdapterCapabilityAssessment } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { REASONING_LIMITS } from '../limits.js';
import { PROPOSAL_JSON_SCHEMA } from './schema.js';
import type { ReasonerPort, ReasonerRequest, ReasonerTurn } from './port.js';

/** Fixed, allowlisted endpoint: never taken from configuration, documents or model output (SSRF boundary). */
export const SERV_ORIGIN = 'https://inference-api.openserv.ai';
export const SERV_CHAT_COMPLETIONS_URL = `${SERV_ORIGIN}/v1/chat/completions`;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const failure = (reasonCode: string, message = 'The reasoning service request failed.') =>
  new DomainError('DEPENDENCY_FAILED', message, { reasonCode });

const ResponseSchema = z.object({
  id: z.string().max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  system_fingerprint: z.string().max(200).nullable().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                type: z.literal('function').optional(),
                function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(200_000) }),
              }),
            )
            .max(16)
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.int().min(0).optional(), completion_tokens: z.int().min(0).optional() })
    .optional(),
});

const EFFORTS = new Set(['low', 'medium', 'high']);

export interface ServAdapterOptions {
  fetch?: FetchLike;
}

export class ServReasoningAdapter implements ReasonerPort {
  readonly adapter = 'SERV_REASONING' as const;
  readonly #key: string | null;
  readonly #model: string | null;
  readonly #effort: string | null;
  readonly #fetch: FetchLike;

  private constructor(key: string | null, model: string | null, effort: string | null, fetchImpl: FetchLike) {
    this.#key = key;
    this.#model = model;
    this.#effort = effort;
    this.#fetch = fetchImpl;
  }

  /**
   * Read configuration from the SERV workload's environment: `SERV_API_KEY` (documented; `OPENSERV_API_KEY` accepted
   * as an alias), `SERV_REASONING_MODEL` (required: a model id from the account's SERV catalog) and optional
   * `SERV_REASONING_EFFORT` (low | medium | high). Any base-URL variable is ignored.
   */
  static fromEnv(env: Readonly<Record<string, string | undefined>> = process.env, opts: ServAdapterOptions = {}) {
    const key = (env.SERV_API_KEY ?? env.OPENSERV_API_KEY ?? '').trim() || null;
    const model = (env.SERV_REASONING_MODEL ?? '').trim() || null;
    const effort = (env.SERV_REASONING_EFFORT ?? '').trim().toLowerCase();
    const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    return new ServReasoningAdapter(
      key,
      model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) ? model : null,
      EFFORTS.has(effort) ? effort : null,
      fetchImpl,
    );
  }

  assess(): AdapterCapabilityAssessment {
    const unsupported = (reasonCode: string) => ({ kind: 'UNSUPPORTED', reasonCode }) as AdapterCapabilityAssessment;
    if (!this.#key) return unsupported('SERV_API_KEY_ABSENT');
    if (!this.#model) return unsupported('SERV_MODEL_NOT_CONFIGURED');
    return { kind: 'ELIGIBLE' };
  }

  /** The exact JSON body sent to SERV (exposed for contract tests and the reasoning-config digest). */
  requestBody(req: ReasonerRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.packetText },
    ];
    for (const t of req.transcript)
      if (t.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: t.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });
      else messages.push({ role: 'tool', tool_call_id: t.toolCallId, content: t.content });
    return {
      model: this.#model,
      messages,
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'uptimebuyer_reasoning_proposal_v1', strict: true, schema: PROPOSAL_JSON_SCHEMA },
      },
      max_completion_tokens: req.maxOutputTokens,
      ...(this.#effort ? { reasoning_effort: this.#effort } : {}),
      stream: false,
    };
  }

  async complete(req: ReasonerRequest): Promise<ReasonerTurn> {
    const cap = this.assess();
    if (cap.kind !== 'ELIGIBLE')
      throw new DomainError('POLICY_HOLD', 'The reasoning adapter is not configured.', {
        reasonCode: 'ADAPTER_UNSUPPORTED',
      });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs);
    let res: Response;
    let raw: string;
    try {
      res = await this.#fetch(SERV_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(this.requestBody(req)),
        redirect: 'error',
        signal: controller.signal,
      });
      raw = await readBounded(res, REASONING_LIMITS.maxResponseBytes, controller);
    } catch (e) {
      if (e instanceof DomainError) throw e;
      if (controller.signal.aborted) throw failure('MODEL_TIMEOUT', 'The reasoning service did not answer in time.');
      throw failure('SERV_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const code =
        res.status === 401 || res.status === 403
          ? 'SERV_AUTH_FAILED'
          : res.status === 429
            ? 'SERV_RATE_LIMITED'
            : res.status === 402
              ? 'SERV_CREDITS_EXHAUSTED'
              : res.status >= 500
                ? 'SERV_UPSTREAM_ERROR'
                : 'SERV_BAD_REQUEST';
      throw failure(code);
    }
    let parsed: z.output<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(raw));
    } catch {
      throw failure('SERV_RESPONSE_INVALID');
    }
    const choice = parsed.choices[0]!;
    const model = {
      adapter: 'SERV_REASONING' as const,
      modelId: parsed.model ?? this.#model!,
      modelVersion: parsed.system_fingerprint ?? null,
      responseId: parsed.id ?? null,
    };
    const usage = {
      promptTokens: parsed.usage?.prompt_tokens ?? null,
      completionTokens: parsed.usage?.completion_tokens ?? null,
    };
    if (choice.finish_reason === 'length') throw failure('MODEL_OUTPUT_TRUNCATED');
    if (choice.finish_reason === 'content_filter' || choice.message.refusal) throw failure('MODEL_REFUSED');
    const calls = choice.message.tool_calls ?? [];
    if (calls.length > 0)
      return {
        kind: 'TOOL_CALLS',
        calls: calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
        model,
        usage,
      };
    if (typeof choice.message.content !== 'string' || choice.message.content.length === 0)
      throw failure('MODEL_OUTPUT_EMPTY');
    return { kind: 'FINAL', content: choice.message.content, model, usage };
  }
}

async function readBounded(res: Response, max: number, controller: AbortController): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    controller.abort();
    throw failure('MODEL_OUTPUT_TOO_LARGE', 'The reasoning service response exceeded its bound.');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw failure('MODEL_OUTPUT_TOO_LARGE', 'The reasoning service response exceeded its bound.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
