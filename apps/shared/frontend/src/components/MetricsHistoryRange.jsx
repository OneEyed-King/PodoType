import { useEffect, useState } from 'react';
import ChartPanel from './charts/ChartPanel.jsx';
import InfoDot from './InfoDot.jsx';
import TimeRangePicker, { formatRangeMinutes } from './TimeRangePicker.jsx';
import { api } from '../api.js';

// Always visible once the service row itself is expanded — no second
// "View history range" click needed to even see this exists. That extra
// click used to hide history behind a collapsed toggle nested inside an
// already-collapsed row (two clicks just to find out whether history was
// available at all); no mainstream tool does that — Grafana, Datadog and
// Coroot all show a chart with its time-range control right there the
// moment you land on a panel, and only make you click to CHANGE the
// range, never to reveal that a range exists. Loads its default window
// (1h) the moment this mounts, same "fetch once expanded, not on every
// poll" reasoning as before — it just no longer waits for a second click
// to start that fetch.
const DEFAULT_RANGE_MINUTES = 60;

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function MetricsHistoryRange({ serviceName }) {
  const [rangeMinutes, setRangeMinutes] = useState(DEFAULT_RANGE_MINUTES);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function load(minutes) {
    setLoading(true);
    setError(null);
    const until = new Date();
    const since = new Date(until.getTime() - minutes * 60 * 1000);
    api
      .metricsHistoryRange(serviceName, since.toISOString(), until.toISOString())
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  // Fetches immediately on mount and whenever the range changes — the
  // click that used to gate this ("open the history section") is gone;
  // the only click left is the one that actually changes something (the
  // range picker itself).
  useEffect(() => {
    load(rangeMinutes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceName, rangeMinutes]);

  function selectRange(minutes) {
    setRangeMinutes(minutes);
  }

  const cpuPoints = data ? data.points.map((p) => ({ t: p.t, v: p.cpuPercent })) : [];
  const memPoints = data ? data.points.map((p) => ({ t: p.t, v: p.memPercent })) : [];
  const reqPoints = data && data.requests ? data.requests.map((p) => ({ t: p.t, v: p.requestsPerSec })) : [];
  const errPoints = data && data.requests ? data.requests.map((p) => ({ t: p.t, v: p.errorRate * 100 })) : [];
  function lastValue(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].v !== null && arr[i].v !== undefined && Number.isFinite(arr[i].v)) return arr[i].v;
    }
    return undefined;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-dim">
          History — last {formatRangeMinutes(rangeMinutes)}
          <InfoDot title="Container health and request-rate history for a past window, from 5 minutes to 7 days back — instead of only what's live right now. Bounded by your account's own data retention setting." />
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <TimeRangePicker minutes={rangeMinutes} onChange={selectRange} allowLive={false} />
          <button type="button" className="link-btn text-[12px]" onClick={() => load(rangeMinutes)} disabled={loading}>
            {loading ? 'loading…' : '↻ refresh'}
          </button>
        </div>
      </div>

      {error && <div className="text-[13px] text-down">{error}</div>}

      {data && !error && (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-muted">
            {formatWhen(data.since)} → {formatWhen(data.until)}
          </div>
          {data.points.length === 0 && reqPoints.length === 0 && (
            <div className="text-[13px] text-muted">No data retained for this window.</div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.points.length > 0 && (
              <>
                <ChartPanel
                  label="CPU %"
                  points={cpuPoints}
                  color="rgb(var(--color-accent))"
                  currentText={lastValue(cpuPoints) !== undefined ? `${lastValue(cpuPoints).toFixed(1)}%` : '—'}
                  unit="%"
                  valueFormatter={(v) => `${v.toFixed(0)}%`}
                  height={180}
                />
                <ChartPanel
                  label="Memory %"
                  points={memPoints}
                  color="rgb(var(--color-ink-dim))"
                  currentText={lastValue(memPoints) !== undefined ? `${lastValue(memPoints).toFixed(1)}%` : '—'}
                  unit="%"
                  valueFormatter={(v) => `${v.toFixed(0)}%`}
                  height={180}
                />
              </>
            )}
            {reqPoints.length > 0 && (
              <>
                <ChartPanel
                  label="Requests/sec"
                  points={reqPoints}
                  color="rgb(var(--color-accent))"
                  currentText={lastValue(reqPoints) !== undefined ? lastValue(reqPoints).toFixed(1) : '—'}
                  valueFormatter={(v) => v.toFixed(1)}
                  height={180}
                />
                <ChartPanel
                  label="Error rate %"
                  points={errPoints}
                  color={lastValue(errPoints) > 0 ? 'rgb(var(--color-down))' : 'rgb(var(--color-accent))'}
                  currentText={lastValue(errPoints) !== undefined ? `${lastValue(errPoints).toFixed(1)}%` : '—'}
                  unit="%"
                  valueFormatter={(v) => `${v.toFixed(0)}%`}
                  height={180}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
