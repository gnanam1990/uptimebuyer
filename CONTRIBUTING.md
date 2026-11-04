# Contributing

- Read `docs/spec/START-HERE.md` and `docs/spec/CORE-CONTRACT.md` first. Invariants are binding.
- Branches: `feat/mNN-<prompt-name>`; commits: `feat(mNN): …`, `test(mNN): …`, `fix(mNN): …`, `docs(mNN): …`.
- Every behavior change starts with a failing test that maps to a `T-0NN` ID in `docs/spec/requirements.json`.
- `pnpm verify` must pass locally and in CI before merge. Integration tests need `DATABASE_URL` (see `.env.example`; `docker compose -f infra/docker-compose.yml up -d`).
- Never commit secrets; `pnpm secrets:scan` scans tracked, untracked, build and history surfaces.
