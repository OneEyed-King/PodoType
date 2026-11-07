import InfoDot from './InfoDot.jsx';
import TraceExplorer from './TraceExplorer.jsx';

// This panel is ONLY about the manual full-OTel-agent opt-in
// (BulkOtelSetup/docker-compose.otel.yml) — its "on"/"off" badge reflects
// cfg.otel.enabled and NOTHING else. Earlier this also lit up "on" whenever
// eBPF (Beyla, always-on, zero opt-in — see docker-compose.yml) happened to
// have data for this service, which meant the exact same badge flipped
// between "off — Set up →" and live numbers with nothing the person did —
// indistinguishable from a real feature toggling itself, and exactly the
// kind of thing that makes someone think a working setup just broke (a
// live incident here really did produce "no traces yet" panels with zero
// explanation — see the storage watchdog in server.js for the other half
// of that fix). eBPF's own data now lives in BeylaPanel instead, which
// never renames itself depending on whether traffic happened to show up in
// the last few minutes. See server.js "trace.source" for how the two are
// told apart server-side rather than guessed at here.
export default function TracingPanel({ svc, cfg, expanded, onToggleExpanded, supportedOtelLanguages, onSetup, onDisable, onShowInstructions }) {
  const otelAgentSetup = Boolean(cfg.otel && cfg.otel.enabled);
  const trace = svc.trace;
  // Only ever true for a same-name hit — see server.js's trace.source
  // comment. A Beyla-sourced trace never lights this panel up.
  const hasAgentData = Boolean(trace && trace.source === 'agent');
  const p95Text = hasAgentData && trace.p95Ms !== null && trace.p95Ms !== undefined ? `${Math.round(trace.p95Ms)}ms` : '—';

  return (
    <div className="bg-panel-recessed border border-border-soft rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-soft text-[12px] font-bold uppercase tracking-wider text-muted">
        <span className="inline-flex items-center gap-1.5">
          Tracing
          <InfoDot
            title={`Real cross-service trace waterfalls, via an OpenTelemetry agent. Not zero-touch: needs one shared compose file applied alongside your main one (PodoType generates and keeps it up to date — covers every traced service, not just this one). Supported languages: ${
              supportedOtelLanguages.join(', ') || 'none yet'
            }.`}
          />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`font-mono text-[11px] ${otelAgentSetup ? 'text-accent' : 'text-muted'}`}>
            {otelAgentSetup ? 'on' : 'off'}
          </span>
          {otelAgentSetup && (
            <button
              type="button"
              onClick={onToggleExpanded}
              title={expanded ? 'Collapse' : 'Expand'}
              className={`link-btn transition-transform ${expanded ? 'rotate-180 text-accent' : ''}`}
            >
              ⌄
            </button>
          )}
        </span>
      </div>

      <div className="px-2.5 py-2">
        {!otelAgentSetup && (
          <div className="text-[13px] text-muted">
            off —{' '}
            <button type="button" onClick={onSetup} className="link-btn text-accent">
              Set up →
            </button>{' '}
            for full code-level spans (eBPF already covers this service automatically — see the eBPF panel below).
          </div>
        )}

        {otelAgentSetup && !hasAgentData && (
          <div className="text-[13px] text-muted">
            Enabled — waiting for its first spans from this service's own OpenTelemetry agent. This can take a minute after
            first applying the setup file, or after a restart.
          </div>
        )}

        {otelAgentSetup && hasAgentData && (
          <TraceExplorer
            serviceName={svc.name}
            p95Text={p95Text}
            slow={Boolean(trace.slow)}
            statusText={trace.status === 'recent' ? 'sampled' : 'no recent traces'}
            expanded={expanded}
            footer={
              <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border-soft">
                <button
                  type="button"
                  className="link-btn"
                  onClick={onShowInstructions}
                  title={`This service is set up as ${cfg.otel.language} — opens the one shared setup file covering every traced service, not just this one`}
                >
                  setup file ({cfg.otel.language}) ↗
                </button>
                <button type="button" className="link-btn" onClick={onDisable}>
                  Disable
                </button>
              </div>
            }
          />
        )}

        {otelAgentSetup && !hasAgentData && expanded && (
          <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border-soft">
            <button
              type="button"
              className="link-btn"
              onClick={onShowInstructions}
              title={`This service is set up as ${cfg.otel.language} — opens the one shared setup file covering every traced service, not just this one`}
            >
              setup file ({cfg.otel.language}) ↗
            </button>
            <button type="button" className="link-btn" onClick={onDisable}>
              Disable
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
