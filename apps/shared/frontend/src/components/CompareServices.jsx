import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Comparison target cap — a wide table stops being readable past this many
// columns, and nobody's realistically eyeballing more than a handful of
// services side by side at once anyway.
const MAX_COMPARE = 6;

function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}
function fmtMs(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v)}ms`;
}
function fmtRate(v) {
  if (v === null || v === undefined) return '—';
  return v >= 10 ? `${Math.round(v)}/s` : `${v.toFixed(1)}/s`;
}
function fmtInt(v) {
  return v === null || v === undefined ? '—' : String(v);
}
function fmtPercentNum(v) {
  return v === null || v === undefined ? '—' : `${v.toFixed(1)}%`;
}

// Rows shown in the comparison table — one entry per metric, each knowing
// how to pull its own value off a service object and how to format it. Same
// {name, up, red, trace, health} shape both builds already produce (see
// App.jsx's statusServices/hostedDiscovery.services — this component reads
// nothing build-specific, so it works unmodified on both).
//
// labelKey (not a literal label) so the row label resolves through i18n at
// render time — same pattern as the website's CompareJob.jsx/FeaturesJob.jsx
// and this app's own Sidebar.jsx NAV_ITEMS.
const METRIC_ROWS = [
  {
    labelKey: 'rowStatus',
    render: (svc, t) =>
      svc.up === true ? (
        <span className="text-up font-semibold">{t('compareServices.statusUp')}</span>
      ) : svc.up === false ? (
        <span className="text-down font-semibold">{t('compareServices.statusDown')}</span>
      ) : (
        <span className="text-muted">{t('compareServices.statusUnknown')}</span>
      ),
  },
  { labelKey: 'rowRequestsPerSec', render: (svc) => fmtRate(svc.red && svc.red.requestsPerSec) },
  {
    labelKey: 'rowErrorRate',
    render: (svc) => {
      const v = svc.red && svc.red.errorRate;
      const cls = v !== null && v !== undefined && v > 0 ? 'text-down' : 'text-ink';
      return <span className={cls}>{fmtPct(v)}</span>;
    },
  },
  { labelKey: 'rowP50', render: (svc) => fmtMs(svc.red && svc.red.p50Ms) },
  { labelKey: 'rowP95', render: (svc) => fmtMs(svc.red && svc.red.p95Ms) },
  { labelKey: 'rowP99', render: (svc) => fmtMs(svc.red && svc.red.p99Ms) },
  {
    labelKey: 'rowRestarts',
    render: (svc) => {
      const v = svc.health && svc.health.restartCount;
      const cls = v ? 'text-slow' : 'text-ink';
      return <span className={cls}>{fmtInt(v)}</span>;
    },
  },
  { labelKey: 'rowCpu', render: (svc) => fmtPercentNum(svc.health && svc.health.cpuPercent) },
  { labelKey: 'rowMemory', render: (svc) => fmtPercentNum(svc.health && svc.health.memPercent) },
];

// Picks a sensible starting comparison so the panel isn't empty the first
// time someone opens it — up to 3 watched services, worst-status-first
// (down before unknown before up) so a genuinely interesting comparison is
// what's on screen by default rather than an arbitrary alphabetical slice.
function defaultSelection(services) {
  return [...services]
    .sort((a, b) => {
      const rank = (s) => (s.up === false ? 0 : s.up === null || s.up === undefined ? 1 : 2);
      return rank(a) - rank(b);
    })
    .slice(0, 3)
    .map((s) => s.name);
}

export default function CompareServices({ services }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(() => defaultSelection(services || []));
  const [query, setQuery] = useState('');

  const byName = new Map((services || []).map((s) => [s.name, s]));
  const selectedServices = selected.map((n) => byName.get(n)).filter(Boolean);

  function toggle(name) {
    setSelected((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, name];
    });
  }

  const q = query.trim().toLowerCase();
  const pickList = (services || []).filter((s) => !q || s.name.toLowerCase().includes(q));

  if (!services || services.length === 0) {
    return <p className="text-muted text-[15px]">{t('compareServices.noServicesYet')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-panel border border-border rounded-lg p-3.5">
        <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
          <div className="text-[13px] font-semibold text-ink-dim">
            {t('compareServices.compareUpTo', { max: MAX_COMPARE, count: selected.length })}
          </div>
          {services.length > 6 && (
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('compareServices.searchPlaceholder')}
              className="text-[13px] bg-panel-raised border border-border rounded-md px-3 py-1.5 text-ink placeholder:text-muted focus:outline-none focus:border-accent"
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pickList.map((s) => {
            const isSelected = selected.includes(s.name);
            const disabled = !isSelected && selected.length >= MAX_COMPARE;
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => toggle(s.name)}
                disabled={disabled}
                className={`text-[13px] font-semibold rounded-md px-3 py-1.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  isSelected
                    ? 'text-accent border-accent bg-accent/10'
                    : 'text-ink-dim border-border hover:border-accent hover:text-accent'
                }`}
              >
                {s.name}
              </button>
            );
          })}
          {pickList.length === 0 && (
            <span className="text-muted text-[13px]">{t('compareServices.noMatch', { query })}</span>
          )}
        </div>
      </div>

      {selectedServices.length === 0 ? (
        <p className="text-muted text-[15px]">{t('compareServices.pickAtLeastOne')}</p>
      ) : (
        <div className="bg-panel border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr>
                <th className="text-left px-3.5 py-2.5 border-b border-border-soft text-ink-dim font-semibold whitespace-nowrap">
                  {t('compareServices.metricHeader')}
                </th>
                {selectedServices.map((svc) => (
                  <th
                    key={svc.name}
                    className="text-left px-3.5 py-2.5 border-b border-border-soft text-ink font-semibold whitespace-nowrap"
                  >
                    {svc.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRIC_ROWS.map((row) => (
                <tr key={row.labelKey} className="border-b border-border-soft last:border-b-0">
                  <td className="px-3.5 py-2 text-ink-dim whitespace-nowrap">{t(`compareServices.${row.labelKey}`)}</td>
                  {selectedServices.map((svc) => (
                    <td key={svc.name} className="px-3.5 py-2 text-ink whitespace-nowrap">
                      {row.render(svc, t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
