import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Reddit feedback (investigatormaker): when eBPF tracing silently
// captures nothing — missing BTF, insufficient kernel capabilities, beyla
// failed to start — this app gave no visible explanation, just empty
// charts indistinguishable from "no traffic yet." This banner surfaces
// the named failure from GET /api/preflight (engine server.js) instead of
// leaving that to guesswork. Self-hosted only right now — see
// engineApi.js's own comment on why hostedApi.js has no equivalent yet;
// `api.preflight` is undefined on that build, so this renders nothing
// there rather than erroring.
//
// 'error' (BTF missing / beyla unreachable) and 'warning' (beyla's up and
// BTF's there, but it still hasn't resolved any real traffic — confirmed
// live on Docker Desktop/WSL2, where eBPF can't see into a container's
// actual processes even though both checks above pass) get their own
// styling: 'error' is a hard problem to fix on the host side, 'warning' is
// "this platform may just not support eBPF — use Code Tracing instead,"
// which is why only 'warning' gets the one-click link there.
const POLL_MS = 15000;

const VARIANTS = {
  error: { label: "Tracing isn't working", border: 'border-down/40', bg: 'bg-down/5', text: 'text-down' },
  warning: {
    label: 'No traffic captured yet',
    border: 'border-slow/40',
    bg: 'bg-slow/5',
    text: 'text-slow',
  },
};

export default function PreflightBanner({ onGoToCodeTracing }) {
  const [preflight, setPreflight] = useState(null);

  useEffect(() => {
    if (!api.preflight) return; // hosted build — no preflight endpoint yet
    let cancelled = false;
    function tick() {
      api
        .preflight()
        .then((body) => {
          if (!cancelled) setPreflight(body);
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

  const variant = preflight && VARIANTS[preflight.status];
  if (!variant) return null; // 'ok', or not loaded yet — nothing to interrupt the page for

  return (
    <div className={`mb-5 border ${variant.border} ${variant.bg} rounded-lg px-3.5 py-2.5`}>
      <div className={`text-[12px] font-bold uppercase tracking-wider ${variant.text} mb-1`}>{variant.label}</div>
      <div className="text-[13px] text-ink leading-relaxed">{preflight.message}</div>
      {preflight.status === 'warning' && onGoToCodeTracing && (
        <button
          type="button"
          onClick={onGoToCodeTracing}
          className={`mt-2 text-[12px] font-semibold ${variant.text} underline hover:no-underline`}
        >
          Go to Code Tracing →
        </button>
      )}
    </div>
  );
}
