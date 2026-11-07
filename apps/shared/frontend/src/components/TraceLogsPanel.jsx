import { useEffect, useState } from 'react';
import { api } from '../api.js';

// The thread's other recurring ask: "correlated logs that repair broken
// context." This is a best-effort version of that, not real trace-log
// correlation (which needs trace context injected into log lines, which
// zero-code eBPF instrumentation can't do) — it's every involved
// service's own logs, windowed to roughly when this trace was in flight.
// See server.js's /api/traces/:id/logs comment for the exact assumption
// this makes (trace service name == container/log name) and where that
// can be wrong.
export default function TraceLogsPanel({ traceId }) {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!api.traceLogs || !open) return;
    let cancelled = false;
    setState(null);
    api
      .traceLogs(traceId)
      .then((body) => {
        if (!cancelled) setState(body);
      })
      .catch((err) => {
        if (!cancelled) setState({ available: false, reason: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [traceId, open]);

  if (!api.traceLogs) return null;

  return (
    <div className="mt-3 border border-border rounded-lg px-3.5 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[12px] font-bold uppercase tracking-wider text-ink-dim"
      >
        <span>Logs during this trace</span>
        <span className="font-mono text-[11px] text-muted normal-case">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="mt-2">
          {!state && <div className="text-[12px] text-muted">loading…</div>}
          {state && !state.available && (
            <div className="text-[12px] text-muted">no logs found in this trace's window</div>
          )}
          {state && state.available && state.lines.length === 0 && (
            <div className="text-[12px] text-muted">no matching log lines in this trace's time window</div>
          )}
          {state && state.available && state.lines.length > 0 && (
            <div className="font-mono text-[11px] leading-relaxed max-h-64 overflow-y-auto space-y-0.5">
              {state.lines.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-muted whitespace-nowrap">{l.ts ? l.ts.slice(11, 23) : '--:--:--'}</span>
                  <span className="text-accent whitespace-nowrap">[{l.service}]</span>
                  <span className="text-ink-dim break-all">{l.line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
