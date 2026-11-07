import { useEffect, useState } from 'react';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

// Topology changes far slower than up/down status does — no point polling
// this as fast as App.jsx's own 5s status poll.
const MAP_POLL_MS = 10000;

const COL_WIDTH = 200;
const ROW_HEIGHT = 64;
const NODE_WIDTH = 152;
const NODE_HEIGHT = 44;
const PADDING = 24;

// Assigns each node a column = the length of the longest call chain leading
// to it (a plain Sugiyama-style layering, Kahn's algorithm with the
// "distance so far" carried along instead of just an ordering) — callers
// end up left of their callees, which is the one property that actually
// makes a service map readable as "who calls whom" rather than a random
// scatter. A request graph SHOULD be a DAG, but isn't guaranteed to be one
// in practice — a genuine bidirectional integration, a retry loop, or (as
// confirmed live on this project) two real services merging into one node
// because of a name collision upstream, can all produce a cycle. Plain
// Kahn's algorithm has no valid seed node once every node has an
// unprocessed caller, which is exactly what was collapsing every node into
// column 0 before this fix — a real service map went fully vertical with
// no horizontal room for the connecting lines. The loop below now breaks a
// stall by force-picking the least-blocked remaining node as a new root
// (fewest still-unmet incoming edges) — a standard feedback-arc-set
// heuristic, not globally optimal but always terminating (the outer guard
// stays as a hard backstop) and always producing a genuinely left-to-right
// layout instead of a degenerate single column.
// Same threshold server.js/clickhouse.js already use for a node's own
// `slow` flag (SLOW_THRESHOLD_MS) — kept in sync here so an edge label
// and a node's border never disagree about what counts as slow.
const SLOW_EDGE_MS = 500;

function computeColumns(nodes, edges) {
  const names = nodes.map((n) => n.name);
  const nameSet = new Set(names);
  const outgoing = new Map(names.map((n) => [n, []]));
  const incomingCount = new Map(names.map((n) => [n, 0]));
  for (const e of edges) {
    if (!nameSet.has(e.from) || !nameSet.has(e.to) || e.from === e.to) continue;
    outgoing.get(e.from).push(e.to);
    incomingCount.set(e.to, (incomingCount.get(e.to) || 0) + 1);
  }

  const column = new Map(names.map((n) => [n, 0]));
  const remaining = new Map(incomingCount);
  const queue = names.filter((n) => incomingCount.get(n) === 0);
  const processed = new Set();
  let guard = names.length * names.length + names.length; // generous but finite

  while (processed.size < names.length && guard-- > 0) {
    if (queue.length === 0) {
      // Stuck on a cycle — every remaining node still has >=1 unprocessed
      // caller, so Kahn's algorithm alone can never seed the queue (this is
      // exactly what collapsed everything into column 0 before this fix:
      // e.g. two nodes with edges both ways, or a name collision that
      // merges two real services into one node with edges pointing both
      // directions). Rather than give up and leave every remaining node at
      // column 0, force-pick the least-blocked one (fewest still-unmet
      // incoming edges, ties broken by name for a stable layout) and treat
      // it as a new root — this is the standard "break one edge of the
      // cycle" move a feedback-arc-set heuristic makes, good enough for a
      // handful of services even if it's not globally optimal.
      let best = null;
      for (const n of names) {
        if (processed.has(n)) continue;
        if (best === null || remaining.get(n) < remaining.get(best) || (remaining.get(n) === remaining.get(best) && n < best)) {
          best = n;
        }
      }
      if (best === null) break;
      queue.push(best);
    }
    const n = queue.shift();
    if (processed.has(n)) continue;
    processed.add(n);
    for (const next of outgoing.get(n)) {
      column.set(next, Math.max(column.get(next), column.get(n) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) <= 0 && !processed.has(next)) queue.push(next);
    }
  }
  return column;
}

function layoutGraph(nodes, edges) {
  const column = computeColumns(nodes, edges);
  const byColumn = new Map();
  for (const node of nodes) {
    const col = column.get(node.name) || 0;
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col).push(node);
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => b.requestCount - a.requestCount || a.name.localeCompare(b.name));
  }

  const positions = new Map();
  const maxCol = Math.max(0, ...byColumn.keys());
  const maxRows = Math.max(1, ...[...byColumn.values()].map((l) => l.length));

  for (const [col, list] of byColumn) {
    // Center each column vertically against the tallest column, rather
    // than top-aligning everything — a lone node in a short column sitting
    // at the same height as its callers/callees reads more like "one node"
    // and less like an arbitrary list position.
    const colHeight = list.length * ROW_HEIGHT;
    const maxHeight = maxRows * ROW_HEIGHT;
    const offsetY = (maxHeight - colHeight) / 2;
    list.forEach((node, i) => {
      positions.set(node.name, {
        x: PADDING + col * COL_WIDTH,
        y: PADDING + offsetY + i * ROW_HEIGHT,
      });
    });
  }

  return {
    positions,
    width: PADDING * 2 + (maxCol + 1) * COL_WIDTH - (COL_WIDTH - NODE_WIDTH),
    height: PADDING * 2 + maxRows * ROW_HEIGHT - (ROW_HEIGHT - NODE_HEIGHT),
  };
}

