'use strict';
// Research-only outcome proxy. It never constructs inputs or alters frozen
// candidate fields; it only labels a later, complete 5m outcome window.
const Rank=require('./historical-rank.js');
const SYMBOLS=Object.freeze({BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT',DOGE:'DOGEUSDT',SUI:'SUIUSDT'});
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
function symbolFor(asset){return SYMBOLS[String(asset||'').toUpperCase()]||null;}
function candlesFromBinance(payload){
  if(!Array.isArray(payload))return[];
  return payload.map(row=>({time:finite(row?.[0]),open:finite(row?.[1]),high:finite(row?.[2]),low:finite(row?.[3]),close:finite(row?.[4]),volume:finite(row?.[5]),close_time:finite(row?.[6])}));
}
function completeWindow(rows,timestamp){
  const expected=Number(timestamp),need=Rank.OUTCOME_BARS,interval=Rank.BASE_MS,window=rows.filter(row=>Number.isFinite(row.time)&&row.time>=expected).slice(0,need);
  if(window.length!==need)return{ok:false,reason:'BINANCE_PROXY_INCOMPLETE_WINDOW',rows:window};
  for(let index=0;index<window.length;index++){
    const row=window[index],valid=[row.time,row.open,row.high,row.low,row.close,row.volume,row.close_time].every(Number.isFinite)&&row.open>0&&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close)&&row.close_time>=row.time;
    if(!valid)return{ok:false,reason:'BINANCE_PROXY_INVALID_OHLC',rows:window};
    if(row.time!==expected+index*interval)return{ok:false,reason:'BINANCE_PROXY_CANDLE_GAP',rows:window};
  }
  return{ok:true,rows:window};
}
function resolveProxy(candidate,rows){
  const window=completeWindow(rows,candidate.timestamp);
  if(!window.ok)return{status:'UNRESOLVED_DATA_GAP',reason:window.reason,next_valid_candle_gap_ms:null,available_bars:window.rows.length,execution:'No proxy outcome was inferred across an incomplete Binance USD-M 5m window',outcome_source:'BINANCE_PROXY'};
  const target=Rank.resolveCandidate(candidate,window.rows);
  if(!target||target.status!=='RESOLVED')return{...(target||{status:'UNRESOLVED_DATA_GAP',reason:'BINANCE_PROXY_UNRESOLVABLE'}),outcome_source:'BINANCE_PROXY'};
  return {...target,outcome_source:'BINANCE_PROXY',signal_venue:'COINBASE',proxy_basis:`Binance USD-M ${symbolFor(candidate.asset)} 5m historical proxy`,outcome_candle_start:window.rows[0].time,outcome_candle_end:window.rows.at(-1).close_time,timestamp_safety:'Outcome candles begin at the decision timestamp and are excluded from frozen pre-entry inputs'};
}
module.exports={SYMBOLS,symbolFor,candlesFromBinance,completeWindow,resolveProxy};
