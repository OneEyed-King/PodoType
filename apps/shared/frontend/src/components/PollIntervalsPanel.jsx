import { useEffect, useState } from 'react';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

// One field: a label, a number input, and a unit — every poll interval is
// this same shape, just a different key/label/unit, so there's no reason
// for nine near-identical blocks of JSX instead of one small component
// mapped over a FIELDS array (same "describe the pairs, render them once"
// approach ServiceAlertOverrides.jsx already uses for its own threshold
// rows).
function IntervalRow({ label, hint, unit, value, onChange, min }) {
  return (
    <div className="flex items-center gap-2 text-[13px] flex-wrap py-1">
      <span className="text-ink-dim w-56 shrink-0 inline-flex items-center gap-1.5">
        {label}
        {hint && <InfoDot title={hint} />}
      </span>
      <input
        type="number"
        min={min}
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
      />
      <span className="text-muted">{unit}</span>
    </div>
  );
}

// Every background poll/eval cadence this app runs — used to be env-var-
// only (fixed at container start, same complaint this project already
// heard about alert thresholds and retention before those got their own
// settings panels): nobody self-hosting this should have to edit a
// docker-compose.yml env var and restart the container just to make a
// cadence this app itself decides faster or slower. See server.js's
// defaultPollIntervals/mergePollIntervals/applyPollIntervals for the
// actual mechanics — a save here takes effect immediately, no restart.
const FIELDS = [
  {
    key: 'checkSeconds',
    label: 'Service health checks',
    unit: 's',
    min: 5,
    hint: 'How often each watched service\'s own HTTP/TCP check (set under that service) re-runs. This is also what the TLS certificate check rides on — see below.',
  },
  { key: 'checkTimeoutSeconds', label: 'Health check timeout', unit: 's', min: 1, hint: 'How long a single check attempt waits before being treated as a failure.' },
  { key: 'storageCheckSeconds', label: 'Disk / storage check', unit: 's', min: 5, hint: "How often ClickHouse's own free disk space is re-checked." },
  { key: 'containerStatsPollSeconds', label: 'CPU / memory polling', unit: 's', min: 5, hint: 'How often each watched container\'s live CPU/memory/network stats are re-sampled.' },
  { key: 'containerMetricsSnapshotSeconds', label: 'Metrics history snapshot', unit: 's', min: 10, hint: "How often a CPU/memory/request-rate snapshot is written to ClickHouse for the \"what did yesterday look like\" charts." },
  { key: 'alertEvalSeconds', label: 'Alert evaluation', unit: 's', min: 5, hint: 'How often every alert condition (service down, CPU, memory, error rate, latency, TLS expiry) is re-judged against current data.' },
  { key: 'redMetricsPollSeconds', label: 'RED metrics polling', unit: 's', min: 5, hint: "How often Beyla's error-rate/latency/throughput data is re-scraped." },
  { key: 'logPatternFlushSeconds', label: 'Log pattern flush', unit: 's', min: 5, hint: 'How often sampled log lines are clustered and flushed to ClickHouse.' },
  {
    key: 'tlsCertPollHours',
    label: 'TLS certificate recheck',
    unit: 'h',
    min: 0.25,
    hint: "How often a watched service's TLS certificate expiry is re-checked in the background. Setting or changing a service's own HTTPS check (or watching/un-watching it) already triggers an immediate check regardless of this value — this only controls the ongoing recheck cadence.",
  },
];

export default function PollIntervalsPanel() {
  const [values, setValues] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  function load() {
    api
      .pollIntervals()
      .then((body) => {
        setValues(body);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    load();
    // Fetched once, not polled — these barely ever change, same reasoning
    // RetentionPanel's own effect comment gives for not polling itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError) return <div className="mb-5 text-[13px] text-down">Couldn't load poll interval settings: {loadError}</div>;
  if (!values) return <div className="mb-5 text-[13px] text-muted">Loading poll interval settings…</div>;

  function openEditor() {
    setDraft({ ...values });
    setSaveError(null);
    setSaved(false);
    setEditing(true);
  }

  function setField(key, v) {
    setDraft((d) => ({ ...d, [key]: v === '' ? '' : Number(v) }));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await api.setPollIntervals(draft);
      setValues(result);
      setSaved(true);
      setEditing(false);
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
          <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Configure poll intervals</span>
          <button
            type="button"
            className="link-btn text-muted hover:text-ink text-[15px] leading-none"
            onClick={() => setEditing(false)}
            title="Close without saving"
          >
            ×
          </button>
        </div>
        <div className="px-3.5 py-3 flex flex-col gap-0.5">
          <div className="text-[12px] text-muted mb-1.5">
            Takes effect immediately on save — no container restart needed.
          </div>
          {FIELDS.map((f) => (
            <IntervalRow
              key={f.key}
              label={f.label}
              hint={f.hint}
              unit={f.unit}
              min={f.min}
              value={draft[f.key] ?? ''}
              onChange={(v) => setField(f.key, v)}
            />
          ))}
          <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border-soft">
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
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim inline-flex items-center gap-1.5">
          Configure poll intervals
          <InfoDot title="How often this app checks things in the background — health checks, CPU/memory, alert evaluation, TLS certificate expiry, and so on. Editable here instead of an env var + container restart." />
        </span>
        <div className="flex items-center gap-2.5">
          {saved && <span className="text-[12px] text-up">✓ saved</span>}
          <button type="button" className="link-btn text-[12px]" onClick={openEditor}>
            ⚙ Configure
          </button>
        </div>
      </div>
    </div>
  );
}
