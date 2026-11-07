import { useEffect, useRef, useState } from 'react';
import ChartPanel from './charts/ChartPanel.jsx';
import InfoDot from './InfoDot.jsx';
import { api } from '../api.js';

// Machine-wide (host-level) CPU/memory/load, as opposed to every other
// panel on this page which is scoped to one container. Deliberately not a
// separate page and not shown by default — this is the one thing on the
// page that isn't "your services", so it stays out of the way until asked
// for, per the same "don't make people click past things they didn't ask
// to see" reasoning TraceExplorer/MetricsHistoryRange's range pickers
// already follow. Polls at the same 20s cadence the backend itself
// samples /hostproc at (self-hosted's CONTAINER_STATS_POLL_INTERVAL_MS),
// and only while actually open — no point polling a panel nobody's
// looking at.
const POLL_MS = 20000;

function fmtPercent(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`;
}

function fmtLoad(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

function fmtBytes(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const gb = v / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = v / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

function fmtUptime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function HostStatsPanel({ rangeMinutes }) {
  // Open by default (still just a toggle, not forced) — host stats are
  // useful at a glance without an extra click, and the panel's own poll
  // below is already gated on `open` so this doesn't add any idle load
  // when someone does close it.
  const [open, setOpen] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  function load() {
    setLoading(true);
    api
      .hostStats({ minutes: rangeMinutes })
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!open) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
    // Re-fetches immediately when the Overview page's own range changes
    // (not just on open/close) — self-hosted trims its history buffer to
    // match (see server.js's GET /api/host-stats), so the sparklines
    // should reflect the newly selected window right away rather than
    // waiting for the next POLL_MS tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rangeMinutes]);

  const current = data && data.current;
  const cpuHistory = data && Array.isArray(data.history) ? data.history.map((p) => ({ t: p.t, v: p.cpuPercent })) : [];
  const memHistory = data && Array.isArray(data.history) ? data.history.map((p) => ({ t: p.t, v: p.memPercent })) : [];
  // Both builds cap how far back host-level history actually goes: self-
  // hosted keeps an in-memory buffer (historyRetentionSeconds, from GET
  // /api/host-stats — currently ~15 minutes), hosted doesn't store host
  // history at all yet (hosted_host_stats is a single latest row — see
  // hostStatsStore.js), so `history` there is always empty. Either way,
  // a selected range wider than what's actually retained deserves an
  // honest note instead of a sparkline that silently just stops.
  const retentionMinutes =
    data && data.historyRetentionSeconds ? data.historyRetentionSeconds / 60 : null;
  const rangeExceedsRetention =
    rangeMinutes && retentionMinutes !== null && rangeMinutes > retentionMinutes;
  const noHistoryStored = data && !Array.isArray(data.history);

  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`text-[13px] font-semibold rounded-md px-3.5 py-1.5 border ${
          open
            ? 'text-accent border-accent bg-accent/5'
            : 'text-ink bg-panel-raised border-border hover:border-accent hover:text-accent'
        }`}
      >
        🖥 Host stats {open ? '▲' : '▼'}
      </button>

      {open && (
        <div className="mt-2 border border-border rounded-lg px-4 py-3">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-dim uppercase tracking-wide">
              Host machine
              <InfoDot title="CPU, memory, load average and uptime for the whole machine this runs on — not any one container. Read directly from the host's /proc, no extra containers or agents involved." />
            </span>
            <button type="button" className="link-btn text-[12px]" onClick={load} disabled={loading}>
              {loading ? 'loading…' : '↻ refresh'}
            </button>
          </div>

          {error && <div className="text-[13px] text-down">{error}</div>}

          {!error && data && data.available && noHistoryStored && (
            <div className="text-[12px] text-muted mb-2">
              Point-in-time only — hosted doesn't store host-level history yet, so this always shows the current
              reading regardless of the selected time range.
            </div>
          )}

          {!error && data && data.available && !noHistoryStored && rangeExceedsRetention && (
            <div className="text-[12px] text-muted mb-2">
              Only the last ~{Math.round(retentionMinutes)}m of host history is kept — showing all of it, not the
              full selected range.
            </div>
          )}

          {!error && data && !data.available && (
            <div className="text-[13px] text-muted">
              Host metrics aren't available yet — still gathering the first sample.
            </div>
          )}

          {!error && current && (
            <>
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="flex-1 min-w-[160px] border border-border-soft rounded-lg px-3.5 py-2.5 bg-panel-raised/40">
                <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Load average</div>
                <div className="text-[16px] font-semibold text-ink">
                  {fmtLoad(current.cpu?.load1)} · {fmtLoad(current.cpu?.load5)} · {fmtLoad(current.cpu?.load15)}
                </div>
                <div className="text-[11px] text-muted mt-0.5">1m · 5m · 15m</div>
              </div>

              <div className="flex-1 min-w-[160px] border border-border-soft rounded-lg px-3.5 py-2.5 bg-panel-raised/40">
                <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Uptime</div>
                <div className="text-[16px] font-semibold text-ink">{fmtUptime(current.uptimeSeconds)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ChartPanel
                label="CPU"
                points={cpuHistory}
                color="rgb(var(--color-accent))"
                currentText={
                  <>
                    {fmtPercent(current.cpu?.percent)}
                    {current.cpu?.cores ? (
                      <span className="text-muted font-normal text-[14px]"> · {current.cpu.cores} cores</span>
                    ) : null}
                  </>
                }
                unit="%"
                valueFormatter={(v) => `${v.toFixed(0)}%`}
                height={180}
              />
              <ChartPanel
                label="Memory"
                points={memHistory}
                color="rgb(var(--color-ink-dim))"
                currentText={
                  <>
                    {fmtPercent(current.memory?.percent)}
                    {current.memory?.usedBytes !== null && current.memory?.usedBytes !== undefined ? (
                      <span className="text-muted font-normal text-[14px]">
                        {' '}
                        · {fmtBytes(current.memory.usedBytes)} / {fmtBytes(current.memory.totalBytes)}
                      </span>
                    ) : null}
                  </>
                }
                unit="%"
                valueFormatter={(v) => `${v.toFixed(0)}%`}
                height={180}
              />
            </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
