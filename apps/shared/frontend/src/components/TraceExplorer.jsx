import { useEffect, useState } from 'react';
import TraceWaterfall from './TraceWaterfall.jsx';
import CriticalPathStrip from './CriticalPathStrip.jsx';
import TraceLogsPanel from './TraceLogsPanel.jsx';
import TimeRangePicker, { formatRangeMinutes } from './TimeRangePicker.jsx';
import { api } from '../api.js';

// How often the trace list re-fetches while it's mounted — matches
// App.jsx's own poll cadence so "live" means the same thing everywhere.
const TRACE_POLL_MS = 5000;

// How many rows show before needing a click — hosted's recentTraces can
// return up to 50 (see apps/hosted/license-server/clickhouse.js), and self-hosted's
// engine caps at 8 server-side, but neither of those numbers is a UI
// decision: the panel itself should decide how much to show at once
// regardless of how many the datasource handed it. 50 rows of health-check
// (or now, chattier dummy-stack) traces was pushing this panel to occupy
// the whole screen — capped here instead, with a plain "show N more" to
// expand, same idea as LogsPanel's own tail-length cap.
const TRACE_LIST_PAGE_SIZE = 15;

// EVERY selected range is a rolling window that keeps auto-refreshing to
// "now" — same model Grafana/Datadog/Honeycomb all use: picking "Last 5m"
// doesn't freeze a snapshot, it means "show me the last 5 minutes, and
// keep sliding that forward." There's no separate frozen/historical mode
// any more — see the polling effect below, which now runs its interval
// unconditionally instead of only when rangeMinutes was null.
//
// Merges a fresh poll's result into what's already on screen instead of
// replacing it outright, so a single poll that happens to land on a quiet
// moment doesn't blank the list out from under someone. Fresh entries win
// on a traceId collision (latest status/duration); anything from the
// previous fetch that isn't in the fresh one is kept only as long as it's
// still inside THIS range (rangeMinutes, in ms) — once a trace ages past
// the selected window's edge it's supposed to drop off, same as it would
// in Grafana. The combined list is re-sorted slowest-first to match what
// the backend itself returns.
function mergeLiveTraces(prevTraces, freshTraces, rangeMinutes) {
  const byId = new Map();
  for (const t of prevTraces || []) byId.set(t.traceId, t);
  for (const t of freshTraces || []) byId.set(t.traceId, t);
  const windowMs = (rangeMinutes || DEFAULT_RANGE_MINUTES) * 60 * 1000;
  const cutoffNs = BigInt(Date.now() - windowMs) * 1000000n;
  return Array.from(byId.values())
    .filter((t) => {
      if (!t.startTimeUnixNano) return true;
      try {
        return BigInt(t.startTimeUnixNano) >= cutoffNs;
      } catch {
        return true;
      }
    })
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
}

// Default window on first load — no more "Live" option with an
// undocumented backend-side default window (self-hosted's own 5-minute
// LOOKBACK_SECONDS vs. hosted's much wider full-retention query used to
// mean the exact same button showed a different amount of history
// depending which build you were on). Picking a real, visible range here
// means the picker's label always says exactly what's on screen.
const DEFAULT_RANGE_MINUTES = 15;

// Duration alone doesn't say WHEN a trace happened — sorted slowest-first,
// a list of durations looks identical whether every trace is from the last
// second or from ten minutes ago, and that distinction matters once a
// service goes idle. startTimeUnixNano already comes back from Tempo in
// every trace (see server.js's recentTraceList); this was just never
// rendered. Same toLocaleTimeString() convention already used for log
// lines (LogsPanel) and the "Updated HH:MM:SS" footer (App.jsx), so a
// timestamp means the same thing everywhere on this page.
function formatTraceTime(startTimeUnixNano) {
  if (!startTimeUnixNano) return null;
  try {
    const ms = Number(BigInt(startTimeUnixNano) / 1000000n);
    return new Date(ms).toLocaleTimeString();
  } catch {
    return null;
  }
}

