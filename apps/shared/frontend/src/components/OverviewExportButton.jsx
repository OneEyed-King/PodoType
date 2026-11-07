import { useState } from 'react';
import { api } from '../api.js';

// Exports the Overview page as a downloadable Markdown report (product
// backlog item #5.1). Deliberately re-fetches its own /alerts snapshot on
// click rather than reading it off IncidentPanel/OverviewSummary — those
// keep their alert data as private state (see their own POLL_MS effects),
// and lifting it up into App.jsx just for this button would mean either
// prop-drilling or a third poller anyway. One extra request at export time
// is a fair trade for not touching two already-working, unrelated
// components. Uses the same `services` list (statusServices/watchedServices)
// and rangeMinutes/rangeLabel App.jsx already passes into OverviewSummary
// and IncidentPanel, so the numbers in the report always match what's on
// screen.
function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}
function fmtMs(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v)}ms`;
}
function fmtRate(v) {
  if (v === null || v === undefined) return '—';
  return v >= 10 ? `${Math.round(v)}/s` : `${v.toFixed(1)}/s`;
}
function statusWord(up) {
  return up === true ? 'up' : up === false ? 'down' : 'unknown';
}

function buildMarkdown({ services, rangeMinutes, rangeLabel, alerts }) {
  const generatedAt = new Date();
  const watched = services.length;
  const healthy = services.filter((s) => s.up === true).length;
  const down = services.filter((s) => s.up === false).length;
  const unknown = watched - healthy - down;

  const active = (alerts && alerts.active) || [];
  const criticalCount = active.filter((a) => a.severity === 'critical').length;
  const warningCount = active.length - criticalCount;

  const cutoffMs = Date.now() - rangeMinutes * 60 * 1000;
  const lines = [];
  lines.push('# PodoType overview report');
  lines.push('');
  lines.push(`Generated: ${generatedAt.toLocaleString()}`);
  lines.push(`Range: last ${rangeLabel}`);
  lines.push('');
  lines.push('## Service health');
  lines.push('');
  lines.push(`- Watched: ${watched}`);
  lines.push(`- Healthy: ${healthy}`);
  lines.push(`- Down: ${down}`);
  lines.push(`- Unknown: ${unknown}`);
  lines.push('');
  lines.push('## Incidents');
  lines.push('');
  lines.push(`- Active: ${active.length} (${criticalCount} critical, ${warningCount} warning)`);
  if (active.length > 0) {
    lines.push('');
    for (const a of active) {
      lines.push(`  - **${a.severity}** — ${a.message} (since ${new Date(a.firstBreachAt).toLocaleString()})`);
    }
  }
  const resolvedInRange = ((alerts && alerts.history) || []).filter(
    (h) => h.event === 'resolved' && h.at && new Date(h.at).getTime() >= cutoffMs
  );
  lines.push(`- Resolved in range: ${resolvedInRange.length}`);
  if (resolvedInRange.length > 0) {
    lines.push('');
    for (const h of resolvedInRange) {
      lines.push(`  - ${h.message} (${new Date(h.at).toLocaleString()})`);
    }
  }
  lines.push('');
  lines.push('## Services');
  lines.push('');
  lines.push('| Service | Status | Requests/sec | Error rate | p95 latency | Restarts |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of services) {
    const red = s.red || {};
    const restarts = s.health && s.health.restartCount !== null && s.health.restartCount !== undefined ? s.health.restartCount : '—';
    lines.push(
      `| ${s.name} | ${statusWord(s.up)} | ${fmtRate(red.requestsPerSec)} | ${fmtPct(red.errorRate)} | ${fmtMs(red.p95Ms)} | ${restarts} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

export default function OverviewExportButton({ services, rangeMinutes, rangeLabel }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);

  function handleExport() {
    setExporting(true);
    setError(null);
    api
      .alerts()
      .catch(() => null) // a failed alerts fetch shouldn't block exporting everything else
      .then((alerts) => {
        const markdown = buildMarkdown({ services, rangeMinutes, rangeLabel, alerts });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `podotype-overview-${stamp}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(err.message))
      .finally(() => setExporting(false));
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleExport}
        disabled={exporting}
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-md px-3.5 py-1.5 border text-ink bg-panel-raised border-border hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {exporting ? 'Exporting…' : '⭳ Export report'}
      </button>
      {error && <span className="text-[12px] text-down">{error}</span>}
    </div>
  );
}
