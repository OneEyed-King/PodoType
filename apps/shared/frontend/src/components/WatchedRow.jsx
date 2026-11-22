import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import StatusPill, { statusPillProps, tracePillProps } from './StatusPill.jsx';
import { api } from '../api.js';

function sourceLabelKey(svc) {
  switch (svc.upSource) {
    case 'check':
      return 'watchedRow.sourceCheck';
    case 'docker-health':
    case 'docker-health-starting':
      return 'watchedRow.sourceDockerHealth';
    case 'docker-state':
      return 'watchedRow.sourceDockerState';
    case 'checking':
      return 'watchedRow.sourceCheckPending';
    default:
      return null;
  }
}

// Full-width row, one line: name, status, and the same quick stats a card
// used to bury behind "configure monitoring" — there's room for them
// inline now. Used to expand IN PLACE into a full tab panel below the
// row — removed (see ServiceDetailPage.jsx/ServiceDetailPanel.jsx, where
// that content now lives) because a row expanding inside a long list of
// watched services meant the trace waterfall or log tail you actually
// came to look at landed wherever that row happened to sit in the list —
// several screens of scrolling for anyone near the bottom. "View
// details" below now navigates to that service's own page instead.
export default function WatchedRow({
  svc,
  isSlowest,
  onStopWatching,
  onOpenDetail,
}) {
  const { t } = useTranslation();
  // Clear-data (product backlog item #12) — deletes this service's own
  // stored spans/logs/metrics, separate from onStopWatching above (which
  // only stops watching it, doesn't touch what's already stored). Local
  // state only: this is a one-shot action with its own inline feedback,
  // not something the rest of the row needs to know about.
  const [clearingData, setClearingData] = useState(false);
  const [clearedData, setClearedData] = useState(false);

  function handleClearData() {
    const ok = window.confirm(t('watchedRow.confirmClear', { name: svc.name }));
    if (!ok) return;
    setClearingData(true);
    setClearedData(false);
    api
      .clearData(svc.name)
      .then(() => {
        setClearedData(true);
        setTimeout(() => setClearedData(false), 4000);
      })
      .catch((err) => window.alert(t('watchedRow.clearFailed', { name: svc.name, error: err.message })))
      .finally(() => setClearingData(false));
  }

  const status = statusPillProps(svc);
  const trace = tracePillProps(svc.trace);
  const sourceKey = sourceLabelKey(svc);
  const source = sourceKey ? t(sourceKey) : null;

  // Left border color -- same severity read AttentionBanner/StatusSummaryStrip
  // already apply, just as a persistent visual instead of text: down beats
  // slow beats up beats unknown, checked in that order so a down service
  // never gets outranked by e.g. also having a slow trace.
  const borderTone =
    svc.up === false
      ? 'border-l-down'
      : trace && trace.cls === 'pill-slow'
      ? 'border-l-slow'
      : svc.up === true
      ? 'border-l-up'
      : 'border-l-unknown';

  const quickBits = [];
  if (source) quickBits.push(source);
  if (svc.trace && svc.trace.p95Ms !== null && svc.trace.p95Ms !== undefined) {
    quickBits.push(t('watchedRow.tracePrefix', { ms: Math.round(svc.trace.p95Ms) }));
  }
  if (svc.checkResponseTimeMs !== null && svc.checkResponseTimeMs !== undefined) {
    quickBits.push(t('watchedRow.checkPrefix', { ms: svc.checkResponseTimeMs }));
  }
  if (svc.metrics) {
    if (svc.metrics.recognized) {
      const rate =
        svc.metrics.errorRate !== null
          ? t('watchedRow.errorsPct', { pct: Math.round(svc.metrics.errorRate * 100) })
          : t('watchedRow.noErrors');
      quickBits.push(t('watchedRow.logsSummary', { matched: svc.metrics.matchedLines, sampled: svc.metrics.sampledLines, rate }));
    } else {
      quickBits.push(t('watchedRow.logsUnrecognized'));
    }
  }
  if (svc.checkError) quickBits.push(t('watchedRow.checkErrorPrefix', { error: svc.checkError }));

  return (
    <div className={`bg-panel border border-border-soft border-l-4 ${borderTone} rounded-lg`}>
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <StatusPill {...status} />
        {trace && <StatusPill {...trace} />}
        <span className="font-mono font-semibold text-[16px] [overflow-wrap:anywhere]">{svc.name}</span>
        {isSlowest && (
          <span
            className="text-down font-bold text-[11px] shrink-0"
            title={t('watchedRow.slowestTitle')}
          >
            {t('watchedRow.slowest')}
          </span>
        )}

        {quickBits.length > 0 && (
          <span className="font-mono text-[16px] text-muted [overflow-wrap:anywhere] flex-1 min-w-[160px]">
            {quickBits.join(' · ')}
          </span>
        )}

        <div className="flex items-center gap-3 ml-auto shrink-0">
          <button type="button" onClick={onOpenDetail} className="link-btn text-accent">
            {t('watchedRow.viewDetails')}
          </button>
          <button
            type="button"
            onClick={handleClearData}
            disabled={clearingData}
            title={t('watchedRow.clearDataTitle')}
            className="link-btn opacity-50 hover:opacity-100 text-[16px] disabled:opacity-30"
          >
            {clearingData ? t('watchedRow.clearing') : clearedData ? t('watchedRow.cleared') : t('watchedRow.clearData')}
          </button>
          <button type="button" onClick={onStopWatching} className="link-btn opacity-50 hover:opacity-100 text-[16px]">
            {t('watchedRow.stopWatching')}
          </button>
        </div>
      </div>

    </div>
  );
}
