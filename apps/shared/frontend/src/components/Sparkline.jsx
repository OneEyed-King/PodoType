// Minimal inline SVG line chart — a handful of points connected by straight
// lines, scaled to fit a small fixed box. Deliberately not a charting
// library (recharts, chart.js, ...): this project already avoids adding a
// dependency (or a container) for something a page can just draw itself
// (see e.g. server.js's Prometheus-line parser instead of a metrics client
// library) — one polyline doesn't need one either.
export default function Sparkline({ points, width = 96, height = 24, color = 'currentColor' }) {
  const numericCount = points.filter((v) => v !== null && v !== undefined && Number.isFinite(v)).length;
  if (numericCount < 2) {
    // Not enough real data yet to draw a trend (first sample after a
    // restart, or a container with no configured memory limit sending
    // nulls) — an empty box beats a flat, misleading line at zero.
    return <svg width={width} height={height} aria-hidden="true" />;
  }

  const values = points.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Points with a null/undefined value (a gap — e.g. this container's very
  // first stats sample, before a rate had a prior sample to diff against)
  // are skipped rather than plotted as zero, so a missing reading doesn't
  // read as a real dip to zero.
  const coords = [];
  points.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    const x = (i / (points.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    coords.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
