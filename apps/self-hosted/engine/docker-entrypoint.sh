#!/bin/sh
# podotype self-hosted "app" container entrypoint. This image bundles what
# the hosted product keeps as three separate containers — engine, web,
# beyla (see docker-compose.yml's old history and apps/hosted's own
# compose files, which still run that split) — into one, since a
# self-hosted install has no reason to pay the extra container/network
# overhead for a split that only exists to let "web" become a genuinely
# separate, multi-tenant hosted router later (see server.js's own SPLIT
# comment). beyla's binary and config are copied in at build time (see
# this directory's Dockerfile) and started here as a plain background
# process; `server.js` (which now also serves the compiled frontend and
# ingests OTLP directly — see server.js's "Static UI" and
# startOtlpIngestServer) is the container's foreground process.
#
# Deliberately NOT a real process supervisor: no independent restart of
# one process without the other, no zombie reaping beyond what `exec`
# gives the foreground process. That's the right trade-off here, not a
# shortcut — beyla with no engine to receive its OTLP output, or an
# engine with no beyla watching the host, are both useless alone, so
# "either one dying takes the whole container down, and Docker's restart
# policy brings both back together" is the correct failure mode, not a
# gap to fix later.
set -e

beyla &

exec node server.js