// "Show this service's recent traces, click one to see its waterfall" —
// used by TracesPanel for whichever instrumentation source (Spans or Code
// Tracing) actually has data right now, per server.js's trace.source
// tagging. Deliberately has no collapsed state of its own: the parent only
// mounts this once there's real data to show, so from the moment it
// appears everything here is visible immediately — no extra click to open
// it, matching how Datadog's APM service page and Grafana's dashboards
// put live numbers where you land instead of behind another accordion.
// The one thing that DOES need a click is picking a specific trace to see
// its span breakdown — that's a real choice (which request?), not
// busywork, so it stays click-to-select.
export default function TraceExplorer({ serviceName }) {
  const [traces, setTraces] = useState(null);
  const [hiddenHealthCheckCount, setHiddenHealthCheckCount] = useState(0);
  const [tracesError, setTracesError] = useState(null);
  const [selectedTraceId, setSelectedTraceId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  // Off by default — health checks are noisy background traffic most people
  // don't want crowding the list. Flipping this on asks the server to skip
  // the health-check filter entirely (e.g. to confirm Docker's HEALTHCHECK
  // is actually firing), rather than just unhiding a client-side subset.
  const [showHealthChecks, setShowHealthChecks] = useState(false);
  // "Clear" doesn't touch Tempo and doesn't stop polling — it just records a
  // watermark (a point in time) and hides anything at-or-before it from the
  // list. Polling keeps running underneath, so a trace that starts *after*
  // you hit Clear shows up on its own, same as before you ever cleared
  // anything. BigInt because these are nanosecond unix timestamps as
  // strings — well past what a JS number can hold precisely.
  const [clearedBeforeNs, setClearedBeforeNs] = useState(null);
  // Resets to the first page whenever the underlying list changes identity
  // (new service, health-check toggle, a Clear/Refresh) — see the effect
  // below. Kept separate from the traces/showHealthChecks state itself so
  // "show more" doesn't fight with the poll re-fetching every 5s.
  const [visibleCount, setVisibleCount] = useState(TRACE_LIST_PAGE_SIZE);
  // A rolling window size, in minutes (see DEFAULT_RANGE_MINUTES) — always
  // "the last N minutes up to right now", kept current by the poll below
  // regardless of which N is picked. There's no separate frozen/historical
  // mode any more: selecting "Last 7d" doesn't take a snapshot, it just
  // means the rolling window is wider, exactly like Grafana's own relative
  // time ranges.
  const [rangeMinutes, setRangeMinutes] = useState(DEFAULT_RANGE_MINUTES);

  function loadTraces() {
    setTracesError(null);
    const until = new Date();
    const since = new Date(until.getTime() - rangeMinutes * 60 * 1000);
    const opts = { includeHealthChecks: showHealthChecks, since: since.toISOString(), until: until.toISOString() };
    api
      .recentTraces(serviceName, opts)
      .then((body) => {
        setTraces((prev) => mergeLiveTraces(prev, body.traces, rangeMinutes));
        setHiddenHealthCheckCount(body.hiddenHealthCheckCount || 0);
      })
      .catch((err) => setTracesError(err.message));
  }

  // Fetches immediately on mount (or whenever showHealthChecks changes),
  // then keeps re-fetching on an interval for as long as this stays
  // mounted — same idea as the top-level status poll, just scoped to this
  // one service's trace list.
  useEffect(() => {
    let cancelled = false;
    setVisibleCount(TRACE_LIST_PAGE_SIZE);

    function tick() {
      const until = new Date();
      const since = new Date(until.getTime() - rangeMinutes * 60 * 1000);
      const opts = { includeHealthChecks: showHealthChecks, since: since.toISOString(), until: until.toISOString() };
      api
        .recentTraces(serviceName, opts)
        .then((body) => {
          if (cancelled) return;
          // Merge rather than overwrite, so a poll that happens to catch a
          // quiet moment doesn't blank out traces that are still inside
          // the selected window (see mergeLiveTraces above).
          setTraces((prev) => mergeLiveTraces(prev, body.traces, rangeMinutes));
          setHiddenHealthCheckCount(body.hiddenHealthCheckCount || 0);
          setTracesError(null);
        })
        .catch((err) => {
          if (!cancelled) setTracesError(err.message);
        });
    }

    tick();
    // Every range now keeps polling — a wider range (say 7d) just means
    // each poll re-fetches a wider window, same idea as any short one,
    // rather than treating "not live" as "fetch once and stop".
    const id = setInterval(tick, TRACE_POLL_MS);
    // See App.jsx's own poll effect for why this exists: confirmed directly
    // on this project that a backgrounded tab (document.hidden === true)
    // can silently stop this setInterval from firing at its normal cadence
    // — the trace list froze on real data for minutes while RED
    // metrics/health kept advancing and the EventSource-driven Logs panel
    // in the SAME tab kept updating live, because push-based EventSource
    // messages aren't throttled the same way JS timers are. Refetching the
    // instant the tab becomes visible again means coming back to it always
    // shows current data, instead of stale numbers sitting there looking
    // like a hang.
    const onVisible = () => {
      if (!cancelled && !document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // loadTraces (used by the Refresh button) is intentionally not in this
    // effect's deps — it's stable enough for this purpose and re-adding it
    // would just re-trigger this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceName, showHealthChecks, rangeMinutes]);

  // What's actually shown: everything fetched, minus whatever's at-or-older
  // than the last Clear watermark. A trace missing a timestamp (shouldn't
  // happen, but Tempo's payload isn't a contract) is kept rather than
  // silently dropped.
  const visibleTraces =
    traces && clearedBeforeNs !== null
      ? traces.filter((t) => {
          if (!t.startTimeUnixNano) return true;
          try {
            return BigInt(t.startTimeUnixNano) > clearedBeforeNs;
          } catch {
            return true;
          }
        })
      : traces;

  function toggleShowHealthChecks() {
    setShowHealthChecks((prev) => !prev);
    setSelectedTraceId(null);
    setSelectedDetail(null);
  }

  function clearTraces() {
    setClearedBeforeNs(BigInt(Date.now()) * 1000000n);
    setSelectedTraceId(null);
    setSelectedDetail(null);
    setVisibleCount(TRACE_LIST_PAGE_SIZE);
  }

  function refreshTraces() {
    setClearedBeforeNs(null);
    setSelectedTraceId(null);
    setSelectedDetail(null);
    setVisibleCount(TRACE_LIST_PAGE_SIZE);
    loadTraces();
  }

  async function selectTrace(traceId) {
    if (selectedTraceId === traceId) {
      setSelectedTraceId(null);
      setSelectedDetail(null);
      return;
    }
    setSelectedTraceId(traceId);
    setSelectedDetail(null);
    try {
      const detail = await api.traceDetail(traceId);
      setSelectedDetail(detail);
    } catch (err) {
      setSelectedDetail({ error: err.message });
    }
  }

  function selectRange(minutes) {
    setSelectedTraceId(null);
    setSelectedDetail(null);
    setVisibleCount(TRACE_LIST_PAGE_SIZE);
    setRangeMinutes(minutes);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="font-mono text-[11px] text-muted uppercase tracking-wide">
          Traces from the last {formatRangeMinutes(rangeMinutes)}, live — click one to see which span was slow
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TimeRangePicker minutes={rangeMinutes} onChange={selectRange} allowLive={false} />
          <label className="inline-flex items-center gap-1 font-mono text-[11px] text-muted cursor-pointer select-none">
            <input type="checkbox" checked={showHealthChecks} onChange={toggleShowHealthChecks} className="accent-accent" />
            show health checks
          </label>
          <button
            type="button"
            className="link-btn text-[12px]"
            onClick={refreshTraces}
            title="Fetch now and un-clear anything hidden by Clear"
          >
            Refresh
          </button>
          <button
            type="button"
            className="link-btn text-[12px]"
            onClick={clearTraces}
            title="Hide what's currently listed — stays live, new traces still appear as they happen"
          >
            Clear
          </button>
        </div>
      </div>
      {!showHealthChecks && hiddenHealthCheckCount > 0 && (
        <div className="text-[12px] text-muted mb-1.5">
          {hiddenHealthCheckCount} health-check trace{hiddenHealthCheckCount === 1 ? '' : 's'} hidden (/actuator/health &amp;
          similar) so real requests aren't crowded out
        </div>
      )}

      {tracesError && <div className="text-[13px] text-down">{tracesError}</div>}
      {!tracesError && traces === null && <div className="text-[13px] text-muted">loading…</div>}
      {!tracesError && traces !== null && visibleTraces.length === 0 && (
        <div className="text-[13px] text-muted">
          {clearedBeforeNs !== null
            ? 'Cleared — still live, new traces will appear here as they come in.'
            : 'No recent traces to inspect yet.'}
        </div>
      )}

      {visibleTraces && visibleTraces.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {visibleTraces.slice(0, visibleCount).map((t, i) => (
            <button
              key={t.traceId}
              type="button"
              onClick={() => selectTrace(t.traceId)}
              title={`${t.rootService || ''} ${t.rootOperationLabel || t.rootOperation || ''}`.trim()}
              className={`text-left px-2 py-1 rounded font-mono text-[13px] border ${
                selectedTraceId === t.traceId ? 'border-accent bg-accent/5' : 'border-transparent hover:border-border-soft'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                {i === 0 && <span className="text-down font-bold text-[11px] shrink-0">SLOWEST</span>}
                {t.isError && <span className="pill pill-down text-[11px] shrink-0">error</span>}
                <span className="text-ink-dim [overflow-wrap:anywhere] leading-snug">
                  {/* Service and operation together, always — previously this showed
                      ONLY the operation (falling back to service only when no operation
                      existed), so every row looked the same regardless of which service
                      it belonged to unless you hovered for the title tooltip. */}
                  {t.rootService && <span className="text-muted">{t.rootService}</span>}
                  {t.rootService && (t.rootOperationLabel || t.rootOperation) ? ' · ' : ''}
                  {t.rootOperationLabel || t.rootOperation}
                </span>
                <span className="text-muted ml-auto shrink-0 flex items-center gap-2">
                  {formatTraceTime(t.startTimeUnixNano) && (
                    <span className="text-[11px] opacity-70">{formatTraceTime(t.startTimeUnixNano)}</span>
                  )}
                  {t.durationMs !== null ? `${Math.round(t.durationMs)}ms` : '—'}
                </span>
              </div>
            </button>
          ))}
          {visibleTraces.length > visibleCount && (
            <button
              type="button"
              className="link-btn text-[12px] self-start mt-1"
              onClick={() => setVisibleCount((n) => n + TRACE_LIST_PAGE_SIZE)}
            >
              Show {Math.min(TRACE_LIST_PAGE_SIZE, visibleTraces.length - visibleCount)} more (
              {visibleTraces.length - visibleCount} hidden)
            </button>
          )}
        </div>
      )}

      {selectedTraceId && (
        <>
          {selectedDetail && selectedDetail.error && <div className="text-[13px] text-down mt-2">{selectedDetail.error}</div>}
          {selectedDetail && !selectedDetail.error && (
            <>
              <CriticalPathStrip traceId={selectedTraceId} />
              <TraceWaterfall detail={selectedDetail} />
              <TraceLogsPanel traceId={selectedTraceId} />
            </>
          )}
          {!selectedDetail && <div className="text-[13px] text-muted mt-2">loading spans…</div>}
        </>
      )}
    </div>
  );
}
