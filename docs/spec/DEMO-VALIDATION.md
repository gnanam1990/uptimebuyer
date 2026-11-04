# Demo and Validation Plan

## Demo objective

Prove a closed operational loop:

> real refrigeration signal → evidence-bound recovery plan → deterministic safety decision → bounded paid action → real intervention → independently verified recovery

The demo must make failure handling visible. A polished happy path without authoritative input and outcome evidence does not prove the product claim.

## Recommended physical setup

- A monitored cooler, insulated test chamber, or other safe non-production thermal setup.
- ESP32-class device with calibrated temperature sensor; optional current or door sensor.
- Edge agent publishing signed/credentialed MQTT measurements with device ID, sequence, timestamp, quality, and calibration metadata.
- A real public OEM manual or service document tied to the demonstrated equipment or component family.
- A real provider/service path and at least one real Kite-paid action.
- A controlled recovery action that cannot damage food, equipment, people, or property.

The demo environment must never bypass electrical, refrigerant, food-safety, warranty, or technician-licensing requirements.

## Authorization gates

Every real payment, provider contact or purchase, physical intervention, site recording, video upload, X post, repository publication and event submission in this plan requires explicit user authorization for that exact step (account, recipient or merchant, amount and cap, content), given in the active conversation. A general request to build or demo is not that authorization. Without it the step is recorded `BLOCKED` or `NOT_RUN` and is never replaced by a simulation presented as real.

## Narrative sequence

1. Show the sensor in a stable safe range and the asset record with model, serial, manual revision, site, policy, and inventory-at-risk value.
2. Introduce a safe controlled fault on the live authenticated sensor. A replay of a previously captured fault may illustrate the UI only when it carries the `SIMULATED_INPUT` badge; it cannot satisfy the central real-signal claim or E5.
3. Show incident deduplication, data freshness, threshold evidence, the response/containment deadline from a versioned tenant procedure, and downtime cost. If an optional spoilage-risk estimate is shown, label its provenance, revision, uncertainty and non-authoritative status.
4. Show SERV extracting cited evidence from the exact document revision.
5. Present at least two recovery candidates. Reject one because it is incompatible, unsafe, unapproved, too slow, or insufficiently evidenced.
6. Show deterministic `ALLOW`, `HOLD`, or `REJECT`; the model's proposal is never the authority.
7. Obtain operator approval, idempotently issue the immutable bounded execution authority, and show separate confirmed Kite-session activation with exact provider-account revision, amount, merchant/service, purpose, expiry, retry rules and optional provider reference.
8. After the user authorizes the exact action, recipient/merchant and cap, execute a real provider/contact/purchase action. Show idempotency key, payment state, provider state, and redacted receipt.
9. Demonstrate one failure: provider timeout, ambiguous payment, duplicate request, incompatible substitute, or stale sensor data.
10. Perform the approved intervention.
11. Keep the incident open until the configured continuous safe window passes and CMMS/authorized-operator evidence is valid.
12. Show the append-only evidence ledger, total cost, time-to-recovery, decisions, overrides, and unresolved limitations.

## Evidence ladder

| Level | Evidence | What it proves |
|---|---|---|
| E0 | Specification or screenshot | Intended design only |
| E1 | Unit/contract test | Local deterministic behavior |
| E2 | Integrated test with controlled dependencies | Cross-component behavior |
| E3 | Live provider/sponsor response without payment | Connectivity and protocol negotiation |
| E4 | Real bounded payment plus fulfilled downstream action | Commercial action completed |
| E5 | Independent sensor/CMMS recovery evidence | Operational outcome achieved |

The main product claim needs E4 and E5. Lower evidence levels must never be narrated as equivalent.

## Mandatory fault cases

- Duplicate telemetry and duplicate payment request do not create duplicate incidents or charges.
- Stale or missing sensor data cannot produce a green recovered state.
- An ambiguous part match becomes `HOLD`, not `ALLOW`.
- A substitute part cannot proceed on LLM confidence alone.
- Provider timeout after a possible charge becomes `UNKNOWN`; reconciliation runs before retry.
- Provider “completed” status without independent recovery evidence leaves the incident open.
- Recovery signal that regresses during the stable window resets the recovery evaluation (or escalates per policy); the incident stays `VERIFYING` and is not reopened, because only `RECOVERED` can reopen.
- Worker/API restart preserves the workflow and evidence ledger.

## Demo-day fallback policy

- With user authorization for the recording, record a real end-to-end run before the deadline and keep raw logs and timestamps.
- If a live third-party service fails, show the recorded real run and a live failure/reconciliation path; label both clearly.
- Do not switch to a fake provider and present it as live fulfillment.
- Keep read-only screenshots or exports of provider status, receipt, work order, and sensor window with secrets redacted.
- Maintain a local simulator only for deterministic fault injection; display a persistent `SIMULATED_INPUT` badge.

## Capture checklist

- 16:9 primary recording and readable 1080p UI.
- Subtitles are sufficient; narration is optional.
- No secret, wallet credential, phone number, customer data, or precise facility address is visible.
- Cursor movement and terminal output are deliberate and legible.
- Architecture diagram appears briefly, followed by the running product.
- The video shows the blocked unsafe candidate, bounded approval, real action, failure handling, and authoritative closeout.
- On-screen statuses match backend truth.
- The video and write-up show the recorded real SERV Reasoning run, state which event track is entered (Kite track proposed), and explain how SERV Reasoning is used, as the official page requires.

## Validation record

For every final run, record:

- commit SHA and deployment identifier;
- asset, sensor, manual, policy, and evidence revision IDs;
- incident and decision IDs;
- execution-authority ID/signed scope/lifecycle, Kite-session operation/outcome/reference, payment intent, receipt, and reconciliation IDs with secrets removed;
- provider order/job/call identifier;
- recovery-window start/end and authoritative evidence;
- commands/tests executed and exact results;
- remaining `NOT_RUN`, `UNKNOWN`, or unsupported claims.

