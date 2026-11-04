# ADR 0002: SERV Reasoning adapter and bounded reasoning boundary

Status: accepted (M05, 2026-11-05). Real SERV execution: `NOT_RUN`.

## Context

The event requires SERV Reasoning (KITE-OPENSERV-INTEGRATION §6). This environment has no OpenServ account or API key. On
2026-11-05 we read OpenServ's public documentation to find the interface:

- `docs.openserv.ai/serv-reasoning/introduction.md` describes SERV Reasoning as an inference API. It is "wire-compatible
  with the OpenAI Chat Completions API and the Anthropic Messages API".
- `docs.openserv.ai/serv-reasoning/api/index.md` and `.../api/chat-completions.md` document the request:
  - **Base URL:** `https://inference-api.openserv.ai`.
  - **Endpoint:** `POST /v1/chat/completions`.
  - **Auth header:** `Authorization: Bearer $SERV_API_KEY`.
  - **Required fields:** `model` (a catalog id) and `messages`. A system or developer message is mandatory.
  - **Optional fields:** `max_completion_tokens`, `reasoning_effort`, `temperature`, `tools`, `tool_choice` and `stream`.
    Other OpenAI parameters are forwarded to the model.
  - **Response:** `{id, object: "chat.completion", model, choices[{index, message, finish_reason}], usage}`. `finish_reason`
    is one of `stop`, `length`, `content_filter` or `tool_calls`.
- `.../tutorials/structured-outputs.md` documents `response_format: {type: "json_schema", json_schema: {name, strict,
schema}}`. It tells callers to validate the output themselves.
- `.../tools.md` covers tools. Custom tools use the OpenAI function format. Tools whose names start with `serv_` are SERV
  features that SERV removes before the model runs. We do not use them.

The OpenServ _agent_ SDK (`@openserv-labs/sdk`) is a separate product. It uses `api.openserv.ai` workspaces and tasks and
the `x-openserv-key` header, and its documentation does not mention SERV Reasoning.

## Decision

1. **`ServReasoningAdapter`** (`packages/evidence/src/reasoning/serv-adapter.ts`) sends exactly one request type:
   - The URL is the constant `POST https://inference-api.openserv.ai/v1/chat/completions`. No base-URL configuration
     exists, and `redirect: 'error'` is set.
   - The body contains: the system prompt, the serialized incident packet as the user message, three function tools, a
     strict `json_schema` response format, `max_completion_tokens` and `stream: false`.
   - The response is size-bounded (1 MiB), time-bounded (60 s per call, 150 s per run) and has no automatic retry.
   - Tool calls and final content are mapped into the reasoning port. `length` and `content_filter` finish reasons, and
     refusals, count as failures.
   - HTTP errors map to codes that never contain the key or the response body: `SERV_AUTH_FAILED`, `SERV_RATE_LIMITED`,
     `SERV_CREDITS_EXHAUSTED`, `SERV_BAD_REQUEST` and `SERV_UPSTREAM_ERROR`.
2. **Configuration.** The adapter reads `SERV_API_KEY`, the documented name, and accepts `OPENSERV_API_KEY` as an alias.
   `SERV_REASONING_MODEL` is required because the model catalog depends on the account, so we never guess an id.
   `SERV_REASONING_EFFORT` (`low` | `medium` | `high`) is optional. If the key or the model is missing, `assess()` returns
   `UNSUPPORTED` (`SERV_API_KEY_ABSENT` / `SERV_MODEL_NOT_CONFIGURED`). The run is then recorded `NOT_RUN` and no network
   call is made. The key is held in a private field and is never logged or stored.
3. **Separation from Kite (INV-06).** The SERV workload holds only the SERV key. The adapter cannot reach anything else.
   Tools run inside UptimeBuyer and are read-only:
   - `search_evidence` searches the run's own revision.
   - `get_asset_snapshot` returns the bound asset revision.
   - `submit_candidate_schema` submits the final proposal.

   Arguments are strict schemas. A tool argument cannot name a tenant, revision, URL or credential. Any other tool name
   rejects the run.

4. **Output is a proposal only (INV-02).** The proposal schema (`reasoning-proposal.v1`) has no field for approval,
   exact compatibility, payment, URL or closure. `compatibilityClaim` can only be `CANDIDATE_ONLY`. A run is rejected for
   any of these reasons:
   - schema failure;
   - a `binding` echo that does not match (incident, evidence revision or input digest);
   - a citation outside the offered set, or with the wrong source digest or locator, or a quote that does not match;
   - a URL or secret material in the output;
   - an unexpected tool, or the tool, turn or size budget exceeded.

   The reasons above lead to rejection. Separately, any of the following forces `NEEDS_HUMAN_REVIEW` on a proposal that
   is otherwise valid:
   - conflicts present;
   - a conflict the model did not report;
   - flagged evidence in scope;
   - a refused tool argument.

5. **Contract fake.** `ContractFakeReasoner` returns scripted turns. It labels the result origin and the ledger trust
   `CONTRACT_FAKE`, so a fake result is never presented as a SERV run.

## Uncertainty (recorded, not assumed)

- **Live access.** The adapter has never called the live service. Whether a key issued at `console.openserv.ai`
  works against this exact body is unverified.
- **Model and version fields.** The response `model` field may echo the requested id or return the underlying model.
  We store it as `model_id` and treat `system_fingerprint`, when present, as the version. Both are unverified.
- **Strict schemas.** The docs say other OpenAI parameters are forwarded. Whether `strict: true` is enforced for every
  model in the catalog is not documented, so we validate the output ourselves in every case.
- **Rate limits and credits.** Rate-limit numbers, timeouts and the status code for insufficient credits are not
  documented. 402 is mapped to `SERV_CREDITS_EXHAUSTED` as a guess, and 429 to `SERV_RATE_LIMITED`.
- **Event requirement.** We did not find the official hackathon page that states "SERV Reasoning must be part of your
  build". Whether calling this endpoint satisfies the requirement is unconfirmed until the coordinator checks it.
- **First live run.** The first credentialed run must record the request and response digests, the model id, the token
  usage and the disposition (AI-SAFETY §7). That run requires explicit user authorization, because it spends prepaid
  credits.

## Consequences

The adapter's contract tests (`packages/evidence/test/t023-serv-adapter.test.ts`) run against an injected fetch. They prove
the request and response mapping only. Every reasoning result in this repository comes from the contract fake, and
`openServ` external evidence remains `NOT_RUN`. To run live, set `SERV_API_KEY` and `SERV_REASONING_MODEL` in the SERV
workload only, then run `runReasoning` with `ServReasoningAdapter.fromEnv()`.
