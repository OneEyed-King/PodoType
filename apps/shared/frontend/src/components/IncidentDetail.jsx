// Standard incident detail view (backlog item #11) — opened from
// IncidentPanel's active/resolved rows via App.jsx's own section-based
// navigation (this app has no router, every other "page" already works
// this way — see Sidebar.jsx/App.jsx's `section` state). Shows the same
// fixed set of fields for every incident regardless of severity or
// status, so "what happened" is always the same shape to read: what
// fired, on what, when, for how long, and a way to take that record with
// you (item #11.1 — see the download button below).
function sevLabel(severity) {
  return severity === 'critical' ? 'Critical' : 'Warning';
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function buildReportMarkdown(incident) {
  const firedAt = incident.firstBreachAt ? new Date(incident.firstBreachAt) : null;
  const resolvedAt = incident.status === 'resolved' && incident.at ? new Date(incident.at) : null;
  const durationMs = firedAt && resolvedAt ? resolvedAt.getTime() - firedAt.getTime() : null;

  const lines = [];
  lines.push(`# Incident report — ${incident.key || 'unknown'}`);
  lines.push('');
  lines.push(`Status: ${incident.status === 'resolved' ? 'Resolved' : 'Active'}`);
  lines.push(`Severity: ${sevLabel(incident.severity)}`);
  lines.push(`Message: ${incident.message || '—'}`);
  lines.push(`Fired: ${firedAt ? firedAt.toLocaleString() : '—'}`);
  lines.push(`Resolved: ${resolvedAt ? resolvedAt.toLocaleString() : incident.status === 'resolved' ? '(unknown time)' : 'still active'}`);
  if (durationMs !== null) lines.push(`Duration: ${fmtDuration(durationMs)}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');
  return lines.join('\n');
}

function downloadReport(incident) {
  const markdown = buildReportMarkdown(incident);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safeKey = (incident.key || 'incident').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `podotype-incident-${safeKey}-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function IncidentDetail({ incident, onBack }) {
  if (!incident) return null;

  const firedAt = incident.firstBreachAt ? new Date(incident.firstBreachAt) : null;
  const resolvedAt = incident.status === 'resolved' && incident.at ? new Date(incident.at) : null;
  const durationMs = firedAt && resolvedAt ? resolvedAt.getTime() - firedAt.getTime() : null;
  const isCritical = incident.severity === 'critical';

  return (
    <div>
      <button type="button" className="link-btn text-[13px] mb-3" onClick={onBack}>
        ← Back to Overview
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${isCritical ? 'bg-down' : 'bg-slow'}`} />
          <h1 className="text-[20px] font-bold m-0">
            {sevLabel(incident.severity)} — {incident.key || 'Incident'}
          </h1>
          <span
            className={`font-mono text-[11px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 border ${
              incident.status === 'resolved'
                ? 'text-muted border-border bg-panel-raised'
                : 'text-up border-up/30 bg-up/10'
            }`}
          >
            {incident.status === 'resolved' ? 'Resolved' : 'Active'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => downloadReport(incident)}
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-md px-3.5 py-1.5 border text-ink bg-panel-raised border-border hover:border-accent hover:text-accent"
        >
          ⭳ Download report
        </button>
      </div>

      <div className="border border-border rounded-lg divide-y divide-border-soft">
        <div className="px-4 py-3">
          <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Message</div>
          <div className="text-[15px] text-ink [overflow-wrap:anywhere]">{incident.message || '—'}</div>
        </div>
        <div className="flex flex-wrap">
          <div className="flex-1 min-w-[160px] px-4 py-3">
            <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Fired</div>
            <div className="text-[14px] text-ink">{firedAt ? firedAt.toLocaleString() : '—'}</div>
          </div>
          <div className="flex-1 min-w-[160px] px-4 py-3">
            <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Resolved</div>
            <div className="text-[14px] text-ink">
              {resolvedAt ? resolvedAt.toLocaleString() : incident.status === 'resolved' ? '(unknown time)' : 'Still active'}
            </div>
          </div>
          <div className="flex-1 min-w-[160px] px-4 py-3">
            <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">Duration</div>
            <div className="text-[14px] text-ink">{durationMs !== null ? fmtDuration(durationMs) : '—'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
