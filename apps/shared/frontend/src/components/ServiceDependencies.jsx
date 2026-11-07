import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Upstream/downstream list for ONE service, inline in its own expanded
// row — same edge data ServiceMap.jsx already draws as a full graph (see
// that file's own fetch of api.serviceMap()), just filtered down to the
// handful of edges touching this one service and shown as plain text
// instead of a canvas layout. This is the thing Coroot does that the
// full-page Service Map didn't: seeing what a service talks to WITHOUT
// leaving the row you're already looking at. Deliberately a separate,
// tiny fetch rather than lifting ServiceMap's poll into App.jsx — the
// service-map query is cheap (capped at 200 edges server-side) and this
// only runs for rows someone actually expanded this panel on, same
// "fetched only once opened" posture ServiceAlertOverrides/LogsPanel
// already use elsewhere in this row.
export default function ServiceDependencies({ serviceName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .serviceMap()
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  if (error) return <div className="text-[13px] text-down">{error}</div>;
  if (!data) return <div className="text-[13px] text-muted">loading…</div>;

  const edges = data.edges || [];
  const upstream = edges.filter((e) => e.to === serviceName && e.from !== serviceName);
  const downstream = edges.filter((e) => e.from === serviceName && e.to !== serviceName);

  if (upstream.length === 0 && downstream.length === 0) {
    return (
      <div className="text-[13px] text-muted">
        No call relationships seen for this service in the last {Math.round((data.lookbackSeconds || 300) / 60)} minutes
        — either nothing calls it (or it calls nothing) yet, or there's not enough trace data.
      </div>
    );
  }

  function EdgeRow({ label, other, callCount, p95Ms }) {
    return (
      <div className="flex items-center gap-2 text-[13px] font-mono">
        <span className="text-muted w-16 shrink-0">{label}</span>
        <span className="text-ink font-semibold [overflow-wrap:anywhere]">{other}</span>
        <span className="text-muted text-[12px] ml-auto shrink-0">
          {callCount} call{callCount === 1 ? '' : 's'} · p95 {Math.round(p95Ms)}ms
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {upstream.map((e) => (
        <EdgeRow key={`up:${e.from}`} label="called by" other={e.from} callCount={e.callCount} p95Ms={e.p95Ms} />
      ))}
      {downstream.map((e) => (
        <EdgeRow key={`down:${e.to}`} label="calls" other={e.to} callCount={e.callCount} p95Ms={e.p95Ms} />
      ))}
    </div>
  );
}
