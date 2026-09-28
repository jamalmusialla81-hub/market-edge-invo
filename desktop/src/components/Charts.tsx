// Small dependency-free SVG charts. Single-series lines and polarity bars
// (green = gain, red = loss); every chart has a hover readout and an empty
// state that says there is no data rather than drawing placeholder shapes.
import { useMemo, useRef, useState } from 'react';

const W = 640;
const H = 220;
const PAD = { l: 64, r: 16, t: 12, b: 28 };

function extent(values: number[], includeZero = false): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.01 || 1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

function ticks(lo: number, hi: number, n = 4): number[] {
  return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}

export function Empty({ text = 'No data yet' }: { text?: string }) {
  return <div className="chart-empty">{text}</div>;
}

export function LineChart({ points, yFormat, xFormat, color = 'var(--series-1)', zeroLine = false, area = false, label }: {
  points: { x: number; y: number }[]; yFormat: (v: number) => string; xFormat: (v: number) => string;
  color?: string; zeroLine?: boolean; area?: boolean; label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const [x0, x1] = [points[0].x, points[points.length - 1].x];
    const [y0, y1] = extent(points.map((p) => p.y), zeroLine);
    const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => PAD.t + (1 - (y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const base = sy(Math.max(y0, Math.min(0, y1)));
    return { sx, sy, d, y0, y1, x0, x1, base };
  }, [points, zeroLine]);
  if (!geo) return <Empty text={points.length === 1 ? 'Only one data point so far' : 'No data yet'} />;

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i += 1) if (Math.abs(geo.sx(points[i].x) - x) < Math.abs(geo.sx(points[best].x) - x)) best = i;
    setHover(best);
  };
  const h = hover === null ? null : points[hover];
  return (
    <div className="chart">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks(geo.y0, geo.y1).map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.sy(t)} y2={geo.sy(t)} className="grid" />
            <text x={PAD.l - 8} y={geo.sy(t) + 4} className="axis" textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 8} className="axis">{xFormat(geo.x0)}</text>
        <text x={W - PAD.r} y={H - 8} className="axis" textAnchor="end">{xFormat(geo.x1)}</text>
        {zeroLine && geo.y0 < 0 && geo.y1 > 0 && <line x1={PAD.l} x2={W - PAD.r} y1={geo.sy(0)} y2={geo.sy(0)} className="zero" />}
        {area && <path d={`${geo.d}L${geo.sx(geo.x1)},${geo.base}L${geo.sx(geo.x0)},${geo.base}Z`} fill={color} opacity={0.12} />}
        <path d={geo.d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {h && (
          <g>
            <line x1={geo.sx(h.x)} x2={geo.sx(h.x)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
            <circle cx={geo.sx(h.x)} cy={geo.sy(h.y)} r={4} fill={color} stroke="var(--bg-panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      <div className="chart-readout">{h ? `${xFormat(h.x)} · ${yFormat(h.y)}` : `${points.length} points · hover for values`}</div>
    </div>
  );
}

export function PolarityBars({ items, format, label }: { items: { label: string; value: number; note?: string }[]; format: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!items.length) return <Empty />;
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  return (
    <div className="bars" role="img" aria-label={label}>
      {items.map((item, i) => {
        const w = (Math.abs(item.value) / max) * 50;
        return (
          <div className="bar-row" key={item.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="bar-label">{item.label}</span>
            <span className="bar-track">
              <span className="bar-mid" />
              <span className={`bar ${item.value >= 0 ? 'pos' : 'neg'}`}
                style={item.value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
            </span>
            <span className={`bar-value ${item.value > 0 ? 'pos' : item.value < 0 ? 'neg' : ''}`}>{format(item.value)}</span>
            {hover === i && item.note && <span className="bar-note">{item.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Histogram of per-trade outcomes; bins left of zero are losses. */
export function Histogram({ values, format, label, bins = 10 }: { values: number[]; format: (v: number) => string; label: string; bins?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!values.length) return <Empty text="No closed trades yet" />;
  let lo = Math.min(...values, 0);
  let hi = Math.max(...values, 0);
  if (lo === hi) { lo -= 1; hi += 1; }
  const step = (hi - lo) / bins;
  const counts = Array.from({ length: bins }, (_, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, n: 0 }));
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / step))].n += 1;
  const maxN = Math.max(...counts.map((c) => c.n));
  return (
    <div className="chart">
      <div className="histogram" role="img" aria-label={label}>
        {counts.map((c, i) => (
          <div key={i} className="hist-col" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className={`hist-bar ${c.to <= 0 ? 'neg' : c.from >= 0 ? 'pos' : 'mixed'}`} style={{ height: `${(c.n / maxN) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-readout">
        {hover !== null ? `${format(counts[hover].from)} to ${format(counts[hover].to)}: ${counts[hover].n} trade(s)` : `${values.length} closed trades · ${format(lo)} to ${format(hi)}`}
      </div>
    </div>
  );
}

export function CountBars({ items, label }: { items: { label: string; value: number }[]; label: string }) {
  if (!items.length) return <Empty />;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="bars" role="img" aria-label={label}>
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <span className="bar-label">{item.label}</span>
          <span className="bar-track"><span className="bar neutral" style={{ left: 0, width: `${(item.value / max) * 100}%` }} /></span>
          <span className="bar-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
