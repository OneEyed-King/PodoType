import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Reddit/reviewer feedback (multiple reviewers, independently): the
// Overview showed fleet-wide charts and an incident list, but nothing
// answered "which service actually started this" when several services
// are degraded at once — you'd see 3 red rows and have to guess which one
// was the cause vs. a downstream symptom. The data to answer that already
// existed (every alert in activeAlerts carries firstBreachAt — see
// evaluateAlertCondition in server.js), it just wasn't surfaced anywhere.
// This component does the one simple thing: when 2+ alerts are active at
// once, call out whichever one fired FIRST as the likely origin point —
// everything that started breaching later is presented as "since affected"
// rather than as its own unrelated incident. This is temporal ordering,
// not causal proof (two unrelated services could just coincidentally break
// around the same time) — the wording below is deliberately "likely
// origin", never a hard claim of causation.
const POLL_MS = 5000;

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export default function RootCauseSummary({ onSelectService }) {
  const [alerts, setAlerts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    function tick() {
      api
        .alerts()
        .then((body) => {
          if (!cancelled) setAlerts(body);
        })
        .catch(() => {});
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!alerts) return null;

  const active = (alerts.active || []).filter((a) => a.firstBreachAt && a.service);
  // Nothing to correlate with fewer than 2 concurrent alerts — a single
  // active alert IS the root cause, trivially, so a banner here would just
  // repeat what IncidentPanel already shows.
  if (active.length < 2) return null;

  const sorted = [...active].sort(
    (a, b) => new Date(a.firstBreachAt).getTime() - new Date(b.firstBreachAt).getTime()
  );
  const origin = sorted[0];
  const affectedServices = [...new Set(sorted.slice(1).map((a) => a.service))].filter(
    (s) => s !== origin.service
  );
  if (affectedServices.length === 0) return null; // all alerts trace back to the same single service

  const originAgo = fmtAgo(origin.firstBreachAt);

  return (
    <div className="mb-5 border border-slow/40 bg-slow/5 rounded-lg px-3.5 py-2.5">
      <div className="text-[12px] font-bold uppercase tracking-wider text-slow mb-1">Likely origin</div>
      <div className="text-[13px] text-ink leading-relaxed">
        <button
          type="button"
          className="font-semibold text-accent hover:underline"
          onClick={() => onSelectService && onSelectService(origin.service)}
        >
          {origin.service}
        </button>{' '}
        degraded first{originAgo ? ` (${originAgo})` : ''} — {affectedServices.length} other service
        {affectedServices.length === 1 ? '' : 's'} ({affectedServices.join(', ')}) started breaching after.
        This is based on alert timing, not a confirmed cause — worth checking {origin.service} first.
      </div>
    </div>
  );
}
