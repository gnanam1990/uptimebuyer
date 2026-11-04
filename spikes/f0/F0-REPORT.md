# F0 Feasibility Spike Report

> F0 is feasibility evidence, not canonical module or product implementation evidence.

**Recommendation: `NARROW`.** The local process-level broker boundary and the reconciliation state logic hold
against a LOCAL_STAND_IN. Every real external gate (Kite payment, provider fulfilment, physical sensor, operator
interviews, SERV Reasoning) is `BLOCKED` or `UNKNOWN`. A narrowed direction needs the user's acceptance before the
full build (prompt `00a`, decision rule).

## 1. Run record

| Field                                                    | Value                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository path                                          | `/Users/kratos/uptimebuyer-f0` (git worktree of the UptimeBuyer repository)                                                                                                                                                                           |
| Branch                                                   | `spike/f0-feasibility`, cut from `main`                                                                                                                                                                                                               |
| Start SHA                                                | `a0ee73d471d7f36cf003a93a724e0ccf2d99ae99`, clean                                                                                                                                                                                                     |
| Code SHA at the recorded run                             | `a60aee0316d4c035baa5a5310fc7bd1fcfc7d279`, clean (`dirtyPaths: 0`)                                                                                                                                                                                   |
| End SHA                                                  | the `docs(f0)` commit that adds this report and `evidence/F0-RESULT.json` (see `git log`)                                                                                                                                                             |
| Execution date                                           | 2026-11-04 (recorded run 16:33:26Z to 16:33:48Z)                                                                                                                                                                                                      |
| Environment                                              | macOS (Darwin 27.2.0, arm64). All processes run as the same local user (uid 501). Loopback only.                                                                                                                                                      |
| Tools                                                    | Node v22.23.1, OpenSSL 3.6.3, curl 8.7.1, `sandbox-exec` present (a deprecated macOS API)                                                                                                                                                             |
| Machine-readable result                                  | `spikes/f0/evidence/F0-RESULT.json` (redacted; 35 checks, 150 probe results)                                                                                                                                                                          |
| Authorization reference                                  | ADR 0001 decision 9. The user ordered an end-to-end build without further prompts. No Kite, OpenServ or provider credentials exist, and no real payment, call, email or operator contact was authorized. No private message content is recorded here. |
| Real call / email / payment / purchase / physical action | **None.** No network traffic left loopback.                                                                                                                                                                                                           |

### Commands and exit codes

| Command                                                                                       | Exit                   |
| --------------------------------------------------------------------------------------------- | ---------------------- |
| `node spikes/f0/run.mjs`                                                                      | 0 (35/35 local checks) |
| `pnpm exec vitest run --config spikes/f0/vitest.config.mjs`                                   | 0 (17 tests)           |
| `pnpm exec eslint spikes --max-warnings=0`                                                    | 0                      |
| `pnpm format`                                                                                 | 0                      |
| `DATABASE_URL=postgres://uptimebuyer:uptimebuyer@localhost:55432/uptimebuyer_dev pnpm verify` | 0                      |

`pnpm verify` does not run the spike, because the root vitest projects do not include `spikes/`. It shows that the
spike breaks no repository gate: lint, format, typecheck, tests, build, pack check and the secret scan all pass.

## 2. Sub-gate results

| Gate                               | Status                                             | Evidence (`F0-RESULT.json` → `checks[].gate`)                                                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0-A provider capability           | **BLOCKED**                                        | There is no Kite credential and no authorization. The live catalog was not re-queried. Only a LOCAL_STAND_IN capability preflight ran (`adapter-preflight`). It is a local analogue and documents nothing about Kite.                                                              |
| F0-B exclusive broker boundary     | **PASS (local spike boundary only)**               | 13 `F0-B` checks plus 3 controls pass. Production isolation: **NOT_RUN**. A distinct OS user or workload identity: **NOT_RUN**.                                                                                                                                                    |
| F0-C low-value paid action         | **BLOCKED**                                        | No real paid action was authorized. The reconciliation STATE logic passed against the LOCAL_STAND_IN only (8 `F0-C(local)` checks).                                                                                                                                                |
| F0-D sensor and evidence slice     | **UNKNOWN**                                        | The input is SIMULATED_INPUT only, so this gate cannot pass. Real sensor: **BLOCKED** (no device). Real manual or BOM citation: **BLOCKED** (no exact equipment or document was selected). The local stale, ambiguous-part and SOP-deadline logic passed (5 `F0-D(local)` checks). |
| F0-E recovery-authority separation | **PASS (local logic, stand-in + fixture records)** | 5 `F0-E` checks pass. Final UptimeBuyer recovery policy: **NOT_RUN** (M11).                                                                                                                                                                                                        |
| F0-F customer problem evidence     | **BLOCKED**                                        | There are no interview records and no authorization to contact operators. No roles, segments or dates exist to report.                                                                                                                                                             |
| F0-G SERV Reasoning                | **BLOCKED**                                        | There is no OpenServ account or API key (`f0-serv` reports `NO_OPENSERV_ACCOUNT_OR_API_KEY`). The event submission is blocked until a real SERV run is recorded.                                                                                                                   |

