import { useEffect, useRef, useState } from 'react';
import InfoDot from './InfoDot.jsx';
import { api } from '../api.js';

const LOG_INITIAL_TAIL = 100;
const LOG_MAX_LINES_KEPT = 500; // caps memory/DOM size on a long-running tail, not a display limit anyone will hit scrolling
// How often the clustered view re-fetches while open — slower than the live
// tail's push-based SSE on purpose: clustering re-scans a few hundred lines
// server-side on every call (see server.js's LOG_CLUSTER_TAIL_DEFAULT), so
// this is "check back occasionally", not "stream".
const LOG_CLUSTERS_POLL_MS = 15000;

const LEVEL_DOT = { fatal: 'bg-down', error: 'bg-down', warning: 'bg-slow', info: 'bg-muted' };
const LEVEL_TEXT = { fatal: 'text-down', error: 'text-down', warning: 'text-slow', info: 'text-ink-dim' };

// The clustered view — server.js groups a larger tail into recurring line
// SHAPES (numbers/ids/timestamps replaced with placeholders) so a noisy
// container's log stops being "the same line 400 times" and becomes "here
// are the 12 distinct things this container actually says, and how often
// each one happens". Fetched on demand (only while this sub-view is open),
// same as the live tail only streaming while expanded.
function ClusteredLogs({ serviceName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .logClusters(serviceName)
        .then((body) => {
          if (!cancelled) {
            setData(body);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    }
    tick();
    const id = setInterval(tick, LOG_CLUSTERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [serviceName]);

  if (error) return <div className="text-[13px] text-down">{error}</div>;
  if (!data) return <div className="text-[13px] text-muted">scanning recent logs…</div>;
  if (data.clusters.length === 0) return <div className="text-[13px] text-muted">no log lines yet</div>;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-muted mb-0.5">
        {data.clusterCount} distinct pattern{data.clusterCount === 1 ? '' : 's'} across the last {data.linesExamined} lines
        {data.truncated ? ` (showing the ${data.clusters.length} most frequent)` : ''}
      </div>
      <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
        {data.clusters.map((c) => (
          <div key={c.template} className="bg-panel rounded border border-border-soft px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[c.level] || 'bg-muted'}`} />
              <span className="font-mono text-[12px] font-bold text-ink shrink-0">×{c.count}</span>
              <span className={`font-mono text-[12px] [overflow-wrap:anywhere] ${LEVEL_TEXT[c.level] || 'text-ink-dim'}`}>
                {c.template}
              </span>
              {c.lastTs && (
                <span className="font-mono text-[11px] text-muted ml-auto shrink-0">
                  last {new Date(c.lastTs).toLocaleTimeString()}
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-muted mt-0.5 pl-3.5 [overflow-wrap:anywhere]">{c.sample}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Preset lookback windows for the History tab's time-range picker — hours,
// so they compare directly against logRetention.hours without a
// day/hour unit-conversion bug creeping in. Filtered down to whatever's
// actually within retention before rendering (see HistoryLogs below) —
// offering "30 days" when only 2 days are actually retained would be
// exactly the "looks complete, silently isn't" problem this feature was
// built to avoid for the live-tail-based views.
const LOG_HISTORY_RANGE_PRESETS = [
  { label: '1h', hours: 1 },
  { label: '4h', hours: 4 },
  { label: '1d', hours: 24 },
  { label: '2d', hours: 48 },
  { label: '5d', hours: 120 },
  { label: '7d', hours: 168 },
  { label: '15d', hours: 360 },
  { label: '30d', hours: 720 },
];

// The History tab — unlike Live (streams from Docker right now) and
// Clustered (re-scans a live tail on demand, no memory of anything older
// than that tail), this reads from ClickHouse's own stored pattern
// history, so it's the only one of the three that can answer "what
// happened over the last N days" with an actual, retention-backed
// guarantee instead of "however much Docker happened to still have". That
// only works once someone has explicitly opted this service into it — see
// server.js's "Log pattern storage" section for the full trade-off (a
// real second copy of data, on purpose small — clustered patterns, not
// raw lines — but never a space SAVINGS) — so this renders the opt-in
// prompt with that trade-off spelled out until it's turned on.
function HistoryLogs({ serviceName }) {
  const [status, setStatus] = useState(null); // 'loading' | 'off' | 'on' | 'toggling'
  const [retentionHours, setRetentionHours] = useState(null);
  const [rangeHours, setRangeHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Learn both "is this on" and "how far back is actually kept" up front —
  // the history endpoint itself reports `enabled`, and the retention
  // endpoint is what bounds the range picker's own options below.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    Promise.all([api.logPatternHistory(serviceName), api.logRetentionConfig()])
      .then(([hist, retention]) => {
        if (cancelled) return;
        setStatus(hist.enabled ? 'on' : 'off');
        setRetentionHours(retention.hours);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  useEffect(() => {
    if (status !== 'on') return undefined;
    let cancelled = false;
    api
      .logPatternHistory(serviceName, rangeHours)
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName, status, rangeHours]);

  async function enable() {
    setStatus('toggling');
    try {
      await api.setLogStorage(serviceName, true);
      setStatus('on');
    } catch (err) {
      setError(err.message);
      setStatus('off');
    }
  }

  async function disable() {
    setStatus('toggling');
    try {
      await api.setLogStorage(serviceName, false);
      setStatus('off');
      setData(null);
    } catch (err) {
      setError(err.message);
      setStatus('on');
    }
  }

  if (status === 'loading' || status === null) {
    return <div className="text-[13px] text-muted">checking log storage status…</div>;
  }

  if (status === 'off' || status === 'toggling') {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[13px] text-ink-dim">
          Off by default. This tab reads from Docker's live logs directly, same as Live/Clustered — nothing about
          podotype stores log data anywhere. Turning this on for <span className="font-semibold text-ink">{serviceName}</span>{' '}
          starts a SECOND, small copy — clustered patterns, not raw lines — kept independently in ClickHouse so
          history survives a restart and time-range search actually means something. This is genuinely{' '}
          <span className="font-semibold text-ink">additional disk usage on top of</span> whatever Docker's own logs
          already use, not a replacement for them or a way to reduce it.
        </div>
        <button
          type="button"
          onClick={enable}
          disabled={status === 'toggling'}
          className="self-start text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3 py-1.5 disabled:opacity-50"
        >
          {status === 'toggling' ? 'Enabling…' : `Enable log storage for ${serviceName}`}
        </button>
        {error && <div className="text-[12px] text-down">{error}</div>}
      </div>
    );
  }

  const options = LOG_HISTORY_RANGE_PRESETS.filter((p) => retentionHours === null || p.hours <= retentionHours);
  if (options.length === 0 && retentionHours !== null) options.push({ label: `${retentionHours}h`, hours: retentionHours });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted">Storing patterns for this service.</span>
        <select
          value={rangeHours}
          onChange={(e) => setRangeHours(Number(e.target.value))}
          className="bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[12px] text-ink"
        >
          {options.map((o) => (
            <option key={o.hours} value={o.hours}>
              last {o.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={disable} className="link-btn text-[11px] text-muted hover:text-down ml-auto">
          Disable
        </button>
      </div>

      {error && <div className="text-[13px] text-down">{error}</div>}
      {!error && !data && <div className="text-[13px] text-muted">loading stored history…</div>}
      {data && data.hoursUsed !== null && data.hoursUsed < data.hoursRequested && (
        <div className="text-[11px] text-slow">
          Showing the last {data.hoursUsed}h — that's your current log retention, shorter than the {data.hoursRequested}h
          range you picked.
        </div>
      )}
      {data && data.clusters && data.clusters.length === 0 && (
        <div className="text-[13px] text-muted">no stored patterns in this window yet</div>
      )}
      {data && data.clusters && data.clusters.length > 0 && (
        <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
          {data.clusters.map((c) => (
            <div key={c.template} className="bg-panel rounded border border-border-soft px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[c.level] || 'bg-muted'}`} />
                <span className="font-mono text-[12px] font-bold text-ink shrink-0">×{c.count}</span>
                <span className={`font-mono text-[12px] [overflow-wrap:anywhere] ${LEVEL_TEXT[c.level] || 'text-ink-dim'}`}>
                  {c.template}
                </span>
                {c.lastTs && (
                  <span className="font-mono text-[11px] text-muted ml-auto shrink-0">
                    last {new Date(`${c.lastTs}Z`).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="font-mono text-[11px] text-muted mt-0.5 pl-3.5 [overflow-wrap:anywhere]">{c.sample}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Live tail via Server-Sent Events (server.js's "/api/services/:name/logs/stream")
// — new lines appear the moment they're written, same as `docker logs -f` or
// Grafana's Live view, instead of re-fetching a fixed "last N lines" slice on
// a timer. Deliberately collapsed by default and only connects once opened —
// a raw log tail is a deep-dive someone opens for ONE row at a time, and
// holding a live connection open for every collapsed row in the background
// would be pure waste. See MetricsPanel for the same collapsed-by-default
// shape.
//
// storageStatus (passed down from App.jsx's own /api/status poll) exists
// only to explain a real, confusing failure mode: when the HOST disk is
// completely full, this panel goes static — same lines forever, no error,
// nothing to fix in this component. That's not a bug in the SSE mechanism
// (verified working correctly, see the session's other notes); it's
// upstream of it. This container's own stdout/stderr is captured by
// Docker's default json-file logging driver, which writes to a file under
// /var/lib/docker on the HOST's root filesystem — the same filesystem
// Tempo's storage watchdog (see server.js "Storage watchdog") already
// monitors. When that filesystem hits 100%, Docker itself can't persist
// new log lines at all, so there's nothing new for `docker logs --follow`
// (what streamContainerLogs tails) to ever relay — the stream stays open
// and healthy, it just has nothing to send. Surfacing storage status here
// turns "logs silently froze, is this broken?" into an understood,
// labeled condition instead of a second bug report for the same root
// cause as the disk-full incident itself.
export default function LogsPanel({ serviceName, storageStatus }) {
  // Defaults OPEN. This panel's collapse/expand toggle predates the
  // horizontal-tabs redesign (see WatchedRow's TABS) — back when every
  // panel sat in one long vertical stack, collapsed-by-default kept the
  // page from being a wall of live-tailing panels. Now LogsPanel only
  // even mounts while WatchedRow's own "Logs" tab is the active one, so
  // clicking that tab IS the "I want to see logs" signal — a second,
  // separate "View" click here just to see the thing you already asked
  // for was the exact "small button" bug reported. The toggle stays (see
  // the "Hide" button below) for anyone who wants to stop the live tail
  // without leaving the tab, but it no longer gates the first view.
  const [expanded, setExpanded] = useState(true);
  // 'live' (existing SSE tail) or 'clusters' (grouped-by-pattern view, see
  // ClusteredLogs above) — a person switching to clusters isn't asking for
  // live streaming AND clustering at once, so the live connection only
  // opens in 'live' mode (see the effect below's `mode === 'live'` guard),
  // same "don't hold a connection open for a view that isn't shown" idea
  // this panel already applies to the collapsed state as a whole.
  const [mode, setMode] = useState('live');
  const [lines, setLines] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const boxRef = useRef(null);

  // Basic log search — see server.js's own comment on
  // /api/services/:name/logs/search for the split this mirrors: `query`
  // filters whatever's already in the live buffer INSTANTLY (client-side,
  // no request), while `deepSearch` is an explicit, on-demand call for
  // anything further back than that buffer covers. Two different searches
  // over two different windows of data, not one search that's sometimes
  // fast and sometimes slow for reasons a user can't see.
  const [query, setQuery] = useState('');
  const [deepSearch, setDeepSearch] = useState(null); // { loading, error, result } | null

  useEffect(() => {
    if (!expanded || mode !== 'live') return undefined;
    setLines([]);
    setError(null);
    setConnected(false);

    const es = new EventSource(
      `/api/services/${encodeURIComponent(serviceName)}/logs/stream?tail=${LOG_INITIAL_TAIL}`
    );
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // malformed frame — skip rather than crash the tail
      }
      setLines((prev) => {
        const next = prev.length >= LOG_MAX_LINES_KEPT ? prev.slice(prev.length - LOG_MAX_LINES_KEPT + 1) : prev;
        return [...next, parsed];
      });
    };
    es.addEventListener('error', (ev) => {
      try {
        const body = JSON.parse(ev.data);
        if (body && body.error) setError(body.error);
      } catch {
        // a plain connection drop, not a server-sent error event — EventSource
        // will retry on its own; just reflect "not connected" meanwhile
      }
      setConnected(false);
    });
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [expanded, mode, serviceName]);

  // Reset search state on a mode switch (or if this row somehow gets
  // reused for a different service) — a stale query/deep-search result
  // left over from Clustered mode, or from a previous service, would be
  // actively misleading sitting in Live mode.
  useEffect(() => {
    setQuery('');
    setDeepSearch(null);
  }, [mode, serviceName]);

  async function runDeepSearch() {
    const q = query.trim();
    if (!q) return;
    setDeepSearch({ loading: true, error: null, result: null });
    try {
      const result = await api.searchLogs(serviceName, q);
      setDeepSearch({ loading: false, error: null, result });
    } catch (err) {
      setDeepSearch({ loading: false, error: err.message, result: null });
    }
  }

  // Newest line on top, oldest at the bottom — the Grafana Live-tail
  // convention people expect coming from that tool, rather than a plain
  // terminal's oldest-on-top/newest-at-bottom order. `lines` itself still
  // accumulates oldest-to-newest (simplest to append to); only the render
  // below reverses it for display.
  //
  // Pinning follows the same flip: stay pinned to the TOP as fresh lines
  // arrive (that's where the newest one now renders), but only while
  // already scrolled near the top, so someone scrolled down to read older
  // lines isn't yanked back up.
  useEffect(() => {
    if (!boxRef.current) return;
    const el = boxRef.current;
    const nearTop = el.scrollTop < 60;
    if (nearTop) el.scrollTop = 0;
  }, [lines]);

  // Client-side filter over whatever's already in the buffer — instant, no
  // request, but only as deep as this tab's own SSE connection has seen
  // since it opened. "Search older logs too" (below) is the escape hatch
  // for anything before that.
  const filteredLines = query.trim()
    ? lines.filter((l) => l.line && l.line.toLowerCase().includes(query.trim().toLowerCase()))
    : lines;

  return (
    <div className="bg-panel-recessed border border-border-soft rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft text-[12px] font-bold uppercase tracking-wider text-muted">
        <span className="inline-flex items-center gap-1.5">
          Logs
          <InfoDot title="Live tail of this container's own stdout/stderr, unfiltered — new lines appear as they're written, the same as `docker logs -f` or Grafana's Live view. Clustered groups a larger recent tail into recurring line shapes instead, so a noisy repeating message doesn't bury anything different. Only fetches/streams while this section is open." />
          {expanded && mode === 'live' && (
            <span className={`normal-case font-normal text-[11px] ${connected ? 'text-accent' : 'text-muted'}`}>
              {connected ? '● live' : 'connecting…'}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {expanded && (
            <div className="flex items-center rounded border border-border-soft overflow-hidden text-[11px] normal-case font-semibold">
              <button
                type="button"
                onClick={() => setMode('live')}
                className={`px-2 py-0.5 ${mode === 'live' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}
              >
                Live
              </button>
              <button
                type="button"
                onClick={() => setMode('clusters')}
                className={`px-2 py-0.5 ${mode === 'clusters' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}
              >
                Clustered
              </button>
              <button
                type="button"
                onClick={() => setMode('history')}
                className={`px-2 py-0.5 ${mode === 'history' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}
                title="Stored pattern history — opt-in, see the History tab itself for the trade-off"
              >
                History
              </button>
            </div>
          )}
          <button type="button" onClick={() => setExpanded((v) => !v)} className="link-btn text-accent text-[12px]">
            {expanded ? '⌃ Hide' : 'View ⌄'}
          </button>
        </div>
      </div>

      {expanded && mode === 'clusters' && (
        <div className="px-2.5 py-2">
          <ClusteredLogs serviceName={serviceName} />
        </div>
      )}

      {expanded && mode === 'history' && (
        <div className="px-2.5 py-2">
          <HistoryLogs serviceName={serviceName} />
        </div>
      )}

      {expanded && mode === 'live' && (
        <div className="px-2.5 py-2">
          {storageStatus === 'critical' && (
            <div className="text-[12px] text-slow mb-1.5">
              Disk space is critical — Docker can't persist new log lines right now, so this may look frozen even
              though the stream itself is connected. Not a bug here; see the Disk space banner above.
            </div>
          )}

          <div className="flex items-center gap-1.5 mb-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter this buffer…"
              className="flex-1 min-w-0 bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[12px] text-ink"
            />
            {query.trim() && (
              <button
                type="button"
                onClick={runDeepSearch}
                disabled={Boolean(deepSearch && deepSearch.loading)}
                className="shrink-0 text-[12px] font-semibold text-ink bg-panel-raised border border-border hover:border-accent hover:text-accent rounded px-2 py-1 disabled:opacity-50"
                title="This box only filters what's already arrived since you opened this tab — search a bigger recent history on the container itself instead"
              >
                {deepSearch && deepSearch.loading ? 'Searching…' : 'Search older logs too'}
              </button>
            )}
          </div>

          {error && <div className="text-[13px] text-down">{error}</div>}
          {!error && lines.length === 0 && <div className="text-[13px] text-muted">waiting for log lines…</div>}
          {lines.length > 0 && (
            <div
              ref={boxRef}
              className="max-h-64 overflow-y-auto bg-panel rounded border border-border-soft px-2 py-1.5 flex flex-col gap-0.5"
            >
              {filteredLines.length === 0 && (
                <div className="text-[12px] text-muted">no lines in the current buffer match "{query}"</div>
              )}
              {[...filteredLines].reverse().map((l, i) => (
                <div key={`${l.ts || ''}-${i}`} className="font-mono text-[12px] leading-snug [overflow-wrap:anywhere] flex gap-2">
                  {l.ts && <span className="text-muted shrink-0">{new Date(l.ts).toLocaleTimeString()}</span>}
                  <span className="text-ink-dim">{l.line}</span>
                </div>
              ))}
            </div>
          )}

          {deepSearch && (
            <div className="mt-2 border-t border-border-soft pt-2">
              {deepSearch.loading && <div className="text-[12px] text-muted">searching recent container logs…</div>}
              {deepSearch.error && <div className="text-[13px] text-down">{deepSearch.error}</div>}
              {deepSearch.result && (
                <>
                  <div className="text-[11px] text-muted mb-1">
                    {deepSearch.result.matchCount} match{deepSearch.result.matchCount === 1 ? '' : 'es'} across the last{' '}
                    {deepSearch.result.linesExamined} lines
                    {deepSearch.result.truncated ? ` (showing the ${deepSearch.result.matches.length} most recent)` : ''}
                  </div>
                  {deepSearch.result.matches.length > 0 && (
                    <div className="max-h-56 overflow-y-auto bg-panel rounded border border-border-soft px-2 py-1.5 flex flex-col gap-0.5">
                      {[...deepSearch.result.matches].reverse().map((l, i) => (
                        <div key={`${l.ts || ''}-${i}`} className="font-mono text-[12px] leading-snug [overflow-wrap:anywhere] flex gap-2">
                          {l.ts && <span className="text-muted shrink-0">{new Date(l.ts).toLocaleTimeString()}</span>}
                          <span className="text-ink-dim">{l.line}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
