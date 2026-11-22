import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'podotype-accent';

// Five curated accent presets — not a full color picker (see the
// "Add selectable accent color presets" issue this implements): an
// arbitrary user-picked hue would mean re-validating contrast/
// legibility across every chart series, status pill, and badge in the
// app, which is a much bigger surface than this feature is worth.
// 'rust' matches the podotype-website's brand color and is the
// dashboard's default; 'cobalt' is the dashboard's original accent,
// kept as an opt-in preset. Each preset's hue is kept clear of the
// status colors (up=green, down=red, slow=orange — see index.css) so
// a non-default accent is never mistaken for a status indicator.
// Swatch hex values here are purely for the picker UI; the actual
// --color-accent values (and their dark-mode variants) live in
// index.css's :root[data-accent=…] blocks, same separation
// ThemeToggle.jsx already uses for data-theme.
const PRESETS = [
  { id: 'rust', label: 'Rust', swatch: '#a6501f' },
  { id: 'cobalt', label: 'Cobalt', swatch: '#2546c7' },
  { id: 'violet', label: 'Violet', swatch: '#7c3aed' },
  { id: 'teal', label: 'Teal', swatch: '#0d9488' },
  { id: 'pink', label: 'Pink', swatch: '#db2777' },
];

function getInitialAccent() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (PRESETS.some((p) => p.id === stored)) return stored;
  } catch {
    // localStorage can throw in some embedded/private contexts — fall
    // through to the default the same as if nothing was stored.
  }
  return 'rust';
}

// A small swatch picker — sets data-accent on <html> (index.css's
// :root[data-accent='x'] blocks are what actually swap --color-accent;
// this component only owns the decision + persistence, same pattern as
// ThemeToggle.jsx) and remembers the choice in localStorage so it
// survives a reload. 'rust' is the base palette's own accent (matches
// the podotype-website's brand color), so it's represented by the
// ABSENCE of the attribute rather than a redundant override block.
export default function AccentPicker() {
  const [accent, setAccent] = useState(getInitialAccent);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (accent === 'rust') {
      document.documentElement.removeAttribute('data-accent');
    } else {
      document.documentElement.setAttribute('data-accent', accent);
    }
    try {
      localStorage.setItem(STORAGE_KEY, accent);
    } catch {
      // Best-effort — a failed write just means the choice won't persist
      // across reloads, not worth surfacing to the user.
    }
  }, [accent]);

  // Close on outside click or Escape, same expectations as any other
  // small popover in the app (e.g. the Jump palette).
  useEffect(() => {
    if (!open) return undefined;
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onEscape(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const current = PRESETS.find((p) => p.id === accent) ?? PRESETS[0];

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Accent color"
        className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-md bg-panel-raised border border-border hover:border-accent/50 transition-colors"
      >
        <span
          className="w-3 h-3 rounded-full border border-black/10"
          style={{ backgroundColor: current.swatch }}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-[36px] z-20 flex items-center gap-1.5 p-1.5 rounded-md border border-border bg-panel-raised shadow-lg">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.label}
              onClick={() => {
                setAccent(p.id);
                setOpen(false);
              }}
              className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                p.id === accent ? 'border-ink' : 'border-transparent'
              }`}
              style={{ backgroundColor: p.swatch }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
