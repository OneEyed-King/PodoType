import { useEffect, useRef, useState } from 'react';

// A keyboard-first "go to..." box — Ctrl+K / Cmd+K from anywhere on the
// page opens it (see App.jsx's keydown listener), type to filter, Enter
// or click jumps straight to a service row (expanding + scrolling to it)
// or one of the page's other views (service map, query console, alerts
// config). Exists because scrolling/hunting through a flat list of rows
// stops being fast once there are more than a handful of watched
// services — this is the same job Coroot's own "Go to..." ctrl+k box
// does, not a copy of its visuals (see TimeRangePicker.jsx for the
// outside-click/Escape pattern this follows, the closest existing
// precedent in this codebase).
export default function JumpBox({ items, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = query.trim()
    ? items.filter((it) => it.label.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[activeIndex]) onSelect(filtered[activeIndex]);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [filtered, activeIndex, onSelect, onClose]);

  function onBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[12vh] z-50"
      onMouseDown={onBackdropClick}
    >
      <div
        ref={containerRef}
        className="bg-panel-raised border border-border rounded-lg w-full max-w-md shadow-xl overflow-hidden"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to a service, the service map, query console…"
          className="w-full bg-transparent px-4 py-3 text-[14px] font-mono outline-none border-b border-border-soft placeholder:text-muted"
        />
        <div className="max-h-[50vh] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-muted">No matches.</div>
          )}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onSelect(it)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-4 py-2 text-[13px] font-mono flex items-center justify-between gap-2 ${
                i === activeIndex ? 'bg-accent/10 text-accent' : 'text-ink'
              }`}
            >
              <span className="[overflow-wrap:anywhere]">{it.label}</span>
              <span className="text-muted text-[11px] uppercase tracking-wide shrink-0">{it.kind}</span>
            </button>
          ))}
        </div>
        <div className="px-4 py-1.5 border-t border-border-soft text-[11px] text-muted font-mono flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
