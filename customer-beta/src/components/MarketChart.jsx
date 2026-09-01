import { useEffect, useState } from 'react';
import { fetchMarketChart } from '../lib/marketEdgeApi.js';

const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: value >= 100 ? 2 : value >= 1 ? 4 : 6 }).format(value) : '—';

function priceScale(candles, levels) {
  const values = [...candles.flatMap(candle => [candle.high, candle.low]), ...levels.map(([, value]) => value).filter(Number.isFinite)];
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max((high - low) * .06, Math.abs(high) * .001);
  return { low: low - padding, high: high + padding };
}

export default function MarketChart({ trade }) {
  const [timeframe, setTimeframe] = useState('15m');
  const [chart, setChart] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!trade?.asset) { setChart(null); setError(null); return undefined; }
    const controller = new AbortController();
    setLoading(true); setError(null); setChart(null);
    fetchMarketChart({ asset: trade.asset, timeframe, signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setChart(next); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [trade?.asset, timeframe]);

  const candles = chart?.candles || [];
  // A new scan clears its selected setup before this effect clears the previous
  // chart. Keep that short transition deliberately blank: a cached chart must
  // never render against an absent or different trade snapshot.
  const hasRenderableChart = Boolean(trade?.asset && chart && candles.length);
  const levels = [['TP2', trade?.tp2, 'target'], ['TP1', trade?.tp1, 'target'], ['Entry', trade?.entry, 'entry'], ['Stop', trade?.stop, 'stop']];
  const bounds = candles.length ? priceScale(candles, levels) : null;
  const height = 250, width = 720, top = 18, bottom = 28, plotHeight = height - top - bottom;
  const y = value => top + (bounds.high - value) / (bounds.high - bounds.low) * plotHeight;
  const x = index => 24 + index / Math.max(candles.length - 1, 1) * (width - 48);
  const candleWidth = Math.max(1, Math.min(7, (width - 48) / Math.max(candles.length, 1) * .64));

  return <section className="market-chart" aria-label={trade?.asset ? `${trade.asset} live market chart` : 'Market chart'}>
    <div className="chart-heading"><div><span>Live market chart</span><small>{trade?.asset ? `${trade.asset} · frozen chart request` : 'Select a scanned market'}</small></div><div className="timeframes" aria-label="Chart timeframe">{TIMEFRAMES.map(item => <button type="button" key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div></div>
    {loading && <div className="chart-empty" role="status">Loading legitimate {timeframe} candles…</div>}
    {error && <div className="chart-empty chart-error">Chart unavailable. No price data is shown.</div>}
    {!loading && !error && !trade && <div className="chart-empty">Run a scan, then select a market to inspect its chart.</div>}
    {!loading && !error && hasRenderableChart && <><svg className="candles" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${trade.asset} ${timeframe} candlestick chart from ${chart.source}`}>
      {[.2, .4, .6, .8].map(line => <line key={line} x1="20" x2={width - 20} y1={top + plotHeight * line} y2={top + plotHeight * line} className="chart-grid" />)}
      {candles.map((candle, index) => { const rising = candle.close >= candle.open, cx = x(index), open = y(candle.open), close = y(candle.close); return <g key={candle.time} className={rising ? 'up' : 'down'}><line x1={cx} x2={cx} y1={y(candle.high)} y2={y(candle.low)} /><rect x={cx - candleWidth / 2} y={Math.min(open, close)} width={candleWidth} height={Math.max(1, Math.abs(close - open))} /></g>; })}
      {levels.filter(([, value]) => Number.isFinite(value)).map(([label, value, tone]) => <g key={label} className={`chart-level ${tone}`}><line x1="20" x2={width - 20} y1={y(value)} y2={y(value)} /><text x={28} y={y(value) - 4}>{label} {money(value)}</text></g>)}
      <text x="22" y={height - 9} className="axis-label">{new Date(candles[0].time).toLocaleDateString()}</text><text x={width - 110} y={height - 9} className="axis-label">{new Date(candles.at(-1).time).toLocaleDateString()}</text>
    </svg><div className="chart-footnote"><span>{chart.source} live candles</span><span>Captured {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(chart.capturedAt))}</span><span>Levels shown only when supplied by the scan</span></div></>}
  </section>;
}
