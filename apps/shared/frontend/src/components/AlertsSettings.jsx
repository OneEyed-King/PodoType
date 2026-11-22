import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import InfoDot from './InfoDot.jsx';

// A labeled checkbox row for one trigger type — kept as its own tiny
// component since there are four identical ones (service down, storage,
// CPU, memory) and inlining each would just repeat the same JSX four times.
function TriggerToggle({ label, hint, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none py-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      <span className="text-ink-dim">{label}</span>
      {hint && <span className="text-muted text-[12px]">— {hint}</span>}
    </label>
  );
}

// One warning/critical threshold pair (CPU or memory) — two small number
// inputs side by side, same shape both times. `unit` defaults to "%" (CPU/
// memory/error-rate all share it); latency passes "ms" instead so this one
// component covers every threshold pair rather than a near-duplicate for ms.
// `direction` defaults to "atLeast" (warn/critical fire at or ABOVE the
// number — true for every pair except TLS expiry). TLS expiry passes
// "atMost": fewer days remaining is worse, so this just swaps the symbol
// shown — evaluateAlerts on the server decides the actual breach direction
// either way, this is purely so the label doesn't read backwards. The
// symbol itself is passed into the translated string as {{symbol}} (see
// the locale files' alertsSettings.warnPrefix/criticalPrefix) rather than
// being a separate hardcoded character, so direction still works the same
// in every language.
function ThresholdPair({ label, warning, critical, onWarning, onCritical, unit = '%', max = 100, direction = 'atLeast' }) {
  const { t } = useTranslation();
  const symbol = direction === 'atMost' ? '≤' : '≥';
  return (
    <div className="flex items-center gap-2 text-[13px] flex-wrap">
      <span className="text-ink-dim w-14 shrink-0">{label}</span>
      <span className="text-muted">{t('alertsSettings.warnPrefix', { symbol })}</span>
      <input
        type="number"
        min="0"
        max={max}
        value={warning}
        onChange={(e) => onWarning(e.target.value)}
        className="w-16 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
      />
      <span className="text-muted">{unit}, {t('alertsSettings.criticalPrefix', { symbol })}</span>
      <input
        type="number"
        min="0"
        max={max}
        value={critical}
        onChange={(e) => onCritical(e.target.value)}
        className="w-16 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
      />
      <span className="text-muted">{unit}</span>
    </div>
  );
}

