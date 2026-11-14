# Demo video plan (DRAFT until the submission; the video is uploaded)

> DRAFT until the hackathon submission, which is NOT_RUN <!-- C-025 -->. The video is attached to the release `v1.0.0`
> (`https://github.com/gnanam1990/uptimebuyer/releases/tag/v1.0.0`) under the owner's VIDEO_UPLOAD authorization
> `auth-video-upload-20261114-9ef8df`, which named that destination and the file's sha256. Its console
> walk-through is SIMULATED; its evidence segments show committed records of real runs; the complete real-input journey
> (DEMO-VALIDATION.md) is NOT_RUN <!-- C-020 C-021 C-022 C-023 -->.

## Format

- `docs/release/video/uptimebuyer-demo.mp4`: H.264, 1920x1080, 30 fps, about 3 minutes, no audio, captions burned in;
  the same captions are `SUBTITLES.srt`. Digest, size and segment times: `video/video-manifest.json` <!-- C-017 -->.
- Built by `node scripts/release/demo-video.mjs` (needs `DATABASE_URL` and a built web bundle): the timeline in that
  script is the single source of the segments, the captions and `SUBTITLES.srt`; `--check` fails if the subtitles drift.
- The console segment is captured by `node scripts/release/console-capture.mjs` (real pointer moves and clicks on the
  local SIMULATED stack, DevTools screencast at twice the frame size) and edited in Recordly: eased zooms on the panel
  each caption talks about and an animated cursor that follows the logged pointer path. The edit adds no frame and
  reorders nothing; `demo-video.mjs --console <dir>` composes it with the slides. The edit decisions (step marks, zoom
  regions, cursor path) are in `video/console/`, the clip's digest in the manifest.
- Every console caption starts with SIMULATED, the console's own environment label (in the navigation rail) says
  SIMULATED_INPUT on every page, and every simulated reading carries its SIMULATED_INPUT tag. Every evidence slide carries a REAL EVIDENCE badge and names its record.
- No secret, wallet address, e-mail, phone number or account id on screen: the console data is synthetic and the
  evidence slides show only fields of the already redacted records (ids shortened).

## Storyboard

| #   | Segment             | Label     | Source                                             | What it shows                                                                   | Claim                               |
| --- | ------------------- | --------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| a   | Title (0:00)        | CONTEXT   | slide                                              | What UptimeBuyer is; the three labels used in the video                         | <!-- C-017 -->                      |
| b   | Architecture (0:08) | CONTEXT   | slide drawn from `ARCHITECTURE.md`                 | SERV proposes, code decides, the broker is the only paid egress                 | <!-- C-003 C-006 -->                |
| c   | Console (0:24)      | SIMULATED | capture of the local e2e stack, edited in Recordly | Command Center, incident, evidence, plan, order, UNKNOWN, verification, ledger  | <!-- C-001 C-004 C-007 C-008 -->    |
| d1  | SERV run (1:23)     | REAL      | `evidence/journeys/j-2026-11-12-serv-document-2/`  | Manual provenance, run, cost, verified citations, gate table, earlier rejection | <!-- C-021 --> NOT_RUN as a journey |
| d2  | Kite payment (1:49) | REAL      | `evidence/journeys/j-2026-11-13-kite-payment-2/`   | Signed authority, session, x402 call, merchant results, UNKNOWN, resolution     | <!-- C-022 --> NOT_RUN as a journey |
| e   | Not yet (2:37)      | NOT_RUN   | slide                                              | Sensor, recovery, timeout, deployment, the complete journey                     | <!-- C-020 C-023 C-024 --> NOT_RUN  |
| f   | End card (2:49)     | CONTEXT   | slide                                              | Repository URL, where the evidence lives                                        | <!-- C-017 -->                      |

In segment c the order page shows "Session confirmed" and captured amounts: they come from the RECORDED_CONTRACT broker
(simulated), not from Kite, and the caption says so. The only real payment is the one in segment d2.

## Before any upload

Run `pnpm release:check` and `node scripts/release/demo-video.mjs --check`, watch the whole video once (labels visible,
nothing sensitive on screen), then pass the `VIDEO_UPLOAD` gate with an authorization naming the destination and the
file's sha256 (`GATE-REQUESTS.md`). Uploading is the operator's own action.
