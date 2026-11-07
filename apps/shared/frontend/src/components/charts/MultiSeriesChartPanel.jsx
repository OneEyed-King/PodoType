import {
  ResponsiveContainer,
  AreaChart,
  LineChart,
  Area,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';

// Multi-series sibling to ChartPanel.jsx — for the cases where more than
// one line genuinely belongs on the same axis (percentiles, a per-entity
// breakdown that sums to a whole), not decorative color. Per the dataviz
// skill: "assign categorical hues in fixed order, never cycled" (series
// colors come from index.css's --color-series-1..8, the validated
// categorical palette — see that skill's references/palette.md, re-run
// through its validator against this app's own panel surfaces) and
// "color follows the entity, never its rank" (a series keeps its slot
// across re-renders, picked by array position in the `series` prop, not
// reassigned when one drops out).
//
// `mode`:
//   - 'lines': overlapping, non-stacked lines — for values that are each
//     already a summary and shouldn't be added together (p50/p95/p99
//     latency: p99 is not "on top of" p95, they're independent readings
//     of the same distribution).
//   - 'stackedArea': stacked composition — for values that genuinely sum
//     to a meaningful whole (per-service request rate, where the stack
//     height at any point IS the fleet total).
//
// `data`: array of { t: msEpoch, [series[i].key]: number|null, ... }.
// `series`: array of { key, label, color } — color is a "var(--color-x)"
// or raw hex string, not wrapped in rgb(...) (unlike ChartPanel's
// rgb(var(...)) tokens — the series-N tokens are already plain hex).
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

function TooltipContent({ active, payload, label, series, unit, valueFormatter }) {
  if (!active || !payload || payload.length === 0) return null;
  // Keep the series' own fixed order (payload's order can vary), and skip
  // entries with no reading at this point rather than show "—" for every
  // series that just doesn't have a sample here.
  const byKey = new Map(payload.map((p) => [p.dataKey, p.value]));
  return (
    <div className="bg-panel-raised border border-border rounded-md px-2.5 py-1.5 text-[12px] shadow-lg">
      <div className="text-muted font-mono text-[11px] mb-1">{fmtTimeFull(label)}</div>
      <div className="flex flex-col gap-0.5">
        {series.map((s) => {
          const v = byKey.get(s.key);
          if (v === null || v === undefined || !Number.isFinite(v)) return null;
          const text = valueFormatter ? valueFormatter(v) : `${v}${unit || ''}`;
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-ink-dim">{s.label}</span>
              <span className="text-ink font-semibold ml-auto pl-3">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Custom legend content — the dataviz skill's "text wears text tokens,
// never the series color" rule: the swatch carries identity, the label
// stays in muted ink regardless of which series it names.
function LegendContent({ series }) {
  return (
    <div className="flex items-center gap-3.5 flex-wrap justify-center pt-1.5 text-[11px]">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 text-muted">
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export default function MultiSeriesChartPanel({
  label,
  unit = '',
  data,
  series,
  mode = 'lines',
  valueFormatter,
  height = 220,
  emptyText = 'No data yet for this window.',
  infoTitle,
}) {
  const enoughPoints =
    (data || []).filter((row) => series.some((s) => row[s.key] !== null && row[s.key] !== undefined && Number.isFinite(row[s.key])))
      .length >= 2;
  const Chart = mode === 'stackedArea' ? AreaChart : LineChart;

  return (
    <div className="border border-border-soft rounded-lg px-4 py-3.5 bg-panel flex-1 min-w-[280px]">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted">{label}</span>
        {infoTitle && <span className="text-muted text-[11px] italic cursor-help shrink-0" title={infoTitle}>i</span>}
      </div>
      {!enoughPoints ? (
        <div className="flex items-center justify-center text-[13px] text-muted" style={{ height }}>
          {emptyText}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <Chart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
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
              content={<TooltipContent series={series} unit={unit} valueFormatter={valueFormatter} />}
              cursor={{ stroke: 'rgb(var(--color-muted))', strokeWidth: 1, strokeDasharray: '3 3' }}
            />
            <Legend content={<LegendContent series={series} />} />
            {mode === 'stackedArea'
              ? series.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stackId="1"
                    stroke={s.color}
                    strokeWidth={1}
                    fill={s.color}
                    fillOpacity={0.55}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))
              : series.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
          </Chart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
