import { useTranslation } from 'react-i18next';

// Shown in place of a ClickHouse-backed view (Service map, Traces/Query
// console, a service's Traces/Metrics-history/Logs tabs) whenever the
// "alerts + uptime only" toggle (see ObservabilityPanel.jsx) is off —
// there's nothing stored to show, so this explains why instead of
// rendering an empty chart/table that looks broken.
export default function ObservabilityDisabledNotice({ label }) {
  const { t } = useTranslation();
  return (
    <div className="border border-accent rounded-lg bg-panel-raised px-4 py-3 text-[13px] text-ink-dim">
      {label
        ? t('observabilityPanel.disabledNoticeWithLabel', { label })
        : t('observabilityPanel.disabledNoticeGeneric')}
    </div>
  );
}
