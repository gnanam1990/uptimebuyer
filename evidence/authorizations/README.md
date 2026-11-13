# Release authorization records

Signed `release-authorization.v1` records, one JSON file per authorization, named `<GATE>.<authorizationId>.json`,
plus `consumed.json` listing authorization ids already used. See `scripts/release/release-gate.mjs` and
`docs/release/RELEASE-GATES.md`.

One record exists: `PAYMENT.auth-payment-20261113-cacd36.json`, the repository owner's authorization of one USD 0.01
payment to lionx402.com (REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP, kite-passport-prod), signed on 2026-11-13 with key
`owner-195587c58bb1180e`. The first live T-058 attempt (journey `j-2026-11-13-kite-payment`) consumed it; that attempt
made no payment (see `evidence/journeys/j-2026-11-13-kite-payment/resolution.json`). `decisions.jsonl` holds the gate's
decision for it. No other external action (repository publication, X post, video upload, release or tag, hackathon
submission, deployment) has been authorized.
