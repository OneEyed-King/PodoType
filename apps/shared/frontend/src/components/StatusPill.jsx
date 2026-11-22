import i18n from '../i18n/index.js';

// "unknown" is deliberately never styled like "down" — absence of evidence
// (container just starting, health check not run yet) must never look like
// a confirmed failure. See ../../server.js "Active health checks" for why.
//
// These two helpers build plain {text, cls} props rather than components,
// so they're called from render logic in several places (not hooks) —
// resolved via the shared i18n instance directly (i18n.t) rather than
// useTranslation(), since there's no component here to hook into.
export function statusPillProps(svc) {
  const t = i18n.t;
  if (svc.up === true) return { text: t('statusPill.up'), cls: 'pill-up' };
  if (svc.up === false) return { text: t('statusPill.down'), cls: 'pill-down' };
  if (svc.upSource === 'checking') return { text: t('statusPill.checking'), cls: 'pill-unknown' };
  if (svc.upSource === 'docker-health-starting') return { text: t('statusPill.healthCheckStarting'), cls: 'pill-unknown' };
  if (svc.upSource === 'not-found' || !svc.found) return { text: t('statusPill.containerNotSeen'), cls: 'pill-unknown' };
  return { text: t('statusPill.unknown'), cls: 'pill-unknown' };
}

export function tracePillProps(trace) {
  const t = i18n.t;
  if (!trace) return null;
  if (trace.status === 'recent') return trace.slow ? { text: t('statusPill.traceSlow'), cls: 'pill-slow' } : { text: t('statusPill.traceOk'), cls: 'pill-up' };
  if (trace.status === 'idle') return { text: t('statusPill.noRecentTraces'), cls: 'pill-unknown' };
  return { text: t('statusPill.noTracesYet'), cls: 'pill-unknown' };
}

export default function StatusPill({ text, cls }) {
  return <span className={`pill ${cls}`}>{text}</span>;
}
