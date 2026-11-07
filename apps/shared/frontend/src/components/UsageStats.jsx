import { useEffect, useState } from 'react';
import { api, DEPLOY_MODE } from '../api.js';
import { formatRangeMinutes } from './TimeRangePicker.jsx';
import InfoDot from './InfoDot.jsx';

const HOSTED = DEPLOY_MODE === 'hosted';
const POLL_MS = 30000;

// Reference-only monthly price points for Hetzner Cloud's budget
// shared-vCPU (CX) line, EU region, USD — pulled from hetzner.com /
// bestusavps.com in late September 2026. This is NOT this host's actual
// bill (Podotype has no way to know what anyone actually pays their
// provider — see the "estimate from detected specs" decision this
// feature was built around), just a well-known, honest reference point
// so "this machine is roughly a $X/mo class of box" means something
// concrete instead of an invented number. Update this table if Hetzner's
// own pricing changes meaningfully; swap the whole table for a different
// provider's if that's a more useful reference for your audience.
const VPS_COST_REFERENCE = [
  { cores: 1, ramGb: 2, usd: 4.59 },
  { cores: 2, ramGb: 4, usd: 6.49 },
  { cores: 4, ramGb: 8, usd: 9.99 },
  { cores: 8, ramGb: 16, usd: 18.49 },
  { cores: 16, ramGb: 32, usd: 34.99 },
];

function estimateMonthlyCostUsd(cores, totalBytes) {
  if (!cores || !totalBytes) return null;
  const ramGb = totalBytes / 1024 / 1024 / 1024;
  // Smallest reference tier that covers BOTH this host's cores and RAM.
  const fit = VPS_COST_REFERENCE.find((t) => cores <= t.cores && ramGb <= t.ramGb);
  if (fit) return fit.usd;
  // Bigger than the largest listed tier — extrapolate linearly from the
  // top tier's $/core rate rather than pretending to know the exact price
  // of a machine that size.
  const top = VPS_COST_REFERENCE[VPS_COST_REFERENCE.length - 1];
  return Math.round(cores * (top.usd / top.cores) * 100) / 100;
}

function fmtCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${n}`;
}

function fmtGb(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

function StatTile({ label, value, sub, warn, info }) {
  return (
    <div className="flex-1 min-w-[170px] border border-border rounded-lg px-4 py-3.5">
      <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1.5 flex items-center gap-1">
        {label}
        {info && <InfoDot title={info} />}
      </div>
      <div className={`text-[28px] font-bold leading-none ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="text-[12px] text-ink-dim mt-1.5">{sub}</div>}
    </div>
  );
}

