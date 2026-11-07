# PodoType (self-hosted)

Zero-instrumentation observability for Docker — traces, RED metrics, logs,
and container health, auto-captured via eBPF (Beyla), with no code changes
to your own services.

## Requirements

- Docker Engine with Compose v2 (`docker compose`, not the old `docker-compose`).
- **A real Linux kernel.** Beyla's eBPF capture needs one — it does not
  work on Docker Desktop for Windows/Mac (including WSL2's kernel in many
  setups), where it will start cleanly but silently capture nothing. Run
  this on a Linux VM, a cheap VPS, or native Linux for traces/metrics to
  actually show up. Discovery (listing your containers and their
  up/down status) works everywhere regardless, since that's plain Docker
  API access, not eBPF.
- Ports `8973`, `4318`, and `8123` free on the host (all overridable — see
  `.env.example`).

## Quick start

```bash
curl -fsS https://raw.githubusercontent.com/OneEyed-King/PodoType/main/deploy/docker-compose.yaml \
  | docker compose -f - up -d
```

Wait about 10–15 seconds for ClickHouse's healthcheck to pass (the `app`
container waits for it before starting), then open
`http://localhost:8973`.

**What you should see:** every container currently running on the host,
listed with its up/down status — that part works immediately, with
nothing else to configure. Toggle "watch" on a service to start tracking
it; if you're on real Linux (see Requirements above), RED metrics and
traces for watched services start appearing within the next few seconds
as real traffic hits them. If nothing shows up after a minute of real
traffic, check the Troubleshooting section below before assuming
something's broken.

To stop and remove it:

```bash
docker compose -f deploy/docker-compose.yaml down
```

Your data (ClickHouse volume + dashboard state) persists across restarts
in named Docker volumes; add `-v` to the command above to wipe it too.

## Configuration

Copy `.env.example` to `.env` next to wherever you run the install
command from, and edit it — every setting is optional with a sane
default. Covers the published ports and the (off by default) API key; see
the file itself for what each one does.

## Local development

```bash
git clone https://github.com/OneEyed-King/PodoType.git
cd PodoType
docker compose up -d --build
```

This builds from source instead of pulling the published image — use
this if you're changing PodoType's own code, not for a normal install.
See `docker-compose.yml`'s own comments for the full architecture
reasoning (why `pid: host`/`privileged` is needed, what each mount is
for, etc).

## Troubleshooting

**No containers listed at all.** `app` couldn't reach the Docker socket —
check `docker compose logs app` for a docker.sock permission error.

**Containers listed, but no traces/metrics for a watched service.**
Almost always the Requirements section above — confirm you're on a real
Linux kernel, not Docker Desktop. `docker exec <app container> ls
/sys/kernel/debug` failing or listing nothing is a strong sign eBPF can't
attach on this host.

**`docker compose up` fails to pull the image.** The published image may
not be public yet, or GHCR is having a bad day — check
[the repo's packages page](https://github.com/OneEyed-King/PodoType/pkgs/container/podotype-app)
to confirm `podotype-app` shows as public, or build locally instead (see
Local development above).

**Want deep, code-level traces instead of Beyla's eBPF-captured ones?**
That's the opt-in "Code Tracing" feature in the dashboard — pick a
watched service, generate its OpenTelemetry compose override, apply it
alongside your own stack. Works on any platform, including Docker
Desktop, since it doesn't depend on eBPF at all.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) —
see `LICENSE`. Free to use, self-host, modify, and redistribute, including
commercially for your own use. The one thing it doesn't allow is offering
PodoType itself to third parties as a hosted/managed service.
