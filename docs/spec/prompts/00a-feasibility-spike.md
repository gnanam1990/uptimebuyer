# F0 — Pre-Build Feasibility Spike

Pack status: SPECIFICATION_ONLY. Initial execution status: NOT_RUN.

F0 is a separately authorized evidence gate after M00 and before M01. It is not a canonical module, owns no FR, NFR, INV, or T identifier, and cannot be used to claim that UptimeBuyer is implemented.

## Role and decision

You are the feasibility agent. Answer the few questions that can invalidate the hackathon direction before the full build:

1. Can one authenticated physical sensor or explicitly labelled deployed edge process produce trustworthy normal, fault, and restored-condition observations?
2. Can one exact equipment identity, manufacturer document and OEM/MPN fact be reproduced with citations?
3. Can one low-value, user-approved Kite-paid service complete and expose enough authoritative state to reconcile an ambiguous response?
4. Can a separately running broker alone access the Kite credential and paid endpoint while the API, browser, model and general worker are technically denied?
5. Can provider completion remain separate from equipment-recovery proof?
6. Do at least three relevant restaurant, grocery, dark-store, facilities, or refrigeration operators confirm from a recent incident that emergency response delay or wrong-part sourcing is a current pain worth piloting?
7. Can a real SERV Reasoning run (OpenServ account and API key) return a schema-valid cited proposal from the exact manual revision while holding no Kite credential or paid egress? SERV Reasoning is mandatory for the event submission.

The output is a `PASS`, `FAIL`, `UNKNOWN`, `UNSUPPORTED`, or `BLOCKED` result for each question, a recommendation to proceed, narrow or stop, and redacted evidence. A passing spike qualifies only the exact tested surface.

## Read before acting

Read `START-HERE.md`, `PROJECT-BRIEF.md`, `CORE-CONTRACT.md`, `MASTER-PROMPT.md`, `ARCHITECTURE.md`, `KITE-OPENSERV-INTEGRATION.md`, `HARDWARE-IOT.md`, `SECURITY.md`, `DELIVERY.md`, `RISKS-DECISIONS.md`, `SOURCES.md`, and this prompt. Read repository instructions and the M00 handoff. Verify the actual source SHA, branch, dirty state, toolchains, local services and account/environment metadata without printing secrets.

Preserve user-owned work. Do not reset, clean, stash, rebase, amend, delete, overwrite, create a remote, push, open or merge a pull request, deploy, publish, or submit an event entry.

## Authorization boundary

Read-only catalog/document discovery, local code, local process isolation and simulated fault injection are allowed only within the active implementation request. Before any action that contacts a real recipient, makes a real call or email, creates a paid request, spends funds, buys an item, changes a provider/account, or physically intervenes in equipment, stop and obtain explicit user authorization for:

- exact account and environment, including any Kite account or credential provisioned or used, and any OpenServ usage that consumes paid credits or sends third-party manual content;
- exact provider and recipient or merchant;
- exact action and expected downstream effect;
- maximum amount and currency, including possible retries/fees;
- the single idempotency key or provider reference strategy;
- evidence and redaction plan;
- physical safety boundary when applicable.

If the user does not authorize an external action, record it as `BLOCKED` or `NOT_RUN`. A general request to build the project is not permission to spend, contact a person, order, publish, deploy, or accept provider terms.

## Isolated spike layout

Keep all disposable spike code under `spikes/f0/` on a local branch such as `spike/f0-feasibility`. Do not reshape production packages around a one-off provider result.

Use separate local processes or containers:

- `f0-client`: creates only a credential-free signed/hashed intent envelope;
- `f0-general-worker`: proves that ordinary work can run but cannot read Kite credentials or connect to paid Kite destinations;
- `f0-serv`: the only process holding the OpenServ API key; it reaches only approved OpenServ endpoints and is denied the Kite credential and paid Kite destinations;
- `f0-kite-broker`: the only process with the secret reference and the narrow paid-destination allowlist;
- `f0-sensor`: actual authenticated physical device or genuinely deployed edge process; a separate explicitly labelled simulator may exercise fault paths but cannot pass the real-sensor gate;
- `f0-evidence`: redacted manifests, checksums, commands and result summaries.

