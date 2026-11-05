# syntax=docker/dockerfile:1.7
# UptimeBuyer production-like images (M14; T-057, NFR-01, INV-06). One multi-stage build, one runtime target per
# deployable: migrate, api (serving the built web app), worker, kite-broker and sensor-gateway.
#   docker build -f infra/docker/Dockerfile --target <target> -t ub-<target>:<sha> .
# - Base images are pinned by digest. Dependencies come only from the committed lockfile (--frozen-lockfile).
# - Every runtime target runs as the unprivileged numeric user 10001 with no shell entrypoint and a read-only root
#   filesystem at run time (compose/Kubernetes set read_only).
# - No secret is passed as a build argument, environment value or file: secrets are mounted at run time as files and
#   the environment carries only their paths. The Kite broker's secret document is mounted into the broker container
#   only; only the kite-broker target contains the broker application.
# - Compiled entry points load compiled workspace packages through scripts/runtime/register-dist.mjs.
ARG NODE_IMAGE=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS toolchain
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /src

# Full install, compile (tsc -b) and the web bundle (vite build).
FROM toolchain AS build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Production dependencies only; tests, sources maps for tests and build metadata removed.
FROM build AS prune
RUN pnpm install --frozen-lockfile --prod --offline \
 && find apps packages edge -type d \( -name test -o -name e2e -o -name test-results \) -prune -exec rm -rf {} + \
 && find . -name '*.tsbuildinfo' -delete \
 && rm -rf apps/web/src apps/web/node_modules spikes tests docs evidence tmp* infra edge

# Shared runtime layer: compiled workspace packages and production node_modules, owned by root, read-only to 10001.
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prune /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=prune /src/node_modules ./node_modules
COPY --from=prune /src/packages ./packages
COPY --from=prune /src/scripts/runtime ./scripts/runtime
USER 10001:10001

FROM runtime-base AS migrate
COPY --from=prune /src/scripts/db.mjs ./scripts/db.mjs
USER 10001:10001
CMD ["node", "scripts/db.mjs", "migrate"]

FROM runtime-base AS api
COPY --from=prune /src/apps/api ./apps/api
COPY --from=prune /src/apps/web/dist ./apps/web/dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "--import", "/app/scripts/runtime/register-dist.mjs", "apps/api/dist/main.js"]

FROM runtime-base AS worker
COPY --from=prune /src/apps/worker ./apps/worker
USER 10001:10001
CMD ["node", "--import", "/app/scripts/runtime/register-dist.mjs", "apps/worker/dist/main.js"]

FROM runtime-base AS sensor-gateway
COPY --from=prune /src/apps/sensor-gateway ./apps/sensor-gateway
USER 10001:10001
EXPOSE 8081
CMD ["node", "--import", "/app/scripts/runtime/register-dist.mjs", "apps/sensor-gateway/dist/main.js"]

# The broker reads its secret document from an inherited descriptor (never env or argv): the shell opens the mounted
# 0400/0600 document as fd 3 and execs node, so the same image works with container secrets and Kubernetes secret
# volumes (whose files are owned by root, which the --secret-file owner check would refuse). It listens only on a unix
# socket in a 0700 directory owned by 10001; a volume mounted there inherits that ownership on first use.
FROM runtime-base AS kite-broker
USER root
RUN mkdir -p /run/ub-broker && chown 10001:10001 /run/ub-broker && chmod 0700 /run/ub-broker
COPY --from=prune /src/apps/kite-broker ./apps/kite-broker
USER 10001:10001
CMD ["sh", "-c", "exec node --disable-sigusr1 --import /app/scripts/runtime/register-dist.mjs apps/kite-broker/dist/main.js --socket /run/ub-broker/broker.sock --secret-fd 3 3</run/secrets/broker_config"]
