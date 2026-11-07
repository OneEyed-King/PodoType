/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Every color below reads from a CSS custom property (see
        // index.css's :root / :root[data-theme="light"] blocks) instead
        // of a hardcoded hex — that's what lets light/dark mode work
        // without touching any component: every component already uses
        // these semantic names (bg-panel, text-ink, border-border, ...),
        // never raw hex, so swapping the variables' values swaps the
        // whole app's theme in one place. The "R G B / <alpha-value>"
        // form (not a hex string) is required for Tailwind's opacity
        // modifiers (bg-up/10, border-up/30, etc. — used throughout
        // pill/badge styling) to keep working with a CSS-variable color.
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        'panel-raised': 'rgb(var(--color-panel-raised) / <alpha-value>)',
        'panel-recessed': 'rgb(var(--color-panel-recessed) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        'border-soft': 'rgb(var(--color-border-soft) / <alpha-value>)',
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-dim': 'rgb(var(--color-ink-dim) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        up: 'rgb(var(--color-up) / <alpha-value>)',
        down: 'rgb(var(--color-down) / <alpha-value>)',
        slow: 'rgb(var(--color-slow) / <alpha-value>)',
        unknown: 'rgb(var(--color-unknown) / <alpha-value>)',
      },
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.02) inset',
      },
    },
  },
  plugins: [],
};
