import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

// "Alerts + uptime only" opt-out — a single flag, same settings-panel
// shape as PollIntervalsPanel/RetentionPanel. See server.js's
// defaultObservabilityConfig for the full rationale: turning this off
// stops writing to ClickHouse (container metrics snapshots, log pattern
// flushes, trace ingestion) but changes NOTHING else — Beyla and
// ClickHouse both keep running in the background exactly as before, no
// docker-compose edits, no restarts, ever. Flipping it back on just
// resumes writing to a database that was already there the whole time.
export default function ObservabilityPanel({ onChange }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  function load() {
    api
      .observabilityConfig()
      .then((body) => {
        setEnabled(body.enabled);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.setObservabilityConfig({ enabled: next });
      setEnabled(result.enabled);
      if (onChange) onChange(result.enabled);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return <div className="mb-5 text-[13px] text-down">{t('observabilityPanel.couldntLoad', { error: loadError })}</div>;
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim inline-flex items-center gap-1.5">
          {t('observabilityPanel.label')}
          <InfoDot title={t('observabilityPanel.tooltip')} />
        </span>
        <div className="flex items-center gap-2.5">
          {saving && <span className="text-[12px] text-muted">{t('observabilityPanel.savingEllipsis')}</span>}
          {saveError && <span className="text-[12px] text-down">{saveError}</span>}
          <button
            type="button"
            onClick={toggle}
            disabled={enabled === null || saving}
            role="switch"
            aria-checked={enabled === true}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              enabled ? 'bg-accent' : 'bg-border'
            }`}
            title={enabled ? t('observabilityPanel.turnOff') : t('observabilityPanel.turnOn')}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[#f5f7fc] transition-transform ${
                enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>
      </div>
      {enabled === false && (
        <div className="px-3.5 py-2 border-t border-border-soft text-[12.5px] text-ink-dim bg-panel-raised">
          {t('observabilityPanel.offNote')}
        </div>
      )}
    </div>
  );
}
