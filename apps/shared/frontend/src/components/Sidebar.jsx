import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Left-hand nav shell for the monitor view (both builds). Replaces the old
// pattern of toggle buttons in the per-page toolbar (Service map / Query /
// Alerts all used to be inline panels you switched on and off, stacked on
// top of the watched-service list) with real, persistent sections — pick
// one from here, the main area shows only that section. `active`/`onSelect`
// are plain state in App.jsx (no router — there's nothing here that needs
// a URL of its own, and both builds already avoid one elsewhere).
//
// Labels are resolved via t() at render time (nav.<id>) rather than stored
// as literal strings here, matching the website's FeaturesJob.jsx/
// CompareJob.jsx pattern of keeping a stable key in the module-level array
// and translating only at render.
const NAV_ITEMS = [
  { id: 'overview', labelKey: 'nav.overview', icon: '\u{1F4CA}' },
  { id: 'services', labelKey: 'nav.services', icon: '\u{1F9E9}' },
  { id: 'map', labelKey: 'nav.map', icon: '\u{1F5FA}' },
  { id: 'traces', labelKey: 'nav.traces', icon: '\u{1F50E}' },
  { id: 'tracing-setup', labelKey: 'nav.tracingSetup', icon: '\u{1F9F5}' },
  { id: 'alerts', labelKey: 'nav.alerts', icon: '\u{1F514}' },
  { id: 'compare', labelKey: 'nav.compare', icon: '\u{2696}\u{FE0F}' },
  { id: 'profiling', labelKey: 'nav.profiling', icon: '\u{1F525}' },
  { id: 'settings', labelKey: 'nav.settings', icon: '⚙' },
];

const COLLAPSE_KEY = 'podotype-sidebar-collapsed';

function getInitialCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

// A small "sidebar panel" glyph (a rectangle with a divided left strip) —
// the same shape most apps use for a collapse/expand toggle (this one's
// modeled on the icon in Claude's own sidebar). Plain inline SVG, no icon
// library — this is the only icon in the app that needs a crisp line
// drawing rather than an emoji.
function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

// Brand mark — same ring-with-filled-dot glyph as the marketing site's
// header wordmark (podotype-website's Header.jsx), so the logo reads as
// the same product in both places. Driven by --color-logo (index.css),
// which is set to a precise per-theme match of the site's rust accent —
// this is the one spot the two palettes intentionally meet; nothing else
// in the dashboard's "Cobalt & Cream" theme changes.
function Logo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="rgb(var(--color-logo))" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="6.5" fill="rgb(var(--color-logo))" />
    </svg>
  );
}

// userEmail/onLogout are only ever passed from the hosted branch of
// App.jsx (self-hosted has no login of its own — see App.jsx's authChecked
// comment) — the ribbon below simply doesn't render without them, same
// "additive, doesn't touch self-hosted" pattern the rest of the hosted
// build follows.
export default function Sidebar({ active, onSelect, serviceCount, mode, userEmail, onLogout }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // Best-effort persistence only — a failed write just means the
        // collapsed state doesn't survive a reload.
      }
      return next;
    });
  }

  return (
    <nav
      className={`shrink-0 border-r border-border-soft bg-panel flex flex-col py-3 sticky top-0 h-screen overflow-y-auto transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-52'
      }`}
    >
      <div className={`flex items-center gap-2 px-3 mb-3 ${collapsed ? 'justify-center px-2' : ''}`}>
        <Logo />
        {!collapsed && <span className="font-bold text-[14px] text-ink tracking-tight">PodoType</span>}
      </div>

      <div className={`flex items-center px-2 mb-2 ${collapsed ? 'justify-center' : ''}`}>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          className="w-8 h-8 inline-flex items-center justify-center rounded-md text-muted hover:bg-panel-raised hover:text-ink transition-colors"
        >
          <PanelIcon />
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const isActive = active === item.id;
          const badge = item.id === 'services' ? serviceCount : null;
          const label = t(item.labelKey);
          return (
            <button
              key={item.id}
              type="button"
              data-tour={`nav-${item.id}`}
              onClick={() => onSelect(item.id)}
              title={collapsed ? label : undefined}
              className={`flex items-center gap-2.5 text-left px-3 py-2 rounded-md text-[13px] font-semibold transition-colors ${
                collapsed ? 'justify-center' : ''
              } ${
                isActive
                  ? 'bg-accent/10 text-accent border border-accent/25'
                  : 'text-ink-dim border border-transparent hover:bg-panel-raised hover:text-ink'
              }`}
            >
              <span className="text-[14px] leading-none">{item.icon}</span>
              {!collapsed && <span className="flex-1">{label}</span>}
              {!collapsed && typeof badge === 'number' && badge > 0 && (
                <span className="font-mono text-[11px] font-bold rounded-full px-1.5 py-0.5 bg-panel-raised text-muted">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-auto" />

      {collapsed ? (
        // Collapsed footer: the owl mark stands in for the "hosted" /
        // "self-hosted" text label below — a logo reads at a glance, a
        // single letter ("H"/"SH") doesn't.
        <div
          className="flex justify-center py-2 border-t border-border-soft mx-2"
          title={mode === 'hosted' ? t('sidebar.hosted') : t('sidebar.selfHosted')}
        >
          <span className="text-[16px] leading-none">{'\u{1F989}'}</span>
        </div>
      ) : (
        <div className="px-5 pt-3 border-t border-border-soft mx-2 font-mono text-[11px] text-muted uppercase tracking-wider">
          {mode === 'hosted' ? t('sidebar.hosted') : t('sidebar.selfHosted')}
        </div>
      )}

      {userEmail && onLogout && (
        <div className={`px-3 pt-2 pb-1 mx-2 ${collapsed ? 'flex flex-col items-center' : ''}`}>
          {!collapsed && (
            <div
              className="font-mono text-[12px] text-ink-dim truncate mb-1.5"
              title={userEmail}
            >
              {userEmail}
            </div>
          )}
          <button
            type="button"
            onClick={onLogout}
            title={collapsed ? t('sidebar.logOutTitle', { email: userEmail }) : undefined}
            className={`flex items-center gap-2 text-[13px] font-semibold text-muted hover:text-down rounded-md transition-colors ${
              collapsed ? 'justify-center px-2 py-1.5' : 'px-2 py-1.5 w-full'
            }`}
          >
            <span className="leading-none">{'\u{1F6AA}'}</span>
            {!collapsed && <span>{t('sidebar.logOut')}</span>}
          </button>
        </div>
      )}
    </nav>
  );
}
