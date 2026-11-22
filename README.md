# PodoType (self-hosted)

[**podotype.dev**](https://www.podotype.dev/) — project site, screenshots, and install instructions.

Zero-instrumentation observability, built specifically for your Docker
Compose stack — traces, RED metrics, logs, and container health,
auto-captured via eBPF (Beyla), with no code changes to your own services.
Two containers, one command, free and self-hosted forever under the
Elastic License 2.0.

## Features

- **Zero-instrumentation discovery.** PodoType reads the Docker Engine API
  directly — every running container shows up the moment it starts, with
  no manifest to maintain.
- **RED metrics from your logs.** Opt a service in and PodoType tails its
  container logs, parsing common access-log formats into request rate,
  error rate, and duration — before you've wired up anything else.
- **eBPF auto-tracing (Beyla).** Distributed traces with no code changes,
  no SDKs, and nothing to wire up — on any real Linux host. See
  Requirements below for where this does and doesn't work.
- **OpenTelemetry, opt-in.** Need real code-level spans, or you're on
  Docker Desktop where eBPF can't attach? Pick a service in the dashboard
  and PodoType generates a docker-compose override wired up with the OTel
  SDK — see OpenTelemetry / Code Tracing below.
- **Smart alerts.** Thresholds on CPU, memory, error rate, latency, and
  TLS certificate expiry (for any watched HTTPS service), with
  sustained-breach windows so a one-second blip doesn't page you.
  Delivered over your own Telegram bot, a Slack/Discord webhook, or your
  own mailbox — see Alerts below. PodoType never sees or relays these;
  your instance sends them directly.
- **No env vars to babysit.** Alert thresholds and channels, data
  retention, the manual health check for a service, and every
  background poll/eval cadence the engine runs are all configured from
  the dashboard's Settings — changes take effect immediately, no
  editing `.env` or restarting the container.
- **Your language, your colors.** A handful of accent presets and
  light/dark mode (under Settings), plus a language switcher in the
  header — the dashboard is available in English, German, Spanish,
  French, Japanese, Brazilian Portuguese, and Russian.
- **Service map & Compare.** A dependency graph drawn from real traffic,
  not a YAML file you maintain by hand, plus a side-by-side table of
  request rate, error rate, latency, and trace health for any services
  you pick.
- **One storage engine.** Traces, metrics, and logs all land in a single
  bundled ClickHouse container — no separate Tempo, Prometheus, and Loki
  stack to provision and keep talking to each other.
- **Unlimited, on your own infrastructure.** No container cap, no feature
  gate, self-hosted under the Elastic License 2.0. Your telemetry data
  never leaves your network.
- **Login on by default.** HTTP Basic Auth in front of the whole
  dashboard, `admin`/`admin` out of the box — change it in `.env` before
  exposing this beyond a trusted network. See Login below.

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
curl -fsS https://raw.githubusercontent.com/OneEyed-King/PodoType/master/deploy/docker-compose.yaml \
  | docker compose -f - up -d
```

Wait about 10–15 seconds for ClickHouse's healthcheck to pass (the `app`
container waits for it before starting), then open
`http://localhost:8973` — your browser will prompt for a username and
password (default `admin` / `admin`; see Login below to change it).

**What you should see:** every container currently running on the host,
listed with its up/down status — that part works immediately, with
nothing else to configure. Toggle "watch" on a service to start tracking
it; if you're on real Linux (see Requirements above), RED metrics and
traces for watched services start appearing within the next few seconds
as real traffic hits them. If nothing shows up after a minute of real
traffic, check the Troubleshooting section below before assuming
something's broken.

To stop and remove it, re-run the same curl, piped into `down` instead of
`up -d` (you likely didn't save `docker-compose.yaml` anywhere, so `-f -`
again — reading the file from stdin — is what lets this work without it;
`docker compose down` alone, with no file, does nothing here since
Compose wouldn't know which project you mean):

```bash
curl -fsS https://raw.githubusercontent.com/OneEyed-King/PodoType/master/deploy/docker-compose.yaml \
  | docker compose -f - down
```

(If you DID save the file locally, `docker compose -f docker-compose.yaml down`
from that directory works too.)

Your data (ClickHouse volume + dashboard state) persists across restarts
in named Docker volumes; add `-v` to the command above to wipe it too.

## Configuration

Copy `.env.example` to `.env` next to wherever you run the install
command from, and edit it — every setting is optional with a sane
default. Covers the published ports, login, and the (off by default) API
key; see the file itself for what each one does.

### Login

The dashboard is protected by HTTP Basic Auth out of the box — a browser
prompt asks for a username and password before showing anything, UI and
API alike. Default is `admin` / `admin`, so the first thing worth doing
on a real install is changing it in `.env`:

```bash
# .env
PODOTYPE_BASIC_AUTH_USER=someone
PODOTYPE_BASIC_AUTH_PASSWORD=a-real-password
```

then `docker compose up -d` to apply it (no rebuild needed). This is one
shared login for the whole instance, not per-user accounts. It does
**not** cover the OTLP port (`4318`) — that's where Beyla and any
OTel-enabled services send trace data to, not something a person visits,
and those senders don't carry credentials.

### Routing / reverse proxy

PodoType itself just listens on plain HTTP (`PODOTYPE_UI_PORT`, default
`8973`) — if you want it on a real domain with HTTPS, put a reverse proxy
in front of it on the same host. It's a single backend on one port, so
any proxy works the same way; two common ones:

**Caddy** (automatic HTTPS, simplest option — put this in a `Caddyfile`):

```
podotype.yourdomain.com {
    reverse_proxy localhost:8973
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name podotype.yourdomain.com;

    # ssl_certificate / ssl_certificate_key — e.g. from certbot

    location / {
        proxy_pass http://127.0.0.1:8973;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Either way, keep Basic Auth turned on (it's on by default) even behind a
proxy with its own TLS — the proxy terminates HTTPS for the connection
coming in, it doesn't replace login on its own. If the proxy and
PodoType run in the same `docker compose` project, route to the service
name (`app`) and container port (`8080`) instead of `localhost`/`8973`;
if the proxy runs separately (e.g. a host-level nginx/Caddy you already
run for other sites), `localhost:8973` is correct as shown above, since
`PODOTYPE_UI_PORT` is published to the host.

## Local development

```bash
git clone https://github.com/OneEyed-King/PodoType.git
cd PodoType
docker compose build
docker compose up -d
```

(`docker compose up -d --build` also works and does both in one step —
split out above so each command is easy to re-run on its own, e.g.
re-running just `docker compose build` after a code change, then `docker
compose up -d` to apply it.)

This builds from source instead of pulling the published image — use
this if you're changing PodoType's own code, not for a normal install.
See `docker-compose.yml`'s own comments for the full architecture
reasoning (why `pid: host`/`privileged` is needed, what each mount is
for, etc).

To stop and remove the containers this way (keeps your named volumes —
add `-v` to also wipe them):

```bash
docker compose down
```

## Alerts

Everything here is "bring your own" — PodoType never sends anything on
your behalf, or sees your credentials beyond storing them on your own
instance. All of it is configured from the dashboard's Alerts panel
(no env vars needed); click "Configure" there.

**Triggers:** service down, ClickHouse storage critical, threshold pairs
(warning/critical) for CPU, memory, error rate, and latency, and TLS
certificate expiry (warning at 14 days left, critical at 3, for any
watched service whose health check is HTTP against an https:// target).
Each one needs to stay breached across a configurable number of
consecutive checks (default tunable in the same panel, as is how often
that check itself runs — see Settings) before it actually fires — a
single noisy blip won't page you, and the alert clears the moment one
check comes back healthy. Error rate and latency only ever fire for a
service Beyla is already seeing real traffic for.

**Delivery channels** (enable any combination):

- **Telegram** — free. Create a bot via [@BotFather](https://t.me/BotFather),
  grab the bot token it gives you, then send the bot any message once so
  PodoType can look up your chat ID. Paste both into the panel.
- **Webhook** — works with Slack, Discord, or anything else that accepts
  an incoming webhook URL. Paste the URL in.
- **Email** — sent via your own mailbox (Gmail, Google Workspace, Zoho
  Mail, Outlook, or any other SMTP provider). You'll need the SMTP host
  and port (465 for SSL, 587 for STARTTLS), the sending mailbox address,
  and its password — use an app-specific password if your provider
  requires one once 2FA is on (Gmail/Workspace:
  myaccount.google.com/apppasswords; Zoho: Security › App Passwords).

Each channel has its own "Send test message" button that fires a real
message right now with whatever's currently typed, so you can confirm it
works before saving.

## OpenTelemetry / Code Tracing

eBPF can't run everywhere — Docker Desktop, a managed runtime, or you may
just want real code-level spans instead of Beyla's syscall-level ones.
This is fully opt-in, per service, and doesn't touch anything else in
your stack:

1. In the dashboard, open a watched service and find its Tracing panel,
   then click **Set up →** and pick the service's language.
2. PodoType generates `docker-compose.podotype.yml` — a single shared
   override file covering every OTel-enabled service, not just this one
   (so enabling a second service later just regenerates the same file).
   Download it or copy it from the panel.
3. Apply it alongside your real compose file:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.podotype.yml up -d
   ```

4. After the set of traced services changes, clean up any leftover
   fetch containers from the previous version of the file (safe — this
   only ever matches PodoType's own, do **not** use `--remove-orphans`
   here, since that could remove containers from your own stack that
   simply aren't in this override file):

   ```bash
   docker ps -a --filter "name=-podotype-otel-fetch" --format "{{.Names}}" | xargs -r docker rm -f
   ```

**For CI/CD:** paste the `include:` snippet the panel gives you at the
top of the real `docker-compose.yml` your pipeline deploys (needs
Compose v2.20+), so the override applies automatically on every rebuild
without a separate `-f` flag.

Traces from both eBPF and OpenTelemetry show up in the same dashboard —
same trace explorer, same service map, your choice of path per service.

## Upgrading from an older PodoType install

PodoType used to ship as 4 separate containers (`engine`, `web`, `beyla`,
`clickhouse`); it's 2 now (`app`, `clickhouse` — see `docker-compose.yml`'s
own comment for why). If you have an old install around, or you're
re-running `up` after pulling a new image and get a `Conflict. The
container name "/podotype-app" is already in use` error, that's a leftover
container from a previous run or an incompatible older container reusing
the same name — Compose can't just replace it, since it belongs to a
different project (or came from a manual `docker run`, not `docker
compose`). Fix it before retrying:

```bash
docker rm -f podotype-app
docker compose up -d --remove-orphans
```

`--remove-orphans` here is safe: it only ever removes containers that
belong to THIS compose project (`podotype`/whatever directory you're in)
but are no longer in its compose file — exactly the old `web`/`beyla`
containers from the 4-container architecture. (This is different from the
`--remove-orphans` warning under Code Tracing's own setup instructions,
which is about a *separate*, unrelated compose project — removing orphans
there could delete your own stack's containers too.)

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
That's the opt-in "Code Tracing" feature in the dashboard — see
OpenTelemetry / Code Tracing above. Works on any platform, including
Docker Desktop, since it doesn't depend on eBPF at all.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) —
see `LICENSE`. Free to use, self-host, modify, and redistribute, including
commercially for your own use. The one thing it doesn't allow is offering
PodoType itself to third parties as a hosted/managed service.
