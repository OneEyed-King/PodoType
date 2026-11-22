import { ACCENT_PRESETS, useAccent } from './AccentPicker.jsx';
import InfoDot from './InfoDot.jsx';

// Accent color selection, moved here from the top bar — same settings-
// panel shape every other Settings entry uses (RetentionPanel,
// LogRetentionPanel, PollIntervalsPanel), rather than a small swatch
// button tucked in the header where it was easy to miss and sat oddly
// next to the live HOST/watched-count readout. The actual state and
// persistence (data-accent attribute + localStorage) still lives in
// AccentPicker.jsx's useAccent hook — this just gives it a bigger, more
// discoverable home with all the swatches visible at once instead of
// behind a click-to-open dropdown.
export default function AppearancePanel() {
  const [accent, setAccent] = useAccent();

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center gap-1.5">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Appearance</span>
        <InfoDot title="Pick an accent color for the dashboard. Saved per-browser — it doesn't change anything for anyone else." />
      </div>
      <div className="px-3.5 py-3">
        <div className="text-[12px] text-ink-dim mb-2">Accent color</div>
        <div className="flex items-center gap-2.5 flex-wrap">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setAccent(p.id)}
              title={p.label}
              className="flex flex-col items-center gap-1 group"
            >
              <span
                className={`w-7 h-7 rounded-full border-2 transition-transform group-hover:scale-110 ${
                  p.id === accent ? 'border-ink' : 'border-transparent'
                }`}
                style={{ backgroundColor: p.swatch }}
              />
              <span className={`text-[11px] ${p.id === accent ? 'text-ink font-semibold' : 'text-muted'}`}>
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
