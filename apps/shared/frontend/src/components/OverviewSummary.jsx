import { useEffect, useState } from 'react';
import { api } from '../api.js';

// A plain-language, template-built sentence — NOT an LLM call. Every
// number in it comes straight from data this page already has elsewhere
// (services' .up flags, the same /alerts endpoint IncidentPanel polls);
// this just reads it back as a sentence instead of making someone add up
// four stat tiles themselves. See the "non-AI summary" request this was
// built from — deliberately no model call, no network cost beyond the
// alerts poll every other Overview widget already makes.
const POLL_MS = 5000;

export default function OverviewSummary({ services, rangeMinutes, rangeLabel }) {
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
    parts.push("You're not watching any services yet.");
  } else if (down > 0) {
    parts.push(
      `${down} of ${watched} watched service${watched === 1 ? '' : 's'} ${down === 1 ? 'is' : 'are'} currently down or degraded.`
    );
  } else if (unknown > 0) {
    parts.push(`All ${healthy} reporting services are healthy — ${unknown} more ${unknown === 1 ? "hasn't" : "haven't"} confirmed health yet.`);
  } else {
    parts.push(`All ${watched} watched service${watched === 1 ? '' : 's'} ${watched === 1 ? 'is' : 'are'} healthy.`);
  }

  if (activeCount !== null) {
    if (activeCount === 0) {
      parts.push(
        resolvedInRange
          ? `No active incidents — ${resolvedInRange} resolved in the last ${rangeLabel}.`
          : `No incidents in the last ${rangeLabel}.`
      );
    } else {
      parts.push(
        `${activeCount} active incident${activeCount === 1 ? '' : 's'}${criticalCount > 0 ? ` (${criticalCount} critical)` : ''} right now.`
      );
    }
  }

  return (
    <div className="mb-5 border border-border-soft rounded-lg px-3.5 py-2.5 bg-panel-raised/40">
      <div className="text-[13px] text-ink-dim leading-relaxed">{parts.join(' ')}</div>
    </div>
  );
}
