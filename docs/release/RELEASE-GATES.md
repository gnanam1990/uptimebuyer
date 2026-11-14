# Release gates (T-060)

Every external action is a separate gate (`config/release/gates.json`, `scripts/release/release-gate.mjs`). A gate opens
only for a signed authorization record of that exact gate (Ed25519, by a key registered in
`config/release/authorizers.json`), valid and unused, whose scope matches the request exactly, with every preflight
check passed. Authorizations never transfer between gates. Opening a gate records a decision; the operator then performs
the action themselves. The tooling performs no external action.

## Status at handoff

`node scripts/release/release-gate.mjs status`. One authorizer key is registered (`owner-195587c58bb1180e`, the repository
owner's). The authorization records are the owner's two one-cent PAYMENT authorizations,
`auth-payment-20261113-cacd36` (consumed by the first live T-058 attempt, which made no payment) and
`auth-payment-20261113-86104d` (consumed by the second attempt, whose payment is recorded in
`evidence/journeys/j-2026-11-13-kite-payment-2/`), and the v1.0.0 release records `auth-release-tag-20261114-fee5f4`
(tag `v1.0.0` at `619cb5f`) and `auth-video-upload-20261114-9ef8df` (the demo video attached to that release). All
four are used, so every gate is refused <!-- C-013 -->:

| Gate                 | Decision | Reason                     | Action it would allow                                        |
| -------------------- | -------- | -------------------------- | ------------------------------------------------------------ |
| REPO_PUBLICATION     | REFUSED  | NO_AUTHORIZATION           | Push the repository and/or change its visibility             |
| X_POST               | REFUSED  | NO_AUTHORIZATION           | Publish the X post from the approved draft                   |
| VIDEO_UPLOAD         | REFUSED  | AUTHORIZATION_ALREADY_USED | Upload the demo video                                        |
| RELEASE_TAG          | REFUSED  | AUTHORIZATION_ALREADY_USED | Create a release or tag                                      |
| PAYMENT              | REFUSED  | AUTHORIZATION_ALREADY_USED | Execute one real bounded Kite-paid action through the broker |
| HACKATHON_SUBMISSION | REFUSED  | NO_AUTHORIZATION           | Submit the hackathon form                                    |
| DEPLOY               | REFUSED  | NO_AUTHORIZATION           | Deploy the images to a hosted environment                    |

## Authorizing one action

1. The person authorizing registers their Ed25519 public key in `config/release/authorizers.json` (reviewed change).
2. They write a `release-authorization.v1` record naming the gate, the exact scope (for example the deploy environment,
   source SHA and image IDs; or the payment merchant, cap, currency and purpose), a validity window and their verbatim
   statement, sign it offline (`signAuthorization`) and add it under `evidence/authorizations/`.
3. Run the gate's preflight (for `DEPLOY` and `RELEASE_TAG`: verify, the local smoke, a backup with a verified restore
   and an exercised rollback) and `node scripts/release/release-gate.mjs check <GATE> --request ... --preflight ...`.
4. On `AUTHORIZED`, the operator performs the action and adds the authorization id to `consumed.json`.

## Authorizing the submission's release actions

`scripts/release/authorize.mjs` also builds and signs X_POST, VIDEO_UPLOAD, RELEASE_TAG and HACKATHON_SUBMISSION
records (`x-post`, `video-upload`, `release-tag`, `hackathon-submission`), binding the post text, the video and the
submission content by a sha256 it computes, after the same plain-words summary and `YES` <!-- C-018 -->. The exact scopes,
the order and the commands for this submission are in [GATE-REQUESTS.md](./GATE-REQUESTS.md). RELEASE_TAG and
VIDEO_UPLOAD were signed and used for v1.0.0; the owner posted on X and submitted the form outside this tooling, so the
X_POST and HACKATHON_SUBMISSION records are NOT_RUN <!-- C-025 -->.

## Authorizing the one bounded Kite payment (T-058)

The payment part of the real-input journey is NOT_RUN until the steps below are done. The person who authorizes runs
`scripts/release/authorize.mjs` on their own machine; no agent runs it. It works offline, keeps one Ed25519 key in
`~/.config/uptimebuyer/authorizer/` (directory 0700, key 0600, outside the repository), prints only the public key and
its key id, and signs a PAYMENT record only after the person types `YES`.

1. Create (or show) the authorizer key and copy the printed `keyId` and `publicKey`:

   ```sh
   cd /Users/kratos/uptimebuyer
   node scripts/release/authorize.mjs keygen
   ```

2. Register that public key in `config/release/authorizers.json` under `authorizers` as a reviewed, committed change
   (`"<keyId>": "<publicKey>"`). The live run refuses a dirty tracked tree, so this commit comes first.

3. Sign the authorization for exactly this payment (validity at most 4 hours; read the plain-words summary, then type
   `YES`). It writes `evidence/authorizations/PAYMENT.<authorizationId>.json` and prints the `authorizationId`:

   ```sh
   cd /Users/kratos/uptimebuyer
   node scripts/release/authorize.mjs payment --merchant lionx402.com --amount-minor 1 --currency USD --purpose REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP --environment kite-passport-prod --valid-hours 2
   ```

4. The operator's live journey run checks the gate itself before any Kite command:
   `release-gate.mjs check PAYMENT --request <file> --preflight <file> --authorization <id>`, with the request and the
   four preflight checks (`broker-isolation`, `budget-bound`, `reconciliation-ready`, `kill-switch-ready`) built from
   the run's real state. An AUTHORIZED decision consumes the record and is logged with the digest of the exact request
   it decided and that request's journey id. Evidence of a completed payment counts only with that consumed decision,
   for that request, that journey id and inside that run window; an unused record is never evidence that a payment was
   authorized, and the record cannot be used twice. The journey id is bound in the decision record, not in the signed
   scope, because the authorization is signed before the run (and its id) exists. The recorded payment must stay inside
   the authorized request: amount at most its amount, the same currency, merchant and purpose.

The scope is merchant `lionx402.com`, at most 1 minor unit of USD, purpose `REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP`,
environment `kite-passport-prod`. The broker also caps every Kite session in code at 1 cent per call and 5 cents in
total, whatever an authorization says.

## Rollback

Backup, restore and image rollback were exercised locally (`docs/release/evidence/t057-release-smoke.json`,
`infra/runbooks/BACKUP-RESTORE-ROLLBACK.md`) <!-- C-012 -->. A production rollback drill is NOT_RUN <!-- C-024 -->.
