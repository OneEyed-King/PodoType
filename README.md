# Podotype (self-hosted)

Zero-instrumentation observability for Docker — traces, RED metrics, logs,
and container health, auto-captured via eBPF (Beyla), with no code changes
to your own services.

## Quick start

```bash
curl -fsS https://raw.githubusercontent.com/<org>/<repo>/main/deploy/docker-compose.yaml \
  | docker compose -f - up -d
```

Open `http://localhost:8973`.

Two containers: `app` (engine + dashboard + Beyla, combined) and
`clickhouse` (trace/log/metric storage). Self-hosted is free and
unlimited — no license server, no account, no network calls anywhere
except to your own Docker socket and ClickHouse.

## Local development

```bash
docker compose up -d --build
```

See `docker-compose.yml`'s own comments for the full architecture
reasoning (why `pid: host`/`privileged` is needed, what each mount is
for, etc).

## License

MIT — see `LICENSE`. (Confirm this is the license you want before
publishing; swap it out first if not.)
