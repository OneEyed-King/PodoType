import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  // Not published to the host by default (see docker-compose.yml) —
  // someone turning this on for real needs to either publish a port for
  // `profiler` there or reverse-proxy it, then point this at that URL.
  // Left as a plain constant rather than wiring a settings UI for a
  // feature that hasn't been verified against a real host yet.
  const PARCA_UI_URL = 'http://localhost:7070';

  return (
    <div className="border border-border rounded-lg px-4 py-3.5">
      <div className="text-[13px] text-ink leading-relaxed mb-2">{t('profilingPanel.description')}</div>
      <div className="text-[12px] text-ink-dim leading-relaxed mb-3">{t('profilingPanel.newNote')}</div>
      <a
        href={PARCA_UI_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-[12px] font-semibold text-accent border border-accent/40 rounded-md px-3 py-1.5 hover:bg-accent/10"
      >
        {t('profilingPanel.openParca')}
      </a>
    </div>
  );
}