// The "Est. host cost" tile, but editable — Coroot can show an exact
// price because it integrates with specific cloud providers' APIs; this
// app only ever sees detected CPU/RAM, so VPS_COST_REFERENCE below is
// necessarily a same-specs-different-provider guess. This is the escape
// hatch (backlog item #15): whoever pays the actual bill can enter it
// once, and that number is what shows from then on, with a way back to
// the auto-estimate.
function CostTile({ estimatedUsd, estimatedSub, override, onSave, onClear, saving }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(override ? String(override.monthlyUsd) : '');
  const [label, setLabel] = useState(override ? override.instanceLabel || '' : '');

  function startEdit() {
    setAmount(override ? String(override.monthlyUsd) : '');
    setLabel(override ? override.instanceLabel || '' : '');
    setEditing(true);
  }

  function submit(e) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return;
    onSave(value, label.trim() || null).then(() => setEditing(false));
  }

  if (editing) {
    return (
      <form
        onSubmit={submit}
        className="flex-1 min-w-[220px] border border-accent rounded-lg px-4 py-3.5 flex flex-col gap-2"
      >
        <div className="font-mono text-[11px] text-muted uppercase tracking-wide">Actual monthly cost</div>
        <input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="e.g. 12.00"
          autoFocus
          className="bg-panel-raised border border-border rounded-md px-2.5 py-1.5 text-[14px] text-ink font-mono"
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Instance type (optional, e.g. AWS t3.medium)"
          className="bg-panel-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] text-ink"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={saving}
            className="text-[12px] font-semibold rounded-md px-3 py-1 bg-accent text-[#f5f7fc] hover:brightness-110 disabled:opacity-50"
          >
            Save
          </button>
          <button type="button" className="link-btn text-[12px]" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const usingOverride = Boolean(override);
  const value = usingOverride
    ? `$${override.monthlyUsd < 10 ? override.monthlyUsd.toFixed(2) : Math.round(override.monthlyUsd)}/mo`
    : estimatedUsd !== null
    ? `~$${estimatedUsd < 10 ? estimatedUsd.toFixed(2) : Math.round(estimatedUsd)}/mo`
    : '—';

  return (
    <div className="flex-1 min-w-[170px] border border-border rounded-lg px-4 py-3.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="font-mono text-[11px] text-muted uppercase tracking-wide">
          {usingOverride ? 'Host cost' : 'Est. host cost'}
        </div>
        <button type="button" className="link-btn text-[11px]" onClick={startEdit}>
          {usingOverride ? 'edit' : 'set actual cost'}
        </button>
      </div>
      <div className="text-[28px] font-bold leading-none text-ink">{value}</div>
      <div className="text-[12px] text-ink-dim mt-1.5">
        {usingOverride ? (
          <>
            {override.instanceLabel || 'entered manually'}
            {' · '}
            <button type="button" className="link-btn" onClick={onClear} disabled={saving}>
              use auto-estimate instead
            </button>
          </>
        ) : (
          estimatedSub
        )}
      </div>
    </div>
  );
}

// A row of large, always-visible stat tiles — deliberately NOT tucked
// behind a collapsed toggle the way HostStatsPanel's CPU/mem/load detail
// is. The whole point of this component is that a cost figure and a
// usage-cap figure are exactly the numbers someone shouldn't have to go
// looking for — see the request this was built from: caps and cost
// visible in real numbers, not small print.
export default function UsageStats({ rangeMinutes, rangeLabel }) {
  const [hostStats, setHostStats] = useState(null);
  const [usage, setUsage] = useState(null);
  const [usageError, setUsageError] = useState(null);
  // Range-scoped spans/ingest — separate from `usage` above (hosted's
  // always-calendar-month spansThisMonth/spansCap, which stays fixed
  // regardless of the Overview page's own time-range picker, since the
  // free-tier cap IS a calendar-month concept). This is the part that
  // actually moves with rangeMinutes, on BOTH builds — self-hosted never
  // had a usage concept before, this is its first (see engineApi's new
  // usageRange).
  const [rangeUsage, setRangeUsage] = useState(null);
  const [rangeUsageError, setRangeUsageError] = useState(null);
  const [costOverride, setCostOverrideState] = useState(null);
  const [savingOverride, setSavingOverride] = useState(false);

  function loadCostOverride() {
    api
      .getCostOverride()
      .then((body) => setCostOverrideState(body.override))
      .catch(() => {});
  }

  function saveCostOverride(monthlyUsd, instanceLabel) {
    setSavingOverride(true);
    return api
      .setCostOverride(monthlyUsd, instanceLabel)
      .then((body) => setCostOverrideState(body.override))
      .finally(() => setSavingOverride(false));
  }

  function clearCostOverride() {
    setSavingOverride(true);
    api
      .clearCostOverride()
      .then(() => setCostOverrideState(null))
      .finally(() => setSavingOverride(false));
  }

  function load() {
    api
      .hostStats()
      .then(setHostStats)
      .catch(() => {});
    if (HOSTED) {
      api
        .usage()
        .then((body) => {
          setUsage(body);
          setUsageError(null);
        })
        .catch((err) => setUsageError(err.message));
    }
  }

  function loadRangeUsage() {
    if (!rangeMinutes) return;
    const until = new Date();
    const since = new Date(until.getTime() - rangeMinutes * 60 * 1000);
    const sinceIso = since.toISOString();
    const untilIso = until.toISOString();
    const req = HOSTED
      ? api.usage(sinceIso, untilIso).then((body) => ({
          spansInRange: body.spansInRange,
          ingestRatePerSecInRange: body.ingestRatePerSecInRange,
        }))
      : api.usageRange(sinceIso, untilIso);
    req
      .then((body) => {
        setRangeUsage(body);
        setRangeUsageError(null);
      })
      .catch((err) => setRangeUsageError(err.message));
  }

  useEffect(() => {
    load();
    loadCostOverride();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRangeUsage();
    const id = setInterval(loadRangeUsage, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeMinutes]);

  const current = hostStats && hostStats.current;
  const costUsd = current ? estimateMonthlyCostUsd(current.cpu?.cores, current.memory?.totalBytes) : null;

  const capPercent =
    usage && usage.spansCap ? Math.min(100, Math.round((usage.spansThisMonth / usage.spansCap) * 100)) : null;
  const overCap = Boolean(usage && usage.spansCap && usage.spansThisMonth >= usage.spansCap);

  const nothingToShow = costUsd === null && !costOverride && !(HOSTED && usage) && !rangeUsage;
  if (nothingToShow && !usageError && !rangeUsageError) return null;

  return (
    <div className="flex flex-wrap gap-3 mb-5">
      {(costUsd !== null || costOverride) && (
        <CostTile
          estimatedUsd={costUsd}
          estimatedSub={
            current
              ? `${current.cpu.cores} vCPU · ${fmtGb(current.memory.totalBytes)} RAM — reference price for a similarly-sized VPS, not your actual bill`
              : null
          }
          override={costOverride}
          onSave={saveCostOverride}
          onClear={clearCostOverride}
          saving={savingOverride}
        />
      )}

      {rangeUsage && (
        <>
          <StatTile
            label="Spans in range"
            value={fmtCompact(rangeUsage.spansInRange)}
            sub={`across everything stored in the last ${rangeLabel || formatRangeMinutes(rangeMinutes)}`}
          />
          <StatTile
            label="Ingest rate (spans/sec)"
            value={`${
              rangeUsage.ingestRatePerSecInRange >= 10
                ? Math.round(rangeUsage.ingestRatePerSecInRange)
                : rangeUsage.ingestRatePerSecInRange.toFixed(1)
            }/s`}
            sub={`averaged over the last ${rangeLabel || formatRangeMinutes(rangeMinutes)} — pick a wider range above to smooth out short bursts/lulls`}
            info="This is SPANS per second, not requests — one traced request usually produces more than one span (the request itself, plus any downstream/DB/internal calls Beyla captured alongside it), so this number naturally runs higher than your requests/sec. It's also an average over whichever range is selected above, not a live instant reading — if traffic was heavier earlier in a longer window than it is right now, the cumulative 'Spans this month' total can grow faster than this rate alone would suggest. Widen the range to see a more representative average."
          />
        </>
      )}

      {HOSTED && usage && (
        <>
          <StatTile
            label="Spans this month"
            value={fmtCompact(usage.spansThisMonth)}
            sub={usage.spansCap ? `of ${fmtCompact(usage.spansCap)} on the free tier` : 'unlimited'}
            warn={overCap}
          />
          <StatTile label="Data ingested" value={fmtGb(usage.estimatedBytesThisMonth)} sub="this calendar month, estimated" />
          {capPercent !== null && (
            <div className="flex-1 min-w-[170px] border border-border rounded-lg px-4 py-3.5">
              <div className="font-mono text-[11px] text-muted uppercase tracking-wide mb-1.5">Free tier usage</div>
              <div className="h-2.5 rounded-full bg-panel-raised overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full ${overCap ? 'bg-down' : 'bg-accent'}`}
                  style={{ width: `${capPercent}%` }}
                />
              </div>
              <div className={`text-[13px] ${overCap ? 'text-down font-semibold' : 'text-ink-dim'}`}>
                {overCap
                  ? 'Over the free-tier cap — new spans are being dropped until next month.'
                  : `${capPercent}% used this month`}
              </div>
            </div>
          )}
        </>
      )}

      {usageError && <div className="text-[13px] text-down">Couldn't load usage — {usageError}</div>}
      {rangeUsageError && <div className="text-[13px] text-down">Couldn't load range usage — {rangeUsageError}</div>}
    </div>
  );
}
