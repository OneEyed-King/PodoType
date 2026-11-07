import { useEffect, useState } from 'react';
import { api } from '../api.js';
import AlertsSettings from './AlertsSettings.jsx';

// How often this panel re-fetches while mounted — same cadence as App.jsx's
// own poll, since /api/alerts is cheap (it just reads state server.js's
// background evaluateAlerts() loop already maintains, no live Docker/
// ClickHouse calls of its own).
const ALERTS_POLL_MS = 5000;

// Self-hosted's history used to be memory-only (lost on every restart) —
// now persisted (see apps/self-hosted/engine/server.js's pushAlertHistory), same as
// hosted's Postgres-backed hosted_alert_history always was. Since entries
// can now genuinely be days old instead of always being "earlier today,"
// this formats with a date whenever an entry isn't from today, instead of
// toLocaleTimeString() alone (which would show a bare "2:14 PM" for
// something that actually fired three days ago — misleading, not just
// imprecise).
function formatHistoryTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString() : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

// Distinct from AttentionBanner on purpose: AttentionBanner is an instant
// read of the current status (down THIS second, slow THIS second) and
// clears the moment that reading looks fine again. This panel shows what's
// actually fired — i.e. stayed true for enough consecutive checks in a row
// (server.js's ALERT_SUSTAIN_CHECKS) to be worth telling someone who isn't
// staring at this page — plus a short log of recent fires/recoveries, and
// whether anything beyond "look at the dashboard" is actually configured to
// deliver that. A person setting up Telegram/webhook alerts for the first
// time needs to see "in-app only right now" as an honest, undismissable
// fact, not guess at it.
export default function AlertsPanel() {
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function fetchAlerts() {
    return api
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
    const id = setInterval(tick, ALERTS_POLL_MS);
    // Same backgrounded-tab timer throttling as everywhere else this
    // project polls (see App.jsx / TraceExplorer.jsx) — refetch the moment
    // the tab's visible again rather than sit on a stale read.
    const onVisible = () => {
      if (!cancelled && !document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (error || !alerts) return null; // fails quietly — AttentionBanner already covers the instant read if this endpoint is briefly unreachable
  // Always rendered once alerts data has loaded, even with nothing active and
  // an empty history — a panel that only appears the first time something
  // fires looks, until that first fire, exactly like a panel that was never
  // built at all. Showing "nothing firing" plus the sustain window and
  // delivery channels up front is what lets someone actually confirm this is
  // wired up and watching, instead of taking it on faith.

  const channelLabels = [];
  if (alerts.channels.telegram) channelLabels.push('Telegram');
  if (alerts.channels.webhook) channelLabels.push('webhook');
  const channelsText = channelLabels.length > 0 ? channelLabels.join(' + ') : 'in-app only';

  if (settingsOpen) {
    return (
      <AlertsSettings
        onClose={() => setSettingsOpen(false)}
        onSaved={() => fetchAlerts()}
      />
    );
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
            title={`Sustained for ${alerts.sustainChecks} consecutive checks before firing. Delivery: ${channelsText}.`}
          >
            delivery: {channelsText}
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
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.severity === 'critical' ? 'bg-down' : 'bg-slow'}`} />
                <span className="text-[13px] text-ink-dim [overflow-wrap:anywhere]">{a.message}</span>
              </div>
              <span className="font-mono text-[11px] text-muted shrink-0">since {new Date(a.firstBreachAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {alerts.active.length === 0 && (
        <div className="px-3.5 py-2 text-[13px] text-muted">Nothing currently firing.</div>
      )}

      {alerts.history.length > 0 && (
        <div className="border-t border-border-soft">
          <button
            type="button"
            className="link-btn text-[12px] px-3.5 py-1.5"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen ? 'Hide' : 'Show'} recent activity ({alerts.history.length})
          </button>
          {historyOpen && (
            <div className="divide-y divide-border-soft max-h-56 overflow-y-auto">
              {alerts.history.map((h, i) => (
                <div key={`${h.key}-${h.at}-${i}`} className="flex items-center gap-2 px-3.5 py-1.5 font-mono text-[12px]">
                  <span className={h.event === 'fired' ? 'text-down' : 'text-up'}>{h.event === 'fired' ? '●' : '○'}</span>
                  <span className="text-muted shrink-0">{formatHistoryTime(h.at)}</span>
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
