# ADR 0001 — Foundation stack and environment decisions

Status: accepted (M00, 2026-11-04)

## Context

The specification (`docs/spec/`) proposes a TypeScript monorepo with PostgreSQL, Redis/BullMQ, MQTT and an S3-compatible store, and requires an ADR wherever the real environment differs. Intake found Node 22, pnpm 11, PostgreSQL 17, Redis 8 and Docker available locally; no MQTT broker; no OpenServ, Kite or provider credentials.

## Decisions

1. **Language and workspace:** TypeScript 6.0.3 (the newest release inside typescript-eslint's supported range), pnpm workspaces, one committed lockfile, exact-pinned dev dependencies, Node 22 (`.node-version`).
2. **Authoritative store:** PostgreSQL 17. All uniqueness, conservation and tenancy guarantees are enforced in the database, never by queue ordering.
3. **Jobs and outbox:** PostgreSQL-backed transactional outbox and job table (`FOR UPDATE SKIP LOCKED`) instead of Redis/BullMQ for the first slice. It removes a second source of truth and keeps restart recovery in one database. Redis can be added later as a cache only.
4. **Telemetry transport:** signed HTTPS ingestion (HMAC per device credential) at `apps/sensor-gateway`. MQTT/TLS is a later adapter behind the same ingestion contract.
5. **Object store:** content-addressed local filesystem store behind an object-store port; S3 is an adapter.
6. **Migrations:** forward-only, checksum-verified SQL files under `packages/data/migrations`, ordered by the M02 owner.
7. **License:** MIT (the specification left it to M00; the target is a public hackathon repository).
8. **External capabilities:** OpenServ/SERV, Kite Passport, StablePhone/StableEmail/StableEnrich/Bitrefill, CMMS and a physical sensor are not available in this environment. Their adapters are contract-tested; every real-world result remains `NOT_RUN` until a credentialed, user-authorized run produces evidence. No mock is presented as a real result.
9. **F0 disposition:** the user instructed an end-to-end build without further prompts. F0's local harness runs; its external sub-gates (real payment, real provider contact, operator interviews, real SERV run, physical sensor) are `BLOCKED` for lack of credentials and per-action authorization. The build therefore proceeds under the **narrowed claim**: complete, tested software with real external effects `NOT_RUN`.

## Consequences

Integration tests require `DATABASE_URL`; CI provides a Postgres 17 service. `pnpm bootstrap` is the single documented clean-checkout command.
