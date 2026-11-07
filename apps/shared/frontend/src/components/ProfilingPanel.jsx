// Continuous profiling landing panel — the last of the Reddit feature
// pass's four items (possible-cause, critical path, trace-window logs,
// this). Deliberately NOT a custom flamegraph renderer: Parca already
// ships its own web UI (see docker-compose.yml's profiler/profiler-agent
// services), and building a second one here would just be duplicating
// work for no real benefit over linking to it directly. This whole
// feature is marked NEW/UNTESTED in docker-compose.yml's own comment —
// this panel is honest about that rather than pretending it's a finished,
// verified part of the product.
export default function ProfilingPanel() {
  // Not published to the host by default (see docker-compose.yml) —
  // someone turning this on for real needs to either publish a port for
  // `profiler` there or reverse-proxy it, then point this at that URL.
  // Left as a plain constant rather than wiring a settings UI for a
  // feature that hasn't been verified against a real host yet.
  const PARCA_UI_URL = 'http://localhost:7070';

  return (
    <div className="border border-border rounded-lg px-4 py-3.5">
      <div className="text-[13px] text-ink leading-relaxed mb-2">
        Continuous CPU profiling via Parca Agent (eBPF, zero code changes) — profiles every
        process on the host all the time, so "where did the CPU go" has an answer even without
        an incident to trigger it.
      </div>
      <div className="text-[12px] text-ink-dim leading-relaxed mb-3">
        This is new and not yet verified end-to-end on a real host — see docker-compose.yml's
        profiler/profiler-agent services. Parca ships its own flamegraph UI rather than this app
        building a second one.
      </div>
      <a
        href={PARCA_UI_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-[12px] font-semibold text-accent border border-accent/40 rounded-md px-3 py-1.5 hover:bg-accent/10"
      >
        Open Parca UI →
      </a>
    </div>
  );
}
