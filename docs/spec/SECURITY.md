# UptimeBuyer Security Specification

Status: `SPECIFICATION_ONLY`  
Threat tests, penetration test, provider controls, and production hardening: `NOT_RUN`

## 1. Security objectives

1. A tenant can observe and mutate only its own resources.
2. A model, browser, worker compromise, or shell path cannot bypass the commercial broker.
3. No external action exceeds current, exact, signed authority.
4. Duplicate/replayed input cannot duplicate financial or operational effects.
5. Hostile documents and provider content cannot become instructions.
6. Recovery and audit claims remain attributable and revision-bound.
7. Secrets and sensitive operational/contact data remain minimized and revocable.

## 2. Assets

- Kite and provider credentials, workload identities, signing keys;
- tenant policy, approval, and budget authority;
- equipment identity, BOM/manuals, service history, telemetry, locations;
- contact details, call/email transcripts, receipts and invoices;
- evidence manifests, state-transition ledger, recovery proof;
- source, CI/CD, artifact provenance, deployment configuration.

## 3. Principal threats and controls

| Threat | Primary controls | Required proof |
|---|---|---|
| cross-tenant IDOR/query/cache leak | tenant-scoped authorization, RLS, scoped keys, negative tests | API + DB denial tests |
| prompt injection in manual/transcript/web result | data labeling, sandbox parsing, no privileged tools, schema/citation validation | adversarial corpus |
| payment bypass via direct HTTP/shell | exclusive broker secret and egress, deny other identities | network/credential isolation test |
| replay/duplicate spend | request digest, unique idempotency key, reservation lock, reconciliation | crash/replay test |
| forged/stale approval | signed scope, expiry, plan/evidence/policy hash | mutation tests |
| webhook spoof/replay | signature, timestamp, provider event uniqueness, lookup | signed/replay tests |
| SSRF and arbitrary fetch | allowlisted adapter origins, DNS/IP validation, no model URLs | SSRF suite |
| unsafe part substitution | exact identifiers, deterministic policy, named approval | incompatibility fixtures |
| false recovery from boundary-equal, late/backfilled/mixed-tail, wrong-asset/action, or provider evidence | immutable policy-derived observation boundary, strict-after `LIVE` telemetry only, exact signoffs, stale/revoked/cross-tenant denial, current fresh tail | causal recovery fault-injection E2E |
| telemetry spoof/tamper | per-device identity, ACL, sequence, calibration, revocation | device adversarial tests |
| secret leakage | secret manager, redaction, deny model/browser, scanning | repo/log/export scans |
| supply-chain compromise | lockfile, signed/checksummed artifacts, SBOM, provenance, review gates | clean build + scan evidence |
| resource exhaustion | payload/time/token/concurrency quotas, cursor paging, circuit breakers | load/abuse tests |

## 4. Authentication and authorization

Users authenticate through an OIDC provider with short-lived sessions and strong MFA policy at the identity provider. Service-to-service access uses distinct workload identities. Devices use per-device credentials. Authorization checks tenant membership, resource tenant, role, action, incident/site scope, and policy condition on every command.

Minimum roles:

- `viewer`: read permitted operations data;
- `operator`: acknowledge incidents and supply evidence;
- `maintenance_approver`: approve exact technical interventions within scope;
- `finance_approver`: approve spend within scope;
- `admin`: manage tenant configuration but cannot forge historical evidence;
- `auditor`: read redacted ledger/export.

High-risk execution may require both maintenance and finance authority when policy declares separation of duties. No role is implicitly global.

## 5. Credential architecture

Secrets live in a managed secret store or workload-identity provider. Database rows contain opaque references. The separately deployed Kite broker workload alone can resolve Kite payment references and receive paid-endpoint egress; API, web, SERV and general-worker identities have explicit deny policy. Provider credentials are adapter-specific and scoped to the minimum operation. Rotation and emergency revocation are documented. Production secrets are never used in PR/preview builds or browser bundles.

## 6. Network policy