The spike may use a minimal intent schema rather than the final domain implementation. It must not claim the final M09 broker, production network isolation, tenant model, budget ledger or product state machine exists.

## F0-A — Current provider capability

1. Re-query official/live Kite catalog and relevant provider documentation at execution time.
2. Record retrieval time, service identifier, endpoint, environment, request schema, payment challenge, price/currency, fulfillment response, lookup/status/refund capability, idempotency semantics and terms boundary.
3. Distinguish catalog listing, HTTP 402 negotiation, authorized payment, payment confirmation and downstream fulfillment.
4. Reject a provider for the winning claim if an ambiguous effect cannot be looked up or safely repeated with the same idempotency reference.
5. Do not infer present support from this pack's point-in-time source list.

Result is `PASS` only when the exact planned low-value action and its reconciliation surface are supported. Documentation alone is not fulfillment proof.

## F0-B — Exclusive broker boundary

1. Start the broker under a distinct OS/container/workload identity.
2. Inject the Kite credential only into the broker; record secret metadata, never its value.
3. Give only the broker the paid-destination allowlist.
4. From the client, browser-shaped process, model-shaped process and general worker, attempt secret reads, direct DNS/network access, alternate HTTP clients, redirects and proxy/environment-variable bypass.
5. Prove those attempts fail while the broker can accept only the credential-free intent reference.
6. Tamper with incident/purpose/provider/amount/currency/expiry/idempotency fields and prove the broker rejects the altered envelope.

Local process/container evidence proves the spike boundary only. Production isolation stays `NOT_RUN` until the target deployment enforces separate workload identity, secret grants and egress policy.

## F0-C — Low-value paid action and reconciliation

After the exact action is authorized:

1. Display provider, recipient/merchant, purpose, maximum amount, currency, expiry and idempotency reference before execution.
2. Persist a redacted pre-egress intent record.
3. Execute exactly one low-value action through `f0-kite-broker`.
4. Record payment state and downstream provider result separately.
5. Preserve provider/payment references, timestamps, response digests and redacted receipt or fulfillment artifact.
6. Exercise ambiguous-outcome recovery only through a safe provider-supported method. Prefer a controlled client-response loss after the provider has an idempotency reference; never create a second real effect merely to test retry.
7. Lookup/reconcile using authoritative provider state. If lookup remains inconclusive, result is `UNKNOWN`, not `FAIL` and not a retry invitation.
8. Confirm the general worker cannot use the broker credential or repeat the effect.

A paid search, phone call or email passes only its exact commercial action. It does not prove part compatibility, delivery, installation or equipment recovery.

## F0-D — Sensor and evidence vertical slice

1. Use a safe controlled rig with an authenticated physical sensor or a genuinely deployed authenticated edge process; never modify live refrigeration circuitry or safety interlocks. A local simulator/replay may supplement fault coverage but cannot make this capability `PASS`.
2. Record device identity, authentication mode, firmware/build digest, channel/unit, calibration metadata, source time, receive time, boot ID and sequence.
3. Show one fresh normal observation and one controlled breach or replay labelled with its true source.
4. Use one exact equipment manufacturer/model/serial snapshot and one real manufacturer manual/BOM revision.
5. Cite the exact page/record that establishes the demonstrated OEM/MPN or intervention fact.
6. Introduce an ambiguous/incompatible candidate and show that the spike cannot turn semantic similarity into approval.
7. Load the response or containment deadline from a versioned tenant/demo SOP. Any spoilage estimate is separately labelled non-authoritative and cannot replace that deadline.
8. Restore the safe controlled condition and record fresh observations, but do not claim the final recovery verifier or product incident state exists.

Simulator input, replay and manual intervention are allowed when clearly labelled. Simulator-only evidence makes the real sensor capability `UNKNOWN` and the recommendation at most `NARROW`; it cannot be narrated as a physical autonomous repair or an F0-D pass.

## F0-E — Recovery-authority separation

Create separate evidence records for:

- payment observation;
- provider acceptance;
- downstream delivery/work report;
- installed-part or authorized sign-off when available;
- fresh sensor observations over the spike window.

Prove that a provider-completed message or payment receipt alone cannot create the spike's recovery result. The result may say the controlled condition returned to range, but final UptimeBuyer recovery policy remains `NOT_RUN` until M11 and the canonical tests execute.

## F0-F — Customer problem evidence

