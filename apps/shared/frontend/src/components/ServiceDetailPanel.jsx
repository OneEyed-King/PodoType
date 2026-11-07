import TracesPanel from './TracesPanel.jsx';
import ResourceHealthPanel from './ResourceHealthPanel.jsx';
import MetricsHistoryRange from './MetricsHistoryRange.jsx';
import LogsPanel from './LogsPanel.jsx';
import ServiceAlertOverrides from './ServiceAlertOverrides.jsx';
import ServiceSloPanel from './ServiceSloPanel.jsx';
import ServiceDependencies from './ServiceDependencies.jsx';

// The manual-check row + horizontal tab strip that used to live inline
// inside WatchedRow's own "expanded" state (see WatchedRow.jsx's own
// comment on why that moved: a row expanding IN PLACE inside a long list
// of watched services meant the thing you actually came to look at (a
// trace waterfall, a log tail) landed wherever that row happened to be in
// the list, several screens of scrolling down for anyone near the bottom.
// Pulled out here unchanged (same props, same TABS, same per-tab
// components) so it can render as its own full page (see
// ServiceDetailPage.jsx) instead — the list itself now only ever shows
// one line per service.
export default function ServiceDetailPanel({
  svc,
  cfg,
  activeTab,
  onSetupCheck,
  onRemoveCheck,
  onSelectTab,
  storageStatus,
  supportsManualCheck = true,
  supportsCodeTracing = true,
  supportsAlertOverrides = true,
}) {
  const TABS = [
    { id: 'traces', label: '📈 Traces' },
    { id: 'health', label: '🖥 Health' },
    { id: 'metrics', label: '📊 Metrics' },
    { id: 'logs', label: '📝 Logs' },
    ...(supportsAlertOverrides ? [{ id: 'alerts', label: '🔔 Alerts' }] : []),
    { id: 'slo', label: '📊 SLO' },
    { id: 'dependencies', label: '🔗 Dependencies' },
  ];
  const tab = TABS.some((t) => t.id === activeTab) ? activeTab : TABS[0].id;

  return (
    <div className="flex flex-col gap-3">
      {(supportsManualCheck || svc.check) && (
        <div className="flex items-center gap-2 flex-wrap text-[16px]">
          {svc.check ? (
            <>
              <span className="font-mono text-[16px] text-muted [overflow-wrap:anywhere]">
                manual check — {svc.check.type}: {svc.check.target}
              </span>
              <button type="button" className="link-btn" onClick={() => onSetupCheck(svc.check)}>
                Edit
              </button>
              <button type="button" className="link-btn" onClick={onRemoveCheck}>
                Remove
              </button>
            </>
          ) : (
            <button type="button" className="link-btn" onClick={() => onSetupCheck(null)}>
              Add manual health check (optional)
            </button>
          )}
        </div>
      )}

      <div className="border border-border-soft rounded-md overflow-hidden">
        <div className="flex items-center gap-1 px-2 pt-2 border-b border-border-soft overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTab(t.id)}
              className={`shrink-0 text-[13px] font-semibold px-3 py-1.5 rounded-t-md border-b-2 transition-colors ${
                tab === t.id
                  ? 'text-accent border-accent bg-accent/5'
                  : 'text-ink-dim border-transparent hover:text-ink hover:border-border'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-3">
          {tab === 'traces' && (
            <TracesPanel svc={svc} cfg={cfg} supportsCodeTracing={supportsCodeTracing} />
          )}
          {tab === 'health' && <ResourceHealthPanel svc={svc} />}
          {tab === 'metrics' && <MetricsHistoryRange serviceName={svc.name} />}
          {tab === 'logs' && <LogsPanel serviceName={svc.name} storageStatus={storageStatus} />}
          {tab === 'alerts' && supportsAlertOverrides && <ServiceAlertOverrides serviceName={svc.name} />}
          {tab === 'slo' && <ServiceSloPanel svc={svc} />}
          {tab === 'dependencies' && <ServiceDependencies serviceName={svc.name} />}
        </div>
      </div>
    </div>
  );
}
