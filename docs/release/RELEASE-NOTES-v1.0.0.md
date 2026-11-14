# UptimeBuyer v1.0.0: release notes

> Released on 2026-11-14 as tag `v1.0.0` at `619cb5f`, under the owner's single-use RELEASE_TAG authorization
> `auth-release-tag-20261114-fee5f4`. The demo video `uptimebuyer-demo.mp4` (sha256
> `ec87d6aba4b84d35d29d32231b220caa51d81ec2bca961698b6d8b58690c2bca`) is attached under the VIDEO_UPLOAD authorization
> `auth-video-upload-20261114-9ef8df`. The video's console part is SIMULATED and labelled so.

The SERV Hackathon 02 submission build (Track 02: Kite). Everything here was built from the build pack imported on
2026-11-04 <!-- C-015 -->.

## What is included

- **Incident to recovery**: signed telemetry with freshness and deduplication, one incident per fault, cited evidence,
  deterministic compatibility (ALLOW, HOLD, REJECT), cost-to-recovery planning, bounded approval, orders and service
  jobs, and recovery verification that closes only on a stable sensor window plus an authoritative sign-off
  <!-- C-001 C-002 C-004 C-008 -->.
- **SERV Reasoning adapter**: proposals only, every citation re-opened against the stored document, injected
  instructions isolated <!-- C-003 -->.
- **Kite broker**: the only holder of the paid credential and paid egress, signed bounded authorities, hard caps in code,
  UNKNOWN reconciled before any retry, manual resolution for outcomes it cannot verify <!-- C-005 C-006 C-007 -->.
- **Operator console**: honest stale, unknown and unsupported states; keyboard and screen-reader operable
  <!-- C-009 -->.
- **Operations**: worker with per-runner locks, compose definitions, local smoke, backup, restore and rollback runbook
  <!-- C-010 C-011 C-012 -->.
- **Release tooling**: one gate per external action, signed single-use authorizations (now also for X_POST,
  VIDEO_UPLOAD, RELEASE_TAG and HACKATHON_SUBMISSION), the real-input journey gate and the claim check
  <!-- C-013 C-014 C-018 -->.
- **Demo video**: `uptimebuyer-demo.mp4` (1080p, 2 min 56 s, captions burned in, `SUBTITLES.srt`), built by
  `scripts/release/demo-video.mjs` <!-- C-017 -->.

## Evidence

- Local: unit, integration and browser suites pass in `pnpm verify`; the coverage report is `docs/coverage/COVERAGE.md`
  <!-- C-016 -->.
- SERV run recorded (full journey NOT_RUN): journey j-2026-11-12-serv-document-2, serv-mini over the published Dixell XR60CX manual, COMPLETED, $0.024365, 7 of 7 citations verified; document and reasoning PASS <!-- C-021 -->.
- Kite payment recorded (full journey NOT_RUN): journey j-2026-11-13-kite-payment-2, one 0.01 USDC x402 payment to lionx402.com through a passkey-approved session, HTTP 200 with 7 results, no second charge on the duplicate <!-- C-022 -->.
- Its outcome (recorded; full journey NOT_RUN): UNKNOWN on chain id 2366, resolved CAPTURED by the owner from out-of-band evidence; payment, fulfillment and duplicate PASS; chain 2366 is an open question <!-- C-022 -->.
- Earlier attempts are recorded as they happened: a REJECTED SERV proposal and a Kite attempt with no payment (both NOT_RUN as evidence) <!-- C-021 C-022 -->.

## Not yet proven (NOT_RUN)

- Physical sensor: NOT_RUN <!-- C-020 -->.
- Physical recovery evidence: NOT_RUN <!-- C-023 -->.
- The timeout case after a real payment: NOT_RUN <!-- C-022 -->.
- Hosted deployment: NOT_RUN <!-- C-024 -->.
- One complete real-input journey (T-058): NOT_RUN <!-- C-021 C-022 -->.
- Production load, SLOs, edge/WAF and enforced network policy: NOT_RUN <!-- C-026 -->.

Write-up: [WRITEUP.md](./WRITEUP.md). Claims ledger: [claims.json](./claims.json).