- Web: API only.
- API: database, identity verification, queue; no Kite/merchant egress.
- SERV: approved OpenServ and read-only internal evidence tools; no broker/provider egress.
- General worker: approved non-payment adapter egress by job identity.
- Kite broker: egress to Kite/payment endpoints and required lookup endpoints, plus PostgreSQL and the secret manager; ingress only from the API workload identity and the general worker's outbox-dispatch job identity, each carrying a signed opaque execution reference.
- Sensor gateway: MQTT ingress, database/queue; no general outbound internet.
- Database/Redis/object store: private network and authenticated access.

DNS resolution and redirects are revalidated; link-local, loopback, private metadata, and unapproved IP ranges are denied for external fetches.

## 7. Document and file handling

Uploads use bounded presigned intents, extension-independent media detection, malware/content scanning, decompression limits, sandboxed parsing, immutable object keys, and digest verification. Active content is never executed. Failed scans quarantine the blob. OCR/extraction output retains provenance and is untrusted.

## 8. Commercial and approval security

Approval is a server-rendered structured action, not a conversational phrase. It binds tenant, incident, immutable asset revision, plan hash, action digest, evidence/policy revisions, exact provider-account revision and action constraints, maximum/currency, actor, and expiry. Browser mutation cannot expand scope. Price increase, substitute, account/capability revision change, expiry, or provider change invalidates unexecuted authority; an in-flight attempt remains bound to and reconciles through its historical revision. The broker rechecks everything immediately before the reserve-plus-`SEND_STARTED` linearization transaction.

Every tenant-owned table carries `tenant_id` and composite tenant foreign keys; provider callbacks are namespaced by tenant, provider, and provider account. Row-level security is defense in depth, not a substitute for server authorization and composite constraints.

## 9. Audit and non-repudiation boundary

Audit records include actor, action, resource, result, correlation/causation, revision, and redacted metadata. They are append-only and access-controlled. Optional hash chaining may detect tampering but does not by itself prove real-world truth. Provider receipts and signatures are preserved as evidence with their exact authority described.

## 10. Privacy

Collect only operationally necessary contacts and transcripts. Display and export are tenant/role-scoped, purpose-limited and redacted. Retention is source- and tenant-policy-specific. Raw/unapproved communication never enters a model: only the minimum excerpt may be sent after tenant policy, purpose, role, recording/processing consent where required, retention and redaction checks, with the outbound digest audited. Production support access is time-bounded and audited. Legal, recording-consent, food-safety, and payment obligations require jurisdiction-specific review before production.

## 11. Secure development gates

- protected main branch, required review, signed/attributed commits according to repository policy;
- secret scan, dependency review, license check, SAST, container/SBOM scan;
- typed schemas and authorization tests for every route;
- no dynamic code execution from model/provider content;
- no critical/high unresolved finding in release scope;
- provenance for release artifacts and pinned deploy inputs;
- independent adversarial review before production.

## 12. Incident response

For suspected compromise: stop new commercial intents, revoke affected credentials, preserve logs/evidence, identify tenant scope, reconcile all pending/unknown attempts, notify authorized responders, restore from verified artifacts, rotate keys, and publish a reviewed incident record. Stopping new spend must not destroy pending reconciliation evidence.

## 13. Security acceptance tests

- cross-tenant access denied through direct IDs, search, export, cache, event, and object paths;
- model injection cannot reach privileged tools or alter policy;
- direct provider/Kite requests and Kite secret reads from API, SERV, general-worker, web, sensor-gateway and browser identities fail at network and credential boundaries;
- replayed approval, webhook, event, telemetry batch, and execute request cause no duplicate effect;
- worker crash before/after payment submission converges to one result;
- forged sensor or stale sample cannot close incident;
- secret scanning covers source, build output, logs, traces, exports, screenshots, and test fixtures;
- SSRF, decompression bomb, large payload, and queue flood remain bounded.

Related requirements: FR-10 through FR-13, FR-18, FR-21, FR-23, FR-24; NFR-02 through NFR-06, NFR-09 through NFR-12; INV-02 through INV-08, INV-10 through INV-16.

