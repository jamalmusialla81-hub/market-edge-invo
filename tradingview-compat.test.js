const assert=require('node:assert/strict');
const Quant=require('./quant-engine.js'),TV=require('./tradingview-compat.js');
const candles=Array.from({length:240},(_,index)=>{const close=100+index*.15+Math.sin(index/7)*2;return{time:index*300000,open:close-.2,high:close+1,low:close-1,close,volume:1000+index};});
const actual=TV.snapshot(candles),frame=Quant.features(candles,288);
for(const key of ['ema9','ema20','ema50','rsi','atr','macd','macdSignal'])assert.ok(Math.abs(actual[key]-frame[key])<1e-10,`${key} differs`);
assert.equal(TV.symbol('binance','eth'),'BINANCE:ETHUSDT');assert.match(TV.chartUrl('coinbase','btc','USD'),/COINBASE%3ABTCUSD/);
const alert=TV.parseAlert({event_id:'x-1',symbol:'ETHUSDT',exchange:'BINANCE',timeframe:'15m',timestamp:1_000,close:100,volume:20,condition:'EMA confirmation',state:'candidate'},2_000);
assert.equal(alert.state,'CANDIDATE');assert.throws(()=>TV.parseAlert({...alert,timestamp:100_000},2_000),/Future/);assert.throws(()=>TV.parseAlert({...alert,state:'LONG'},2_000),/state/);
console.log('TradingView equivalence and alert tests passed');
