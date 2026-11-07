import { useEffect, useState } from 'react';
import InfoDot from './InfoDot.jsx';
import Sparkline from './Sparkline.jsx';
import { api } from '../api.js';

// Matches CONTAINER_STATS_POLL_INTERVAL_MS on the server — no point polling
// history faster than the background poller that actually produces new
// samples.
const HISTORY_POLL_MS = 20000;

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const mb = bytes / 1e6;
  if (mb < 1000) return `${mb.toFixed(0)}MB`;
  return `${(mb / 1000).toFixed(2)}GB`;
}

// Docker/Beyla report I/O as bytes/sec — shown per-second like `docker
// stats`'s own NET I/O column, scaled up to KB or MB once it's big enough
// that a raw byte count stops being readable at a glance.
function formatBps(bps) {
  if (bps === null || bps === undefined) return '—';
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// One stat block: a current-value readout plus its own sparkline underneath
// — used for every metric here (CPU, memory, net rx/tx, disk read/write,
// requests/errors) so a Coroot- or Prometheus-style "number plus trend"
// looks the same regardless of which signal it's showing.
function Stat({ label, valueText, tone, sparklinePoints, sparklineColor }) {
  return (
    <div className="min-w-[92px]">
      <div className={`font-mono text-[15px] font-bold ${tone || 'text-ink'}`}>{valueText}</div>
      <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">{label}</div>
      {sparklinePoints && (
        <div className={sparklineColor || 'text-muted'}>
          <Sparkline points={sparklinePoints} />
        </div>
      )}
    </div>
  );
}

// Separate from Traces/Requests above on purpose: RED metrics answer "are
// this service's REQUESTS healthy" — this answers "is the CONTAINER itself
// healthy" (about to get OOM-killed, pegging a CPU core, thrashing the
// disk). Neither Beyla nor Tempo has any of this on its own; it's plain
// Docker stats (see server.js's "Container health" comment) plus, where
// Beyla has resolved this container to a service name, the same request-
// rate/error-rate history RED already computes — same numbers `docker
// stats` and the RED pill above already show, just charted over time
// instead of frozen at "right now".
//
// History is fetched on demand (only while this panel is actually mounted,
// i.e. the row is expanded) rather than riding along on the 5s /api/status
// poll every watched service gets regardless of whether anyone's looking —
// same reasoning TraceExplorer already applies to its own per-service fetch.
export default function ResourceHealthPanel({ svc }) {
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .metricsHistory(svc.name)
        .then((body) => {
          if (!cancelled) {
            setHistory(body);
            setHistoryError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setHistoryError(err.message);
        });
    }
    tick();
    const id = setInterval(tick, HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // svc.name only — this panel unmounts/remounts (via WatchedRow's key)
    // if the row itself changes identity, so there's nothing else here that
    // should restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc.name]);

  const health = svc.health;
  const tone =
    health && health.status === 'critical' ? 'text-down' : health && health.status === 'warning' ? 'text-slow' : 'text-ink-dim';

  const cpuPoints = history ? history.cpu.map((p) => p.value) : [];
  const memPoints = history ? history.memory.map((p) => p.percent ?? null) : [];
  const netRxPoints = history ? history.network.map((p) => p.rxBps) : [];
  const netTxPoints = history ? history.network.map((p) => p.txBps) : [];
  const diskReadPoints = history ? history.disk.map((p) => p.readBps) : [];
  const diskWritePoints = history ? history.disk.map((p) => p.writeBps) : [];
  const reqPoints = history ? history.requests.map((p) => p.requestsPerSec) : [];
  const errPoints = history ? history.requests.map((p) => p.errorRate * 100) : [];
  const hasRequestHistory = history && history.requests.length >= 2;

  return (
    <div className="bg-panel-recessed border border-border-soft rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft text-[12px] font-bold uppercase tracking-wider text-muted">
        <span className="inline-flex items-center gap-1.5">
          Container health
          <InfoDot title="CPU, memory, network and disk I/O for this container itself, read directly from Docker (the same numbers `docker stats` shows), plus request/error rate history where Beyla has resolved this container to a service. Separate from request-level tracing above. Memory shows a percent-of-limit only if this container's compose entry actually sets a memory limit." />
        </span>
        {health && (health.restartCount !== null || health.uptimeSeconds !== null) && (
          <span className="font-mono text-[11px] normal-case tracking-normal text-muted">
            {health.uptimeSeconds !== null && <>up {formatUptime(health.uptimeSeconds)}</>}
            {health.uptimeSeconds !== null && health.restartCount !== null && ' · '}
            {health.restartCount !== null && <>{health.restartCount} restart{health.restartCount === 1 ? '' : 's'}</>}
            {/* Restart count alone doesn't say why — a service OOM-killed
                (needs more memory / has a leak) and one crash-looping on a
                bug and one that was just redeployed all show the same "N
                restarts" without this. Only shown once there's actually a
                restart to explain. */}
            {health.restartCount > 0 && health.lastExitReason && (
              <>
                {' · '}
                <span className={health.lastExitReason.kind === 'oom' ? 'text-down' : health.lastExitReason.kind === 'crash' ? 'text-slow' : ''}>
                  last: {health.lastExitReason.label}
                </span>
              </>
            )}
          </span>
        )}
      </div>

      <div className="px-2.5 py-2">
        {svc.up === false && <div className="text-[13px] text-muted">container not running</div>}
        {svc.up !== false && !health && <div className="text-[13px] text-muted">waiting for first reading…</div>}
        {svc.up !== false && health && health.error && <div className="text-[13px] text-muted">error: {health.error}</div>}

        {svc.up !== false && health && !health.error && (
          <div className="flex gap-5 flex-wrap">
            <Stat
              label="CPU"
              valueText={health.cpuPercent !== null ? `${health.cpuPercent.toFixed(1)}%` : '—'}
              sparklinePoints={cpuPoints}
              sparklineColor="text-accent"
            />
            <Stat
              label={`Memory${health.memPercent !== null ? ` — ${Math.round(health.memPercent)}% of limit` : ' (no limit set)'}`}
              valueText={
                <>
                  {formatBytes(health.memUsageBytes)}
                  {health.memLimitBytes !== null && (
                    <span className="text-muted font-normal text-[13px]"> / {formatBytes(health.memLimitBytes)}</span>
                  )}
                </>
              }
              tone={tone}
              sparklinePoints={health.memPercent !== null ? memPoints : null}
              sparklineColor={tone}
            />
            <Stat
              label="Net RX"
              valueText={formatBps(health.netRxRateBps)}
              sparklinePoints={netRxPoints}
              sparklineColor="text-accent"
            />
            <Stat
              label="Net TX"
              valueText={formatBps(health.netTxRateBps)}
              sparklinePoints={netTxPoints}
              sparklineColor="text-accent"
            />
            <Stat
              label="Disk read"
              valueText={formatBps(health.blkReadRateBps)}
              sparklinePoints={diskReadPoints}
              sparklineColor="text-ink-dim"
            />
            <Stat
              label="Disk write"
              valueText={formatBps(health.blkWriteRateBps)}
              sparklinePoints={diskWritePoints}
              sparklineColor="text-ink-dim"
            />
            {hasRequestHistory && (
              <>
                <Stat
                  label="Requests/sec"
                  valueText={reqPoints[reqPoints.length - 1] !== undefined ? reqPoints[reqPoints.length - 1].toFixed(1) : '—'}
                  sparklinePoints={reqPoints}
                  sparklineColor="text-accent"
                />
                <Stat
                  label="Error rate"
                  valueText={errPoints[errPoints.length - 1] !== undefined ? `${errPoints[errPoints.length - 1].toFixed(1)}%` : '—'}
                  sparklinePoints={errPoints}
                  sparklineColor={errPoints[errPoints.length - 1] > 0 ? 'text-down' : 'text-muted'}
                />
              </>
            )}
          </div>
        )}
        {historyError && <div className="text-[11px] text-muted mt-1.5">history unavailable: {historyError}</div>}
      </div>
    </div>
  );
}
