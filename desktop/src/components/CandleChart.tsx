// Dependency-free SVG candlestick chart for Trade Detail. The time axis is
// real time, so a gap in the exchange data shows as a gap: nothing is
// interpolated or drawn that the source did not return. Hover for OHLC.
import { useMemo, useRef, useState } from 'react';
import type { Candle, CandleInterval, ChartLevel, ChartMarker } from '../api';
import { Empty } from './Charts';
import { price as fmtPrice, ts } from '../format';

const W = 960;
const H = 400;
const PAD = { l: 10, r: 210, t: 14, b: 28 };
const STEP: Record<CandleInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

const LEVEL_CLASS: Record<string, string> = { ENTRY: 'lvl-entry', STOP: 'lvl-stop', TP1: 'lvl-tp', TP2: 'lvl-tp2', BREAKEVEN_STOP: 'lvl-be' };
const MARKER_CLASS = (kind: string) => (kind === 'ENTRY' ? 'mk-entry' : kind.startsWith('TP') ? 'mk-tp' : kind.includes('STOP') ? 'mk-stop' : 'mk-other');

export interface HindsightLine { key: string; label: string; price: number }
/** A real observed extreme (MFE / MAE). `at_ms` is null when the time it was reached is not known. */
export interface ExcursionPoint { kind: 'MFE' | 'MAE'; price: number; at_ms: number | null; precision?: string | null }
/** A counterfactual exit: research only, never a fill. */
export interface CounterfactualPoint { key: string; label: string; price: number; at_ms: number; r: number | null }

