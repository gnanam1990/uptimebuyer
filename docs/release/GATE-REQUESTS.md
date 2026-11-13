# Gate requests for the submission (DRAFT, nothing signed)

> DRAFT. Nothing here is signed or performed: X_POST, VIDEO_UPLOAD, RELEASE_TAG and HACKATHON_SUBMISSION hold no
> authorization record, so each is REFUSED (NO_AUTHORIZATION) <!-- C-013 --> and each action is NOT_RUN <!-- C-025 -->
> until its own explicit authorization. The owner signs on their own machine; the tooling only records decisions. The demo
> video's console part is SIMULATED and labelled so.

Each record is built by `scripts/release/authorize.mjs` from explicit arguments: it computes every file digest itself,
prints the record in plain words (the X text in full) and signs only after the exact answer `YES`. `--preview` prints the
same record without reading the key or signing. `--request-out` writes the gate request (the record's exact scope) that
`release-gate.mjs check` needs; it refuses to overwrite an existing file <!-- C-018 -->.

## Scopes (from `config/release/gates.json`)

| Gate                 | Scope fields                          | Values for this submission                                                                                                          | Validity (max) |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| RELEASE_TAG          | tag, sourceSha                        | `v1.0.0`; the commit of `main` after this branch is merged (`SOURCE` below)                                                         | 24 h           |
| VIDEO_UPLOAD         | destination, fileSha256               | `https://github.com/gnanam1990/uptimebuyer/releases/tag/v1.0.0`; `0e245dde5103e3812814ef397ca40f151d21cea355bdb6e7e4c07acd130645a1` | 24 h           |
| X_POST               | account, contentSha256                | the owner's X handle; `c4a45a11c56e524a0d42dbaecb7b7e9b7439c67ff15f5f5046e15a4516feef3e` (`x-post/release-url.txt`)                 | 24 h           |
| HACKATHON_SUBMISSION | destination, contentSha256, sourceSha | `https://openserv.typeform.com/submissions02`; the digest of the filled copy of `SUBMISSION.md`; `SOURCE`                           | 24 h           |

The video digest is the one in `video/video-manifest.json` (`shasum -a 256 docs/release/video/uptimebuyer-demo.mp4`).
If the post uses another variant, its digest is in `X-DRAFT.md`.

## Order

The submission gate's preflight needs the repository public, the video uploaded and the post published, so the order is:
merge, RELEASE_TAG, VIDEO_UPLOAD, X_POST, HACKATHON_SUBMISSION. Every command below is run by the owner in a terminal;
the records and decision logs land in `evidence/authorizations/` and are committed afterwards (they do not change the
tagged commit). Request and preflight files go outside the repository:

```sh
mkdir -p /Users/kratos/uptimebuyer-release
cd /Users/kratos/uptimebuyer
git fetch origin
SOURCE="$(git rev-parse origin/main)"
echo "$SOURCE"
```

## 1. RELEASE_TAG (tag v1.0.0 at SOURCE)

```sh
cd /Users/kratos/uptimebuyer
node scripts/release/authorize.mjs release-tag --tag v1.0.0 --source-sha "$SOURCE" --valid-hours 4 --request-out /Users/kratos/uptimebuyer-release/RELEASE_TAG.request.json
```

Preflight, each established before it is written as `true`: `verify-green` (`pnpm verify` at `SOURCE`), `smoke-local`
(`pnpm release:smoke`), `backup-restore-verified` and `rollback-exercised` (the smoke record
`docs/release/evidence/t057-release-smoke.json`), `clean-tree` (`git status --short` empty at `SOURCE`). Then, with
`AUTH_ID` set to the printed `authorizationId`:

```sh
cd /Users/kratos/uptimebuyer
printf '%s\n' '{"verify-green":true,"smoke-local":true,"backup-restore-verified":true,"rollback-exercised":true,"clean-tree":true}' > /Users/kratos/uptimebuyer-release/RELEASE_TAG.preflight.json
node scripts/release/release-gate.mjs check RELEASE_TAG --request /Users/kratos/uptimebuyer-release/RELEASE_TAG.request.json --preflight /Users/kratos/uptimebuyer-release/RELEASE_TAG.preflight.json --authorization "$AUTH_ID"
```

On AUTHORIZED the owner creates the release `v1.0.0` at `SOURCE` with `RELEASE-NOTES-v1.0.0.md` as its text.

## 2. VIDEO_UPLOAD (attach the video to the v1.0.0 release)

```sh
cd /Users/kratos/uptimebuyer
node scripts/release/authorize.mjs video-upload --destination https://github.com/gnanam1990/uptimebuyer/releases/tag/v1.0.0 --file docs/release/video/uptimebuyer-demo.mp4 --valid-hours 4 --request-out /Users/kratos/uptimebuyer-release/VIDEO_UPLOAD.request.json
```

Preflight: `claim-check` (`pnpm release:check`, 0 findings), `subtitles-present` (`node scripts/release/demo-video.mjs
--check`), `no-secret-on-screen` and `simulation-labels-visible` (the owner watches the whole video once; the T-059 video
tests check the frames' sources):

```sh
cd /Users/kratos/uptimebuyer
printf '%s\n' '{"claim-check":true,"subtitles-present":true,"no-secret-on-screen":true,"simulation-labels-visible":true}' > /Users/kratos/uptimebuyer-release/VIDEO_UPLOAD.preflight.json
node scripts/release/release-gate.mjs check VIDEO_UPLOAD --request /Users/kratos/uptimebuyer-release/VIDEO_UPLOAD.request.json --preflight /Users/kratos/uptimebuyer-release/VIDEO_UPLOAD.preflight.json --authorization "$AUTH_ID"
```

For another host, sign the same command with that page's https URL as `--destination`.

## 3. X_POST (variant R)

```sh
cd /Users/kratos/uptimebuyer
node scripts/release/authorize.mjs x-post --account "@YOUR_X_HANDLE" --text-file docs/release/x-post/release-url.txt --valid-hours 4 --request-out /Users/kratos/uptimebuyer-release/X_POST.request.json
```

Preflight: `claim-check` (`pnpm release:check`), `link-check` (the release page opens in a clean browser and shows the
video), `secret-scan` (`pnpm secrets:scan`), `event-rules-revalidated` (the event page re-read on the day):

```sh
cd /Users/kratos/uptimebuyer
printf '%s\n' '{"claim-check":true,"link-check":true,"secret-scan":true,"event-rules-revalidated":true}' > /Users/kratos/uptimebuyer-release/X_POST.preflight.json
node scripts/release/release-gate.mjs check X_POST --request /Users/kratos/uptimebuyer-release/X_POST.request.json --preflight /Users/kratos/uptimebuyer-release/X_POST.preflight.json --authorization "$AUTH_ID"
```

The owner then posts the file's text exactly (copy it from the file, not from a rendered page).

## 4. HACKATHON_SUBMISSION (the Typeform)

Fill the placeholders (`<DEMO_URL>`, `<X_POST_URL>`, `<TEAM_NAME>`) in a copy, read it, then sign that copy:

```sh
cd /Users/kratos/uptimebuyer
cp docs/release/SUBMISSION.md /Users/kratos/uptimebuyer-release/SUBMISSION.final.md
node scripts/release/authorize.mjs hackathon-submission --destination https://openserv.typeform.com/submissions02 --content-file /Users/kratos/uptimebuyer-release/SUBMISSION.final.md --source-sha "$SOURCE" --valid-hours 4 --request-out /Users/kratos/uptimebuyer-release/HACKATHON_SUBMISSION.request.json
```

Preflight: `claim-check`, `link-check` (every link in the filled copy opens), `event-rules-revalidated`,
`repository-public`, `video-uploaded`, `x-posted`:

```sh
cd /Users/kratos/uptimebuyer
printf '%s\n' '{"claim-check":true,"link-check":true,"event-rules-revalidated":true,"repository-public":true,"video-uploaded":true,"x-posted":true}' > /Users/kratos/uptimebuyer-release/HACKATHON_SUBMISSION.preflight.json
node scripts/release/release-gate.mjs check HACKATHON_SUBMISSION --request /Users/kratos/uptimebuyer-release/HACKATHON_SUBMISSION.request.json --preflight /Users/kratos/uptimebuyer-release/HACKATHON_SUBMISSION.preflight.json --authorization "$AUTH_ID"
```

The owner then pastes each field of the signed copy into the form and submits it before 15 November 2026, 23:59 UTC.
