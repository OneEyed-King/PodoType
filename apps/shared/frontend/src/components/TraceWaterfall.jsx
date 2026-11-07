import { useState } from 'react';

// A minimal Gantt-style waterfall: one bar per span, positioned by its
// offset from the trace's start and sized by its own duration, both as a
// percentage of the trace's total duration. No charting library needed —
// this is exactly what answers "where did the time go": the widest bar is
// the bottleneck, and its left position shows where in the request it fell.
//
// Spans are shown as a real call tree (indented by parent-child depth, in
// call order), not a flat list — a slow span means something different
// depending on whether it's a top-level hop or three calls deep inside
// another one, and "which service called which" is the whole point of a
// *distributed* trace once more than one service is instrumented.

// The server already truncates to the top 15 spans by duration (see
// fetchTraceDetail) — that can leave a child in the list whose parent got
// cut. Rather than dropping those or erroring, treat any span whose parent
// isn't present in this response as a root of its own — it still renders,
// just without a visual parent to nest under.
function buildForest(spans) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const childrenOf = new Map();
  const roots = [];

  for (const s of spans) {
    const hasParentHere = s.parentSpanId && byId.has(s.parentSpanId);
    if (hasParentHere) {
      if (!childrenOf.has(s.parentSpanId)) childrenOf.set(s.parentSpanId, []);
      childrenOf.get(s.parentSpanId).push(s);
    } else {
      roots.push(s);
    }
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.offsetMs - b.offsetMs);
  }
  roots.sort((a, b) => a.offsetMs - b.offsetMs);

  // Flatten to display order (each node right after its parent, children in
  // call order) with a depth for indentation. Depth is capped defensively —
  // span data from Tempo is trusted, but there's no reason to let a
  // malformed parent chain recurse unbounded.
  const ordered = [];
  function visit(span, depth) {
    ordered.push({ span, depth: Math.min(depth, 8) });
    for (const child of childrenOf.get(span.spanId) || []) {
      visit(child, depth + 1);
    }
  }
  for (const root of roots) visit(root, 0);
  return ordered;
}

