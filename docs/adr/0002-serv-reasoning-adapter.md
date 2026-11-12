# ADR 0002: SERV Reasoning adapter and bounded reasoning boundary

Status: accepted (M05, 2026-11-05). Real SERV execution: two recorded runs (2026-11-12, see "Live run record" below).
The second returned a cited proposal the product validated (journey gate reasoning part PASS); the real-input journey
as a whole, and with it T-058, is `NOT_RUN`.

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

## Uncertainty (recorded, not assumed; written before the live run, see "Live run record")

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

## Live run record (2026-11-12, T-058 journeys `j-2026-11-12-serv-document` and `j-2026-11-12-serv-document-2`)

### Run 1: `j-2026-11-12-serv-document` (source commit `ca59099`)

One user-authorized run (model `serv-mini`, hard cap $1.00; the run budget was $0.25 and 120k tokens) went through
`runReasoning` with `ServReasoningAdapter.fromEnv()` over the published Dixell XR60CX manual. The records are in
`evidence/journeys/j-2026-11-12-serv-document/`. What the run settled:

- **Live access works.** The key and this request body reach `POST /v1/chat/completions`.
- **Model field.** SERV echoes the requested id (`serv-mini`), not the upstream model, and sends no `system_fingerprint`.
  A refusal message showed the upstream model is `gpt-5.4-mini`.
- **`reasoning_effort` with tools.** `serv-mini` refuses function tools combined with `reasoning_effort` other than
  `none` (400 before any generation). The run therefore leaves `SERV_REASONING_EFFORT` unset.
- **Strict schemas are enforced.** `response_format` with `oneOf` is refused (400 before any generation). The wire
  schema now uses `anyOf` (commit ca59099); the discriminated branches make the two equivalent, and
  `ReasoningProposalSchema` still validates the output.
- **Usage.** SERV reports `prompt_tokens`, `completion_tokens` and cached prompt tokens. Reported usage:
  18,384 prompt + 1,510 completion tokens, computed cost $0.027444 at catalog prices (9,088 prompt tokens were reported cached;
  the catalog lists no cached price for `serv-mini`, so the recorded figure prices every prompt token at the full rate).
- **Outcome.** The model called `get_asset_snapshot`, then `submit_candidate_schema`. The product REJECTED the proposal:
  `CITATION_OUT_OF_RANGE` (for example a manual-page citation re-labelled with a `RECORD` locator for the asset serial) and
  `CITATION_QUOTE_MISMATCH` (a quote not found in the cited span). The guardrail worked as designed; after run 1 a real run with a
  validated cited proposal was still `NOT_RUN` (see run 2).

### PDF text extraction: parser v3 (after run 1)

Run 1 showed text in the manual's fonts with custom encodings extracted as shifted glyph codes (for example
`W H P S H U D W X U H` for "temperature"), so parts of the manual were unreadable to the model and to the quote check.
The manual's fonts are WinAnsi TrueType fonts (already handled) and four Type0 Identity-H fonts with ToUnicode CMaps
(`bfchar`, both `bfrange` forms, 2-byte codes); one of them is the Symbol font, mapped into U+F0xx. No `/Differences`.

`uptimebuyer-parser.v3` (`packages/evidence/src/pdf.ts`, `cmap.ts`) decides the supported subset:

- Text is decoded through the current font (`Tf`, kept across `BT` and saved/restored by `q`/`Q`; page resources may be
  inherited or indirect). The parts of a `/Contents` array are one content stream, so this state carries across them.
  If a part cannot be read, the state after it is unknown: that part and everything after it are withheld
  (`CONTENT_STREAM_UNREADABLE`).
- A ToUnicode CMap is used when present: `codespacerange`, `bfchar` and `bfrange` (incrementing and array forms) with
  1- and 2-byte codes. A CMap with any malformed entry, `usecmap`, CID operators or wider codes is refused as a whole.
- Simple fonts decode through the WinAnsi, Standard, MacRoman (Annex D Latin set only) or Symbol encoding they name, or without `/Encoding` through their
  built-in encoding (StandardEncoding for nonsymbolic fonts, Symbol for Symbol, unknown for other symbolic fonts), and
  `/Differences` through a standard glyph-name subset (`uniXXXX`, `uXXXX`, suffixes and ligature components included).
