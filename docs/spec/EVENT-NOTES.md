# SERV Hackathon Edition 02 — Event Notes

## Verified event facts

- Event: SERV Hackathon, Edition 02, organized by OpenServ; runs online 2–15 November 2026. Track partners: Dolphin, Kite and Reppo; there is also an Open Track.
- Submission deadline: **15 November 2026, 23:59 UTC**.
- **SERV Reasoning is mandatory:** the official page states SERV Reasoning must be part of the build. Building with it needs an OpenServ account and API key.
- Required submission artifacts: a public code repository, a demo link or video, a short write-up that says what the project does, how it uses SERV Reasoning and which track it enters, and an X post shared by the deadline whose link goes in the submission form.
- Proposed track: Kite (agents with verifiable identity and spending limits). Kite is optional for the event; SERV is not.
- Existing projects are allowed only when the hackathon work adds a meaningful feature.
- Judging emphasis includes creativity, user readiness, and revenue potential.
- Official source: <https://www.openserv.ai/hackathon-2>

These facts are point-in-time evidence captured and re-checked on 4 November 2026. Re-open the official page before final submission because dates, fields, and eligibility rules can change.

## UptimeBuyer submission thesis

UptimeBuyer is a commercial-refrigeration recovery product for multi-site restaurants, grocers, and dark stores. A real equipment signal opens an incident; bounded reasoning finds evidence; deterministic policy blocks unsafe or incompatible action; a user-approved Kite Passport session pays for allowed provider or purchase actions; independent sensor and work-order evidence closes the incident.

The sponsor integration is material rather than decorative:

1. OpenServ/SERV performs bounded evidence extraction and proposes recovery actions.
2. Deterministic application code makes compatibility, safety, authority, and budget decisions.
3. Kite Passport supplies identity, user-controlled spending, and paid-service access.
4. UptimeBuyer owns the vertical asset graph, recovery policy, orchestration, and authoritative recovery verification.

## Submission truth rules

- A public repository is not created, pushed, or made public without explicit user authorization.
- A video is not uploaded, an X post is not published, and the form is not submitted without explicit user authorization.
- Paid fulfillment is `NOT_RUN` until a real payment and downstream result are observed.
- A service returning HTTP 402 proves payment negotiation exists; it does not prove successful paid fulfillment.
- A simulator may test engineering paths, but it cannot be described as a physical recovery result.
- Any unavailable external capability is shown as `UNKNOWN`, `UNSUPPORTED`, or `NOT_RUN`; the UI never converts it into success.
- The final submission must distinguish specification evidence, automated test evidence, deployment evidence, and real-world outcome evidence.

## Pre-submission revalidation

Immediately before publishing or submitting, verify:

- deadline, timezone, tracks, eligibility, and per-person/project limits on the official page;
- repository visibility and license;
- the live demo URL from a clean browser session;
- demo video audio/subtitles and accessibility;
- every sponsor claim against current documentation;
- every external link and QR code;
- secret scan, dependency audit, and clean-checkout test results;
- receipts, provider responses, and sensor evidence have sensitive fields redacted;
- X copy and submission text match the demonstrated build.

## Evidence status at pack creation

| Claim | Status |
|---|---|
| Product implementation exists | `NOT_RUN` |
| Hardware path works | `NOT_RUN` |
| Kite paid action fulfills | `NOT_RUN` |
| OpenServ workflow executes | `NOT_RUN` |
| Deployment is reachable | `NOT_RUN` |
| Public repository exists | `NOT_RUN` |
| Submission artifacts are published | `NOT_RUN` |
| This specification pack is structurally verified | Recorded in `PACK-QA.md` after pack freeze |