These gates are also not run: the live-spike gates in `KITE-OPENSERV-INTEGRATION.md` §9 (real receipt, refund or
reversal, insufficient funds, price change), the browser-shaped process (the client stands in for the API caller),
and the production network policy.

The runner writes a `feasibility` block in the shape of `docs/spec/templates/BUILD-STATUS.json`
(`status: RUN_LOCAL_ONLY`, `recommendation: NARROW`). The repository has no root `BUILD-STATUS.json` yet, so the
coordinator should copy that block into it when the file is created.

## 3. Identifiers (redacted)

- **Provider/destination:** `local-standin-paid` = LOCAL_STAND_IN HTTPS on `127.0.0.1:<ephemeral>`. It is not Kite and not a provider.
- **Approved maximum:** 100 minor units of `XTS` (the ISO 4217 code reserved for testing) per intent. **Actual:** stand-in effects only, and no value moved.
- **Intents/idempotency keys:** `f0-intent-{ok,tamper,expired,not-allowlisted,drop,lookup-down,crash,journal-loss}` / `f0-key-*`. Incident `f0-inc-0001`.
- **Stand-in effect refs (recorded run):** for example `sfx_80d96c5c7955ad73` (ok) and `sfx_953ba32e238e5c70` (crash path). These are random per run.
- **Synthetic credential metadata:** capability fingerprint `e096fad34cdf6bda`, and broker client cert SHA-256 `B8:CE:EC:8D:…:6A:DB`. The values are generated per run and never stored.
- **Sensor/equipment/document:** `sim-cooler-01` (SIMULATED_INPUT). The part fact `FixtureCo FX-EVAP-FAN-120-A` is a fixture and **not a real manual**. The SOP is `demo-sop-cold-holding@v1-fixture`.
- **Process identities:** each role ran as its own OS process, all as uid 501. Roles: `f0-kite-broker` (three launches: crash-armed, restart, journal-loss), `LOCAL_STAND_IN`, `f0-client`, `f0-general-worker`, `f0-serv`, `f0-sensor-sim`, and `f0-decoy` (the control). Each of the three denied roles ran once inside the `sandbox-exec` profile and once without it. The pids are in `processes`.

## 4. F0-B isolation mechanism

**Credential.** The launcher plays the secret manager and the approval store. At runtime it creates a local CA
with `openssl`, one client certificate for `CN=f0-kite-broker`, a server certificate for the stand-in and a
32-byte bearer capability. The key files exist only inside a 0700 temp directory during generation and are then
deleted. The broker receives its key, certificate and capability over a **fd 3 pipe**, never through env, argv,
files or logs. The stand-in holds only the SHA-256 of the capability.

**Paid destination.** The stand-in is HTTPS with `requestCert` and `rejectUnauthorized`. It accepts only the pinned
broker client-certificate fingerprint **and** a capability whose hash matches. The broker pins the server
certificate fingerprint, follows no redirects and does not read proxy environment variables.

**Broker ingress.** A unix socket (0600, inside a 0700 directory) accepts only an Ed25519-signed, credential-free
envelope with an exact field set. The broker then checks the envelope against its own approval record: incident,
purpose, provider, amount ≤ maximum, currency, expiry, idempotency key and allowlist.

**Defence layers, each shown to hold on its own:**

1. _Credential layer (unsandboxed roles)._ Every attempt failed:
   - direct TLS, both without a client certificate and with an attacker-minted one;
   - plain HTTP and raw TCP;
   - curl and undici fetch;
   - a followed 307 redirect with curl and with fetch;
   - `HTTPS_PROXY`/`ALL_PROXY` through an attacker-run CONNECT proxy, with curl and with Node's `NODE_USE_ENV_PROXY`;
   - CONNECT and absolute-form requests to the broker (405/400);
   - forged, unsigned and endpoint-embedding envelopes (403);
   - SIGUSR1 against the broker, after which no inspector opened.
2. _Sandbox layer (`sandbox-exec` profile)._ The profile denies TCP to the stand-in port, file reads of the broker's private state directory and process-info of other processes. These attempts fail with `EPERM`. Ordinary work and broker-socket ingress still succeed.
3. _Broker policy._ Each of the 7 fields was tampered two ways and all 14 envelopes were rejected: mutation after signing gives `SIGNATURE_INVALID`, and re-signing with the client key gives `AUTHORITY_MISMATCH_*` or `AMOUNT_EXCEEDS_APPROVAL`. Expired authority and a non-allowlisted provider were also rejected. The stand-in ledger shows no egress for any of these. The untampered control was accepted.

