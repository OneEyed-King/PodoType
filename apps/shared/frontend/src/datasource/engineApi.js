// SELF-HOSTED datasource — thin wrapper over podotype engine's REST API
// (see ../../../engine/server.js), proxied through ../../web/server.js.
// Unchanged from before the hosted/thin-agent build existed: this is one
// of two datasource implementations selected by ./index.js at build time
// (see that file's comment) — self-hosted's App.jsx keeps importing this
// one exact same way it always has, so nothing here changing behavior for
// that build was ever a goal or a risk of the datasource split.

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch {
      // response wasn't JSON — keep the status-code fallback
    }
    throw new Error(`${url} -> ${detail}`);
  }
  return res.json();
}

export const engineApi = {
  services: () => fetchJSON('/api/services'),
  // Optional {minutes} trims the in-memory host-stats history buffer
  // server-side to that window (see server.js's own GET /api/host-stats
  // comment) — HostStatsPanel.jsx passes the Overview page's own
  // selected range through so this panel moves with the rest of the
  // page. Omitted/ignored entirely returns everything still buffered,
  // same as before this param existed.
  hostStats: ({ minutes } = {}) =>
    fetchJSON(`/api/host-stats${minutes ? `?minutes=${encodeURIComponent(minutes)}` : ''}`),
  // Total spans stored (and the average ingest rate implied by that) for
  // an explicit window — see server.js's GET /api/usage-range. Same
  // {spansInRange, ingestRatePerSecInRange} shape hostedApi.usage's own
  // range fields use, so UsageStats.jsx can render one tile pair for
  // both builds.
  usageRange: (sinceIso, untilIso) =>
    fetchJSON(`/api/usage-range?since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`),
  // Manual cost override (backlog item #15) — same shape on both
  // builds: {override: {monthlyUsd, instanceLabel} | null}.
  getCostOverride: () => fetchJSON('/api/cost-override'),
  setCostOverride: (monthlyUsd, instanceLabel) =>
    fetchJSON('/api/cost-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyUsd, instanceLabel }),
    }),
  clearCostOverride: () => fetchJSON('/api/cost-override', { method: 'DELETE' }),
  status: () => fetchJSON('/api/status'),
  toggle: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/toggle`, { method: 'POST' }),
  // Deletes this service's own stored spans/log patterns/metrics history —
  // separate from toggle above, which only starts/stops WATCHING it. See
  // server.js's DELETE /api/services/:name/data for exactly what this
  // clears (backlog item #12: 'un-watched a dead service, now let me
  // reclaim the disk it used').
  clearData: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/data`, { method: 'DELETE' }),
  setCheck: (name, body) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  setMetrics: (name, enabled) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  setOtel: (name, body) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/otel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // Global, not per-service — there's one tracing setup file covering
  // every currently-traced service, not one per service (see server.js).
  otelCompose: () => fetchJSON('/api/otel/compose'),
  otelComposeDownloadUrl: () => '/api/otel/compose/download',
  // Best-effort language guess, used only to pre-fill (never auto-apply)
  // the language choice when setting up tracing — the person always
  // confirms or overrides it. See server.js "Guessing a service's language".
  guessOtelLanguage: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/otel/guess`),
  guessOtelLanguages: () => fetchJSON('/api/otel/guess-languages'),
  // No setBeyla/beylaCompose here anymore — the eBPF watcher is a
  // zero-config, always-on container now (see docker-compose.yml), not
  // something the UI opts services into one at a time.
  // since/until (both optional, both-or-neither) let TraceExplorer.jsx's
  // range picker browse a past window instead of just "recent" — see
  // server.js's /api/services/:name/traces route (parseTimeRangeQuery)
  // for the actual query-side support this already had before any UI
  // called it this way.
  recentTraces: (name, opts) => {
    const params = new URLSearchParams();
    if (opts && opts.includeHealthChecks) params.set('showHealthChecks', '1');
    if (opts && opts.since) params.set('since', opts.since);
    if (opts && opts.until) params.set('until', opts.until);
    const qs = params.toString();
    return fetchJSON(`/api/services/${encodeURIComponent(name)}/traces${qs ? `?${qs}` : ''}`);
  },
  traceDetail: (traceId) => fetchJSON(`/api/traces/${encodeURIComponent(traceId)}`),
  // Raw log tail — see server.js's "/api/services/:name/logs" comment for
  // why this is separate from setMetrics/svc.metrics (that's a parsed
  // access-log error-rate signal; this is the actual lines, unparsed).
  logs: (name, tail) => fetchJSON(`/api/services/${encodeURIComponent(name)}/logs?tail=${tail || 200}`),
  // Same container logs, grouped into recurring patterns — see server.js's
  // "Log clustering" comment.
  logClusters: (name, tail) => fetchJSON(`/api/services/${encodeURIComponent(name)}/log-clusters${tail ? `?tail=${tail}` : ''}`),
  // Basic substring search over a larger tail than the Live tab keeps
  // client-side — see server.js's own comment on this route.
  searchLogs: (name, q, tail) =>
    fetchJSON(
      `/api/services/${encodeURIComponent(name)}/logs/search?q=${encodeURIComponent(q)}${tail ? `&tail=${tail}` : ''}`
    ),
  // Trace retention settings UI: current hours + a real daily-volume
  // estimate from ClickHouse's own system.parts (see server.js's
  // estimateDailyTraceBytes). POST is hours (+ optional reclaimNow to also
  // run MATERIALIZE TTL immediately).
  retentionConfig: () => fetchJSON('/api/retention/config'),
  setRetentionConfig: (hours, reclaimNow) =>
    fetchJSON('/api/retention/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours, reclaimNow: Boolean(reclaimNow) }),
    }),
  // Sustained-condition alerts (service-down / storage / CPU / memory) — see
  // server.js's "Alerts" section. Distinct from AttentionBanner's instant
  // read of the same underlying signals: this reflects what's stayed true
  // for ALERT_SUSTAIN_CHECKS cycles and what notification channels (if any)
  // are actually wired up to tell someone who isn't looking at this page.
  alerts: () => fetchJSON('/api/alerts'),
  // Tracing preflight — see server.js's "Tracing preflight check" section.
  // Self-hosted only for now: it reads a host-mounted /sys/kernel/btf path
  // that only the self-hosted engine container has (docker-compose.yml);
  // the hosted agent doesn't expose this yet, so hostedApi.js deliberately
  // has no equivalent — PreflightBanner.jsx checks `api.preflight` exists
  // before calling it, rather than this silently 404ing on that build.
  preflight: () => fetchJSON('/api/preflight'),
  // "Possible cause" — see server.js's own section comment. Self-hosted
  // only for the same reason preflight is: no hosted equivalent route
  // exists yet (license-server/clickhouse.js has its own separate
  // fetchTraceDetail-equivalent, not wired to this). PossibleCauseCard.jsx
  // checks `api.possibleCause` exists before calling it either way.
  possibleCause: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/possible-cause`),
  // Cross-service critical path for one trace, and best-effort logs from
  // every service involved in it — see server.js's own section comment
  // for both. Same optional-feature pattern as possibleCause/preflight:
  // components check `api.criticalPath`/`api.traceLogs` exist before
  // calling them.
  criticalPath: (traceId) => fetchJSON(`/api/traces/${encodeURIComponent(traceId)}/critical-path`),
  traceLogs: (traceId) => fetchJSON(`/api/traces/${encodeURIComponent(traceId)}/logs`),
  // Alerts settings UI: which triggers are on, their thresholds, the
  // sustain window, and each notification channel's enabled+credentials.
  // POST is a partial update — send only what changed, anything omitted
  // keeps its saved value (see server.js's own merge-onto-current comment).
  alertsConfig: () => fetchJSON('/api/alerts/config'),
  setAlertsConfig: (partial) =>
    fetchJSON('/api/alerts/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  // Fires one real test message right now through the given channel, using
  // whatever credentials are passed (so a not-yet-saved token/URL can be
  // tried before committing to Save) — falls back to the currently-saved
  // credentials for that channel when none are passed.
  testAlertChannel: (channel, credentials) =>
    fetchJSON('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, ...(credentials ? { [channel]: credentials } : {}) }),
    }),
  // CPU/memory/network/disk/request-rate history for one service's charts —
  // see server.js's "History charts for one watched service" comment for
  // why this is its own on-demand endpoint instead of riding along on the
  // 5s /api/status poll every service already gets.
  metricsHistory: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/metrics-history`),
  // Who-calls-whom, derived from real spans already in ClickHouse — see
  // server.js's "Service map" comment. Nodes are Beyla/OTel service names,
  // not necessarily the same as podotype's watched-container names.
  serviceMap: () => fetchJSON('/api/service-map'),
  // Opt-in, per-service clustered log-pattern storage — see server.js's
  // "Log pattern storage" comment for the full trade-off (real, additive
  // disk usage; not a replacement for Docker's own logs). Toggle is instant
  // — no restart needed, server.js's own background reconciler picks it up.
  setLogStorage: (name, enabled) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/log-storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  // Historical clustered view sourced from ClickHouse instead of a live
  // tail — only returns real data once setLogStorage(name, true) has been
  // running a while; returns {enabled:false, clusters:[]} otherwise, not
  // an error, since "hasn't opted in" is a normal state.
  logPatternHistory: (name, hours) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/log-patterns/history${hours ? `?hours=${hours}` : ''}`),
  // Log-pattern retention — SEPARATE setting from trace retention (see
  // server.js's mergeLogRetentionConfig comment for why); same
  // GET current+estimate / POST hours+reclaimNow shape as retentionConfig.
  logRetentionConfig: () => fetchJSON('/api/log-retention/config'),
  setLogRetentionConfig: (hours, reclaimNow) =>
    fetchJSON('/api/log-retention/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours, reclaimNow: Boolean(reclaimNow) }),
    }),
  // Only meaningful for the public demo build (see server.js's "Demo
  // license expiry" comment) — {demo:false} on every real/private
  // deployment, since the private image's build never bakes an expiry
  // file in. Deliberately reachable with no engine key, so this still
  // answers even after every other /api/* route starts refusing.
  licenseStatus: () => fetchJSON('/api/license-status'),
  // Per-service alert threshold overrides — see server.js's "Per-service
  // alert overrides" comment. GET returns both the raw override (what's
  // actually saved — a field absent from it means "inherits the global
  // value") and `effective` (what will actually be evaluated for this
  // service right now). POST is a partial update; pass `null` for any one
  // field to clear just that override back to inheriting, or `{clear:true}`
  // to drop every override for this service at once.
  alertOverrides: (name) => fetchJSON(`/api/services/${encodeURIComponent(name)}/alert-overrides`),
  setAlertOverrides: (name, body) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/alert-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // Deploy markers — see server.js's "Deploy markers" comment. `service`
  // filters to one service; omit for every watched service's markers.
  deployMarkers: (service, hours) => {
    const params = new URLSearchParams();
    if (service) params.set('service', service);
    if (hours) params.set('hours', hours);
    const qs = params.toString();
    return fetchJSON(`/api/deploy-markers${qs ? `?${qs}` : ''}`);
  },
  // "What else happened around this moment" — traces + raw logs + any
  // deploy marker from a window around one timestamp. See server.js's
  // "Incident context" comment.
  incidentContext: (name, { at, windowSeconds } = {}) => {
    const params = new URLSearchParams();
    if (at) params.set('at', at);
    if (windowSeconds) params.set('windowSeconds', windowSeconds);
    const qs = params.toString();
    return fetchJSON(`/api/services/${encodeURIComponent(name)}/incident-context${qs ? `?${qs}` : ''}`);
  },
  // Historical (ClickHouse-backed) CPU/memory/request-rate/error-rate for an
  // arbitrary past window — see server.js's "Long-term metrics retention"
  // comment. `since`/`until` are ISO timestamps.
  metricsHistoryRange: (name, since, until) =>
    fetchJSON(`/api/services/${encodeURIComponent(name)}/metrics-history/range?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`),
  // Ad-hoc read-only SQL against podotype's own ClickHouse — the "debug
  // like Grafana Explore" escape hatch. See server.js's "Ad-hoc debug
  // query" comment for the safety model (SELECT/WITH only, single
  // statement, same engine-key trust boundary as every other route here).
  runQuery: (sql, limit) =>
    fetchJSON('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, limit }),
    }),
  // Real column list per table, straight from ClickHouse's own
  // system.columns — what the query console shows as a schema reference.
  queryTables: () => fetchJSON('/api/query/tables'),
  // SaaS build only (see server.js's "SaaS license heartbeat"/"SaaS
  // license tiers" comments) — {saas:false, tier:'unrestricted'} on every
  // free/self-hosted or demo deployment, since LICENSE_SERVER_URL is never
  // set there. `instanceId` is the anonymous id Paddle checkout attaches
  // as customData — never a secret, never typed in by anyone.
  saasLicenseStatus: () => fetchJSON('/api/saas-license-status'),
  // Public/client-side-safe Paddle config (price id + client token — the
  // same trust level as a Stripe publishable key, never a secret) plus
  // this install's instanceId to attach to checkout. `enabled: false`
  // until a real Paddle account is actually configured server-side.
  billingConfig: () => fetchJSON('/api/billing/config'),
};
