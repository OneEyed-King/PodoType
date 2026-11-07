import { useEffect, useState } from 'react';
import { api } from '../api.js';

// The recurring Reddit ask, now built: not just "this service is slow,"
// but a first guess at WHY, pulled from the slowest/erroring span in a
// recent real trace (server.js's buildPossibleCause — see that file's own
// section comment). Deliberately hedged everywhere: "possible cause," not
// "root cause" — this is correlation from one trace, not a diagnosis, and
// every message already reads that way server-side. Available on both
// builds now (hostedApi.js grew its own possibleCause route — see
// license-server/clickhouse.js); the api.possibleCause existence check
// below is kept anyway as the generic "datasource doesn't have this
// optional feature" guard, same as preflight's own.
export default function PossibleCauseCard({ serviceName }) {
  const [state, setState] = useState(null); // null = loading, otherwise the response body

  useEffect(() => {
    if (!api.possibleCause) return; // hosted build — no equivalent route yet
    let cancelled = false;
    setState(null);
    api
      .possibleCause(serviceName)
      .then((body) => {
        if (!cancelled) setState(body);
      })
      .catch((err) => {
        if (!cancelled) setState({ available: false, reason: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  if (!api.possibleCause) return null;
  if (state === null) return null; // loading — avoid a flash of "no data" before the first response
  if (!state.available) return null; // no recent traces to reason about yet — nothing useful to show

  return (
    <div className="mb-3 border border-border rounded-lg px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Possible cause</span>
        <span
          className={`font-mono text-[11px] font-bold rounded-full px-2 py-0.5 border ${
            state.isError ? 'text-down bg-down/10 border-down/30' : 'text-slow bg-slow/10 border-slow/30'
          }`}
        >
          {state.sharePercent !== null ? `${state.sharePercent}% of request time` : state.isError ? 'error' : 'slow'}
        </span>
      </div>
      <div className="text-[13px] text-ink leading-relaxed mb-2">{state.message}</div>
      <div className="text-[13px] text-ink-dim leading-relaxed">
        <span className="font-semibold text-ink">Suggested next step: </span>
        {state.nextStep}
      </div>
      <div className="text-[11px] text-muted mt-2">
        Based on one recent trace ({state.traceId.slice(0, 12)}…) — a possible explanation, not a confirmed diagnosis.
      </div>
    </div>
  );
}
