import { useEffect, useRef, useState } from 'react';

// The relative-range list every mainstream APM/observability tool
// converges on (Grafana's quick ranges, Datadog's timeframe selector,
// Honeycomb's time picker) — fine-grained at the short end (5m/15m/30m,
// where you actually want minute-level resolution while chasing something
// that just happened) and coarser once you're looking back far enough that
// minute-level precision stops mattering. What this app had before jumped
// straight from "1 hour" to "24 hours" to "7 days" with nothing in
// between, which is the exact gap being fixed here.
export const TIME_RANGE_OPTIONS = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '3h', minutes: 180 },
  { label: '6h', minutes: 360 },
  { label: '12h', minutes: 720 },
  { label: '24h', minutes: 1440 },
  { label: '2d', minutes: 2880 },
  { label: '7d', minutes: 10080 },
  { label: '30d', minutes: 43200 },
];

export function formatRangeMinutes(minutes) {
  const known = TIME_RANGE_OPTIONS.find((o) => o.minutes === minutes);
  if (known) return known.label;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// A single "Last X ▾" button that opens a short dropdown list on click —
// the same interaction shape Grafana/Datadog/Honeycomb all settled on for
// time-range selection, and deliberately NOT a permanent row of pill
// buttons: ten-plus presets (5m through 7d) is too many buttons to keep
// sitting on screen next to a data panel at all times, but collapses to a
// single control here. Selecting a preset applies it immediately — a
// relative range is unambiguous, so there's nothing to "Apply" separately
// the way a custom absolute range would need.
export default function TimeRangePicker({ minutes, onChange, allowLive = true, liveLabel = 'Live' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentLabel = minutes === null ? liveLabel : formatRangeMinutes(minutes);

  function pick(value) {
    onChange(value);
    setOpen(false);
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // Same size/shape every other secondary button in this app uses
        // (Jump, + Add service, Bulk tracing setup, …) — this used to be a
        // small standalone accent pill, which read as a different kind of
        // control instead of just another button in the row.
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-md px-3.5 py-1.5 border text-ink bg-panel-raised border-border hover:border-accent hover:text-accent"
        title="Change time range"
      >
        {currentLabel}
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 right-0 min-w-[8.5rem] bg-panel-raised border border-border-soft rounded-md shadow-lg py-1 flex flex-col max-h-72 overflow-auto">
          {allowLive && (
            <button
              type="button"
              onClick={() => pick(null)}
              className={`text-left px-3 py-1 text-[13px] font-mono hover:bg-accent/10 ${
                minutes === null ? 'text-accent font-semibold' : 'text-ink-dim'
              }`}
            >
              {liveLabel}
            </button>
          )}
          {TIME_RANGE_OPTIONS.map((o) => (
            <button
              key={o.minutes}
              type="button"
              onClick={() => pick(o.minutes)}
              className={`text-left px-3 py-1 text-[13px] font-mono hover:bg-accent/10 ${
                minutes === o.minutes ? 'text-accent font-semibold' : 'text-ink-dim'
              }`}
            >
              Last {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
