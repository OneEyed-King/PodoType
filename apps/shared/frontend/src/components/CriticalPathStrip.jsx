import { useEffect, useState } from 'react';
import { api } from '../api.js';

// The recurring Reddit ask: "does one real problem show up as one
// group, or 500 separate traces" was about incident grouping
// (IncidentPanel/IncidentDetail handle that); this is the OTHER half of
// that same thread — "which span is the root cause, where did the time
// actually go across the WHOLE chain, not just one service's own span."
// buildCriticalPathChain (server.js) walks the ancestry of whichever
// span was still running when the trace finally ended — the sequence of
// calls that was still "on the hook" for the total latency. Deliberately
// labeled "approximate," same hedging posture as PossibleCauseCard: this
// is the ancestry chain of the last-finishing span, not a full
// concurrent-gap-analysis critical path.
export default function CriticalPathStrip({ traceId }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!api.criticalPath) return;
    let cancelled = false;
    setState(null);
    api
      .criticalPath(traceId)
      .then((body) => {
        if (!cancelled) setState(body);
      })
      .catch((err) => {
        if (!cancelled) setState({ available: false, reason: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  if (!api.criticalPath) return null;
  if (!state || !state.available || !state.chain || state.chain.length === 0) return null;

  return (
    <div className="mb-3 border border-border rounded-lg px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Critical path</span>
        <span className="font-mono text-[11px] text-muted">approximate</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {state.chain.map((hop, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div
              className={`rounded-md border px-2 py-1 text-[12px] ${
                hop.isError ? 'border-down/40 bg-down/10 text-down' : 'border-border-soft bg-bg-raised text-ink'
              }`}
              title={hop.operation}
            >
              <span className="font-semibold">{hop.service}</span>
              <span className="text-ink-dim"> · {Math.round(hop.durationMs)}ms</span>
            </div>
            {i < state.chain.length - 1 && <span className="text-muted">→</span>}
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted mt-2">
        The chain of calls still running when this request finally finished — not every span that ran, just the ones on the hook for the total time.
      </div>
    </div>
  );
}
