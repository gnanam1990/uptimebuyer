# Hackathon form text (DRAFT, not submitted)

> DRAFT for https://openserv.typeform.com/submissions02 (SERV Hackathon 02; deadline 15 November 2026, 23:59 UTC).
> Not submitted: HACKATHON_SUBMISSION is NOT_RUN and needs its own explicit authorization over the exact final text
> (`GATE-REQUESTS.md`). Fill the placeholders in a copy, sign that copy, then paste the content of each text block into
> its field (one paragraph per line). The demo's console part is SIMULATED and labelled so; its evidence parts show
> committed records of real runs.

## Project name

```text
UptimeBuyer
```

## One-liner

```text
From refrigeration failure to verified recovery, with bounded spending: SERV Reasoning proposes cited evidence, code decides, and a Kite broker pays only within a signed cap.
```

Claims: <!-- C-003 C-004 C-005 --> local tests.

## Description

```text
UptimeBuyer coordinates commercial-refrigeration recovery for multi-site restaurants, grocers and dark stores. A cooler's temperature signal opens one incident. SERV Reasoning reads the equipment manual and proposes cited facts and candidate actions. Deterministic code decides compatibility, safety and budget. An operator approves a bounded spend, an isolated broker is the only process that can pay (through Kite Passport), and the incident closes only on independent recovery evidence (a stable sensor window plus an authoritative sign-off), never on a provider's say-so.
Recorded so far: one SERV Reasoning run on the published Dixell XR60CX manual (accepted, $0.024365) and one 1-cent Kite x402 payment with the merchant's answer (7 results; the duplicate caused no second charge). Each is one part of the real-input journey, which as a whole is NOT_RUN.
Not yet proven: a physical sensor, physical recovery, the timeout case and a hosted deployment (all NOT_RUN).
```

Claims: <!-- C-002 C-004 C-005 C-008 --> local tests; <!-- C-021 C-022 --> recorded parts, full journey NOT_RUN;
<!-- C-020 C-023 C-024 --> NOT_RUN.

## How it uses SERV Reasoning

```text
SERV Reasoning is the evidence and proposal layer. It gets the exact manual revision and the incident packet, calls two product tools and returns fault hypotheses, extracted fields with citations, candidate actions and its uncertainty. The answer is a MODEL PROPOSAL with no authority: the product re-opens every citation against the stored document and rejects the whole proposal on any mismatch, and every decision stays deterministic code.
Recorded run (the full journey is NOT_RUN): serv-mini, 7 of 7 citations verified, $0.024365, journey j-2026-11-12-serv-document-2. An earlier run was REJECTED by the citation check; the PDF font decoding was fixed and the run repeated.
```

Claims: <!-- C-003 C-004 --> local tests; <!-- C-021 --> recorded run, full journey NOT_RUN.

## Track

```text
Track 02: Kite (agents with verifiable identity and spending limits you control). Only the broker holds the paid credential; every spend needs a signed, bounded authority (amount, merchant, purpose, expiry) plus the owner's single-use signed release-gate record.
Recorded payment (the full journey is NOT_RUN): a passkey-approved one-cent Kite Passport session and one x402 payment of 0.01 USDC to lionx402.com. The broker recorded it UNKNOWN because kpass reported chain id 2366 instead of Base; the owner resolved it CAPTURED from wallet, Kite activity and session evidence. What chain 2366 denotes is an open question.
```

Claims: <!-- C-005 C-006 C-007 C-013 --> local tests; <!-- C-022 --> recorded payment, full journey NOT_RUN.

## What was built during the hackathon

```text
Everything in the repository, from the build pack imported on 2026-11-04: fifteen modules (M00 to M14) from the workspace to the operator console and release gates, the real-input journey runners and their evidence records, and the submission tooling (demo video builder, claim check, signed release-gate records).
```

Claims: <!-- C-015 C-017 C-018 --> repository history and local tests.

## Repository

```text
https://github.com/gnanam1990/uptimebuyer
```

## Demo link

```text
<DEMO_URL>
```

For example the v1.0.0 release page with the video attached, once VIDEO_UPLOAD is authorized.

## X post link

```text
<X_POST_URL>
```

After X_POST is authorized and the owner posts.

## Team

```text
<TEAM_NAME>
```

A solo build by the repository owner (GitHub gnanam1990); fill in the name to show.
