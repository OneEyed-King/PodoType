import { useState } from 'react';

// Down services and very-slow traces surfaced above everything else — the
// two situations worth interrupting a glance-over for. Dismissing an item
// is per-browser-session only (a plain useState Set): it comes back if you
// reload, and it comes back if the same service trips the same issue again
// after recovering — this is a "seen it, move on for now" ack, not a
// permanent silence.
export default function AttentionBanner({ statusServices, slowThresholdMs, storage }) {
  const [dismissed, setDismissed] = useState(() => new Set());

  const issues = [];
  // Host disk running low — not a per-service issue, but the single most
  // important thing to surface here: left silent, this is exactly what
  // causes every service below to eventually show "no data" with no
  // visible reason.
  //
  // SAAS-CLICKHOUSE BRANCH: unlike the Tempo branch, `app` does NOT do any
  // eager pruning of its own here — there's nothing for it to prune.
  // ClickHouse ages out old rows itself via the table TTL set in
  // clickhouse/otel-collector-config.yaml, on its own background schedule,
  // independent of anything this UI does or shows. So this banner is
  // purely informational for both 'warning' and 'critical' — it explains
  // what's happening, but nothing here is "fixing" it the way the Tempo
  // branch's auto-prune was. lastAutoPrune is always null on this branch
  // (server.js never sets it), so the old "recently freed space" recovery
  // note never fires here — that's expected, not a regression.
  if (storage && (storage.status === 'warning' || storage.status === 'critical')) {
    const freeMb = storage.freeBytes !== null ? Math.round(storage.freeBytes / 1e6) : null;
    issues.push({
      key: 'storage',
      name: 'Disk space',
      tone: 'slow',
      text: `${storage.usedPercent}% full${freeMb !== null ? ` (${freeMb}MB free)` : ''} on ClickHouse's volume — it ages out old trace data on its own schedule (see the table TTL); no action needed unless this keeps climbing.`,
    });
  }
  for (const svc of statusServices) {
    if (svc.up === false) {
      issues.push({
        key: `${svc.name}|down`,
        name: svc.name,
        tone: 'down',
        text: svc.checkError ? `down — ${svc.checkError}` : 'down — not responding',
      });
    }
    if (svc.trace && svc.trace.slow && svc.trace.p95Ms !== null && svc.trace.p95Ms !== undefined) {
      issues.push({
        key: `${svc.name}|slow`,
        name: svc.name,
        tone: 'slow',
        text: `very slow traces — p95 ${Math.round(svc.trace.p95Ms)}ms (above ${slowThresholdMs}ms)`,
      });
    }
    // Memory only ever gets a status here if the container actually has a
    // configured limit to be near (see server.js's Container health
    // comment) — this is the "about to get OOM-killed" warning, distinct
    // from the host-disk one above.
    if (svc.health && (svc.health.status === 'warning' || svc.health.status === 'critical') && svc.health.memPercent !== null) {
      issues.push({
        key: `${svc.name}|memory`,
        name: svc.name,
        tone: svc.health.status === 'critical' ? 'down' : 'slow',
        text: `memory at ${Math.round(svc.health.memPercent)}% of its configured limit${
          svc.health.status === 'critical' ? ' — at risk of being OOM-killed' : ''
        }`,
      });
    }
  }
  const visible = issues.filter((i) => !dismissed.has(i.key));
  if (visible.length === 0) return null;

  function dismiss(key) {
    setDismissed((prev) => new Set(prev).add(key));
  }

  return (
    <div className="mb-5 border border-down/30 bg-down/5 rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-down/20 text-[12px] font-bold uppercase tracking-wider text-down">
        Attention required
      </div>
      <div className="divide-y divide-down/10">
        {visible.map((issue) => (
          <div key={issue.key} className="flex items-center justify-between gap-3 px-3.5 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${issue.tone === 'down' ? 'bg-down' : 'bg-slow'}`}
              />
              <span className="font-mono text-[14px] font-semibold [overflow-wrap:anywhere]">{issue.name}</span>
              <span className="text-[13px] text-ink-dim [overflow-wrap:anywhere]">{issue.text}</span>
            </div>
            <button
              type="button"
              onClick={() => dismiss(issue.key)}
              title="Dismiss"
              className="link-btn shrink-0 text-muted hover:text-ink text-[15px] leading-none"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