// One notification channel's own enabled toggle + credential fields + a
// "Send test" button that fires a REAL message right now using whatever's
// currently typed (not necessarily saved yet) — see server.js's
// POST /api/alerts/test comment for why this exists: typing in a bot token
// and hoping is exactly the kind of unverified assumption this project has
// otherwise held itself to a higher bar than.
function ChannelSection({ title, description, enabled, onToggleEnabled, fields, onTest, testResult, testing }) {
  const { t } = useTranslation();
  return (
    <div className="border border-border-soft rounded-md p-2.5">
      <label className="flex items-center gap-2 text-[14px] font-semibold cursor-pointer select-none">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggleEnabled(e.target.checked)} className="accent-accent" />
        {title}
      </label>
      <div className="text-[12px] text-muted mb-2 ml-6">{description}</div>
      {enabled && (
        <div className="ml-6 flex flex-col gap-1.5">
          {fields}
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              onClick={onTest}
              disabled={testing}
              className="text-[13px] font-semibold text-ink bg-panel-raised border border-border hover:border-accent hover:text-accent rounded-md px-3.5 py-1.5 disabled:opacity-50"
            >
              {testing ? t('alertsSettings.sendingTest') : t('alertsSettings.sendTestMessage')}
            </button>
            {testResult && (
              <span className={`text-[12px] ${testResult.ok ? 'text-up' : 'text-down'}`}>
                {testResult.ok
                  ? t('alertsSettings.delivered')
                  : testResult.error
                  ? t('alertsSettings.failed', { error: testResult.error })
                  : t('alertsSettings.failedGeneric')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The settings form behind AlertsPanel's "Configure" link — lets someone
// turn each of the four trigger types on/off, tune the two threshold pairs
// evaluateAlerts checks against, set the sustain window, and wire up
// Telegram and/or a generic webhook with a real send-test before saving.
// Fetches the current config fresh every time it opens (not cached in a
// parent) since it's only mounted while actually visible.
export default function AlertsSettings({ onClose, onSaved }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});

  useEffect(() => {
    api
      .alertsConfig()
      .then(setConfig)
      .catch((err) => setLoadError(err.message));
  }, []);

  if (loadError) {
    return <div className="mb-5 text-[13px] text-down">{t('alertsSettings.loadError', { error: loadError })}</div>;
  }
  if (!config) {
    return <div className="mb-5 text-[13px] text-muted">{t('alertsSettings.loading')}</div>;
  }

  function updateEnabled(key, value) {
    setConfig((c) => ({ ...c, enabled: { ...c.enabled, [key]: value } }));
  }
  function updateThreshold(key, value) {
    setConfig((c) => ({ ...c, thresholds: { ...c.thresholds, [key]: value === '' ? '' : Number(value) } }));
  }
  function updateChannel(channel, key, value) {
    setConfig((c) => ({ ...c, channels: { ...c.channels, [channel]: { ...c.channels[channel], [key]: value } } }));
  }

  async function runTest(channel) {
    setTesting((t) => ({ ...t, [channel]: true }));
    setTestResults((r) => ({ ...r, [channel]: null }));
    try {
      const credentials =
        channel === 'telegram'
          ? { botToken: config.channels.telegram.botToken, chatId: config.channels.telegram.chatId }
          : channel === 'email'
          ? {
              smtpHost: config.channels.email.smtpHost,
              smtpPort: config.channels.email.smtpPort,
              smtpUser: config.channels.email.smtpUser,
              smtpPassword: config.channels.email.smtpPassword,
              to: config.channels.email.to,
            }
          : { url: config.channels.webhook.url };
      const result = await api.testAlertChannel(channel, credentials);
      setTestResults((r) => ({ ...r, [channel]: result[channel] }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [channel]: { ok: false, error: err.message } }));
    } finally {
      setTesting((t) => ({ ...t, [channel]: false }));
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.setAlertsConfig(config);
      onSaved(saved);
      onClose();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">{t('alertsSettings.configureTitle')}</span>
        <button type="button" className="link-btn text-muted hover:text-ink text-[15px] leading-none" onClick={onClose} title={t('alertsSettings.closeWithoutSaving')}>
          ×
        </button>
      </div>

      <div className="px-3.5 py-3 flex flex-col gap-4">
        <div>
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1 inline-flex items-center gap-1.5">
            {t('alertsSettings.triggers')}
            <InfoDot title={t('alertsSettings.triggersTooltip')} />
          </div>
          <TriggerToggle
            label={t('alertsSettings.serviceDown')}
            hint={t('alertsSettings.serviceDownHint')}
            checked={config.enabled.serviceDown}
            onChange={(v) => updateEnabled('serviceDown', v)}
          />
          <TriggerToggle
            label={t('alertsSettings.storage')}
            hint={t('alertsSettings.storageHint')}
            checked={config.enabled.storage}
            onChange={(v) => updateEnabled('storage', v)}
          />
          <TriggerToggle label={t('alertsSettings.cpuThreshold')} checked={config.enabled.cpu} onChange={(v) => updateEnabled('cpu', v)} />
          <TriggerToggle label={t('alertsSettings.memoryThreshold')} checked={config.enabled.memory} onChange={(v) => updateEnabled('memory', v)} />
          <TriggerToggle
            label={t('alertsSettings.errorRateThreshold')}
            hint={t('alertsSettings.errorRateHint')}
            checked={config.enabled.errorRate}
            onChange={(v) => updateEnabled('errorRate', v)}
          />
          <TriggerToggle
            label={t('alertsSettings.latencyThreshold')}
            hint={t('alertsSettings.latencyHint')}
            checked={config.enabled.latency}
            onChange={(v) => updateEnabled('latency', v)}
          />
          <TriggerToggle
            label="TLS certificate expiry"
            hint='only checked for a watched service whose health check is set to "HTTP" against an https:// URL'
            checked={config.enabled.tlsExpiry}
            onChange={(v) => updateEnabled('tlsExpiry', v)}
          />
        </div>

        <div>
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1.5 inline-flex items-center gap-1.5">
            {t('alertsSettings.thresholds')}
          </div>
          <div className="flex flex-col gap-1.5">
            <ThresholdPair
              label={t('alertsSettings.cpu')}
              warning={config.thresholds.cpuWarningPercent}
              critical={config.thresholds.cpuCriticalPercent}
              onWarning={(v) => updateThreshold('cpuWarningPercent', v)}
              onCritical={(v) => updateThreshold('cpuCriticalPercent', v)}
            />
            <ThresholdPair
              label={t('alertsSettings.memory')}
              warning={config.thresholds.memWarningPercent}
              critical={config.thresholds.memCriticalPercent}
              onWarning={(v) => updateThreshold('memWarningPercent', v)}
              onCritical={(v) => updateThreshold('memCriticalPercent', v)}
            />
            <ThresholdPair
              label={t('alertsSettings.errorRate')}
              warning={config.thresholds.errorRateWarningPercent}
              critical={config.thresholds.errorRateCriticalPercent}
              onWarning={(v) => updateThreshold('errorRateWarningPercent', v)}
              onCritical={(v) => updateThreshold('errorRateCriticalPercent', v)}
            />
            <ThresholdPair
              label={t('alertsSettings.latency')}
              unit="ms"
              max={60000}
              warning={config.thresholds.latencyWarningMs}
              critical={config.thresholds.latencyCriticalMs}
              onWarning={(v) => updateThreshold('latencyWarningMs', v)}
              onCritical={(v) => updateThreshold('latencyCriticalMs', v)}
            />
            <ThresholdPair
              label={t('alertsSettings.tlsExpiry')}
              unit="d"
              max={365}
              direction="atMost"
              warning={config.thresholds.tlsExpiryWarningDays}
              critical={config.thresholds.tlsExpiryCriticalDays}
              onWarning={(v) => updateThreshold('tlsExpiryWarningDays', v)}
              onCritical={(v) => updateThreshold('tlsExpiryCriticalDays', v)}
            />
          </div>
          <div className="text-[12px] text-muted mt-1">{t('alertsSettings.thresholdNote')}</div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-[13px]">
            <span className="text-ink-dim inline-flex items-center gap-1.5">
              {t('alertsSettings.sustainedFor')}
              <InfoDot title={t('alertsSettings.sustainedTooltip')} />
            </span>
            <input
              type="number"
              min="1"
              max="20"
              value={config.sustainChecks}
              onChange={(e) => setConfig((c) => ({ ...c, sustainChecks: e.target.value === '' ? '' : Number(e.target.value) }))}
              className="w-14 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
            />
            <span className="text-muted">{t('alertsSettings.consecutiveChecks')}</span>
          </label>
        </div>

        <div>
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1.5">{t('alertsSettings.delivery')}</div>
          <div className="flex flex-col gap-2">
            <ChannelSection
              title={t('alertsSettings.telegramTitle')}
              description={t('alertsSettings.telegramDesc')}
              enabled={config.channels.telegram.enabled}
              onToggleEnabled={(v) => updateChannel('telegram', 'enabled', v)}
              onTest={() => runTest('telegram')}
              testResult={testResults.telegram}
              testing={Boolean(testing.telegram)}
              fields={
                <>
                  <input
                    type="text"
                    placeholder={t('alertsSettings.botTokenPlaceholder')}
                    value={config.channels.telegram.botToken}
                    onChange={(e) => updateChannel('telegram', 'botToken', e.target.value)}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                  <input
                    type="text"
                    placeholder={t('alertsSettings.chatIdPlaceholder')}
                    value={config.channels.telegram.chatId}
                    onChange={(e) => updateChannel('telegram', 'chatId', e.target.value)}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                </>
              }
            />
            <ChannelSection
              title={t('alertsSettings.webhookTitle')}
              description={t('alertsSettings.webhookDesc')}
              enabled={config.channels.webhook.enabled}
              onToggleEnabled={(v) => updateChannel('webhook', 'enabled', v)}
              onTest={() => runTest('webhook')}
              testResult={testResults.webhook}
              testing={Boolean(testing.webhook)}
              fields={
                <input
                  type="text"
                  placeholder={t('alertsSettings.webhookPlaceholder')}
                  value={config.channels.webhook.url}
                  onChange={(e) => updateChannel('webhook', 'url', e.target.value)}
                  className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-md"
                />
              }
            />
            <ChannelSection
              title={t('alertsSettings.emailTitle')}
              description={t('alertsSettings.emailDesc')}
              enabled={config.channels.email.enabled}
              onToggleEnabled={(v) => updateChannel('email', 'enabled', v)}
              onTest={() => runTest('email')}
              testResult={testResults.email}
              testing={Boolean(testing.email)}
              fields={
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="text"
                      placeholder={t('alertsSettings.smtpHostPlaceholder')}
                      value={config.channels.email.smtpHost}
                      onChange={(e) => updateChannel('email', 'smtpHost', e.target.value)}
                      className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-[13rem]"
                    />
                    <input
                      type="number"
                      placeholder={t('alertsSettings.portPlaceholder')}
                      value={config.channels.email.smtpPort}
                      onChange={(e) => updateChannel('email', 'smtpPort', e.target.value === '' ? '' : Number(e.target.value))}
                      className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-20"
                    />
                    <span className="text-muted text-[12px]">{t('alertsSettings.portHint')}</span>
                  </div>
                  <input
                    type="text"
                    placeholder={t('alertsSettings.senderPlaceholder')}
                    value={config.channels.email.smtpUser}
                    onChange={(e) => updateChannel('email', 'smtpUser', e.target.value)}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                  <input
                    type="password"
                    placeholder={t('alertsSettings.passwordPlaceholder')}
                    value={config.channels.email.smtpPassword}
                    onChange={(e) => updateChannel('email', 'smtpPassword', e.target.value)}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                  <input
                    type="text"
                    placeholder={t('alertsSettings.sendToPlaceholder')}
                    value={config.channels.email.to}
                    onChange={(e) => updateChannel('email', 'to', e.target.value)}
                    className="bg-panel border border-border-soft rounded px-2 py-1 font-mono text-[13px] text-ink w-full max-w-xs"
                  />
                </>
              }
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border-soft">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
          >
            {saving ? t('alertsSettings.saving') : t('alertsSettings.save')}
          </button>
          <button type="button" onClick={onClose} className="link-btn text-[13px]">
            {t('alertsSettings.cancel')}
          </button>
          {saveError && <span className="text-[13px] text-down">{saveError}</span>}
        </div>
      </div>
    </div>
  );
}