/** Spread right-hand labels so none overlap; keeps their order. */
function spread(ys: number[], gap = 13): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k += 1) if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap;
  const out = new Array(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

export function CandleChart({ candles, interval, levels, markers, currentPrice = null, hindsight = [], excursions = [], counterfactuals = [], label }: {
  candles: Candle[]; interval: CandleInterval; levels: ChartLevel[]; markers: ChartMarker[];
  currentPrice?: number | null; hindsight?: HindsightLine[]; excursions?: ExcursionPoint[]; counterfactuals?: CounterfactualPoint[]; label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const step = STEP[interval];
  const geo = useMemo(() => {
    if (!candles.length) return null;
    const times = [candles[0].time, candles[candles.length - 1].time + step, ...markers.map((m) => m.at_ms)];
    const x0 = Math.min(...times);
    const x1 = Math.max(...times);
    const prices = [
      ...candles.flatMap((c) => [c.high, c.low]), ...levels.map((l) => l.price), ...markers.map((m) => m.price),
      ...(currentPrice ? [currentPrice] : []), ...hindsight.map((h) => h.price), ...excursions.map((e) => e.price), ...counterfactuals.map((c) => c.price),
    ].filter((v) => Number.isFinite(v));
    let y0 = Math.min(...prices);
    let y1 = Math.max(...prices);
    const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.01 || 1;
    y0 -= pad; y1 += pad;
    const plotW = W - PAD.l - PAD.r;
    const sx = (t: number) => PAD.l + ((t - x0) / (x1 - x0 || 1)) * plotW;
    const sy = (p: number) => PAD.t + (1 - (p - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const bodyW = Math.max(1, (step / (x1 - x0 || 1)) * plotW * 0.7);
    return { x0, x1, y0, y1, sx, sy, bodyW };
  }, [candles, levels, markers, currentPrice, hindsight, excursions, counterfactuals, step]);

  if (!geo) return <Empty text="No candles for this window" />;
  const { sx, sy, bodyW } = geo;

  const right = [
    ...levels.map((l) => ({ key: `lvl-${l.kind}`, y: sy(l.price), text: `${l.label} ${fmtPrice(l.price)}`, cls: LEVEL_CLASS[l.kind] ?? 'lvl-entry' })),
    ...(currentPrice ? [{ key: 'current', y: sy(currentPrice), text: `CURRENT ${fmtPrice(currentPrice)}`, cls: 'lvl-current' }] : []),
    ...excursions.map((e) => ({ key: `exc-${e.kind}`, y: sy(e.price), text: `${e.kind === 'MFE' ? 'MFE / PEAK' : 'MAE'} ${fmtPrice(e.price)}`, cls: e.kind === 'MFE' ? 'lvl-mfe' : 'lvl-mae' })),
    ...hindsight.map((h) => ({ key: `hs-${h.key}`, y: sy(h.price), text: `HINDSIGHT ${h.label} ${fmtPrice(h.price)}`, cls: 'lvl-hindsight' })),
  ];
  const labelYs = spread(right.map((r) => r.y + 4));

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < candles.length; i += 1) if (Math.abs(sx(candles[i].time + step / 2) - x) < Math.abs(sx(candles[best].time + step / 2) - x)) best = i;
    setHover(best);
  };
  const h = hover === null ? null : candles[hover];
  const clampX = (t: number) => Math.min(geo.x1, Math.max(geo.x0, t));
  // Marker labels that would overlap a neighbour on the same side are stacked.
  const stack = markers.map((m, i) => markers.slice(0, i).filter((o, j) => (o.side === 'BUY') === (m.side === 'BUY') && Math.abs(sx(o.at_ms) - sx(m.at_ms)) < 64 && j < i).length);
  const ticks = [1, 2, 3].map((i) => geo.x0 + ((geo.x1 - geo.x0) * i) / 4);

  return (
    <div className="chart candle-chart">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 1, 2, 3, 4].map((i) => {
          const p = geo.y0 + ((geo.y1 - geo.y0) * i) / 4;
          return <line key={i} x1={PAD.l} x2={W - PAD.r} y1={sy(p)} y2={sy(p)} className="grid" />;
        })}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 4} className="tick" />
            <text x={sx(t)} y={H - 8} className="axis" textAnchor="middle" data-tick={t}>{ts(t).slice(5, 16)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 8} className="axis">{ts(geo.x0).slice(5, 16)}</text>
        <text x={W - PAD.r} y={H - 8} className="axis" textAnchor="end">{ts(geo.x1).slice(5, 16)}</text>
        <g className="candles">
          {candles.map((c) => {
            const up = c.close >= c.open;
            const cx = sx(c.time + step / 2);
            const top = sy(Math.max(c.open, c.close));
            const bottom = sy(Math.min(c.open, c.close));
            return (
              <g key={c.time} className={`candle ${up ? 'up' : 'down'} ${c.complete ? '' : 'forming'}`} data-candle={c.time}>
                <line x1={cx} x2={cx} y1={sy(c.high)} y2={sy(c.low)} />
                <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bottom - top)} />
              </g>
            );
          })}
        </g>
        {levels.map((l) => (
          <line key={l.kind} data-level={l.kind} x1={PAD.l} x2={W - PAD.r} y1={sy(l.price)} y2={sy(l.price)} className={`level ${LEVEL_CLASS[l.kind] ?? ''}`} />
        ))}
        {currentPrice ? <line data-level="CURRENT" x1={PAD.l} x2={W - PAD.r} y1={sy(currentPrice)} y2={sy(currentPrice)} className="level lvl-current" /> : null}
        {hindsight.map((hl) => (
          <line key={hl.key} data-hindsight={hl.key} x1={PAD.l} x2={W - PAD.r} y1={sy(hl.price)} y2={sy(hl.price)} className="level lvl-hindsight" />
        ))}
        {currentPrice ? (
          <g className="current-tag" data-current-tag>
            <path d={`M${W - PAD.r},${sy(currentPrice)} l7,-8 h0 v16 z`} className="current-pointer" />
          </g>
        ) : null}
        {right.map((r, i) => (
          <text key={r.key} x={W - PAD.r + 6} y={labelYs[i]} className={`level-label ${r.cls}${r.key === 'current' ? ' current-label' : ''}`}>{r.text}</text>
        ))}
        {markers.map((m, i) => {
          const x = sx(m.at_ms);
          const y = sy(m.price);
          const up = m.side === 'BUY';
          const d = up ? `M${x},${y + 3} l-6,11 h12 z` : `M${x},${y - 3} l-6,-11 h12 z`;
          return (
            <g key={`${m.kind}-${i}`} className={`marker ${MARKER_CLASS(m.kind)}`} data-marker={m.kind}>
              <title>{`${m.label} @ ${fmtPrice(m.price)} · ${ts(m.at_ms)}${m.trigger ? ` · ${m.trigger}` : ''}`}</title>
              <path d={d} />
              <text x={x} y={(up ? y + 26 : y - 18) + (up ? 12 : -12) * stack[i]} textAnchor="middle" className="marker-label">
                {m.kind === 'ENTRY' ? m.label : `${m.kind} ${fmtPrice(m.price)}`}
              </text>
            </g>
          );
        })}
        {excursions.map((e) => {
          const x = e.at_ms === null ? W - PAD.r : sx(clampX(e.at_ms));
          const y = sy(e.price);
          const cls = e.kind === 'MFE' ? 'mk-mfe' : 'mk-mae';
          return (
            <g key={e.kind} className={`marker excursion ${cls}`} data-excursion={e.kind}>
              <title>{`${e.kind === 'MFE' ? 'MFE / peak (highest favourable price)' : 'MAE (worst adverse price)'} ${fmtPrice(e.price)}${e.at_ms === null ? ' · time reached not recorded' : ` · reached by ${ts(e.at_ms)}${e.precision ? ` (${e.precision})` : ''}`}`}</title>
              <circle cx={x} cy={y} r={5} />
              <text x={x} y={e.kind === 'MFE' ? y - 9 : y + 17} textAnchor={e.at_ms === null ? 'end' : 'middle'} className="marker-label">{e.kind === 'MFE' ? 'MFE/PEAK' : 'MAE'}</text>
            </g>
          );
        })}
        {counterfactuals.map((c) => (
          <g key={c.key} className="marker counterfactual" data-counterfactual={c.key}>
            <title>{`RESEARCH ONLY · COUNTERFACTUAL · NOT A FILL: ${c.label} would have exited at ${fmtPrice(c.price)} · ${ts(c.at_ms)}${c.r === null ? '' : ` · ${c.r.toFixed(2)}R`}`}</title>
            <path d={`M${sx(clampX(c.at_ms))},${sy(c.price) - 6} l6,6 l-6,6 l-6,-6 z`} />
          </g>
        ))}
        {h && <line x1={sx(h.time + step / 2)} x2={sx(h.time + step / 2)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />}
        {h && <line x1={PAD.l} x2={W - PAD.r} y1={sy(h.close)} y2={sy(h.close)} className="crosshair crosshair-h" />}
      </svg>
      <div className="chart-readout">
        {h ? `${ts(h.time)} · O ${fmtPrice(h.open)} H ${fmtPrice(h.high)} L ${fmtPrice(h.low)} C ${fmtPrice(h.close)}${h.complete ? '' : ' · forming'}`
          : `${candles.length} ${interval} candles · hover for OHLC`}
      </div>
    </div>
  );
}