// Short human byte count for a network-flow edge's label when there's no
// trace-derived call count to show instead (e.g. "1.2 MB") — cumulative
// over the window, not a rate, same as callCount isn't a rate either.
function fmtBytesShort(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function truncate(name, max = 20) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

// Who-calls-whom, drawn straight from real span data — no separate topology
// tracking anywhere in this codebase, and no charting/graph-layout library
// either (see Sparkline.jsx for the same reasoning): a request graph in a
// self-hosted tool this size rarely has more than a handful of services, so
// a plain layered SVG layout is plenty, and it's one fewer dependency that
// can go stale.
export default function ServiceMap() {
  const [map, setMap] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .serviceMap()
        .then((body) => {
          if (!cancelled) {
            setMap(body);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    }
    tick();
    const id = setInterval(tick, MAP_POLL_MS);
    const onVisible = () => {
      if (!cancelled && !document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (error) {
    return <div className="text-[14px] text-down">Couldn't load the service map: {error}</div>;
  }
  if (!map) {
    return <div className="text-[14px] text-muted">Loading service map…</div>;
  }
  if (map.nodes.length === 0) {
    return (
      <div className="text-[14px] text-muted">
        No traced traffic in the last {Math.round(map.lookbackSeconds / 60)} minutes yet — the map fills in once Beyla or an
        OTel agent has captured some real requests.
      </div>
    );
  }

  const { positions, width, height } = layoutGraph(map.nodes, map.edges);
  const nodesByName = new Map(map.nodes.map((n) => [n.name, n]));
  // callCount is null on a self-hosted edge that only has a network-flow
  // (real TCP connection) behind it and no matching trace data yet — see
  // server.js's fetchServiceMap merge comment. Filter those out of the
  // max rather than let a null silently zero out the scaling; bytesTotal
  // gets its own max for edges that have to fall back to it.
  const knownCallCounts = map.edges.map((e) => e.callCount).filter((c) => c !== null && c !== undefined);
  const maxCallCount = Math.max(1, ...knownCallCounts);
  const knownByteTotals = map.edges.map((e) => e.bytesTotal).filter((b) => b !== null && b !== undefined);
  const maxBytesTotal = Math.max(1, ...knownByteTotals);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="font-mono text-[11px] text-muted uppercase tracking-wide">
          Who calls whom — last {Math.round(map.lookbackSeconds / 60)}m of real traffic
        </span>
        <InfoDot title="On self-hosted, an arrow is backed by Beyla's real observed TCP connections (network-flow eBPF capture) whenever one's available this window — that's what a solid line means; trace correlation alone (matching a caller's outbound span to a callee's inbound span by trace ID) fills in call counts and p95 latency, and supplies the edge on its own — shown dashed — when no confirming connection was seen this round. Hosted now confirms edges the same way — real TCP connections its agent observes, forwarded up and matched here. Node names are Beyla's (or an OTel agent's) own service names, which don't always match PodoType's watched-container names — see the dashboard's own 'Beyla name resolution' for why. A service with no callers/callees shown either hasn't made or received a traced request in this window, or only ever gets health-check traffic." />
        {map.edges.some((e) => e.source === 'trace-only') && (
          <span className="flex items-center gap-2 ml-2 font-mono text-[10px] text-muted">
            <span className="flex items-center gap-1">
              <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" className="stroke-muted" strokeWidth="1.5" /></svg>
              confirmed
            </span>
            <span className="flex items-center gap-1">
              <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" className="stroke-muted" strokeWidth="1.5" strokeDasharray="3 3" opacity={0.6} /></svg>
              trace-only
            </span>
          </span>
        )}
      </div>
      <div className="overflow-x-auto border border-border-soft rounded-md bg-panel-recessed">
        <svg width={width} height={height} className="block">
          <defs>
            <marker id="svc-map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 Z" className="fill-muted" />
            </marker>
          </defs>

          {map.edges.map((e, i) => {
            const from = positions.get(e.from);
            const to = positions.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const midX = (x1 + x2) / 2;
            // Thicker line for a busier edge — scaled against the busiest
            // edge on THIS map rather than a fixed constant, so it stays
            // meaningful whether traffic is 5 req or 5000 req in the window.
            // Falls back to the flow's byte total when there's no trace-
            // derived call count for it (a network-only edge — see
            // server.js's fetchServiceMap merge comment).
            const hasCallCount = e.callCount !== null && e.callCount !== undefined;
            const strokeWidth = hasCallCount
              ? 1 + (e.callCount / maxCallCount) * 2.5
              : 1 + ((e.bytesTotal || 0) / maxBytesTotal) * 2.5;
            // A network-flow-confirmed edge (real TCP connection observed
            // this window — source 'network'/'network+trace') draws
            // solid; 'trace-only' (no confirming flow this round — see
            // fetchServiceMap's own comment on why those are kept, not
            // dropped) draws dashed, so a look at the map itself shows
            // which edges are backed by an actual observed connection
            // versus trace correlation alone. Both builds send `source`
            // now (see clickhouse.js's serviceMap on the hosted side,
            // fetchServiceMap on self-hosted's) — `undefined` is only a
            // defensive fallback (e.g. an older cached response) and
            // reads the same as confirmed rather than flagging every edge
            // as unconfirmed.
            const unconfirmed = e.source === 'trace-only';
            // Latency label sits at the curve's midpoint, on a small
            // panel-colored backdrop so it stays legible over crossing
            // edges — previously this number only existed in a hover
            // tooltip, which meant you had to already suspect a specific
            // edge was slow before you'd ever see its number. Showing it
            // permanently is what actually lets "which hop is slow" jump
            // out at a glance, the way Coroot's and Grafana's own service
            // maps both label edges directly rather than gating the
            // number behind a hover.
            const midY = (y1 + y2) / 2;
            const edgeLabel = hasCallCount
              ? e.p95Ms !== null
                ? `${e.callCount} · ${Math.round(e.p95Ms)}ms`
                : `${e.callCount}`
              : fmtBytesShort(e.bytesTotal);
            const labelWidth = 11 + edgeLabel.length * 5.2;
            return (
              <g key={`${e.from}->${e.to}-${i}`}>
                <path
                  d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                  fill="none"
                  className="stroke-muted"
                  strokeWidth={strokeWidth}
                  strokeOpacity={unconfirmed ? 0.35 : 0.6}
                  strokeDasharray={unconfirmed ? '3 3' : undefined}
                  markerEnd="url(#svc-map-arrow)"
                >
                  <title>
                    {e.from} → {e.to}
                    {hasCallCount ? `: ${e.callCount} call${e.callCount === 1 ? '' : 's'}` : `: ${fmtBytesShort(e.bytesTotal)} observed`}
                    {e.p95Ms !== null ? `, p95 ${Math.round(e.p95Ms)}ms` : ''}
                    {unconfirmed
                      ? ' — from trace data only, no live TCP connection observed this window'
                      : e.source
                      ? ' — confirmed by a real TCP connection'
                      : ''}
                  </title>
                </path>
                <rect
                  x={midX - labelWidth / 2}
                  y={midY - 7}
                  width={labelWidth}
                  height={13}
                  rx="3"
                  className="fill-panel"
                  opacity={0.92}
                />
                <text
                  x={midX}
                  y={midY + 2.5}
                  textAnchor="middle"
                  className={`font-mono text-[8px] ${e.p95Ms !== null && e.p95Ms > SLOW_EDGE_MS ? 'fill-slow' : 'fill-muted'}`}
                >
                  {edgeLabel}
                </text>
              </g>
            );
          })}

          {map.nodes.map((node) => {
            const pos = positions.get(node.name);
            if (!pos) return null;
            const n = nodesByName.get(node.name);
            const borderColor = n.slow ? 'stroke-slow' : n.requestCount > 0 ? 'stroke-accent' : 'stroke-border';
            return (
              <g key={node.name} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx="6"
                  className={`fill-panel-raised ${borderColor}`}
                  strokeWidth="1.5"
                >
                  <title>
                    {node.name}
                    {node.requestCount > 0 ? ` — ${node.requestCount} inbound req, p95 ${Math.round(node.p95Ms)}ms` : ' — no inbound traffic seen'}
                  </title>
                </rect>
                <text x={NODE_WIDTH / 2} y={17} textAnchor="middle" className="fill-ink font-mono text-[11px] font-semibold">
                  {truncate(node.name)}
                </text>
                <text x={NODE_WIDTH / 2} y={32} textAnchor="middle" className="fill-muted font-mono text-[9px]">
                  {node.requestCount > 0 ? `${node.requestCount} req · p95 ${Math.round(node.p95Ms)}ms` : 'no inbound traffic'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
