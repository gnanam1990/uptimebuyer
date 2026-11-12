# Demo video plan (DRAFT, not recorded, not uploaded)

> DRAFT. No video has been recorded or uploaded: the video upload is NOT_RUN and needs its own explicit authorization
> (`RELEASE-GATES.md`). This plan covers the local SIMULATED demo only. A recording of the real-input journey
> (DEMO-VALIDATION.md) is NOT_RUN: it needs a real sensor, document, OpenServ run, bounded Kite-paid action and
> recovery evidence in one run. Only the document part has passed (journey j-2026-11-12-serv-document); the one SERV run there
> was REJECTED and everything else is NOT_RUN <!-- C-020 C-021 C-022 C-023 -->.

## Format

- 16:9, 1080p, about 3 minutes, subtitles in `SUBTITLES.srt` (narration optional).
- A persistent on-screen caption for the whole video: "SIMULATED DEMO: SIMULATOR sensors, recorded-contract payments,
  contract-fake reasoning and CMMS. Not a real run." The environment label in every screenshot says the same.
- No secret, wallet, phone number, customer data or address on screen (the data is synthetic).

## Storyboard (SIMULATED)

| #   | Scene                  | Source                                       | What it shows                                                                       | Claim                                    |
| --- | ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Title and honesty card | slide                                        | What UptimeBuyer does; the run is SIMULATED; E4/E5 evidence is NOT_RUN              | <!-- C-022 C-023 --> NOT_RUN             |
| 2   | Architecture           | `ARCHITECTURE.md` diagram                    | Broker as the only paid egress; model proposes, code decides                        | <!-- C-006 -->                           |
| 3   | Command Center         | `screenshots/01-command-center.png`          | SIMULATED_INPUT sensors with freshness; open incidents                              | <!-- C-001 -->                           |
| 4   | Incident               | `screenshots/02-incident.png`                | One incident, procedure deadline, next safe action                                  | <!-- C-002 -->                           |
| 5   | Evidence               | `screenshots/03-evidence.png`                | Cited facts from synthetic documents (contract-fake reasoning)                      | <!-- C-003 -->                           |
| 6   | Plan and approval      | `screenshots/04-plan-approval.png`           | Deterministic decision, bounded approval                                            | <!-- C-004 C-005 -->                     |
| 7   | Order                  | `screenshots/05-order-recorded-contract.png` | RECORDED_CONTRACT order and payment state                                           | <!-- C-005 -->                           |
| 8   | Failure handling       | `screenshots/07-unknown-outcome.png`         | An UNKNOWN outcome kept unresolved until reconciliation                             | <!-- C-007 -->                           |
| 9   | Recovery verification  | `screenshots/06-recovery-verification.png`   | Stable window and authoritative close-out; provider completion alone does not close | <!-- C-008 -->                           |
| 10  | Ledger                 | `screenshots/08-ledger.png`                  | Append-only evidence ledger                                                         | <!-- C-008 -->                           |
| 11  | Limits card            | slide                                        | Every NOT_RUN item from the write-up                                                | <!-- C-020 C-024 C-025 C-026 --> NOT_RUN |

Scene 7 shows "Session confirmed" and a captured amount: those come from the RECORDED_CONTRACT broker (simulated),
not from Kite; the scene's caption must say so.

## Before any upload

Run `pnpm release:check`, confirm the captions match the running build, then pass the `VIDEO_UPLOAD` gate with an
authorization naming the destination and the file's sha256. Uploading is the operator's own action.
