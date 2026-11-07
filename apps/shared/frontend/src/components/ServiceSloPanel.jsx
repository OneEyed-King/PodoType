import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Named, pass/fail conditions for a service — "99% of requests under
// 500ms" instead of a bare p95 number with no stated target — the same
// thing Coroot's own SLO tab shows. Not a new concept or new storage:
// every number this reads (the alert thresholds, and svc.red/svc.trace's
// current values) already exists (see ServiceAlertOverrides.jsx for the
// threshold fetch this mirrors, and WatchedRow's own svc prop for the
// live numbers) — this only reframes them as conditions with a verdict,
// entirely client-side.
//
// Self-hosted and hosted deliberately have DIFFERENT threshold shapes
// (see apps/hosted/license-server/repositories/hostedAlertStore.js's defaultConfig
// comment: hosted has no latency threshold yet, and a single
// errorRatePercent instead of self-hosted's warn/critical pair) — every
// condition below is only shown when its underlying threshold field is
// actually present, rather than assuming one shape and showing a
// misleading "—" for the other build.
function buildConditions(thresholds, svc) {
  const conditions = [];
  const t = thresholds || {};

  const errorRateTargetPercent =
    typeof t.errorRateCriticalPercent === 'number'
      ? t.errorRateCriticalPercent
      : typeof t.errorRatePercent === 'number'
      ? t.errorRatePercent
      : null;
  if (errorRateTargetPercent !== null && svc.red && typeof svc.red.errorRate === 'number') {
    const currentPercent = svc.red.errorRate * 100;
    conditions.push({
      key: 'availability',
      label: 'Availability',
      detail: `error rate stays under ${errorRateTargetPercent}%`,
      ok: currentPercent < errorRateTargetPercent,
      current: `${currentPercent.toFixed(1)}% errors now`,
    });
  }

  if (typeof t.latencyCriticalMs === 'number' && svc.trace && typeof svc.trace.p95Ms === 'number') {
    conditions.push({
      key: 'latency',
      label: 'Latency',
      detail: `p95 stays under ${Math.round(t.latencyCriticalMs)}ms`,
      ok: svc.trace.p95Ms < t.latencyCriticalMs,
      current: `${Math.round(svc.trace.p95Ms)}ms now`,
    });
  }

  return conditions;
}

export default function ServiceSloPanel({ svc }) {
  const [effective, setEffective] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .alertOverrides(svc.name)
      .then((body) => {
        if (!cancelled) setEffective(body.effective || null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc.name]);

  if (error) return <div className="text-[13px] text-down">{error}</div>;
  if (!effective) return <div className="text-[13px] text-muted">loading…</div>;

  const conditions = buildConditions(effective.thresholds, svc);

  if (conditions.length === 0) {
    return (
      <div className="text-[13px] text-muted">
        No SLO conditions configured yet for this service — set an error-rate
        {typeof effective.thresholds?.latencyCriticalMs !== 'number' ? '' : ' or latency'} threshold above to get one.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {conditions.map((c) => (
        <div key={c.key} className="flex items-center gap-2 text-[13px]">
          <span className={`pill ${c.ok ? 'pill-up' : 'pill-down'} shrink-0`}>{c.ok ? 'OK' : 'violating'}</span>
          <span className="font-semibold">{c.label}:</span>
          <span className="text-ink-dim">{c.detail}</span>
          <span className="text-muted font-mono text-[12px] ml-auto">{c.current}</span>
        </div>
      ))}
    </div>
  );
}
