// T-058 real-input journey evidence helpers (pure; no network, no process spawning). Used by the document + reasoning
// journey runner (packages/evidence/test/support/journey-document-reasoning.ts) and its unit tests:
//   - servCostMicros / formatUsd: the cost of a SERV Reasoning run from the usage the API reported, with the same
//     round-up-per-component formula as the runtime ModelBudget, so the recorded cost and the enforced cap agree;
//   - createRecordingFetch: a pass-through fetch that keeps digests and the parsed model output of every SERV exchange
//     (never a header value, so the Authorization header cannot reach an artifact);
//   - redactionCheck: the secret / header / environment-dump check run over every exported artifact;
//   - buildJourneyManifest: a journey-gate manifest with ONLY the parts a run actually produced (document, reasoning).
// Every other journey part is left out so scripts/release/journey-gate.mjs reports it NOT_RUN.
import { createHash } from 'node:crypto';
import { PATTERNS } from '../secret-scan.mjs';

export const JOURNEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * SERV catalog prices in US cents per million tokens, as the live `GET /v1/models` catalog reported them on
 * 2026-11-12 (serv-mini: input 100, output 600, i.e. $1.00 / $6.00 per million). A model without an entry here has
 * no cost bound and the runner refuses it.
 */
export const SERV_CATALOG_PRICES_CENTS = Object.freeze({
  'serv-mini': Object.freeze({ input: 100, output: 600 }),
  'serv-nano': Object.freeze({ input: 25, output: 175 }),
  'serv-swift': Object.freeze({ input: 125, output: 650 }),
});

/** Catalog cents per million tokens -> integer USD micro-units per million tokens (ModelBudget pricing). */
export function pricingMicros(model) {
  const p = SERV_CATALOG_PRICES_CENTS[model];
  if (!p) throw new Error(`no SERV catalog price recorded for model ${model}`);
  return { promptPerMillion: BigInt(p.input) * 10_000n, completionPerMillion: BigInt(p.output) * 10_000n };
}

/** Cost in USD micro-units, each component rounded up exactly like packages/resilience ModelBudget. */
export function servCostMicros(usage, pricing) {
  const p = usage?.promptTokens;
  const c = usage?.completionTokens;
  if (!Number.isSafeInteger(p) || !Number.isSafeInteger(c) || p < 0 || c < 0) return null;
  const up = (tokens, perMillion) => (BigInt(tokens) * perMillion + 999_999n) / 1_000_000n;
  return up(p, pricing.promptPerMillion) + up(c, pricing.completionPerMillion);
}

/** Micro-units as a fixed six-decimal USD string ("0.061234"). */
export function formatUsd(micros) {
  if (micros === null || micros === undefined) return null;
  const m = BigInt(micros);
  if (m < 0n) throw new Error('negative cost');
  return `${m / 1_000_000n}.${String(m % 1_000_000n).padStart(6, '0')}`;
}

function summarizeChatCompletion(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { parsed: false };
  }
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const message = choice?.message ?? {};
  return {
    parsed: true,
    id: typeof body?.id === 'string' ? body.id : null,
    model: typeof body?.model === 'string' ? body.model : null,
    systemFingerprint: typeof body?.system_fingerprint === 'string' ? body.system_fingerprint : null,
    created: Number.isSafeInteger(body?.created) ? body.created : null,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: body?.usage && typeof body.usage === 'object' ? body.usage : null,
    content: typeof message.content === 'string' ? message.content : null,
    refusal: typeof message.refusal === 'string' ? message.refusal : null,
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((t) => ({
          id: typeof t?.id === 'string' ? t.id : null,
          name: typeof t?.function?.name === 'string' ? t.function.name : null,
          arguments: typeof t?.function?.arguments === 'string' ? t.function.arguments : null,
        }))
      : [],
  };
}

/**
 * Wrap a fetch so every exchange is recorded: request URL, method, header NAMES (never values), body digest and size;
 * response status, digest, size and the parsed chat-completion summary (or a bounded error body). The response handed
 * back to the caller is untouched (the recording reads a clone).
 */
export function createRecordingFetch(inner = (url, init) => globalThis.fetch(url, init), now = () => new Date()) {
  const exchanges = [];
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? init.body : '';
    const headerNames = Object.keys(init.headers ?? {})
      .map((h) => h.toLowerCase())
      .sort();
    const x = {
      seq: exchanges.length + 1,
      url: String(url),
      method: String(init.method ?? 'GET'),
      requestHeaderNames: headerNames,
      requestSha256: sha256Hex(body),
      requestBytes: Buffer.byteLength(body),
      sentAt: now().toISOString(),
    };
    exchanges.push(x);
    let res;
    try {
      res = await inner(url, init);
    } catch (e) {
      x.transportError = e instanceof Error ? e.name : 'Error';
      x.endedAt = now().toISOString();
      throw e;
    }
    const text = await res.clone().text();
    x.status = res.status;
    x.responseSha256 = sha256Hex(text);
    x.responseBytes = Buffer.byteLength(text);
    x.endedAt = now().toISOString();
    if (res.ok) x.response = summarizeChatCompletion(text);
    else x.errorBody = text.slice(0, 4_000);
    return res;
  };
  return { fetch, exchanges };
}

