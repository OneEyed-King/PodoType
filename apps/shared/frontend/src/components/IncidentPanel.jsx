import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Shared across both builds (uses the unified api.js dispatch, not
// engineApi/hostedApi directly) — same /alerts data AlertsPanel and
// HostedAlertsPanel already poll (active[]: {key, severity, message,
// firstBreachAt}, history[]: {..., resolvedAt?}), just reframed as an
// "incidents" summary for the Overview page instead of a full alerts
// management panel. Deliberately always rendered, even empty — see
// AlertsPanel's own comment on why a panel that only appears once
// something fires is indistinguishable from a panel that was never built.
const POLL_MS = 5000;

function sevDot(severity) {
  return severity === 'critical' ? 'bg-down' : 'bg-slow';
}

function sevLabel(severity) {
  return severity === 'critical' ? 'Critical' : 'Warning';
}

export default function IncidentPanel({ rangeMinutes, rangeLabel, onSelectIncident }) {
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .alerts()
        .then((body) => {
          if (!cancelled) {
            setAlerts(body);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="mb-5 border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-down">
        Couldn't load incidents — {error}
      </div>
    );
  }
  if (!alerts) return null; // first load — avoid a flash of the empty state before data arrives

  const cutoff = Date.now() - rangeMinutes * 60 * 1000;
  // alerts.history entries are {key, at, event: 'fired'|'resolved',
  // message} (see AlertsPanel's own history rendering) — only 'resolved'
  // events are shown here, since 'fired' for anything still active is
  // already covered by the active[] list above, and a resolved event
  // inside the selected window is what "what happened in the last
  // {rangeLabel}" actually means.
  const recentHistory = (alerts.history || []).filter(
    (h) => h.event === 'resolved' && h.at && new Date(h.at).getTime() >= cutoff
  );

  const active = alerts.active || [];
  const criticalCount = active.filter((a) => a.severity === 'critical').length;
  const warningCount = active.length - criticalCount;
  const nothingToShow = active.length === 0 && recentHistory.length === 0;

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Incidents</span>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-down bg-down/10 border border-down/30 rounded-full px-2 py-0.5">
              {criticalCount} critical
            </span>
          )}
          {warningCount > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-slow bg-slow/10 border border-slow/30 rounded-full px-2 py-0.5">
              {warningCount} warning
            </span>
          )}
          {active.length === 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-up bg-up/10 border border-up/30 rounded-full px-2 py-0.5">
              All clear
            </span>
          )}
        </div>
      </div>

      {nothingToShow ? (
        <div className="px-3.5 py-3 text-[13px] text-muted">No incidents in the last {rangeLabel}.</div>
      ) : (
        <div className="divide-y divide-border-soft">
          {active.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => onSelectIncident && onSelectIncident({ ...a, status: 'active' })}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-2 text-left hover:bg-accent/5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sevDot(a.severity)}`} />
                <span className="font-mono text-[11px] font-bold text-muted uppercase shrink-0">{sevLabel(a.severity)}</span>
                <span className="text-[13px] text-ink-dim [overflow-wrap:anywhere]">{a.message}</span>
              </div>
              <span className="font-mono text-[11px] text-muted shrink-0">
                since {new Date(a.firstBreachAt).toLocaleTimeString()}
              </span>
            </button>
          ))}
          {recentHistory.slice(0, 8).map((h, i) => (
            <button
              key={`${h.key}-${h.at}-${i}`}
              type="button"
              onClick={() => onSelectIncident && onSelectIncident({ ...h, status: 'resolved' })}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-2 text-left opacity-70 hover:opacity-100 hover:bg-accent/5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-muted" />
                <span className="font-mono text-[11px] font-bold text-muted uppercase shrink-0">Resolved</span>
                <span className="text-[13px] text-ink-dim [overflow-wrap:anywhere]">{h.message}</span>
              </div>
              <span className="font-mono text-[11px] text-muted shrink-0">{new Date(h.at).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