Across the whole battery, the stand-in's `executeCalls` and authorized-request counters stayed the same (5→5 and
10→10). No capability or key material appeared in any of the 150 harvests. A replayed captured envelope returned
the stored effect with `egress=false`.

**Controls (why the denials mean something).** An ordinary Node process exposes an env canary through `ps -E` to
another process of the same user, and SIGUSR1 opens its inspector. Unsandboxed roles really can read other
processes' env and the broker's state directory. The secret is safe only because it is never in env, argv or
files, and because the broker runs with `--disable-sigusr1`.

**Limits.** This is local process-level isolation, not production network policy, and it is not a separate
workload identity.

- All processes run as the same uid. File modes (0700/0600) do not separate them. `sandbox-exec` is deprecated, and its loopback deny for one port is not an egress policy.
- Untested: reading broker memory with a debugger or `task_for_pid`, core dumps and swap. Also untested: a same-uid attacker editing the broker script before launch.
- A same-uid process can kill the broker. That is an availability loss, not a confidentiality loss, and the crash-recovery path is covered below.
- The launcher holds the secret because it plays the secret manager. The approvals come from the launcher, not from a PostgreSQL reload.
- No DNS, external host or link-local paths were exercised.

## 5. F0-C local reconciliation (LOCAL_STAND_IN)

| Scenario                                                | Result                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal execute, then the same envelope again            | `CONFIRMED`. The resubmission returns the same effect with `RETURN_STORED`, `egress=false` and provider `executeCalls=1`.                                                     |
| Response dropped after the provider commits             | `UNKNOWN (TRANSPORT_LOST)`. A resubmission is refused as `RETURN_UNKNOWN_NO_RETRY`. A lookup by idempotency key gives `CONFIRMED` with the same effect, and `executeCalls=1`. |
| Response dropped and lookup unavailable                 | Stays `UNKNOWN (LOOKUP_INCONCLUSIVE)`. It is never treated as failure and never retried, and `executeCalls=1`.                                                                |
| Broker killed (exit 137) after a durable `SEND_STARTED` | On restart the boot recovery marks it `UNKNOWN`, then a lookup gives `CONFIRMED` with the same effect. `executeCalls=1`.                                                      |
| Broker journal lost, then the same key is re-sent       | The provider-enforced same-key idempotency returns the original effect (`replayed=true`). `executeCalls=2`, `effectsCreated=1`.                                               |

This shows only that the spike's state logic works against a stand-in that we built to support lookup and same-key
idempotency. Whether Kite or any real provider exposes those capabilities is the open F0-A question.

## 6. F0-D and F0-E local logic

- **Simulator:** `f0-sensor-sim` emits SIMULATED_INPUT rows. They classify as follows: normal is `FRESH_IN_RANGE`, the controlled breach is `BREACH`, the stale row is `STALE`, the replayed sequence is `OUT_OF_ORDER_OR_REPLAY`, and the restored row is `FRESH_IN_RANGE` but with `healthyClaimAllowed=false`.
- **Stale data:** a stale in-range reading is never healthy, even when it is relabelled `LIVE_AUTHENTICATED` in a logic-only check.
- **Parts:** a candidate with the same description but a different MPN suffix (similarity 0.97), a different manufacturer, or a missing MPN stays `HELD`. Only an exact manufacturer and MPN match against a cited fact leaves `HELD`, and here it gives `EXACT_MATCH_FIXTURE_ONLY`.
- **Deadline:** the deadline comes only from the versioned SOP (120 min). Without the SOP the result is `HELD`, and the non-authoritative spoilage estimate is ignored.
- **F0-E:** these record sets all give `INSUFFICIENT_FOR_RECOVERY`:
  - payment observation + provider acceptance + a provider "completed" work report;
  - the same plus a sign-off;
  - the same plus a collapsed `COMPLETED` badge.

  Adding a simulated in-range window gives `CONDITION_IN_RANGE_SIMULATED_NOT_RECOVERY`. Five evidence kinds remain five separate records with distinct digests.

## 7. Recommendation: NARROW

What the demo **may** claim:

- a tested broker boundary at local process level, with tamper, replay and bypass denial;
- reconciliation state logic that never turns uncertainty into failure or a duplicate effect;
- recovery logic that refuses to treat payment or provider completion as recovery;
- all of this exercised against a LOCAL_STAND_IN and a SIMULATED_INPUT sensor.

What the demo **may not** claim:

- any real Kite payment, fulfilment or reconciliation;
- production isolation;
- a physical or authenticated sensor, or a real manual citation;
- operator validation;
- a SERV Reasoning run.

The event requires SERV Reasoning, so F0-G remains a submission blocker. `PROCEED` requires, each with explicit
per-action user authorization:

- a credentialed, capped Kite action and its reconciliation;
- an authenticated sensor or a deployed edge process;
- three operator confirmations;
- a recorded SERV run.

F0 is feasibility evidence, not canonical module or product implementation evidence.
