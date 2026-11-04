# Agent instructions — UptimeBuyer

Read `docs/spec/START-HERE.md`, `docs/spec/CORE-CONTRACT.md`, `docs/spec/requirements.json` and your module prompt in `docs/spec/prompts/` before editing. The core contract's invariants are binding; never weaken one to make a test pass.

## Workspace

- pnpm workspace (`apps/*`, `packages/*`, `edge/*`), TypeScript 6 strict ESM (`module: NodeNext`, so relative imports end in `.js`), Node 22.
- Each package: `package.json` (`"type": "module"`, `name: @uptimebuyer/<dir>`, `exports` pointing at `./src/index.ts` for workspace consumers), `tsconfig.json` extending `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist`, and project `references` to the packages it imports. Add each new package to the root `tsconfig.json` references.
- Tests: unit tests `packages/<pkg>/test/**/*.test.ts`; database tests `*.int.test.ts` (they require `DATABASE_URL`, create their own throwaway database, and must fail — not skip — when it is missing). Name every test after its canonical ID, e.g. `describe('T-013 …')`.
- Exact-pinned dependencies only (`pnpm add -E`). Runtime validation with `zod`.
- Migrations: new numbered SQL files in `packages/data/migrations/` (`NNNN_module_topic.sql`). Never edit an applied migration. Every tenant-owned table has `tenant_id` and composite tenant foreign keys.
- Money is integer minor units + ISO currency (`bigint` in SQL, `bigint` in TS). Temperatures are integer milli-degrees Celsius. Timestamps are UTC.

## Workflow per module

1. Branch `feat/mNN-<prompt-file-name>` from up-to-date `main`.
2. Write the failing test first for each owned `T-0NN`; note the red result in the handoff.
3. Implement the smallest complete change; keep commits coherent (`test(mNN): …`, `feat(mNN): …`, `fix(mNN): …`, `docs(mNN): …`) with `Refs:` IDs in the body.
4. `pnpm verify` must exit 0 (with `DATABASE_URL` set) before handoff. Run `pnpm format` before committing.
5. Write `docs/handoffs/MNN.json` (same shape as `docs/handoffs/M00.json`).

## Truth rules

- No secrets in code, fixtures, logs or history. Synthetic secrets in tests are assembled at runtime.
- External services (OpenServ/SERV, Kite, StablePhone/StableEmail/StableEnrich/Bitrefill, CMMS, physical sensors) have no credentials here. Build adapters behind ports with contract fakes; never present a fake result as real. Real-world evidence stays `NOT_RUN`.
- Do not push, open PRs, deploy, spend, contact anyone or publish from a module agent; the coordinator does remote steps.
- Never reset, stash, checkout-over or delete uncommitted work.
