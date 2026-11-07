import { useEffect, useState } from 'react';
import { api } from '../api.js';

// One threshold pair, with its own "Custom for this service" checkbox.
// Unchecked: this service just inherits whatever the global Alerts settings
// say (shown as muted placeholder text) — same behavior every service had
// before per-service overrides existed. Checked: two number inputs appear,
// seeded from whatever's currently EFFECTIVE (the global value, or an
// existing override) so turning "Custom" on never starts from a blank/zero
// value that would immediately misfire.
function OverrideRow({ label, unit, warnValue, critValue, globalWarn, globalCrit, overridden, onToggle, onWarn, onCrit }) {
  return (
    <div className="flex items-center gap-2 text-[13px] flex-wrap py-1">
      <label className="flex items-center gap-1.5 cursor-pointer select-none w-28 shrink-0">
        <input type="checkbox" checked={overridden} onChange={(e) => onToggle(e.target.checked)} className="accent-accent" />
        <span className="text-ink-dim">{label}</span>
      </label>
      {overridden ? (
        <>
          <span className="text-muted">warn ≥</span>
          <input
            type="number"
            min="0"
            value={warnValue}
            onChange={(e) => onWarn(e.target.value)}
            className="w-20 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
          />
          <span className="text-muted">{unit}, critical ≥</span>
          <input
            type="number"
            min="0"
            value={critValue}
            onChange={(e) => onCrit(e.target.value)}
            className="w-20 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
          />
          <span className="text-muted">{unit}</span>
        </>
      ) : (
        <span className="text-muted font-mono text-[13px]">
          inherits global: warn ≥ {globalWarn ?? '—'}{unit}, critical ≥ {globalCrit ?? '—'}{unit}
        </span>
      )}
    </div>
  );
}

const PAIRS = [
  { key: 'cpu', label: 'CPU', unit: '%', warnKey: 'cpuWarningPercent', critKey: 'cpuCriticalPercent' },
  { key: 'memory', label: 'Memory %', unit: '%', warnKey: 'memWarningPercent', critKey: 'memCriticalPercent' },
  {
    key: 'memoryMb',
    label: 'Memory (absolute)',
    unit: 'MB',
    warnKey: 'memWarningMb',
    critKey: 'memCriticalMb',
    // These two have no sane global default (see server.js's
    // defaultAlertConfig comment) — "inherits global" for this one pair
    // really means "not evaluated at all" unless a global value happens to
    // be set too, worth saying explicitly rather than showing a confusing
    // "warn ≥ —MB".
    note: 'requires the "Memory threshold" trigger to also be on — no global default; this is the one to use for a plain "alert if this service uses more than N MB" rule.',
  },
  { key: 'errorRate', label: 'Error rate', unit: '%', warnKey: 'errorRateWarningPercent', critKey: 'errorRateCriticalPercent' },
  { key: 'latency', label: 'Latency', unit: 'ms', warnKey: 'latencyWarningMs', critKey: 'latencyCriticalMs' },
];

// Per-service custom alert thresholds — the direct answer to "I want to set
// an alert on THIS service exceeding 500MB RAM, not every service." Lives
// inside a watched service's expanded row (see WatchedRow), fetched lazily
// only while that section is actually open. Saves via
// POST /api/services/:name/alert-overrides, which merges onto whatever this
// service already has overridden — unchecking a pair here sends an explicit
// null for its two fields, which the backend treats as "go back to
// inheriting the global value" (see server.js's own comment on that route).
export default function ServiceAlertOverrides({ serviceName }) {
  const [data, setData] = useState(null); // { overrides, effective }
  const [draft, setDraft] = useState({}); // key -> { on, warn, crit } — local edit state
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .alertOverrides(serviceName)
      .then((body) => {
        if (cancelled) return;
        setData(body);
        const nextDraft = {};
        for (const p of PAIRS) {
          const ov = body.overrides && body.overrides.thresholds;
          const isOverridden = Boolean(ov && (p.warnKey in ov || p.critKey in ov));
          nextDraft[p.key] = {
            on: isOverridden,
            warn: isOverridden ? ov[p.warnKey] : body.effective.thresholds[p.warnKey],
            crit: isOverridden ? ov[p.critKey] : body.effective.thresholds[p.critKey],
          };
        }
        setDraft(nextDraft);
      })
      .catch((err) => setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  if (loadError) return <div className="text-[13px] text-down">Couldn't load alert overrides: {loadError}</div>;
  if (!data) return <div className="text-[13px] text-muted">Loading custom alert thresholds…</div>;

  function toggle(key, on) {
    setDraft((d) => {
      const p = PAIRS.find((x) => x.key === key);
      // Seed with the current EFFECTIVE value when turning a pair on, so it
      // starts from something sane instead of an empty/zero field.
      const seed = on ? { warn: data.effective.thresholds[p.warnKey], crit: data.effective.thresholds[p.critKey] } : {};
      return { ...d, [key]: { ...d[key], on, ...seed } };
    });
  }
  function setField(key, field, value) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value === '' ? '' : Number(value) } }));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const thresholds = {};
    for (const p of PAIRS) {
      const d = draft[p.key];
      if (d.on) {
        thresholds[p.warnKey] = d.warn;
        thresholds[p.critKey] = d.crit;
      } else {
        // Explicit null — see server.js's alert-overrides POST comment —
        // clears just this pair back to inheriting the global value, rather
        // than leaving a stale override behind or resetting everything else.
        thresholds[p.warnKey] = null;
        thresholds[p.critKey] = null;
      }
    }
    try {
      const result = await api.setAlertOverrides(serviceName, { thresholds });
      setData(result);
      setSaved(true);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {PAIRS.map((p) => (
        <div key={p.key}>
          <OverrideRow
            label={p.label}
            unit={p.unit}
            warnValue={draft[p.key]?.warn ?? ''}
            critValue={draft[p.key]?.crit ?? ''}
            globalWarn={data.effective.thresholds[p.warnKey]}
            globalCrit={data.effective.thresholds[p.critKey]}
            overridden={Boolean(draft[p.key]?.on)}
            onToggle={(on) => toggle(p.key, on)}
            onWarn={(v) => setField(p.key, 'warn', v)}
            onCrit={(v) => setField(p.key, 'crit', v)}
          />
          {p.note && draft[p.key]?.on && <div className="text-[12px] text-muted ml-[7.5rem] -mt-0.5 mb-0.5">{p.note}</div>}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1.5">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3 py-1 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save custom thresholds'}
        </button>
        {saved && <span className="text-[13px] text-up">✓ saved</span>}
        {saveError && <span className="text-[13px] text-down">{saveError}</span>}
      </div>
    </div>
  );
}
