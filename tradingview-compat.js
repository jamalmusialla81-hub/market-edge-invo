(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeTradingView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION='1.0.0';
  const EXCHANGES={BINANCE:'BINANCE',COINBASE:'COINBASE',KRAKEN:'KRAKEN',BYBIT:'BYBIT'};
  function mean(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;}
  function ema(values,period){if(!values.length)return[];const k=2/(period+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(values[i]*k+out[i-1]*(1-k));return out;}
  function simpleRsi(values,period=14){if(values.length<=period)return null;const recent=values.slice(-period-1),changes=recent.slice(1).map((value,index)=>value-recent[index]),gain=mean(changes.map(value=>Math.max(0,value))),loss=mean(changes.map(value=>Math.max(0,-value)));if(!gain&&!loss)return 50;if(!loss)return 100;return 100-100/(1+gain/loss);}
  function trueRange(candle,previous){return previous?Math.max(candle.high-candle.low,Math.abs(candle.high-previous.close),Math.abs(candle.low-previous.close)):candle.high-candle.low;}
  function simpleAtr(candles,period=14){if(candles.length<period+1)return null;return mean(candles.map((candle,index)=>trueRange(candle,candles[index-1])).slice(-period));}
  function snapshot(candles){const closes=candles.map(c=>c.close),e9=ema(closes,9),e20=ema(closes,20),e50=ema(closes,50),e12=ema(closes,12),e26=ema(closes,26),macd=e12.map((v,i)=>v-e26[i]),signal=ema(macd,9);return{ema9:e9.at(-1),ema20:e20.at(-1),ema50:e50.at(-1),rsi:simpleRsi(closes),atr:simpleAtr(candles),macd:macd.at(-1),macdSignal:signal.at(-1)};}
  function symbol(exchange,asset,quote='USDT'){const venue=EXCHANGES[String(exchange||'').toUpperCase()]||'BINANCE',base=String(asset||'BTC').toUpperCase().replace(/[^A-Z0-9]/g,''),q=String(quote||'USDT').toUpperCase().replace(/[^A-Z0-9]/g,'');return `${venue}:${base}${q}`;}
  function chartUrl(exchange,asset,quote){return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol(exchange,asset,quote))}`;}
  function parseAlert(input,now=Date.now()){
    const value=typeof input==='string'?JSON.parse(input):input;if(!value||typeof value!=='object')throw new Error('Alert must be a JSON object');
    const alert={event_id:String(value.event_id||'').slice(0,120),symbol:String(value.symbol||'').toUpperCase(),exchange:String(value.exchange||'').toUpperCase(),timeframe:String(value.timeframe||''),timestamp:Number(value.timestamp),close:Number(value.close),volume:Number(value.volume),condition:String(value.condition||'').slice(0,120),state:String(value.state||'').toUpperCase()};
    if(!/^[A-Z0-9]{2,20}$/.test(alert.symbol))throw new Error('Invalid symbol');
    if(!Object.keys(EXCHANGES).includes(alert.exchange))throw new Error('Unsupported exchange');
    if(!['5m','15m','1h','4h','1d'].includes(alert.timeframe))throw new Error('Unsupported timeframe');
    if(!Number.isFinite(alert.timestamp)||!Number.isFinite(alert.close)||alert.close<=0||!Number.isFinite(alert.volume)||alert.volume<0)throw new Error('Invalid numeric evidence');
    if(!alert.event_id)throw new Error('event_id is required');
    if(!['CANDIDATE','WAIT','NO TRADE'].includes(alert.state))throw new Error('Invalid evidence state');
    if(alert.timestamp>now+60_000)throw new Error('Future alert timestamp');
    return alert;
  }
  return {VERSION,EXCHANGES,ema,simpleRsi,simpleAtr,snapshot,symbol,chartUrl,parseAlert};
});
