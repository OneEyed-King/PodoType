// Four-number "is anything on fire" strip — Watched / Healthy / Attention /
// Unknown — meant to answer that question before scrolling to a single
// service row. Distinct from AttentionBanner below it: that's a dismissible
// list of the SPECIFIC issues (down services, slow traces, low disk);
// this is a permanent, always-visible count, closer to a dashboard's own
// header stat strip than a warning banner. `services` is whatever list the
// caller already has on hand with `.up` on each entry (self-hosted's
// statusServices, hosted's watchedServices) — same boolean/null convention
// both builds already use (true = up, false = down, null/undefined =
// not yet known), so this works unmodified for either.
export default function StatusSummaryStrip({ services }) {
  const watched = services.length;
  const healthy = services.filter((s) => s.up === true).length;
  const attention = services.filter((s) => s.up === false).length;
  const unknown = watched - healthy - attention;

  const cells = [
    { key: 'watched', label: 'Watched', value: watched, sub: 'containers in view', cls: 'text-accent', dot: 'bg-accent' },
    { key: 'healthy', label: 'Healthy', value: healthy, sub: 'reporting up', cls: 'text-up', dot: 'bg-up' },
    {
      key: 'attention',
      label: 'Attention',
      value: attention,
      sub: 'down or degraded',
      cls: attention > 0 ? 'text-down' : 'text-ink-dim',
      dot: attention > 0 ? 'bg-down' : 'bg-unknown',
    },
    { key: 'unknown', label: 'Unknown', value: unknown, sub: 'health not confirmed', cls: 'text-ink-dim', dot: 'bg-unknown' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border-soft border border-border-soft rounded-lg overflow-hidden mb-5">
      {cells.map((c) => (
        <div key={c.key} className="bg-panel px-4 py-3">
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-muted">
            <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
            {c.label}
          </div>
          <div className={`font-mono text-[20px] font-bold leading-tight mt-0.5 ${c.cls}`}>
            {String(c.value).padStart(2, '0')}
          </div>
          <div className="text-[12px] text-muted mt-0.5">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
