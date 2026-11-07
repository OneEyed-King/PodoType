import { useEffect, useState } from 'react';
import ChartPanel from './ChartPanel.jsx';
import MultiSeriesChartPanel from './MultiSeriesChartPanel.jsx';
import { api } from '../../api.js';

// Fleet-wide Golden Signals for the Overview page — the thing SigNoz/
// Datadog/Grafana all put front-and-center on their landing dashboard:
// request rate, error rate, and latency across EVERY watched service at
// once, not one container at a time. No new backend endpoint: this reuses
// the exact same api.metricsHistory(name) each service's own Traces tab
// already calls (see TracesPanel.jsx), just fetched for every watched
// service in parallel and merged client-side — same zero-extra-ClickHouse-
// load reasoning as that panel.
//
// Requests and latency are broken down PER SERVICE (one color per
// service, from index.css's --color-series-1..8 — the dataviz skill's
// validated categorical palette), not flattened into one purple line —
// that's what actually makes "which service is driving this" readable at
// a glance instead of requiring a click into each one. Error rate stays a
// single request-weighted line: a blended error percentage is one
// coherent number, not a sum of parts, so breaking it out per service
// wouldn't add anything a glance at the latency/requests breakdown
// doesn't already point to.
//
// Color assignment is by a FIXED service order (alphabetical, not however
// `services` happens to be ordered this render) so a service keeps its
// color as others are added/removed/reordered — "color follows the
// entity, never its rank" (dataviz skill). Past the 8 available slots,
// the rest fold into a shared neutral "Other services" series rather than
// cycling hues (also that skill's rule — a 9th series is never a
// generated color).
//
// Merging strategy: each service's own history samples on its own cadence
// (self-hosted ticks every ALERT_EVAL_INTERVAL_MS; hosted buckets by
// absolute wall-clock time), so points don't line up index-for-index once
// more than one service is in play. Timestamps are rounded to the nearest
// BUCKET_MS and merged into one shared timeline instead of zipped by
// array index, which would silently misalign services that joined the
// watch list at different times or sampled at a slightly different tick.
const POLL_MS = 20000;
const BUCKET_MS = 20000;
const MAX_SERIES_SLOTS = 8;
const SERIES_COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--color-series-${n})`);
const OTHER_COLOR = 'rgb(var(--color-unknown))';

function bucketOf(t) {
  return Math.round(t / BUCKET_MS) * BUCKET_MS;
}

function safeKey(name) {
  // Recharts dataKey doubles as the row's object key — sanitize so a
  // container name with dots/colons/spaces (all legal in a Docker
  // container name) can't collide with anything or break lookups.
  return `s_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export default function FleetGoldenSignals({ services }) {
  const [perService, setPerService] = useState(new Map());

  useEffect(() => {
    let cancelled = false;
    function tick() {
      Promise.all(
        services.map((s) =>
          api
            .metricsHistory(s.name)
            .then((body) => [s.name, body || {}])
            .catch(() => [s.name, null])
        )
      ).then((entries) => {
        if (cancelled) return;
        setPerService(new Map(entries));
      });
    }
    if (services.length > 0) {
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    setPerService(new Map());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services.map((s) => s.name).join(','), services.length]);

  if (services.length === 0) return null;

  // Fixed order independent of prop/fetch ordering — alphabetical by name
  // — so a service's color slot doesn't shuffle as the watch list changes
  // shape elsewhere on the page.
  const orderedNames = [...services.map((s) => s.name)].sort();
  const namedSlots = orderedNames.slice(0, MAX_SERIES_SLOTS);
  const foldedNames = new Set(orderedNames.slice(MAX_SERIES_SLOTS));
  const hasOverflow = foldedNames.size > 0;

  const REQ_SERIES = namedSlots.map((name, i) => ({ key: safeKey(name), label: name, color: SERIES_COLORS[i] }));
  const LAT_SERIES = [...REQ_SERIES];
  if (hasOverflow) {
    REQ_SERIES.push({ key: 's__other', label: `Other (${foldedNames.size})`, color: OTHER_COLOR });
    LAT_SERIES.push({ key: 's__other', label: `Other (${foldedNames.size})`, color: OTHER_COLOR });
  }

  // bucketT -> row object carrying every series key, plus the fleet-total
  // accumulators the single-line error-rate chart below still needs.
  const buckets = new Map();
  function rowAt(t) {
    const b = bucketOf(t);
    let row = buckets.get(b);
    if (!row) {
      row = { t: b, errWeightedSum: 0, errWeightSum: 0 };
      buckets.set(b, row);
    }
    return row;
  }

  for (const [name, body] of perService.entries()) {
    if (!body) continue;
    const key = foldedNames.has(name) ? 's__other' : safeKey(name);
    for (const p of body.requests || []) {
      if (p.t === null || p.t === undefined) continue;
      const row = rowAt(p.t);
      if (Number.isFinite(p.requestsPerSec)) {
        row[key] = (row[key] || 0) + p.requestsPerSec;
        if (Number.isFinite(p.errorRate)) {
          row.errWeightedSum += p.errorRate * p.requestsPerSec;
          row.errWeightSum += p.requestsPerSec;
        }
      }
    }
    for (const p of body.latency || []) {
      if (p.t === null || p.t === undefined || !Number.isFinite(p.p95Ms)) continue;
      const row = rowAt(p.t);
      const latKey = `lat_${key}`;
      // Folded services share one "Other" latency line too — worst of the
      // group at that point, same "don't hide the outlier in an average"
      // reasoning the old single worst-service chart used.
      row[latKey] = row[latKey] === undefined ? p.p95Ms : Math.max(row[latKey], p.p95Ms);
    }
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.t - b.t);
  const reqRows = sortedBuckets;
  const latRows = sortedBuckets.map((row) => {
    const out = { t: row.t };
    for (const s of LAT_SERIES) out[s.key] = row[`lat_${s.key}`] ?? null;
    return out;
  });
  const errPoints = sortedBuckets.map((row) => ({
    t: row.t,
    v: row.errWeightSum > 0 ? (row.errWeightedSum / row.errWeightSum) * 100 : 0,
  }));

  function lastValue(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].v !== null && arr[i].v !== undefined && Number.isFinite(arr[i].v)) return arr[i].v;
    }
    return undefined;
  }
  const lastErr = lastValue(errPoints);

  return (
    <div className="mb-5">
      <div className="flex gap-3 flex-wrap">
        <MultiSeriesChartPanel
          label="Fleet requests/sec — by service"
          data={reqRows}
          series={REQ_SERIES}
          mode="stackedArea"
          valueFormatter={(v) => v.toFixed(1)}
          height={260}
          infoTitle="Every watched service's own request rate, stacked — the stack height at any point is the fleet total."
          emptyText="No request traffic observed yet across watched services."
        />
        <ChartPanel
          label="Fleet error rate"
          points={errPoints}
          color={lastErr > 0 ? 'rgb(var(--color-down))' : 'rgb(var(--color-accent))'}
          tone={lastErr > 0 ? 'text-down' : undefined}
          currentText={lastErr !== undefined ? `${lastErr.toFixed(1)}%` : '—'}
          unit="%"
          valueFormatter={(v) => `${v.toFixed(0)}%`}
          height={260}
          infoTitle="Request-weighted average error rate across every watched service."
          emptyText="No request traffic observed yet across watched services."
        />
        <MultiSeriesChartPanel
          label="p95 latency — by service"
          data={latRows}
          series={LAT_SERIES}
          mode="lines"
          unit="ms"
          valueFormatter={(v) => `${Math.round(v)}ms`}
          height={260}
          infoTitle="Each watched service's own p95 latency — which one is actually dragging, not just a single worst-case number."
          emptyText="No trace data yet across watched services."
        />
      </div>
    </div>
  );
}
