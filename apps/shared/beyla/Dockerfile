# podotype's own beyla image: upstream grafana/beyla, unmodified, plus one
# file. Exists only so `docker compose up` doesn't need a separate init
# container to write config.yml into a shared volume before beyla can start
# (see ./config.yml's comment, and the root docker-compose.yml's old
# `beyla-config` service this replaced) — a third, permanently-stopped
# container in `docker ps` for a one-line file wasn't worth it once the
# alternative was this simple.
#
# COPY works here even though grafana/beyla's own image is `FROM scratch`
# (no shell, no package manager) because COPY is a build-time instruction
# handled by the Docker builder itself, not something exec'd inside the
# container — it never needs a shell to exist in the base image.
#
# Pin the exact upstream tag being extended — bump this together with the
# "beyla" service's version note in docker-compose.yml, they should always
# match. Check https://hub.docker.com/r/grafana/beyla/tags for newer ones
# (note: NO "v" prefix on Docker Hub, unlike the GitHub release tag).
FROM grafana/beyla:3.33.0
COPY config.yml /etc/beyla/config.yml
