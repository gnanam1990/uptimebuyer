# Release gates (T-060)

Every external action is a separate gate (`config/release/gates.json`, `scripts/release/release-gate.mjs`). A gate opens
only for a signed authorization record of that exact gate (Ed25519, by a key registered in
`config/release/authorizers.json`), valid and unused, whose scope matches the request exactly, with every preflight
check passed. Authorizations never transfer between gates. Opening a gate records a decision; the operator then performs
the action themselves. The tooling performs no external action.

## Status at handoff

`node scripts/release/release-gate.mjs status`. No authorizer key is registered and no authorization record exists, so
every gate is refused <!-- C-013 -->:

| Gate                 | Decision | Reason           | Action it would allow                                        |
| -------------------- | -------- | ---------------- | ------------------------------------------------------------ |
| REPO_PUBLICATION     | REFUSED  | NO_AUTHORIZATION | Push the repository and/or change its visibility             |
| X_POST               | REFUSED  | NO_AUTHORIZATION | Publish the X post from the approved draft                   |
| VIDEO_UPLOAD         | REFUSED  | NO_AUTHORIZATION | Upload the demo video                                        |
| RELEASE_TAG          | REFUSED  | NO_AUTHORIZATION | Create a release or tag                                      |
| PAYMENT              | REFUSED  | NO_AUTHORIZATION | Execute one real bounded Kite-paid action through the broker |
| HACKATHON_SUBMISSION | REFUSED  | NO_AUTHORIZATION | Submit the hackathon form                                    |
| DEPLOY               | REFUSED  | NO_AUTHORIZATION | Deploy the images to a hosted environment                    |

## Authorizing one action

1. The person authorizing registers their Ed25519 public key in `config/release/authorizers.json` (reviewed change).
2. They write a `release-authorization.v1` record naming the gate, the exact scope (for example the deploy environment,
   source SHA and image IDs; or the payment merchant, cap, currency and purpose), a validity window and their verbatim
   statement, sign it offline (`signAuthorization`) and add it under `evidence/authorizations/`.
3. Run the gate's preflight (for `DEPLOY` and `RELEASE_TAG`: verify, the local smoke, a backup with a verified restore
   and an exercised rollback) and `node scripts/release/release-gate.mjs check <GATE> --request ... --preflight ...`.
4. On `AUTHORIZED`, the operator performs the action and adds the authorization id to `consumed.json`.

## Rollback

Backup, restore and image rollback were exercised locally (`docs/release/evidence/t057-release-smoke.json`,
`infra/runbooks/BACKUP-RESTORE-ROLLBACK.md`) <!-- C-012 -->. A production rollback drill is NOT_RUN <!-- C-024 -->.
