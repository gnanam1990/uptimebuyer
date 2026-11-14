# X post (DRAFT texts; the owner has posted)

> The owner posted on X on 2026-11-14 (https://x.com/0xweeky/status/2121434814087938457) directly, outside the release-gate tooling, so no X_POST record exists and
> that gate record is NOT_RUN. The DRAFT variants below are kept as written; the posted text may differ from them. The text must not change after authorization: one changed
> character is a different post and needs a new record. The demo video in the post is partly SIMULATED and says so.

The exact texts are files (no trailing newline), so the digest is taken over the bytes that get posted:
`shasum -a 256 docs/release/x-post/<file>`. The account is filled in when the owner signs (`--account @handle`).

## Variant R: the video is attached to the v1.0.0 release (recommended)

`docs/release/x-post/release-url.txt`, 276 characters, sha256
`c4a45a11c56e524a0d42dbaecb7b7e9b7439c67ff15f5f5046e15a4516feef3e`:

```text
UptimeBuyer (SERV Hackathon 02, Kite track): SERV Reasoning cites the manual, code decides, a broker pays within signed caps.
Real so far: a SERV run and a 1-cent Kite x402 payment. Sensor, recovery: not yet.
Demo: https://github.com/gnanam1990/uptimebuyer/releases/tag/v1.0.0
```

## Variant N: no video link (the link goes only in the form)

`docs/release/x-post/repo-only.txt`, 242 characters, sha256
`e3ddf0b005630505396b876b858332a50486ebbd161f71b00f929107ec91819b`:

```text
UptimeBuyer (SERV Hackathon 02, Kite track): SERV Reasoning cites the manual, code decides, a broker pays within signed caps.
Real so far: a SERV run and a 1-cent Kite x402 payment. Sensor, recovery: not yet.
github.com/gnanam1990/uptimebuyer
```

## Template: the video is hosted elsewhere

`docs/release/x-post/template.txt` (260 characters with the placeholder; a URL of up to 31 characters keeps it within
280). Replace `<VIDEO_URL>` in a copy outside the repository, then sign that copy: its sha256 is the one the gate needs
(the template's own digest is not a post).

```text
UptimeBuyer (SERV Hackathon 02, Kite track): SERV Reasoning cites the manual, code decides, a broker pays within signed caps.
Real so far: a SERV run and a 1-cent Kite x402 payment. Sensor, recovery: not yet.
github.com/gnanam1990/uptimebuyer
Demo: <VIDEO_URL>
```

## Claims behind the text

- SERV Reasoning proposes cited evidence and code decides <!-- C-003 C-004 -->; the broker spends only inside a signed,
  bounded authority <!-- C-005 C-006 -->.
- "a SERV run": one serv-mini run over the published Dixell XR60CX manual, accepted by the citation check (journey `j-2026-11-12-serv-document-2`, reasoning PASS; the full journey is NOT_RUN) <!-- C-021 -->.
- "a 1-cent Kite x402 payment": one 0.01 USDC payment to lionx402.com with the merchant's answer (journey `j-2026-11-13-kite-payment-2`, payment PASS after a manual CAPTURED resolution; chain id 2366 open; the full journey is NOT_RUN) <!-- C-022 -->.
- "Sensor, recovery: not yet": both NOT_RUN <!-- C-020 C-023 -->.

Characters are counted as Unicode code points; X counts each link as 23, so every variant is shorter on X than here.
