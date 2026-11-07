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
const POLL_MS = 15000;

export default function PreflightBanner() {
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

  if (!preflight || preflight.status !== 'error') return null; // 'ok', or not loaded yet — nothing to interrupt the page for

  return (
    <div className="mb-5 border border-down/40 bg-down/5 rounded-lg px-3.5 py-2.5">
      <div className="text-[12px] font-bold uppercase tracking-wider text-down mb-1">Tracing isn't working</div>
      <div className="text-[13px] text-ink leading-relaxed">{preflight.message}</div>
    </div>
  );
}
