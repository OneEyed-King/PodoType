// HOSTED (thin-agent / approach B) datasource — talks to license-server's
// /v1/dashboard/* routes (see ../../../../apps/hosted/license-server/routes/dashboard.js)
// instead of an engine. This is the other half of the datasource split (see
// ./index.js): same handful of function names/shapes engineApi.js exports
// for the parts that are genuinely data-driven (recentTraces, traceDetail,
// serviceMap), so TraceExplorer/TraceWaterfall/ServiceMap render against
// either one unmodified — those components have no idea which build they're
// in, same as a Grafana panel doesn't know which datasource plugin answered
// its query.
//
// credentials: 'include' on every call: license-server auths by session
// cookie (req.user.id, see routes/auth.js), not a bearer key the way the
// self-hosted engine proxy does — there's no per-browser-session engine to
// trust here, just whoever's logged into this account.
//
// Methods engineApi.js has that AREN'T here on purpose (services() in the
// Docker-discovery sense, toggle, setCheck, setOtel, otelCompose, logs,
// alertsConfig, retentionConfig, billingConfig, …): those are all
// self-hosted's Docker-aware control plane, not a datasource concern — see
// the "Genuinely datasource-shaped" vs "actually a control plane" split
// this file's sibling comment (HostedApp.jsx) explains. HostedApp.jsx never
// imports or calls those, so this file never needed to fake them.

