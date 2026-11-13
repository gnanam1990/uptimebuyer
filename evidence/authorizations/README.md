# Release authorization records

Signed `release-authorization.v1` records, one JSON file per authorization, named `<GATE>.<authorizationId>.json`,
plus `consumed.json` listing authorization ids already used. See `scripts/release/release-gate.mjs` and
`docs/release/RELEASE-GATES.md`.

Two records exist, both the repository owner's authorization of one USD 0.01 payment to lionx402.com
(REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP, kite-passport-prod), signed on 2026-11-13 with key `owner-195587c58bb1180e`,
and both consumed (`consumed.json`):

- `PAYMENT.auth-payment-20261113-cacd36.json`, consumed by the first live T-058 attempt (journey
  `j-2026-11-13-kite-payment`), which made no payment (`evidence/journeys/j-2026-11-13-kite-payment/resolution.json`).
- `PAYMENT.auth-payment-20261113-86104d.json`, consumed by the second attempt (journey `j-2026-11-13-kite-payment-2`):
  one paid call of USD 0.01, recorded UNKNOWN by the broker and resolved CAPTURED by the owner as finance approver
  (`evidence/journeys/j-2026-11-13-kite-payment-2/reconciliation.json`).

`decisions.jsonl` holds the gate's AUTHORIZED decision for each, bound to the exact request and journey id. No other
external action (repository publication, X post, video upload, release or tag, hackathon submission, deployment) has
been authorized.
