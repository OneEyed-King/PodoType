import { useEffect, useState } from 'react';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

const DAY_PRESETS = [1, 7, 30, 90];

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

// How long ClickHouse keeps trace data — was env-var-only
// (CLICKHOUSE_TRACE_TTL_HOURS, fixed at container start); this lets someone
// pick 7 days, 30 days, or anything else from the UI, see a REAL estimate of
// what that costs in disk space (from ClickHouse's own system.parts, not a
// guess), and optionally reclaim space immediately rather than waiting for
// ClickHouse's own background TTL sweep — see server.js's "Trace retention
// settings" section for the actual mechanics (ALTER ... MODIFY TTL /
// MATERIALIZE TTL).
// label lets a caller override the visible name for what this actually
// governs — self-hosted never passes it (defaults to the original "Trace
// retention" text, exactly what it always said), hosted passes something
// broader since ITS one setting covers spans+logs+metrics together (see
// hostedApi.js's retentionConfig comment for why hosted doesn't split
// these the way self-hosted's separate RetentionPanel/LogRetentionPanel
// do). Nothing else about this component is hosted-aware — it's exactly
// the same generic api.retentionConfig()/setRetentionConfig() component in
// both builds.
export default function RetentionPanel({ storage, label = 'Trace retention', editorLabel = 'Configure trace retention' }) {
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
      .retentionConfig()
      .then((body) => {
        setConfig(body);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    // Fetched once, not polled — this doesn't change fast, and the estimate
    // itself queries ClickHouse's system.parts (a heavier scan than the
    // usual cached status reads), so re-running it every few seconds across
    // however many open dashboard tabs would be pure waste for a number
    // that barely moves minute to minute. The ↻ button below and a fresh
    // Save both refresh it on demand instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="mb-5 text-[13px] text-down">Couldn't load retention settings: {error}</div>;
  if (!config) return <div className="mb-5 text-[13px] text-muted">Loading retention settings…</div>;

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
      setSaveError('Enter a number of days greater than 0.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const result = await api.setRetentionConfig(Math.round(daysNum * 24), reclaimNow);
      setSaveResult(result);
      load(); // refresh the header stat + estimate against the new value
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
          <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">{editorLabel}</span>
          <button
            type="button"
            className="link-btn text-muted hover:text-ink text-[15px] leading-none"
            onClick={() => setEditing(false)}
            title="Close without saving"
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
                {d} day{d === 1 ? '' : 's'}
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
            <span className="text-[13px] text-muted">days</span>
          </div>

          <div className="text-[13px] text-ink-dim">
            {config.dailyBytesEstimate !== null ? (
              <>
                Recent volume: ~{formatBytes(config.dailyBytesEstimate)}/day (based on the last {config.sampleDays} full day
                {config.sampleDays === 1 ? '' : 's'}).{' '}
                {previewBytes !== null && daysNum > 0 && (
                  <>
                    At that rate, <span className="font-semibold text-ink">{daysNum} day{daysNum === 1 ? '' : 's'}</span> of
                    retention would use approximately <span className="font-semibold text-ink">{formatBytes(previewBytes)}</span>.
                  </>
                )}
              </>
            ) : (
              <>No volume estimate available yet{config.estimateError ? ` (${config.estimateError})` : ''} — a new deployment needs at least a little trace data before this can estimate anything.</>
            )}
          </div>

          <div className="text-[12px] text-muted inline-flex items-start gap-1.5">
            <InfoDot title="Longer retention keeps more history for post-hoc debugging and (later) baselining, but uses more of ClickHouse's own disk. There's no hard limit here — pick whatever you actually want; just keep an eye on the Disk space status if you're already close to full." />
            <span>
              Longer retention uses more disk. {storage && storage.usedPercent !== null && <>ClickHouse's disk is currently {storage.usedPercent}% full.</>}
            </span>
          </div>

          {shortening && (
            <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none">
              <input type="checkbox" checked={reclaimNow} onChange={(e) => setReclaimNow(e.target.checked)} className="accent-accent" />
              <span className="text-ink-dim">Reclaim space immediately</span>
              <InfoDot title="Without this, shortening retention only changes the cutoff going forward — old rows still age out on ClickHouse's own background schedule, which can take a while. Checking this forces ClickHouse to rewrite its data and drop expired rows right now instead (real disk I/O — may take a bit on a large table)." />
            </label>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-border-soft">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="link-btn text-[13px]">
              Cancel
            </button>
            {saveError && <span className="text-[13px] text-down">{saveError}</span>}
            {saveResult && !saveError && (
              <span className="text-[13px] text-up">
                Saved.{' '}
                {saveResult.reclaimed && 'Space reclaimed.'}
                {saveResult.reclaimError && <span className="text-down"> Reclaim failed: {saveResult.reclaimError}</span>}
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
          {label}: {currentDays} day{currentDays === 1 ? '' : 's'}
          {dailyBytesText && <span className="normal-case font-normal text-muted">(~{dailyBytesText}/day recently)</span>}
        </span>
        <div className="flex items-center gap-2.5">
          <button type="button" className="link-btn text-[12px]" onClick={load} title="Refresh the volume estimate">
            ↻
          </button>
          <button type="button" className="link-btn text-[12px]" onClick={openEditor}>
            ⚙ Configure
          </button>
        </div>
      </div>
    </div>
  );
}