const AUTH_HEADER = /\bauthorization\b["']?\s*[:=]/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/;
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i;
const ENV_DUMP =
  /["']?\b(?:SERV_API_KEY|OPENSERV_API_KEY|DATABASE_URL|JOURNEY_DATABASE_URL|KITE_[A-Z0-9_]+|KPASS_[A-Z0-9_]+)\b["']?\s*[:=]\s*["']?[^\s"',}]/;

function encodings(secret) {
  const b = Buffer.from(secret, 'utf8');
  return [secret, b.toString('base64'), b.toString('base64url'), b.toString('hex'), encodeURIComponent(secret)];
}

export const REDACTION_RULES = Object.freeze([
  'SECRET_VALUE',
  'AUTHORIZATION_HEADER',
  'BEARER_TOKEN',
  'CREDENTIALED_URL',
  'ENV_DUMP',
  ...PATTERNS.map((p) => `SECRET_PATTERN:${p.id}`),
]);

/**
 * Check exported files for secrets without ever echoing one. `files` are { path, bytes, binary? }; `secrets` are
 * { name, value } (the values are compared, only the names are reported). Binary files (the PDF) are checked for the
 * secret values only; text files for every rule.
 */
export function redactionCheck(files, secrets, checkedAt = new Date().toISOString()) {
  const values = secrets.filter((s) => typeof s?.value === 'string' && s.value.length >= 8);
  const findings = [];
  const out = [];
  for (const f of files) {
    const buf = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes);
    out.push({ path: f.path, sha256: sha256Hex(buf), bytes: buf.length, binary: f.binary === true });
    for (const s of values)
      if (encodings(s.value).some((e) => buf.includes(Buffer.from(e, 'utf8'))))
        findings.push({ path: f.path, rule: 'SECRET_VALUE', secret: s.name });
    if (f.binary === true) continue;
    const text = buf.toString('utf8');
    if (AUTH_HEADER.test(text)) findings.push({ path: f.path, rule: 'AUTHORIZATION_HEADER' });
    if (BEARER.test(text)) findings.push({ path: f.path, rule: 'BEARER_TOKEN' });
    if (CREDENTIALED_URL.test(text)) findings.push({ path: f.path, rule: 'CREDENTIALED_URL' });
    if (ENV_DUMP.test(text)) findings.push({ path: f.path, rule: 'ENV_DUMP' });
    for (const { id, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(text)) findings.push({ path: f.path, rule: `SECRET_PATTERN:${id}` });
      re.lastIndex = 0;
    }
  }
  return {
    schema: 'journey-redaction-check.v1',
    checkedAt,
    rules: [...REDACTION_RULES],
    secretValuesChecked: values.map((s) => s.name),
    files: out,
    findings,
    result: findings.length === 0 ? 'PASS' : 'FAIL',
  };
}

const iso = (v, name) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
  return Date.parse(v);
};

/** Parts a document + reasoning run may record; anything else stays out of the manifest (NOT_RUN at the gate). */
export const RECORDED_PARTS = Object.freeze({ document: 'PUBLISHED_DOCUMENT', reasoning: 'SERV_REASONING' });

/**
 * Build the journey-gate manifest. Only `document` and `reasoning` may be supplied; each needs capturedAt inside the
 * run window and artifacts under evidence/journeys/<journeyId>/ with a sha256. The reasoning part needs facts.runId.
 */
export function buildJourneyManifest({ journeyId, sourceSha, startedAt, endedAt, parts, context = {} }) {
  if (!JOURNEY_ID.test(String(journeyId))) throw new Error('journeyId must match ^[a-z0-9][a-z0-9-]{0,63}$');
  if (!HEX40.test(String(sourceSha))) throw new Error('sourceSha must be a 40-hex commit');
  const start = iso(startedAt, 'startedAt');
  const end = iso(endedAt, 'endedAt');
  if (end < start) throw new Error('endedAt precedes startedAt');
  const out = {};
  for (const [name, part] of Object.entries(parts ?? {})) {
    if (!(name in RECORDED_PARTS)) throw new Error(`part ${name} cannot be recorded by this run`);
    const t = iso(part.capturedAt, `${name}.capturedAt`);
    if (t < start || t > end) throw new Error(`${name}.capturedAt is outside the run window`);
    const artifacts = part.artifacts ?? [];
    if (artifacts.length === 0) throw new Error(`${name} has no artifacts`);
    for (const a of artifacts) {
      if (typeof a?.path !== 'string' || !a.path.startsWith(`evidence/journeys/${journeyId}/`) || a.path.includes('..'))
        throw new Error(`${name} artifact outside evidence/journeys/${journeyId}/`);
      if (!HEX64.test(String(a.sha256))) throw new Error(`${name} artifact without a sha256`);
    }
    if (name === 'reasoning' && (typeof part.facts?.runId !== 'string' || !part.facts.runId))
      throw new Error('reasoning needs facts.runId');
    if (name === 'reasoning' && (part.facts.runStatus !== 'COMPLETED' || typeof part.facts.proposalId !== 'string'))
      throw new Error('reasoning needs a COMPLETED run with facts.proposalId');
    out[name] = {
      origin: RECORDED_PARTS[name],
      journeyId,
      capturedAt: part.capturedAt,
      artifacts: artifacts.map((a) => ({ path: a.path, sha256: a.sha256 })),
      ...(part.facts ? { facts: part.facts } : {}),
    };
  }
  return {
    schema: 'real-input-journey.v1',
    journeyId,
    sourceSha,
    startedAt,
    endedAt,
    parts: out,
    notRecorded: ['sensor', 'payment', 'fulfillment', 'recovery', 'duplicate', 'timeout'].filter((p) => !(p in out)),
    context,
  };
}
