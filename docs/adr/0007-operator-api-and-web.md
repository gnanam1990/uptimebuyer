# ADR 0007 — Operator HTTP API, typed client and web application (M12)

Status: accepted (M12, 2026-11-05)

## Context

M12 owns FR-01, FR-18, FR-19, FR-20, FR-21, NFR-07, NFR-08, INV-11 and INV-12 (T-049..T-052). Modules M02–M11 expose
TypeScript functions over `(pool, TenantContext, …)`; no HTTP surface existed. REPOSITORY-PLAN places the authenticated
API in `apps/api` and the operator console in `apps/web`, and no other module prompt owns the API, so M12 builds both.
UI-SPEC §15 names Next.js App Router; the console here is a client-rendered single-page app because every view reads
authenticated, per-principal, rapidly changing state (no server rendering benefit), and a static bundle served by the
API keeps one origin, one CSP and no second Node server. That deviation is recorded here.

## Decisions

1. **`apps/api` is a thin Fastify 5.12.7 adapter.** Each route parses its body, query and headers with the strict
   schemas in `@uptimebuyer/contracts/api`, then calls the existing package function with the server-derived
   `TenantContext`. The package function authorizes against the resource's own site inside its tenant transaction, so
   the API carries no SQL and no second RBAC model. Custom methods use `{id}:{verb}` path targets (API-EVENT-SPEC);
   unknown verbs are 404. Mutations require `Idempotency-Key`; versioned aggregate commands require `If-Match: "<v>"`
   and a stale version is the command's own `409 VERSION_CONFLICT` with `currentVersion` (M04 now reports it).
2. **Authentication is M02's, bearer only.** `Authorization: Bearer <OIDC access token>` → `authenticateHuman`
   (`HumanOidcVerifier` over the issuer JWKS: asymmetric algorithms, issuer, audience, max token age) →
   `resolveTenantContext` (`X-Tenant-ID` may only name the principal's own membership). There are no cookies, so there
   is no ambient credential for CSRF; responses send no CORS headers. Unauthenticated failures spend a per-source token
   bucket (429 + `Retry-After`); authority-bearing commands (approve, hold, issue/change authority, publish policy)
   spend a per-principal bucket; rejected webhook deliveries spend a per-source bucket.
3. **Browser sign-in: authorization code + PKCE in a popup.** The verifier, state and access token live only in
   JavaScript memory (never localStorage, sessionStorage, cookies or URLs); the `/auth/callback` page posts
   `{code, state}` to its opener with an exact same-origin target and closes, and the opener accepts it only from that
   popup with the matching state, then redeems it at the token endpoint. A reload asks the person to sign in again.
   The identity provider is configuration (`UB_OIDC_*`); the test harness hosts a loopback-only stub that issues ES256
   tokens for seeded people and enforces an exact client id and redirect URI.
4. **Typed client.** `@uptimebuyer/api-client` encodes every body with the same strict schema the server parses with
   and decodes every response with a loose object schema whose state axes are closed enums, so an unrecognized state is
   an `ApiContractError` rather than a guess; a `202` carrying an error body (outcome unknown) is thrown, never decoded
   as success. The web app talks to the API only through this client.
5. **Additive package reads (coordinated with M02/M04/M05/M08/M09).** `getSessionProfile`, `listAssignableMembers`,
   `listAssetDevices` (`@uptimebuyer/data`), `getIncidentPins` (M04), `getCurrentIncidentEvidenceRevision` (M05),
   `listPlanApprovalRequests` (M08), `listIncidentCommerce` and `recordApprovalHold` (M09). Each authorizes against the
   resource's site and denies out-of-scope rows exactly like missing ones. A hold is the approver's attested
   `approval.hold.v1` ledger entry plus an audit row; it authorizes nothing and changes no lifecycle. No migration.
6. **Web stack: React 19.3.1 + Vite 8.3.5**, exact-pinned, no router or state library (a 100-line History-API router,
   small resource hooks). The built bundle is served same-origin by `apps/api` (`UB_WEB_ROOT`) under a strict CSP
   (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' <token endpoint>; frame-ancestors
'none'; base-uri 'none'; object-src 'none'`), with `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and
   `Cache-Control: no-store` on API responses. Only console routes fall back to the shell; files resolve inside the
   bundle root only. No source maps, no env variables, no analytics, no error-report beacon.
7. **Honest state rendering is one table.** `apps/web/src/status/axes.ts` maps every axis (freshness, local authority,
   Kite session, transport, external outcome, adapter capability, economic intent, purchase order, service job,
   incident state, recovery gate, recovery evaluation, compatibility, delivery, deadline, disposition, urgency) to a
   label, tone, icon shape and description. Green is reserved for FRESH, CONFIRMED payment/session, PASSED evaluation
   and the canonical RECOVERED state; an unrecognized value renders as "Unrecognized value". Purchase orders and
   service jobs use distinct axes, headings and routes. A post-egress UNKNOWN stays UNKNOWN whatever the capability, and
   unsafe retries are disabled with their reason.
8. **Browser proof runs against API truth.** Playwright 1.64.1 + @axe-core/playwright 4.14.0 (Chromium). Global setup
   starts the seed harness (in `apps/kite-broker/test/support`, because the RECORDED_CONTRACT broker needed to reach
   ordered/recovered states is importable only there) as one process and `apps/api` as another; every device is a
   labelled SIMULATOR and the environment label `SEEDED_TEST_DATA` is on every page. Bindings start at seed time, so
   the harness waits until its stale device crosses the 120 s threshold before tests start. `pnpm verify` runs the
   browser suite after the build; CI installs Chromium with `--with-deps` first.

## Consequences

- The API never imports `@uptimebuyer/kite-broker`; authority sessions are requested through an injected
  `SessionActivator`, and without a configured authority signer issuance answers `DEPENDENCY_FAILED`.
  `src/main.ts` configures neither the signer nor webhook verifier secrets from the environment: M14 provisions them
  through the deployment secret channel.
- Order creation/dispatch, reconciliation and CMMS/recovery engine steps stay worker/broker operations; the console
  reads their results and offers only human commands (assign/accept/handoff, deadline events, approve/hold, issue and
  revoke authority, verify/dispute delivery, policy publication).
- Fleet health composes per-asset device reads (N+1) and the ledger export is unpaginated; both are bounded by tenant
  size and are NFR-08/T-054 inputs for M13.
- Rate-limit buckets are per process; behind a proxy, `UB_TRUST_PROXY` must be set or every client shares one source.
