import { useTranslation } from 'react-i18next';
import InfoDot from './InfoDot.jsx';
import TraceExplorer from './TraceExplorer.jsx';

// The eBPF (Beyla) watcher is always-on and un-selective (see
// docker-compose.yml) — same model Coroot's node-agent uses: it watches
// every container on the host unconditionally from the moment
// `docker compose up` finishes, nothing to opt this one service into. That
// means this panel's own header NEVER changes — it always says
// "automatic" — regardless of whether there happens to be a span to show
// this second. Only the BODY changes, between three calm states: no data
// yet (normal — nothing has hit this service recently), live data (show
// it), or "the OTel agent's own data is showing in the Tracing panel
// instead" (also normal — see server.js's trace.source comment for why
// only one of the two shows at a time). None of those states are framed
// as broken or needing action, because none of them are — this used to be
// merged into TracingPanel's on/off badge, which meant a quiet 5-minute
// window looked exactly like "tracing turned itself off and needs setup
// again." It doesn't, and can't — there's nothing to turn off here.
export default function BeylaPanel({ svc, expanded, onToggleExpanded }) {
  const { t } = useTranslation();
  const trace = svc.trace;
  const hasBeylaData = Boolean(trace && trace.source === 'beyla');
  const otherwiseShowingAgentData = Boolean(trace && trace.source === 'agent');
  const p95Text = hasBeylaData && trace.p95Ms !== null && trace.p95Ms !== undefined ? `${Math.round(trace.p95Ms)}ms` : '—';

  return (
    <div className="bg-panel-recessed border border-border-soft rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft text-[12px] font-bold uppercase tracking-wider text-muted">
        <span className="inline-flex items-center gap-1.5">
          {t('beylaPanel.title')}
          <InfoDot title={t('beylaPanel.tooltip')} />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-accent">{t('beylaPanel.automatic')}</span>
          {hasBeylaData && (
            <button
              type="button"
              onClick={onToggleExpanded}
              title={expanded ? t('beylaPanel.collapse') : t('beylaPanel.expand')}
              className={`link-btn transition-transform ${expanded ? 'rotate-180 text-accent' : ''}`}
            >
              ⌄
            </button>
          )}
        </span>
      </div>

      <div className="px-2.5 py-2">
        {otherwiseShowingAgentData && (
          <div className="text-[13px] text-muted">{t('beylaPanel.agentShowing')}</div>
        )}

        {!otherwiseShowingAgentData && !hasBeylaData && (
          <div className="text-[13px] text-muted">{t('beylaPanel.noSpansYet')}</div>
        )}

        {!otherwiseShowingAgentData && hasBeylaData && (
          <TraceExplorer
            serviceName={svc.name}
            p95Text={p95Text}
            slow={Boolean(trace.slow)}
            statusText={trace.status === 'recent' ? t('beylaPanel.sampled') : t('beylaPanel.noRecentTraces')}
            expanded={expanded}
          />
        )}
      </div>
    </div>
  );
}
