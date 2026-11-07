import { useEffect, useState } from 'react';
import { hostedApi } from '../datasource/hostedApi.js';
import InfoDot from './InfoDot.jsx';

// Hosted's version of AlertsSettings.jsx — same visual language (trigger
// toggles, a threshold, a sustain-window input, a channels list with
// inline test), but a genuinely different shape underneath: self-hosted
// inlines exactly one Telegram + one webhook credential pair into its
// config blob; hosted already has a proper multi-channel CRUD table
// (alert_channels, discord + telegram, add as many as you want) built
// earlier for the silence watchdog. Reshaping hosted down to self-hosted's
// single-pair shape would be a regression on that, so this manages
// channels as a real list instead — see hostedApi.js's own comment on
// why alertsConfig()/alertChannels() are two separate calls here.
export default function HostedAlertsSettings({ onClose, onSaved }) {
  const [config, setConfig] = useState(null);
  const [channels, setChannels] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});
  const [newChannel, setNewChannel] = useState({ type: 'discord', label: '', webhookUrl: '', botToken: '', chatId: '', to: '' });
  const [addError, setAddError] = useState(null);
  const [adding, setAdding] = useState(false);

  function loadChannels() {
    return hostedApi.alertChannels().then(setChannels);
  }

  useEffect(() => {
    Promise.all([hostedApi.alertsConfig(), hostedApi.alertChannels()])
      .then(([c, ch]) => {
        setConfig(c);
        setChannels(ch);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  if (loadError) return <div className="mb-5 text-[13px] text-down">Couldn't load alert settings: {loadError}</div>;
  if (!config || !channels) return <div className="mb-5 text-[13px] text-muted">Loading alert settings…</div>;

  function updateEnabled(key, value) {
    setConfig((c) => ({ ...c, enabled: { ...c.enabled, [key]: value } }));
  }
  function updateThreshold(key, value) {
    setConfig((c) => ({ ...c, thresholds: { ...c.thresholds, [key]: value === '' ? '' : Number(value) } }));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await hostedApi.setAlertsConfig(config);
      onSaved(saved);
      onClose();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleChannel(id, enabled) {
    await hostedApi.setAlertChannelEnabled(id, enabled);
    await loadChannels();
  }

  async function removeChannel(id) {
    await hostedApi.deleteAlertChannel(id);
    await loadChannels();
  }

  async function testChannel(id) {
    setTesting((t) => ({ ...t, [id]: true }));
    setTestResults((r) => ({ ...r, [id]: null }));
    try {
      const result = await hostedApi.testAlertChannel(id);
      setTestResults((r) => ({ ...r, [id]: { ok: true } }));
      await loadChannels();
      return result;
    } catch (err) {
      setTestResults((r) => ({ ...r, [id]: { ok: false, error: err.message } }));
    } finally {
      setTesting((t) => ({ ...t, [id]: false }));
    }
  }

  async function addChannel() {
    setAdding(true);
    setAddError(null);
    try {
      const config =
        newChannel.type === 'discord'
          ? { webhookUrl: newChannel.webhookUrl }
          : newChannel.type === 'email'
          ? { to: newChannel.to }
          : { botToken: newChannel.botToken, chatId: newChannel.chatId };
      await hostedApi.createAlertChannel(newChannel.type, newChannel.label || null, config);
      setNewChannel({ type: 'discord', label: '', webhookUrl: '', botToken: '', chatId: '', to: '' });
      await loadChannels();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">Configure alerts</span>
        <button type="button" className="link-btn text-muted hover:text-ink text-[15px] leading-none" onClick={onClose} title="Close without saving">
          ×
        </button>
      </div>

      <div className="px-3.5 py-3 flex flex-col gap-4">
        <div>
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1 inline-flex items-center gap-1.5">
            Triggers
            <InfoDot title="Evaluated centrally, not by the agent — a crashed customer VM shouldn't take its own alerting down with it. Checked every ~30s." />
          </div>
          <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none py-1">
            <input type="checkbox" checked={config.enabled.serviceDown} onChange={(e) => updateEnabled('serviceDown', e.target.checked)} className="accent-accent" />
            <span className="text-ink-dim">Service down</span>
            <span className="text-muted text-[12px]">— a watched container reports not running/unhealthy</span>
          </label>
          <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none py-1">
            <input type="checkbox" checked={config.enabled.errorRate} onChange={(e) => updateEnabled('errorRate', e.target.checked)} className="accent-accent" />
            <span className="text-ink-dim">Error rate</span>
            <span className="text-muted text-[12px]">— a watched service's traced error rate crosses the threshold below</span>
          </label>
        </div>

        <div className="flex items-center gap-2 text-[13px] flex-wrap">
          <span className="text-ink-dim">Error rate threshold</span>
          <input
            type="number"
            min="0"
            max="100"
            value={config.thresholds.errorRatePercent}
            onChange={(e) => updateThreshold('errorRatePercent', e.target.value)}
            className="w-16 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
          />
          <span className="text-muted">%</span>
        </div>

        <div>
          <label className="flex items-center gap-2 text-[13px]">
            <span className="text-ink-dim">Sustained for</span>
            <input
              type="number"
              min="1"
              max="20"
              value={config.sustainChecks}
              onChange={(e) => setConfig((c) => ({ ...c, sustainChecks: e.target.value === '' ? '' : Number(e.target.value) }))}
              className="w-14 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
            />
            <span className="text-muted">consecutive checks</span>
          </label>
        </div>

        <div>
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1.5">Delivery channels</div>
          <div className="flex flex-col gap-2">
            {channels.length === 0 && <div className="text-[13px] text-muted">No channels yet — add one below.</div>}
            {channels.map((c) => (
              <div key={c.id} className="border border-border-soft rounded-md p-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <label className="flex items-center gap-2 text-[14px] font-semibold cursor-pointer select-none">
                    <input type="checkbox" checked={c.enabled} onChange={(e) => toggleChannel(c.id, e.target.checked)} className="accent-accent" />
                    {c.type} {c.label && <span className="text-muted font-normal">({c.label})</span>}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => testChannel(c.id)}
                      disabled={Boolean(testing[c.id])}
                      className="text-[13px] font-semibold text-ink bg-panel-raised border border-border hover:border-accent hover:text-accent rounded-md px-3.5 py-1.5 disabled:opacity-50"
                    >
                      {testing[c.id] ? 'Sending…' : 'Send test'}
                    </button>
                    <button type="button" onClick={() => removeChannel(c.id)} className="link-btn text-[12px] text-muted hover:text-down">
                      Remove
                    </button>
                  </div>
                </div>
                <div className="text-[12px] text-muted mt-1 ml-6 font-mono">
                  {c.type === 'discord'
                    ? c.config.webhookUrl
                    : c.type === 'email'
                    ? c.config.to
                    : `${c.config.botToken} · chat ${c.config.chatId}`}
                  {c.last_error && <span className="text-down"> — last error: {c.last_error}</span>}
                </div>
                {testResults[c.id] && (
                  <div className={`text-[12px] mt-1 ml-6 ${testResults[c.id].ok ? 'text-up' : 'text-down'}`}>
                    {testResults[c.id].ok ? '✓ delivered' : `✗ ${testResults[c.id].error || 'failed'}`}
                  </div>
                )}
              </div>
            ))}

            <div className="border border-dashed border-border-soft rounded-md p-2.5">
              <div className="text-[13px] font-semibold text-ink-dim mb-1.5">Add a channel</div>
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <select
                  value={newChannel.type}
                  onChange={(e) => setNewChannel((c) => ({ ...c, type: e.target.value }))}
                  className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink"
                >
                  <option value="discord">Discord</option>
                  <option value="telegram">Telegram</option>
                  <option value="email">Email</option>
                </select>
                <input
                  type="text"
                  placeholder="Label (optional)"
                  value={newChannel.label}
                  onChange={(e) => setNewChannel((c) => ({ ...c, label: e.target.value }))}
                  className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-40"
                />
              </div>
              {newChannel.type === 'discord' ? (
                <input
                  type="text"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={newChannel.webhookUrl}
                  onChange={(e) => setNewChannel((c) => ({ ...c, webhookUrl: e.target.value }))}
                  className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-md mb-1.5"
                />
              ) : newChannel.type === 'email' ? (
                <input
                  type="text"
                  placeholder="Send alerts to this address"
                  value={newChannel.to}
                  onChange={(e) => setNewChannel((c) => ({ ...c, to: e.target.value }))}
                  className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs mb-1.5"
                />
              ) : (
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <input
                    type="text"
                    placeholder="Bot token (from @BotFather)"
                    value={newChannel.botToken}
                    onChange={(e) => setNewChannel((c) => ({ ...c, botToken: e.target.value }))}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                  <input
                    type="text"
                    placeholder="Chat ID"
                    value={newChannel.chatId}
                    onChange={(e) => setNewChannel((c) => ({ ...c, chatId: e.target.value }))}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={addChannel}
                disabled={adding}
                className="text-[13px] font-semibold text-ink bg-panel-raised border border-border hover:border-accent hover:text-accent rounded-md px-3.5 py-1.5 disabled:opacity-50"
              >
                {adding ? 'Adding…' : 'Add channel'}
              </button>
              {addError && <div className="text-[12px] text-down mt-1">{addError}</div>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border-soft">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="link-btn text-[13px]">
            Cancel
          </button>
          {saveError && <span className="text-[13px] text-down">{saveError}</span>}
        </div>
      </div>
    </div>
  );
}
