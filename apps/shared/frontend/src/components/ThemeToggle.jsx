import { useEffect, useState } from 'react';

const STORAGE_KEY = 'podotype-theme';

// Light is the product's default/primary look now (see index.css's own
// comment) — so the OS-preference check only opts INTO dark when the OS
// explicitly says dark, rather than the old "default to dark unless the
// OS explicitly says light" behavior. A system with no stated preference
// (matchMedia unsupported, or neither query matches) lands on light.
function getInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage can throw in some embedded/private contexts — fall
    // through to the OS preference the same as if nothing was stored.
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

// A small sun/moon toggle — sets data-theme on <html> (index.css's
// :root[data-theme='light'] block is what actually swaps the CSS
// variable palette; this component only owns the decision + persistence,
// not the colors themselves) and remembers the choice in localStorage so
// it survives a reload without waiting on a render.
export default function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Best-effort — a failed write just means the choice won't persist
      // across reloads, not worth surfacing to the user.
    }
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-md bg-panel-raised border border-border text-[14px] hover:border-accent/50 transition-colors"
    >
      {theme === 'dark' ? '🌙' : '☀️'}
    </button>
  );
}