- Type0 Identity-H/V is decoded only with ToUnicode.
- Anything else is withheld as U+FFFD with a recorded reason (`textWithheld`: `FONT_ENCODING_UNKNOWN`, `CMAP_REFUSED`,
  `GLYPH_UNMAPPED`, `CODE_POINT_INVALID`) and is never guessed. Lone surrogates, controls, non-characters, private use
  and bidi controls never reach span text. A page with only withheld text has no text. Form XObject text (`Do`) is not
  extracted, as before.
- New bounds (`DOCUMENT_LIMITS`): `maxFonts`, `maxCMapBytes`, `maxCMapMappings` (charged before a range is expanded),
  `maxCMapMappingsTotal`, `maxRefHops`, `maxFontObjectBytes`. Exceeding one rejects the document (`CMAP_TOO_LARGE`,
  `TOO_MANY_FONTS`).
- Spans are immutable. Migration 0024 keys a document by parser version; a document lineage is one blob under one
  role and applicability, with one row per parser derivation. Re-ingesting a blob whose spans or facts changed records
  a new derived document (`rederived_from_document_id`, migration 0025), which withdraws the old derivation and
  produces a new evidence revision. Facts are extracted by the version that derived the spans (v1 has no
  certification facts). An unchanged extraction is reused and a withdrawn lineage is not resurrected. An explicit
  replacement stays in `supersedes_document_id`, so a re-ingest that does both records both. A replacement naming a
  derivation of its own bytes is refused (`SUPERSEDED_DOCUMENT_SAME_LINEAGE`). A replacement requested for bytes that
  are already recorded succeeds only when it is the recorded link (idempotent retry), otherwise it is refused
  (`REPLACEMENT_BYTES_ALREADY_RECORDED`); success is never reported without the transition.
- Consent withdrawal (`withdrawConsentedCommunicationsInTx`) records the withdrawn consent ref
  (`evidence_consent_withdrawals`, migration 0027) and withdraws its documents under a per-consent advisory lock that
  ingestion also takes after the lineage lock. Ingestion refuses a withdrawn consent ref (`CONSENT_WITHDRAWN`), so no
  committed active document carries a withdrawn consent, whichever path records it.
- Withdrawal, replacement and re-derivation are serialized by a per-lineage advisory lock (a leaf lock, see ADR 0006).
  Withdrawing or replacing a document withdraws every derivation of its bytes. A re-derivation whose older derivation
  was withdrawn by a path outside the lock fails with `DOCUMENT_WITHDRAWN_DURING_REDERIVATION` and records nothing.
- `reopenCitation` re-derives with the parser version recorded on the cited document; the v1/v2 decoder is kept
  verbatim for that. The Dixell manual's v3 span digests from journey 2 are pinned in T-021.
- The system prompt now says that citation ids come only from packet excerpts or `search_evidence` results, each with
  its own digest and locator, that `get_asset_snapshot` has no citation, and how withheld text is shown.
  `PROMPT_TEMPLATE_DIGEST` moved from `reasoning-prompt.v1:sha256:76642896…8267` to
  `reasoning-prompt.v1:sha256:f83d9793…9cfb9c`. The config digest also moves, because it includes the parser version.
  The citation validator is unchanged.

### Run 2: `j-2026-11-12-serv-document-2` (source commit `28d05f0`)

One more user-authorized run (model `serv-mini`, hard cap $1.00, run budget $0.25 and 120k tokens,
`SERV_REASONING_EFFORT` unset) over the same manual, extracted by parser v3 (12 spans, nothing withheld). The records
are in `evidence/journeys/j-2026-11-12-serv-document-2/`. No request was refused.

- **Turns.** The model called `get_asset_snapshot`, then `submit_candidate_schema` (2 turns, both HTTP 200).
- **Usage.** 17,039 prompt + 1,221 completion tokens (8,320 prompt tokens reported cached); computed cost $0.024365
  with every prompt token priced at the full catalog rate.
- **Outcome.** `COMPLETED`, disposition `PROPOSAL_ONLY`. The product's citation validation accepted the proposal
  (`rpr_cf7dc581-…`, authority `NONE`, no review reasons). Every one of its 7 citations names a manual page and
  re-opened from the stored object and verified. It cites nothing from the asset snapshot and extracts no serial.
- **Gate.** The journey gate reads document PASS and reasoning PASS, file-only and with the `--database` cross-check.
  Sensor, payment, fulfillment, recovery, duplicate and timeout are `NOT_RUN`, so the journey and T-058 stay `NOT_RUN`.
