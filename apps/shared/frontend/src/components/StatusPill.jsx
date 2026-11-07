// "unknown" is deliberately never styled like "down" — absence of evidence
// (container just starting, health check not run yet) must never look like
// a confirmed failure. See ../../server.js "Active health checks" for why.
export function statusPillProps(svc) {
  if (svc.up === true) return { text: 'up', cls: 'pill-up' };
  if (svc.up === false) return { text: 'down', cls: 'pill-down' };
  if (svc.upSource === 'checking') return { text: 'checking…', cls: 'pill-unknown' };
  if (svc.upSource === 'docker-health-starting') return { text: 'health check starting…', cls: 'pill-unknown' };
  if (svc.upSource === 'not-found' || !svc.found) return { text: 'container not seen', cls: 'pill-unknown' };
  return { text: 'unknown', cls: 'pill-unknown' };
}

export function tracePillProps(trace) {
  if (!trace) return null;
  if (trace.status === 'recent') return trace.slow ? { text: 'slow', cls: 'pill-slow' } : { text: 'ok', cls: 'pill-up' };
  if (trace.status === 'idle') return { text: 'no recent traces', cls: 'pill-unknown' };
  return { text: 'no traces yet', cls: 'pill-unknown' };
}

export default function StatusPill({ text, cls }) {
  return <span className={`pill ${cls}`}>{text}</span>;
}
