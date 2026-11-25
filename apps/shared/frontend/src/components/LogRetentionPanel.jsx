import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

const DAY_PRESETS = [1, 2, 7, 15, 30];

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1e6;
  return `${mb.toFixed(0)} MB`;
}

function hoursToDays(hours) {
  return Math.round((hours / 24) * 10) / 10;
}

// SEPARATE from RetentionPanel (trace retention) on purpose — see
// server.js's mergeLogRetentionConfig comment. This only ever matters for
// services that have opted into log-pattern storage (see LogsPanel.jsx's
// History tab) — a person who's never turned that on for anything won't
// see this do much, which is expected: there's nothing being retained yet
// to configure. Same UI shape as RetentionPanel (day presets, a live GB
// estimate, an explicit reclaim-now checkbox) since it's the same
// ClickHouse TTL mechanism underneath, just against the log_patterns
// table instead of traces.
export default function LogRetentionPanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState('');
  const [reclaimNow, setReclaimNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [saveError, setSaveError] = useState(null);

  function load() {
    api
      .logRetentionConfig()
      .then((body) => {
        setConfig(body);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return <div className="mb-5 text-[13px] text-down">{t('logRetentionPanel.couldntLoad', { error })}</div>;
  }
  if (!config) return <div className="mb-5 text-[13px] text-muted">{t('logRetentionPanel.loading')}</div>;

  const currentDays = hoursToDays(config.hours);
  const dailyBytesText = formatBytes(config.dailyBytesEstimate);

  function openEditor() {
    setDays(String(currentDays));
    setReclaimNow(false);
    setSaveResult(null);
    setSaveError(null);
    setEditing(true);
  }

  const daysNum = Number(days);
  const previewHours = Number.isFinite(daysNum) && daysNum > 0 ? daysNum * 24 : null;
  const previewBytes =
    previewHours !== null && config.dailyBytesEstimate !== null ? (previewHours / 24) * config.dailyBytesEstimate : null;
  const shortening = previewHours !== null && previewHours < config.hours;

  async function save() {
    if (!Number.isFinite(daysNum) || daysNum <= 0) {
      setSaveError(t('retentionPanel.enterDaysError'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const result = await api.setLogRetentionConfig(Math.round(daysNum * 24), reclaimNow);
      setSaveResult(result);
      load();
      if (!result.reclaimError) setEditing(false);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="mb-5 border border-border rounded-lg overflow-hidden">
        <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between">
          <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">{t('logRetentionPanel.configureTitle')}</span>
          <button
            type="button"
            className="link-btn text-muted hover:text-ink text-[15px] leading-none"
            onClick={() => setEditing(false)}
            title={t('alertsSettings.closeWithoutSaving')}
          >
            ×
          </button>
        </div>
        <div className="px-3.5 py-3 flex flex-col gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {DAY_PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(String(d))}
                className={`text-[13px] font-semibold rounded px-2.5 py-1 border ${
                  Number(days) === d ? 'text-accent border-accent bg-accent/10' : 'text-ink-dim border-border-soft hover:border-accent'
                }`}
              >
                {t('retentionPanel.days', { count: d })}
              </button>
            ))}
            <input
              type="number"
              min="0.04"
              step="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-20 bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink"
            />
            <span className="text-[13px] text-muted">{t('retentionPanel.daysUnit')}</span>
          </div>

          <div className="text-[13px] text-ink-dim">
            {config.dailyBytesEstimate !== null ? (
              <>
                {t('logRetentionPanel.recentVolume', {
                  count: config.sampleDays,
                  bytes: formatBytes(config.dailyBytesEstimate),
                })}{' '}
                {previewBytes !== null && daysNum > 0 && (
                  <>
                    {t('retentionPanel.atThatRate', {
                      daysPhrase: t('retentionPanel.days', { count: daysNum }),
                      bytes: formatBytes(previewBytes),
                    })}
                  </>
                )}
              </>
            ) : (
              <>{t('logRetentionPanel.noVolumeEstimate')}</>
            )}
          </div>

          <div className="text-[12px] text-muted inline-flex items-start gap-1.5">
            <InfoDot title={t('logRetentionPanel.tooltip')} />
            <span>{t('logRetentionPanel.separateNote')}</span>
          </div>

          {shortening && (
            <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none">
              <input type="checkbox" checked={reclaimNow} onChange={(e) => setReclaimNow(e.target.checked)} className="accent-accent" />
              <span className="text-ink-dim">{t('retentionPanel.reclaimNow')}</span>
              <InfoDot title={t('logRetentionPanel.reclaimTooltip')} />
            </label>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-border-soft">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
            >
              {saving ? t('alertsSettings.saving') : t('alertsSettings.save')}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="link-btn text-[13px]">
              {t('alertsSettings.cancel')}
            </button>
            {saveError && <span className="text-[13px] text-down">{saveError}</span>}
            {saveResult && !saveError && (
              <span className="text-[13px] text-up">
                {t('retentionPanel.saved')}{' '}
                {saveResult.reclaimed && t('retentionPanel.spaceReclaimed')}
                {saveResult.reclaimError && (
                  <span className="text-down">{t('retentionPanel.reclaimFailed', { error: saveResult.reclaimError })}</span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim inline-flex items-center gap-1.5">
          {t('logRetentionPanel.headerLabel')}: {t('retentionPanel.days', { count: currentDays })}
          {dailyBytesText && (
            <span className="normal-case font-normal text-muted">
              ({t('retentionPanel.recentVolumeShort', { bytes: dailyBytesText })})
            </span>
          )}
          <InfoDot title={t('logRetentionPanel.tooltip')} />
        </span>
        <div className="flex items-center gap-2.5">
          <button type="button" className="link-btn text-[12px]" onClick={load} title={t('retentionPanel.refreshTooltip')}>
            ↻
          </button>
          <button type="button" className="link-btn text-[12px]" onClick={openEditor}>
            {t('alertsPanel.configure')}
          </button>
        </div>
      </div>
    </div>
  );
}
