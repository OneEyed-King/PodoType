import { useId } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';

// The real chart component — replaces the inline-SVG Sparkline wherever a
// metric is meant to be read, not just glanced at: gridlines, a real time
// axis, a formatted Y axis, and a hover tooltip with crosshair, per the
// dataviz skill's "ship the hover layer by default" rule. One series, one
// axis (never dual-axis — see the skill's non-negotiables), with the
// current value rendered big above the plot so the panel reads stat-tile
// first, trend second, the way SigNoz/Grafana panels do. `color` is a
// "rgb(var(--color-x))" string from one of index.css's existing tokens —
// reused, not a new hue, so this stays visually consistent with every
// status pill/dot already on the page.
//
// `points`: array of { t: msEpoch, v: number|null }. Nulls are gapped, not
// zeroed (a missing sample isn't a real dip to zero — same rule Sparkline
// already followed).
function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function fmtTimeFull(ms) {
  try {
    return new Date(ms).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function TooltipContent({ active, payload, label, unit, valueFormatter }) {
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0].value;
  const text = v === null || v === undefined ? 'no data' : valueFormatter ? valueFormatter(v) : `${v}${unit || ''}`;
  return (
    <div className="bg-panel-raised border border-border rounded-md px-2.5 py-1.5 text-[12px] shadow-lg">
      <div className="text-muted font-mono text-[11px] mb-0.5">{fmtTimeFull(label)}</div>
      <div className="text-ink font-semibold">{text}</div>
    </div>
  );
}

export default function ChartPanel({
  label,
  unit = '',
  points,
  color = 'rgb(var(--color-accent))',
  valueFormatter,
  currentText,
  tone,
  height = 220,
  emptyText = 'No data yet for this window.',
  infoTitle,
}) {
  const gradId = useId().replace(/[:]/g, '');
  const data = (points || []).map((p) => ({ t: p.t, v: p.v }));
  const enoughPoints = data.filter((p) => p.v !== null && p.v !== undefined && Number.isFinite(p.v)).length >= 2;

  return (
    <div className="border border-border-soft rounded-lg px-4 py-3.5 bg-panel flex-1 min-w-[260px]">
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted">{label}</span>
        {infoTitle && <span className="text-muted text-[11px] italic cursor-help shrink-0" title={infoTitle}>i</span>}
      </div>
      {currentText !== undefined && (
        <div className={`font-mono text-[26px] font-bold leading-none mb-2 ${tone || 'text-ink'}`}>{currentText}</div>
      )}
      {!enoughPoints ? (
        <div className="flex items-center justify-center text-[13px] text-muted" style={{ height }}>
          {emptyText}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgb(var(--color-border-soft))" strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={fmtTime}
              stroke="rgb(var(--color-muted))"
              tick={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              stroke="rgb(var(--color-muted))"
              tick={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}
              axisLine={false}
              tickLine={false}
              width={44}
              tickFormatter={(v) => (valueFormatter ? valueFormatter(v) : `${v}${unit}`)}
              allowDecimals={false}
            />
            <Tooltip
              content={<TooltipContent unit={unit} valueFormatter={valueFormatter} />}
              cursor={{ stroke: 'rgb(var(--color-muted))', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={2}
              fill={`url(#grad-${gradId})`}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
