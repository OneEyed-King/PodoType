# podotype SELF-HOSTED "app" image: combines what the hosted product keeps
# as three containers — engine, web, beyla — into one. Decided because the
# engine/web split (see server.js's own SPLIT comment) only pays for itself
# once "web" is a genuinely separate, multi-tenant hosted routing layer;
# for a self-hosted install on one machine it's pure extra container/
# network overhead for no benefit, and folding beyla in too means
# self-hosted ships as 2 containers total (this one + clickhouse) instead
# of 4. The hosted product is NOT built from this file — see
# apps/hosted/* and its own compose files, which still run engine/web/
# beyla split, on purpose, across real customer infrastructure.
#
# Build context is the REPO ROOT, not this directory — same reason the
# old apps/self-hosted/web/Dockerfile needed it: this stage reaches
# apps/shared/frontend (the React source) and apps/shared/beyla/config.yml
# as siblings. See deploy/docker-compose.yaml / docker-compose.yml's
# `app` service for the `context: ., dockerfile: apps/self-hosted/engine/Dockerfile`
# wiring this requires.

# --- UI build stage -------------------------------------------------------
# Compiles the React dashboard to static files — same stage apps/self-hosted/
# web/Dockerfile used to run on its own. Build-time dependency only.
FROM node:20-slim AS ui-build
WORKDIR /ui
COPY apps/shared/frontend/package.json apps/shared/frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY apps/shared/frontend .
RUN npm run build

# --- Final image -----------------------------------------------------------
FROM node:20-slim

WORKDIR /app

# Build context is the repo root (see this file's own top comment), so
# these need the full path now, not the bare filename the old
# apps/self-hosted/engine/Dockerfile used when its context was just this
# directory.
COPY apps/self-hosted/engine/package.json .
RUN npm install --omit=dev --no-audit --no-fund

COPY apps/self-hosted/engine/server.js .
COPY --from=ui-build /ui/dist ./public

# beyla's own published image is `FROM scratch` (grafana/beyla:3.33.0) — a
# single static binary at /beyla plus its CA certs, nothing else. COPY
# --from works against it even though it has no shell: the Docker builder
# reads the layer directly, it never execs anything inside that image. Pin
# this tag together with apps/shared/beyla/Dockerfile's own pinned tag —
# they should always match (see that file's comment for where to check for
# newer ones). config.yml is the same file the hosted build's beyla
# container uses — it already excludes "podotype-app"/"podotype-beyla"
# self-traffic by container name (see that file's own comment), which
# covers this combined container's traffic under either name.
COPY --from=grafana/beyla:3.33.0 /beyla /usr/local/bin/beyla
COPY apps/shared/beyla/config.yml /etc/beyla/config.yml
ENV BEYLA_CONFIG_PATH=/etc/beyla/config.yml

COPY apps/self-hosted/engine/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Just the UI's own toggle-state JSON / OTLP buffering now — ClickHouse
# holds the actual trace/log/metric data (see docker-compose.yml's
# `clickhouse` service), not this container.
VOLUME ["/data"]
ENV STATE_FILE=/data/state.json
ENV CLICKHOUSE_URL=http://clickhouse:8123
ENV CLICKHOUSE_DATABASE=otel

# 8080: the combined API + static UI (published to the host — see
# docker-compose.yml). 4318: OTLP/HTTP (JSON) ingestion — still needs to
# stay reachable from OTHER containers/the host for the opt-in Code
# Tracing feature (manually-instrumented services sending OTLP in), not
# just from beyla now that beyla lives in this same container.
EXPOSE 8080 4318

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