async function fetchJSON(url, opts) {
  const res = await fetch(url, { credentials: 'include', ...opts });
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

export const hostedApi = {
  // Discovery + watch, now real — the agent's own Docker access (same
  // privileges self-hosted's engine has, see deploy/docker-compose.agent.yaml's
  // docker.sock mount) already ships a full container list every
  // heartbeat; this just reads it back (apps/hosted/license-server/repositories/
  // agentDiscoveryStore.js) and joins it against which ones are watched
  // (hosted_watched_services). Same {name, image, watched} shape
  // DiscoveredTable.jsx/SelectServices.jsx already render for self-hosted,
  // so those components work here unmodified.
  services: async () => {
    const body = await fetchJSON('/v1/dashboard/discovery');
    return {
      services: body.services,
      watchedCount: body.watchedCount,
      tier: body.tier,
      maxWatchedServices: body.maxWatchedServices,
      otelLanguages: body.otelLanguages,
    };
  },
  // Flips one container's watched state — server-side enforces the free-
  // tier cap (see routes/dashboard.js's POST .../watch), same "ingestion
  // is never gated, only what's watched/displayed is" philosophy
  // self-hosted's own free tier already uses.
  toggle: (name) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/watch`, { method: 'POST' }),

  // Same name/contract as engineApi.clearData — deletes this service's own
  // stored spans/logs for this account, separate from toggle above (which
  // only starts/stops watching it). See routes/dashboard.js's DELETE
  // .../services/:name/data.
  clearData: (name) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/data`, { method: 'DELETE' }),

  // Same name/shape as engineApi.setCheck ON PURPOSE — App.jsx's own
  // setupCheck/removeCheck prompt-based flow (used by self-hosted's
  // WatchedRow already) calls `api.setCheck`, not something hosted-
  // specific, so matching the name is what lets hosted reuse those same
  // two functions unmodified instead of writing its own copy. The check
  // itself runs agent-side (see apps/hosted/agent/server.js's "Manual health check"
  // section) — this just persists the {type, target} config for the agent
  // to pick up on its next GET /v1/agent/config poll.
  setCheck: (name, body) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Same name/shape as engineApi.setOtel/otelCompose/otelComposeDownloadUrl
  // ON PURPOSE — App.jsx's own setupOtel/disableOtel/showOtelInstructions
  // (used by self-hosted's WatchedRow already) call these through `api`,
  // not something hosted-specific, so hosted reuses those exact functions
  // too. See apps/hosted/license-server/otelOverride.js for the compose generator
  // itself (a near-verbatim port of engine/server.js's own one) and its
  // header comment for why the endpoint it generates needed no change.
  // guessOtelLanguage/guessOtelLanguages are deliberately NOT implemented
  // here — setupOtel already tolerates their absence (try/catch around the
  // call), falling back to the same plain manual-language prompt self-
  // hosted itself falls back to when a guess fails.
  setOtel: (name, body) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/otel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  otelCompose: () => fetchJSON('/v1/dashboard/otel/compose'),
  otelComposeDownloadUrl: () => '/v1/dashboard/otel/compose/download',

  // Landing list — not part of the shared datasource contract (self-hosted
  // has no equivalent call shaped like this one; SelectServices/WatchedRow
  // use the Docker-shaped api.services() instead), so App.jsx's hosted
  // branch is the only caller.
  hostedServices: () => fetchJSON('/v1/dashboard/services'),

  // Same name/shape as engineApi.recentTraces's resolved body, now
  // including includeHealthChecks (routes/dashboard.js's /traces applies
  // the same HEALTH_CHECK_OPERATION_RE filter engine's recentTraceList
  // does — see apps/hosted/license-server/clickhouse.js's recentTraces) — and with
  // server/operation field names normalized to what TraceExplorer.jsx
  // actually reads (t.rootOperation / t.rootService), since clickhouse.js's
  // recentTraces returns `operation`/`service` instead — same data,
  // different label, kept as-is server-side since that's also what the
  // plain dashboard.html page (apps/hosted/license-server/public/dashboard.html) reads
  // directly.
  // since/until (both optional, both-or-neither) — same range-browsing
  // contract as engineApi.recentTraces now has, backed by routes/
  // dashboard.js's GET /traces parseTimeRangeQuery + clickhouse.js's
  // recentTraces windowClause (both clamped server-side to this account's
  // own effectiveRetentionDays regardless of what's asked for here).
  recentTraces: async (serviceName, { includeHealthChecks = false, since, until } = {}) => {
    const params = new URLSearchParams({ service: serviceName, includeHealthChecks: String(includeHealthChecks) });
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    const body = await fetchJSON(`/v1/dashboard/traces?${params.toString()}`);
    return {
      traces: (body.traces || []).map((t) => ({
        traceId: t.traceId,
        durationMs: t.durationMs,
        rootOperation: t.operation,
        rootService: t.service,
        rootOperationLabel: t.operationLabel,
        isError: Boolean(t.isError),
        startTimeUnixNano: t.startTimeUnixNano,
      })),
      hiddenHealthCheckCount: body.hiddenHealthCheckCount || 0,
    };
  },

  // Identical shape to engineApi.traceDetail's response already — see
  // apps/hosted/license-server/clickhouse.js's traceDetail, which mirrors
  // apps/self-hosted/engine/server.js's fetchTraceDetail field-for-field
  // (spanId/parentSpanId/service/operation/offsetMs/durationMs) — no
  // reshaping needed here, unlike recentTraces above.
  traceDetail: (traceId) => fetchJSON(`/v1/dashboard/traces/${encodeURIComponent(traceId)}`),

  // Same shape engine's /api/service-map returns — see
  // apps/hosted/license-server/clickhouse.js's serviceMap, ported query-for-query
  // (with TenantId added) from apps/self-hosted/engine/server.js's fetchServiceMap.
  serviceMap: () => fetchJSON('/v1/dashboard/service-map'),

  // Same shape engine's /api/host-stats returns (minus `history`, which
  // hosted doesn't store yet — see hosted_host_stats' own comment). Takes
  // (and ignores) the same {minutes} opts object engineApi.hostStats now
  // accepts, purely so HostStatsPanel.jsx can call api.hostStats(opts)
  // uniformly on both builds without branching — there's no history
  // buffer here to trim.
  hostStats: () => fetchJSON('/v1/dashboard/host-stats'),
  // Sidebar's logout ribbon — mirrors the server-side session cookie
  // clear at POST /v1/auth/logout (see license-server/routes/auth.js).
  logout: () => fetchJSON('/v1/auth/logout', { method: 'POST' }),
  // Manual cost override (backlog item #15) — same shape on both
  // builds: {override: {monthlyUsd, instanceLabel} | null}.
  getCostOverride: () => fetchJSON('/v1/dashboard/cost-override'),
  setCostOverride: (monthlyUsd, instanceLabel) =>
    fetchJSON('/v1/dashboard/cost-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyUsd, instanceLabel }),
    }),
  clearCostOverride: () => fetchJSON('/v1/dashboard/cost-override', { method: 'DELETE' }),
  // sinceIso/untilIso (both optional, together) add spansInRange/
  // ingestRatePerSecInRange to the response — see routes/dashboard.js's
  // GET .../usage. spansThisMonth/spansCap are always present regardless,
  // since the free-tier cap is inherently a calendar-month figure.
  usage: (sinceIso, untilIso) =>
    fetchJSON(
      sinceIso && untilIso
        ? `/v1/dashboard/usage?since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`
        : '/v1/dashboard/usage'
    ),

  // NEW — the logs section's own landing list and per-container fetch.
  // Not part of the shared datasource contract (self-hosted's logs are
  // Docker-discovery-driven, see LogsPanel.jsx/WatchedRow.jsx; there's no
  // engineApi.hostedContainers equivalent), same "HostedApp.jsx-only,
  // datasource-shaped but hosted-specific" category as hostedServices
  // above — see that method's own comment.
  hostedContainers: () => fetchJSON('/v1/dashboard/containers'),
  containerLogs: (containerName, limit = 200) =>
    fetchJSON(`/v1/dashboard/logs?container=${encodeURIComponent(containerName)}&limit=${limit}`),

  // Same name/signature as engineApi.setMetrics/metricsHistory ON PURPOSE —
  // MetricsPanel.jsx's onToggleEnabled is wired by whatever parent renders
  // it (App.jsx, here), but ResourceHealthPanel.jsx calls `api.metricsHistory`
  // straight from ../api.js itself (which already resolves to this file in
  // the hosted build — see api.js's own DEPLOY_MODE switch). Matching the
  // name is what makes that component work completely unmodified, same
  // "ship data shaped for the existing component" pattern as everything
  // else in this file.
  setMetrics: (name, enabled) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  metricsHistory: (name) => fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/metrics-history`),

  // "Possible cause" / critical path / trace-window logs — hosted
  // equivalents of engineApi.js's own routes, now that license-server's
  // clickhouse.js has them (see that file's section comment). Same
  // optional-call contract: PossibleCauseCard.jsx and friends check these
  // exist on `api` before calling them, so this file no longer needs its
  // own "self-hosted only for now" gap here.
  possibleCause: (name) => fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/possible-cause`),
  criticalPath: (traceId) => fetchJSON(`/v1/dashboard/traces/${encodeURIComponent(traceId)}/critical-path`),
  traceLogs: (traceId) => fetchJSON(`/v1/dashboard/traces/${encodeURIComponent(traceId)}/logs`),

  // Alerts — trigger/threshold config lives at /v1/dashboard/alerts/config
  // (hostedAlertStore.js), evaluated centrally by license-server's
  // hostedAlertEvaluator.js (not the agent — see that file's own comment
  // for why). Channel delivery is a SEPARATE, already-existing surface
  // (/v1/auth/alert-channels — multi-channel CRUD, unlike self-hosted's
  // single inline telegram+webhook pair), so HostedAlertsPanel/
  // HostedAlertsSettings call both, not one unified alertsConfig() the
  // way self-hosted's AlertsSettings.jsx does.
  alertsConfig: () => fetchJSON('/v1/dashboard/alerts/config'),
  setAlertsConfig: (partial) =>
    fetchJSON('/v1/dashboard/alerts/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  alerts: () => fetchJSON('/v1/dashboard/alerts'),

  // Same names/shapes as engineApi's log-clustering/search/history exports
  // ON PURPOSE — LogsPanel.jsx (the actual shared component WatchedRow.jsx
  // renders, unmodified between builds) calls these straight off `api`
  // from ../api.js, same "ship data shaped for the existing component"
  // pattern as metricsHistory/setMetrics above. See routes/dashboard.js's
  // matching routes and clickhouse.js's logClusters/logPatternHistory/
  // searchLogs for the one real difference: those read stored rows instead
  // of a live docker tail, since this service has no direct Docker access.
  // (LogsPanel's Live tab's own EventSource call is the one exception —
  // it's a hardcoded URL, not one of these — see server.js's matching
  // /api/services/:name/logs/stream route for why that needed no change
  // here either.)
  logClusters: (name, tail) => fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/log-clusters${tail ? `?tail=${tail}` : ''}`),
  searchLogs: (name, q, tail) =>
    fetchJSON(
      `/v1/dashboard/services/${encodeURIComponent(name)}/logs/search?q=${encodeURIComponent(q)}${tail ? `&tail=${tail}` : ''}`
    ),
  logPatternHistory: (name, hours) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/log-patterns/history${hours ? `?hours=${hours}` : ''}`),
  logRetentionConfig: () => fetchJSON('/v1/dashboard/log-retention/config'),
  setLogStorage: (name, enabled) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/log-storage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  alertChannels: () => fetchJSON('/v1/auth/alert-channels'),
  createAlertChannel: (type, label, config) =>
    fetchJSON('/v1/auth/alert-channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, label, config }),
    }),
  setAlertChannelEnabled: (id, enabled) =>
    fetchJSON(`/v1/auth/alert-channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  deleteAlertChannel: (id) => fetchJSON(`/v1/auth/alert-channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testAlertChannel: (id) => fetchJSON(`/v1/auth/alert-channels/${encodeURIComponent(id)}/test`, { method: 'POST' }),

  // Same name/shape as engineApi's alertOverrides/setAlertOverrides ON
  // PURPOSE — ServiceAlertOverrides.jsx (shared, unmodified between
  // builds) calls these straight off `api`. See routes/dashboard.js's
  // matching GET/POST .../alert-overrides and serviceAlertOverrideStore.js
  // for the inheritance model (missing key = inherits hostedAlertStore's
  // global config, never a hardcoded default).
  alertOverrides: (name) => fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/alert-overrides`),
  setAlertOverrides: (name, body) =>
    fetchJSON(`/v1/dashboard/services/${encodeURIComponent(name)}/alert-overrides`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Same name/shape as engineApi's runQuery/queryTables ON PURPOSE —
  // QueryConsole.jsx (shared, unmodified between builds) calls
  // api.runQuery/api.queryTables straight off `api`. See
  // routes/dashboard.js's POST /query and GET /query/tables, and
  // clickhouse.js's runAdHocQuery/listQueryTables for the one real
  // difference from self-hosted: the customer's SQL is wrapped in a
  // TenantId-scoped `my_traces`/`my_logs` CTE server-side, so there's no
  // separate client-side change needed to keep this tenant-isolated —
  // it's enforced entirely in clickhouse.js, invisibly to this file.
  runQuery: (sql, limit) =>
    fetchJSON('/v1/dashboard/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql, limit }),
    }),
  queryTables: () => fetchJSON('/v1/dashboard/query/tables'),

  // Same name/shape as engineApi's retentionConfig/setRetentionConfig ON
  // PURPOSE — RetentionPanel.jsx (shared, unmodified between builds)
  // calls these straight off `api`. See routes/dashboard.js's GET/POST
  // /retention/config and retentionConfigStore.js for the one real
  // difference from self-hosted: this is a per-account query-time cap on
  // a shared ClickHouse table, not a real TTL, so `reclaimed` is always
  // false and there's no per-account dailyBytesEstimate to show.
  retentionConfig: () => fetchJSON('/v1/dashboard/retention/config'),
  setRetentionConfig: (hours) =>
    fetchJSON('/v1/dashboard/retention/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hours }),
    }),

  // Same name/shape as engineApi's metricsHistoryRange ON PURPOSE —
  // MetricsHistoryRange.jsx (shared, unmodified between builds) calls
  // api.metricsHistoryRange straight off `api`. See routes/dashboard.js's
  // GET /services/:name/metrics-history/range for the merge of Postgres-
  // backed container stats (points) and ClickHouse-backed RED history
  // (requests) into one response — self-hosted gets both from the same
  // ClickHouse table instead, but the response shape matches either way.
  metricsHistoryRange: (name, since, until) =>
    fetchJSON(
      `/v1/dashboard/services/${encodeURIComponent(name)}/metrics-history/range?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`
    ),
};
