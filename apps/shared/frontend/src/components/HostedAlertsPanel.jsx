import { useEffect, useState } from 'react';
import { hostedApi } from '../datasource/hostedApi.js';
import HostedAlertsSettings from './HostedAlertsSettings.jsx';

// Hosted's version of AlertsPanel.jsx — same layout/behavior (poll,
// active list, collapsible history, a Configure link), reading from
// license-server's hostedAlertEvaluator.js instead of self-hosted's
// in-process evaluateAlerts() loop. See hostedApi.js's own comment for why
// this isn't just AlertsPanel reused directly: the config/channel split is
// shaped differently underneath.
const ALERTS_POLL_MS = 5000;

export default function HostedAlertsPanel() {
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function fetchAlerts() {
    return hostedApi
      .alerts()
      .then((body) => {
        setAlerts(body);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    let cancelled = false;
    function tick() {
      hostedApi
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
    const id = setInterval(tick, ALERTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error || !alerts) return null;

  if (settingsOpen) {
    return <HostedAlertsSettings onClose={() => setSettingsOpen(false)} onSaved={() => fetchAlerts()} />;
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">
          Alerts {alerts.active.length > 0 && <span className="text-down">({alerts.active.length} active)</span>}
        </span>
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono text-[11px] text-muted"
            title={`Sustained for ${alerts.sustainChecks} consecutive checks before firing.`}
          >
            delivery: {alerts.channelCount > 0 ? `${alerts.channelCount} channel${alerts.channelCount === 1 ? '' : 's'}` : 'in-app only'}
          </span>
          <button type="button" className="link-btn text-[12px]" onClick={() => setSettingsOpen(true)}>
            ⚙ Configure
          </button>
        </div>
      </div>

      {alerts.active.length > 0 && (
        <div className="divide-y divide-border-soft">
          {alerts.active.map((a) => (
            <div key={a.key} className="flex items-center justify-between gap-3 px-3.5 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-down" />
                <span className="text-[13px] text-ink-dim [overflow-wrap:anywhere]">{a.message}</span>
              </div>
              <span className="font-mono text-[11px] text-muted shrink-0">since {new Date(a.firstBreachAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {alerts.active.length === 0 && <div className="px-3.5 py-2 text-[13px] text-muted">Nothing currently firing.</div>}

      {alerts.history.length > 0 && (
        <div className="border-t border-border-soft">
          <button type="button" className="link-btn text-[12px] px-3.5 py-1.5" onClick={() => setHistoryOpen((v) => !v)}>
            {historyOpen ? 'Hide' : 'Show'} recent activity ({alerts.history.length})
          </button>
          {historyOpen && (
            <div className="divide-y divide-border-soft max-h-56 overflow-y-auto">
              {alerts.history.map((h, i) => (
                <div key={`${h.key}-${h.at}-${i}`} className="flex items-center gap-2 px-3.5 py-1.5 font-mono text-[12px]">
                  <span className={h.event === 'fired' ? 'text-down' : 'text-up'}>{h.event === 'fired' ? '●' : '○'}</span>
                  <span className="text-muted shrink-0">{new Date(h.at).toLocaleTimeString()}</span>
                  <span className="text-ink-dim [overflow-wrap:anywhere]">{h.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
