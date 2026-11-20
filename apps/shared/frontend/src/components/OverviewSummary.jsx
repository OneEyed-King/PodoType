import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';

// A plain-language, template-built sentence — NOT an LLM call. Every
// number in it comes straight from data this page already has elsewhere
// (services' .up flags, the same /alerts endpoint IncidentPanel polls);
// this just reads it back as a sentence instead of making someone add up
// four stat tiles themselves. See the "non-AI summary" request this was
// built from — deliberately no model call, no network cost beyond the
// alerts poll every other Overview widget already makes.
//
// Each clause is its own i18next key with _one/_other (and _few/_many for
// Russian) plural forms, picked by whichever count is grammatically the
// subject of that clause — not string-concatenated word fragments, which
// don't hold up across languages with different pluralization or word
// order.
const POLL_MS = 5000;

export default function OverviewSummary({ services, rangeMinutes, rangeLabel }) {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .alerts()
        .then((body) => {
          if (!cancelled) setAlerts(body);
        })
        .catch(() => {});
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const watched = services.length;
  const healthy = services.filter((s) => s.up === true).length;
  const down = services.filter((s) => s.up === false).length;
  const unknown = watched - healthy - down;

  const activeCount = alerts ? alerts.active.length : null;
  const criticalCount = alerts ? alerts.active.filter((a) => a.severity === 'critical').length : 0;

  const cutoff = Date.now() - rangeMinutes * 60 * 1000;
  const resolvedInRange = alerts
    ? (alerts.history || []).filter((h) => h.event === 'resolved' && h.at && new Date(h.at).getTime() >= cutoff).length
    : null;

  const parts = [];

  if (watched === 0) {
    parts.push(t('overviewSummary.noneWatched'));
  } else if (down > 0) {
    parts.push(t('overviewSummary.someDown', { count: down, down, watched }));
  } else if (unknown > 0) {
    parts.push(t('overviewSummary.allHealthyUnknown', { count: unknown, healthy, unknown }));
  } else {
    parts.push(t('overviewSummary.allHealthy', { count: watched, watched }));
  }

  if (activeCount !== null) {
    if (activeCount === 0) {
      parts.push(
        resolvedInRange
          ? t('overviewSummary.noActiveResolved', { count: resolvedInRange, range: rangeLabel })
          : t('overviewSummary.noIncidentsRange', { range: rangeLabel })
      );
    } else {
      const criticalSuffix = criticalCount > 0 ? t('overviewSummary.criticalSuffix', { count: criticalCount }) : '';
      parts.push(t('overviewSummary.activeIncidents', { count: activeCount, criticalSuffix }));
    }
  }

  return (
    <div className="mb-5 border border-border-soft rounded-lg px-3.5 py-2.5 bg-panel-raised/40">
      <div className="text-[13px] text-ink-dim leading-relaxed">{parts.join(' ')}</div>
    </div>
  );
}