Use existing user-provided interview records, or obtain explicit user authorization before contacting any real person. Do not scrape private contact data, impersonate the user, promise a product, or publish a statement.

For at least three relevant operators, record an anonymized evidence note covering:

- role, segment, multi-site scope, interview date and whether the account is an existing relationship;
- one recent refrigeration/equipment incident timeline and how the fault was detected;
- time spent identifying the exact asset/part and finding a provider;
- wrong-part, no-stock, approval, callout, downtime or closeout-proof friction actually experienced;
- current workflow/tools and who owns budget/approval;
- what evidence they trust before calling an asset recovered;
- whether they would evaluate a controlled pilot and what security/safety requirement would block it.

Result is `PASS` only when three operators independently confirm at least one current target pain from a concrete recent workflow. Compliments, hypothetical interest, public survey statistics, founder inference, and one repeated anecdote are not three confirmations. `PASS` is early problem evidence, not market validation, willingness-to-pay proof, or authorization to contact them again.

## F0-G — SERV Reasoning

1. Confirm the OpenServ account and API key exist; record secret metadata only, held by `f0-serv`, never by `f0-kite-broker`.
2. Send one read-only evidence packet built from the F0-D manual revision and receive a schema-constrained proposal with citations.
3. Validate every citation against the cited digest/page; reject any proposal text that requests tools, secrets, egress, policy change or payment.
4. Prove `f0-serv` cannot read the Kite credential or reach paid destinations.

Result is `PASS` only for a recorded real SERV run. Without it the build cannot be submitted to the event, whatever else passes.

## Failure injection

At minimum record:

- denied direct paid egress from the general worker;
- denied secret read outside the broker;
- tampered intent rejected;
- duplicate idempotency reference returns or reconciles the same effect;
- one timeout/response-loss path becomes `UNKNOWN` until lookup;
- provider completion without sensor evidence remains insufficient;
- stale sensor data remains non-healthy;
- ambiguous part evidence remains held.

Do not create costly, harmful or duplicate external effects merely to obtain a fault screenshot. Use local faults for all cases except the single explicitly authorized low-value action and its safe reconciliation path.

## Evidence record

Write a redacted F0 report at `spikes/f0/F0-REPORT.md` and mirror its per-sub-gate status into the `feasibility` block of `BUILD-STATUS.json`. It contains:

- repository path, branch, start/end SHA and dirty-state note;
- execution date, environment and tool versions;
- exact commands and exit codes;
- selected sensor/equipment/document/provider identifiers;
- anonymized F0-F roles/segments, interview dates, concrete incident evidence and consent/source basis;
- user authorization reference without private message contents;
- approved maximum and actual amount/currency;
- intent/idempotency/provider/payment references with secrets removed;
- broker and denied-egress process identities;
- status and evidence path for sub-gates F0-A through F0-G;
- every `NOT_RUN`, `UNKNOWN`, `UNSUPPORTED` and `BLOCKED` result;
- whether any real call, email, payment, purchase or physical action occurred;
- recommendation: `PROCEED`, `NARROW`, or `STOP`;
- explicit statement: “F0 is feasibility evidence, not canonical module or product implementation evidence.”

Never store credentials, payment headers, private transcript content, personal contact details, precise private facility addresses or unredacted customer data in the report, logs, fixtures or repository.

## Decision rule

Recommend `PROCEED` only when the selected action can complete and reconcile under a hard cap, broker bypass attempts fail, an authenticated physical sensor or genuinely deployed edge process makes the vertical evidence slice reproducible, provider completion remains separate from restored-condition observation, F0-G records a real SERV Reasoning run, and F0-F has three independent concrete operator confirmations. Simulator-only evidence cannot produce `PROCEED`.

Recommend `NARROW` when a different truthful paid action, a reduced equipment/intervention scope, or a better-supported customer subsegment preserves the product thesis; describe exactly what the demo may and may not claim. A narrowed direction requires user acceptance before full build.

Recommend `STOP` when real paid fulfillment/reconciliation is unsupported, the broker is bypassable, exact evidence cannot be established, or the recovery observation is not credible. Preserve the negative result rather than replacing it with a mock.

Do not start M01 or another full-build module from this prompt. Hand the F0 record to the user for the proceed/narrow/stop decision.
