import { useState } from 'react';

// Replaces the old two-step window.prompt() flow (type, then target) for
// setting a service's manual health check. Two reasons for one real
// modal instead of two native prompts: native dialogs can't be styled
// and hang off the browser's own chrome rather than looking like part of
// this app, and asking for "http" or "tcp" as free text invited exactly
// the confusion a pair of radio buttons can't produce — a reasonable
// person typing "https" for an https:// target used to get bounced with
// "Type must be http or tcp.", because the type here means the CHECK
// MECHANISM, not the target's protocol (an https:// target still uses
// the "http" check type — it's the target string that carries https://).
// Deliberately only two choices, so a dropdown would be one click too
// many — radio buttons show both options and the current one at a glance.
export default function HealthCheckModal({ serviceName, initialType, initialTarget, onCancel, onSave }) {
  const [type, setType] = useState(initialType === 'tcp' ? 'tcp' : 'http');
  const [target, setTarget] = useState(initialTarget || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    const trimmed = target.trim();
    if (!trimmed) {
      setError('Target cannot be empty — use "Remove check" instead to clear it.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(type, trimmed);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && (e.target.tagName !== 'BUTTON')) handleSave();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-center items-start pt-20 bg-black/40"
      onClick={onCancel}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-[440px] max-w-[92vw] bg-panel border border-accent/40 rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border-soft flex items-center justify-between">
          <span className="text-[14px] font-bold text-ink">Health check for &quot;{serviceName}&quot;</span>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted hover:text-ink text-[16px] leading-none"
            title="Close"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-3.5 flex flex-col gap-3.5">
          <div className="text-[12px] text-ink-dim leading-relaxed">
            Only needed if this service has no Docker HEALTHCHECK of its own — otherwise PodoType
            already reads that for free.
          </div>

          <div>
            <div className="text-[12px] font-semibold text-ink-dim mb-1.5">Check type</div>
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
                <input
                  type="radio"
                  name="check-type"
                  value="http"
                  checked={type === 'http'}
                  onChange={() => setType('http')}
                  className="accent-accent mt-0.5"
                />
                <span>
                  <span className="font-semibold">HTTP</span>
                  <span className="text-ink-dim"> — checks a URL. Use this for an https:// target too.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
                <input
                  type="radio"
                  name="check-type"
                  value="tcp"
                  checked={type === 'tcp'}
                  onChange={() => setType('tcp')}
                  className="accent-accent mt-0.5"
                />
                <span>
                  <span className="font-semibold">TCP</span>
                  <span className="text-ink-dim"> — just checks the port accepts a connection.</span>
                </span>
              </label>
            </div>
          </div>

          <div>
            <div className="text-[12px] font-semibold text-ink-dim mb-1.5">
              {type === 'http' ? 'Health check URL' : 'Host:port'}
            </div>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={type === 'http' ? 'https://host:port/health' : 'host:5432'}
              className="w-full bg-panel-raised border border-border-soft rounded px-2.5 py-1.5 font-mono text-[13px] text-ink"
              autoFocus
            />
          </div>

          {error && <div className="text-[12px] text-down">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={onCancel} className="link-btn text-[13px]">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