// Attribute-inspector drawer — what groundcover/Datadog/Grafana all show
// when you click a span: the raw key/value pairs OTel captured for it
// (http.method, db.statement, whatever the instrumentation sent), not just
// whatever's already summarized in the waterfall row. Previously nothing
// here was clickable at all; the row text was the only information you
// could ever see about a span. Collapsed into this one small component so
// TraceWaterfall itself doesn't have to know about attribute formatting.
function SpanAttributesDrawer({ span, onClose }) {
  const attrs = span.attributes && typeof span.attributes === 'object' ? span.attributes : {};
  const keys = Object.keys(attrs).sort();
  return (
    <div className="mt-2 border border-border-soft rounded-md bg-panel-recessed overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft">
        <div className="font-mono text-[12px] min-w-0">
          <span className="text-ink font-semibold">{span.service}</span>{' '}
          <span className="text-ink-dim">· {span.operation}</span>
          {span.isError && (
            <span className="ml-1.5 pill pill-down text-[11px] align-middle">{span.httpStatusCode || 'error'}</span>
          )}
        </div>
        <button type="button" className="link-btn text-[12px] shrink-0" onClick={onClose}>
          Close ✕
        </button>
      </div>
      <div className="px-2.5 py-2 flex flex-col gap-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
          <span>
            span <span className="text-ink-dim">{span.spanId.slice(0, 16)}…</span>
          </span>
          <span>
            duration <span className="text-ink-dim">{Math.round(span.durationMs)}ms</span>
          </span>
          <span>
            offset <span className="text-ink-dim">+{Math.round(span.offsetMs)}ms</span>
          </span>
          {span.parentSpanId && (
            <span>
              parent <span className="text-ink-dim">{span.parentSpanId.slice(0, 16)}…</span>
            </span>
          )}
        </div>
        <div>
          <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1">
            Attributes {keys.length > 0 && `(${keys.length})`}
          </div>
          {keys.length === 0 ? (
            <div className="text-[12px] text-muted">No span attributes recorded for this one.</div>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
              {keys.map((k) => (
                <div key={k} className="flex gap-2 font-mono text-[12px] py-0.5 [overflow-wrap:anywhere]">
                  <span className="text-muted shrink-0">{k}</span>
                  <span className="text-ink-dim">{String(attrs[k])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TraceWaterfall({ detail }) {
  // Which span's attribute drawer is open, if any — reset per trace (via
  // `key` on this component at the call site would also work, but tracking
  // it here means re-selecting the same span across a live-refreshed
  // `detail` just keeps the drawer open rather than needing a remount).
  const [selectedSpanId, setSelectedSpanId] = useState(null);

  if (!detail || detail.spans.length === 0) {
    return <div className="text-[13px] text-muted mt-2">No span data for this trace.</div>;
  }

  if (detail.spans.length === 1) {
    const only = detail.spans[0];
    return (
      <div className="mt-2 text-[13px] text-muted">
        Single-span trace — nothing to compare against. This usually means a background call with no downstream
        calls of its own (e.g. a connection-pool keepalive), not a full request: {only.service} · {only.operation} ·{' '}
        {Math.round(only.durationMs)}ms.
      </div>
    );
  }

  const total = detail.durationMs || Math.max(...detail.spans.map((s) => s.offsetMs + s.durationMs), 1);
  const slowestId = detail.spans[0].spanId;
  const ordered = buildForest(detail.spans);
  const selectedSpan = selectedSpanId ? detail.spans.find((s) => s.spanId === selectedSpanId) || null : null;

  // Crossing a service boundary is the actual "distributed" part of a
  // distributed trace — call it out visually so it's obvious at a glance
  // when a slow span was this service's own work vs. a downstream service
  // it called into.
  const serviceCount = new Set(detail.spans.map((s) => s.service)).size;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="font-mono text-[12px] text-muted">
        trace {detail.traceId.slice(0, 12)}… · {Math.round(detail.durationMs)}ms total
        {serviceCount > 1 ? ` · crosses ${serviceCount} services` : ''}
        {detail.spanCount > detail.spans.length ? ` · showing ${detail.spans.length}/${detail.spanCount} spans` : ''}
        <span className="text-ink-dim"> · click a span for its attributes</span>
      </div>
      {ordered.map(({ span: s, depth }, i) => {
        const leftPct = total > 0 ? (s.offsetMs / total) * 100 : 0;
        const widthPct = total > 0 ? Math.max((s.durationMs / total) * 100, 0.8) : 100;
        const isSlowest = s.spanId === slowestId;
        const isSelected = s.spanId === selectedSpanId;
        // A service boundary is a call from one service into a different
        // one — mark it on the child, since that's the hop that crossed.
        const parentInOrder = i > 0 ? ordered[i - 1] : null;
        const crossesService =
          depth > 0 && parentInOrder && parentInOrder.depth === depth - 1 && parentInOrder.span.service !== s.service;
        return (
          <button
            type="button"
            key={s.spanId}
            onClick={() => setSelectedSpanId((prev) => (prev === s.spanId ? null : s.spanId))}
            className={`text-[12px] text-left w-full rounded px-1 py-0.5 -mx-1 border ${
              isSelected ? 'border-accent bg-accent/5' : 'border-transparent hover:border-border-soft'
            }`}
            style={{ marginLeft: `${depth * 14}px` }}
          >
            <div className="flex justify-between font-mono text-muted mb-0.5">
              <span className="[overflow-wrap:anywhere]">
                {depth > 0 && <span className="text-ink-dim">↳ </span>}
                <span className={crossesService ? 'text-accent font-semibold' : ''}>{s.service}</span>{' '}
                <span className="text-ink-dim">· {s.operation}</span>
                {s.isError && (
                  <span className="ml-1.5 pill pill-down text-[11px] align-middle">
                    {s.httpStatusCode || 'error'}
                  </span>
                )}
              </span>
              <span className={isSlowest || s.isError ? 'text-down font-bold shrink-0' : 'shrink-0'}>
                {Math.round(s.durationMs)}ms
              </span>
            </div>
            <div className="h-1.5 w-full bg-border-soft rounded-sm relative">
              <div
                className={`h-1.5 rounded-sm absolute ${isSlowest || s.isError ? 'bg-down' : 'bg-accent'}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            </div>
          </button>
        );
      })}
      <div className="font-mono text-[11px] text-muted mt-0.5">
        red bar = the single slowest span in this trace, or one that returned an error — that's usually where to
        start looking.
        {serviceCount > 1 ? ' Highlighted service names mark where the call crossed into another service.' : ''}
      </div>
      {selectedSpan && <SpanAttributesDrawer span={selectedSpan} onClose={() => setSelectedSpanId(null)} />}
    </div>
  );
}
