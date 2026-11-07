import { useEffect, useState } from 'react';
import InfoDot from './InfoDot.jsx';
import ChartPanel from './charts/ChartPanel.jsx';
import MultiSeriesChartPanel from './charts/MultiSeriesChartPanel.jsx';
import TraceExplorer from './TraceExplorer.jsx';
import PossibleCauseCard from './PossibleCauseCard.jsx';
import { api } from '../api.js';

// Same cadence ResourceHealthPanel already polls metrics-history at — no
// reason to poll latency history faster than the server-side sampler
// (ALERT_EVAL_INTERVAL_MS, 15s) that actually produces new points.
const LATENCY_HISTORY_POLL_MS = 20000;

// One panel, not two, and nothing here needs a second click to see. Earlier
// this was split into "Tracing" and "eBPF (Beyla)" as separate bordered
// boxes side by side, each with its own collapse chevron you had to click
// after already clicking "Configure monitoring" to get here — two clicks
// deep before you saw a single span, plus scanning two mostly-identical
// boxes to figure out which one actually had your data. Real tools in this
// space don't nest accordions like that: Datadog's APM service page and
// Grafana's dashboards both put the live numbers right where you land, one
// click deep at most, and only ask you to pick a specific trace when you
// want ITS breakdown (which is a real choice, not busywork). This panel
// copies that: both instrumentation sources get one plain-text status line
// each, always visible, and whichever one actually has data shows its
// trace list immediately below — no expand button guarding it.
//
// The two sources stay named for what they ARE, not what produces them
// (nobody watching this needs to know Grafana Beyla or eBPF by name to
// understand "automatic, lighter" vs "opt-in, deeper"):
//   - Spans: automatic, zero-touch, from the always-on eBPF watcher (see
//     docker-compose.yml). Server-tagged trace.source === 'beyla'.
//   - Code Tracing: opt-in, needs the generated compose override applied,
//     deeper (code-level) spans. Server-tagged trace.source === 'agent'.
// Only one shows real data at a time by construction (server.js prefers a
// same-name hit, i.e. Code Tracing, over the Beyla-resolved fallback) — see
// server.js's trace.source comment.
export default function TracesPanel({
  svc,
  cfg,
  // Default true — both builds support Code Tracing now (hosted's agent
  // receives OTLP directly over its own local listener, see
  // otelOverride.js's header comment), so this only ever goes false for a
  // genuinely unsupported deployment shape, not as a per-build toggle
  // anymore.
  supportsCodeTracing = true,
}) {
  const trace = svc.trace;
  const red = svc.red;
  const codeTracingSetup = Boolean(cfg.otel && cfg.otel.enabled);
  const hasSpansData = Boolean(trace && trace.source === 'beyla');
  const hasCodeTracingData = Boolean(trace && trace.source === 'agent');

  // Golden Signals — Requests, Errors, Latency, charted together, the same
  // trio groundcover/Datadog/Grafana all put at the top of a traces view.
  // One fetch covers all three: `requests` (rate + error-rate history) and
  // `latency` (p50/p95/p99 history) are both already on the same
  // metrics-history response — ResourceHealthPanel.jsx's Health tab reads
  // `requests` from here too, and `latency` is the field TracesPanel added
  // itself (see that field's backend comment). Shared by both the Spans
  // and Code Tracing lines below: whichever one has live data is reading
  // the same service's latency either way, so one fetch covers both.
  const [history, setHistory] = useState(null);
  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .metricsHistory(svc.name)
        .then((body) => {
          if (!cancelled) setHistory(body || {});
        })
        .catch(() => {
          if (!cancelled) setHistory({});
        });
    }
    tick();
    const id = setInterval(tick, LATENCY_HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [svc.name]);
  const p95Points = history && history.latency ? history.latency.map((p) => ({ t: p.t, v: p.p95Ms })) : [];
  const latencyRows = history && history.latency ? history.latency.map((p) => ({ t: p.t, p50: p.p50Ms, p95: p.p95Ms, p99: p.p99Ms })) : [];
  const LATENCY_SERIES = [
    { key: 'p50', label: 'p50', color: 'var(--color-series-1)' },
    { key: 'p95', label: 'p95', color: 'var(--color-series-2)' },
    { key: 'p99', label: 'p99', color: 'var(--color-series-8)' },
  ];
  const reqRatePoints = history && history.requests ? history.requests.map((p) => ({ t: p.t, v: p.requestsPerSec })) : [];
  const errRatePoints = history && history.requests ? history.requests.map((p) => ({ t: p.t, v: p.errorRate * 100 })) : [];
  function enoughPoints(arr) {
    return arr.filter((p) => p.v !== null && p.v !== undefined && Number.isFinite(p.v)).length >= 2;
  }
  const hasGoldenSignals = enoughPoints(reqRatePoints) || enoughPoints(errRatePoints) || enoughPoints(p95Points);
  function lastValue(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].v !== null && arr[i].v !== undefined && Number.isFinite(arr[i].v)) return arr[i].v;
    }
    return undefined;
  }
  // p50/p95/p99 together, not p95 alone — p95 by itself can hide a bad
  // tail (a service that's fast MOST of the time but has occasional
  // multi-second outliers looks fine on p95 and bad only on p99), same
  // reasoning Datadog/Grafana/New Relic all show at least this trio for.
  function fmtMs(v) {
    return v !== null && v !== undefined ? `${Math.round(v)}ms` : '—';
  }
  const p95Text = fmtMs(trace && trace.p95Ms);
  const latencyText = trace ? `p50 ${fmtMs(trace.p50Ms)} · p95 ${fmtMs(trace.p95Ms)} · p99 ${fmtMs(trace.p99Ms)}` : p95Text;
  // Rate + error-rate — the other two thirds of RED, from Beyla's own
  // request counters rather than Tempo (see server.js's "RED metrics"
  // comment for why: Tempo's search endpoint only sees a capped slice of
  // recent traces, not every request). Independent of trace.source/which
  // panel line has data above — this reflects every request Beyla saw for
  // this container, whether or not that request also produced a trace
  // either instrumentation source kept.
  const rateText = red ? `${red.requestsPerSec < 0.1 ? red.requestsPerSec.toFixed(2) : red.requestsPerSec.toFixed(1)}/s` : null;
  const errorPct = red ? Math.round(red.errorRate * 100) : null;

  // Ingestion/volume — distinct from Requests above: that's business
  // traffic (Beyla-observed requests), this is raw telemetry volume
  // actually landing in storage right now — spans/sec into the traces
  // table and logs/sec into the logs table, independent signals that can
  // diverge a lot from request rate (one request can fan out into many
  // spans; log volume has nothing to do with request volume at all).
  const ingestion = svc.ingestion;
  function fmtRate(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return v < 0.1 && v > 0 ? v.toFixed(2) : v.toFixed(1);
  }
  const spansRateText = ingestion ? fmtRate(ingestion.spansPerSec) : null;
  const logsRateText = ingestion ? fmtRate(ingestion.logsPerSec) : null;

  return (
    <div className="bg-panel-recessed border border-border-soft rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft text-[12px] font-bold uppercase tracking-wider text-muted">
        <span className="inline-flex items-center gap-1.5">
          Traces
          <InfoDot title="Two independent ways this service's requests can show up here: Spans (automatic, always on, no setup — a shared host-wide watcher captures shallower process-boundary spans for every container) and Code Tracing (opt-in, needs a small compose-file addition, deeper code-level spans via a real OpenTelemetry agent). Whichever one actually has data for this service shows its trace list below." />
        </span>
      </div>

      <div className="px-2.5 py-2 flex flex-col gap-2.5">
        {hasGoldenSignals && (
          <div className="flex gap-3 flex-wrap pb-2.5 border-b border-border-soft">
            <ChartPanel
              label="Requests/sec"
              points={reqRatePoints}
              color="rgb(var(--color-accent))"
              currentText={lastValue(reqRatePoints) !== undefined ? lastValue(reqRatePoints).toFixed(1) : '—'}
              valueFormatter={(v) => v.toFixed(1)}
              height={180}
              infoTitle="Every request Beyla's eBPF watcher saw for this container, charted over time."
            />
            <ChartPanel
              label="Error rate"
              points={errRatePoints}
              color={lastValue(errRatePoints) > 0 ? 'rgb(var(--color-down))' : 'rgb(var(--color-accent))'}
              tone={lastValue(errRatePoints) > 0 ? 'text-down' : undefined}
              currentText={lastValue(errRatePoints) !== undefined ? `${lastValue(errRatePoints).toFixed(1)}%` : '—'}
              unit="%"
              valueFormatter={(v) => `${v.toFixed(0)}%`}
              height={180}
              infoTitle="Share of requests that came back with a 5xx status, charted over time."
            />
            <MultiSeriesChartPanel
              label="Latency (p50 / p95 / p99)"
              data={latencyRows}
              series={LATENCY_SERIES}
              unit="ms"
              valueFormatter={(v) => `${Math.round(v)}ms`}
              height={180}
              infoTitle="The full latency distribution, not just one percentile — p99 shows the tail a p95-only chart can hide."
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-mono text-[12px] text-muted">
            <span className="text-ink-dim font-semibold">Requests</span> (rate/errors) —{' '}
            {svc.up === false ? (
              'container not running'
            ) : red ? (
              <span className={errorPct > 0 ? 'text-slow' : 'text-accent'}>
                {rateText} · {errorPct}% errors
              </span>
            ) : (
              'no data in the last few minutes yet'
            )}
            <InfoDot title="Every request Beyla's eBPF watcher saw for this container, counted directly — not limited to the handful of traces shown below. Rate is requests/sec over the last ~15s; errors are the share of those with a 5xx status." />
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-mono text-[12px] text-muted">
            <span className="text-ink-dim font-semibold">Ingestion</span> (volume) —{' '}
            {spansRateText || logsRateText ? (
              <span className="text-ink-dim">
                {spansRateText !== null ? `${spansRateText} spans/s` : 'no spans'}
                {' · '}
                {logsRateText !== null ? `${logsRateText} logs/s` : 'log storage off'}
              </span>
            ) : (
              'no telemetry stored in the last minute'
            )}
            <InfoDot title="How much telemetry is actually being stored for this service right now, separate from request rate above — spans/sec written to the trace store, and logs/sec written to the log store (only counted when this service has log storage turned on)." />
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-mono text-[12px] text-muted">
            <span className="text-ink-dim font-semibold">Spans</span> (automatic) —{' '}
            {hasSpansData ? (
              <span className="text-accent">{latencyText} · {trace.status === 'recent' ? 'live' : 'idle'}</span>
            ) : hasCodeTracingData ? (
              'quiet — Code Tracing below is live instead'
            ) : (
              'no data in the last few minutes yet'
            )}
          </span>
        </div>

        {supportsCodeTracing ? (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-mono text-[12px] text-muted">
              <span className="text-ink-dim font-semibold">Code Tracing</span> (opt-in) —{' '}
              {!codeTracingSetup ? (
                // Read-only now — turning this on/off, and picking the
                // language, only ever happens from the dedicated Code
                // Tracing page (see Sidebar.jsx) now, not a native
                // window.prompt dialog triggered from in here. See that
                // page's own header comment for why this moved.
                'off — manage from Code Tracing in the sidebar'
              ) : hasCodeTracingData ? (
                <span className="text-accent">{latencyText} · {trace.status === 'recent' ? 'live' : 'idle'}</span>
              ) : (
                'enabled — waiting for its first spans'
              )}
            </span>
            {codeTracingSetup && (
              <span className="font-mono text-[12px] text-muted shrink-0">set up as {cfg.otel.language}</span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[12px] text-muted">
              <span className="text-ink-dim font-semibold">Code Tracing</span> (opt-in) — not available for hosted
              deployments yet — Spans above already cover this service automatically
            </span>
          </div>
        )}

        {(hasSpansData || hasCodeTracingData) && (
          <div className="pt-1 border-t border-border-soft">
            <PossibleCauseCard serviceName={svc.name} />
            <TraceExplorer serviceName={svc.name} />
          </div>
        )}
      </div>
    </div>
  );
}
