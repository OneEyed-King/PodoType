import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const TABS = [
    { id: 'traces', label: t('serviceDetailPanel.tabTraces') },
    { id: 'health', label: t('serviceDetailPanel.tabHealth') },
    { id: 'metrics', label: t('serviceDetailPanel.tabMetrics') },
    { id: 'logs', label: t('serviceDetailPanel.tabLogs') },
    ...(supportsAlertOverrides ? [{ id: 'alerts', label: t('serviceDetailPanel.tabAlerts') }] : []),
    { id: 'slo', label: t('serviceDetailPanel.tabSlo') },
    { id: 'dependencies', label: t('serviceDetailPanel.tabDependencies') },
  ];
  const tab = TABS.some((t) => t.id === activeTab) ? activeTab : TABS[0].id;

  return (
    <div className="flex flex-col gap-3">
      {(supportsManualCheck || svc.check) && (
        <div className="flex items-center gap-2 flex-wrap text-[16px]">
          {svc.check ? (
            <>
              <span className="font-mono text-[16px] text-muted [overflow-wrap:anywhere]">
                {t('serviceDetailPanel.manualCheckPrefix', { type: svc.check.type, target: svc.check.target })}
              </span>
              <button type="button" className="link-btn" onClick={() => onSetupCheck(svc.check)}>
                {t('serviceDetailPanel.edit')}
              </button>
              <button type="button" className="link-btn" onClick={onRemoveCheck}>
                {t('serviceDetailPanel.remove')}
              </button>
            </>
          ) : (
            <button type="button" className="link-btn" onClick={() => onSetupCheck(null)}>
              {t('serviceDetailPanel.addManualCheck')}
            </button>
          )}
        </div>
      )}

      <div className="border border-border-soft rounded-md overflow-hidden">
        <div className="flex items-center gap-1 px-2 pt-2 border-b border-border-soft overflow-x-auto">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => onSelectTab(tb.id)}
              className={`shrink-0 text-[13px] font-semibold px-3 py-1.5 rounded-t-md border-b-2 transition-colors ${
                tab === tb.id
                  ? 'text-accent border-accent bg-accent/5'
                  : 'text-ink-dim border-transparent hover:text-ink hover:border-border'
              }`}
            >
              {tb.label}
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
