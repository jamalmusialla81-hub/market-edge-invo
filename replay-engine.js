(function(root,factory){const Research=typeof module==='object'&&module.exports?require('./research-engine.js'):root.MarketEdgeResearch,api=factory(Research);if(typeof module==='object'&&module.exports)module.exports=api;root.MarketEdgeReplay=api;})(typeof globalThis!=='undefined'?globalThis:this,function(Research){
  'use strict';
  const VERSION='1.0.0',TIMEFRAMES=['5m','15m','1h','4h','1d'];
  if(!Research)throw new Error('MarketEdgeResearch is required before MarketEdgeReplay');
  function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
  function completed(base,asOf){const duration=Research.INTERVAL_MS['5m'];return (Array.isArray(base)?base:[]).filter(candle=>Number.isFinite(finite(candle.time))&&finite(candle.time)+duration<=asOf).map(candle=>({...candle,time:finite(candle.time),open:finite(candle.open),high:finite(candle.high),low:finite(candle.low),close:finite(candle.close),volume:finite(candle.volume)}));}
  function snapshot(base,asOf){
    if(!Number.isFinite(finite(asOf)))throw new Error('Historical snapshot timestamp is required');
    const m5=completed(base,asOf),timeframes={m5};
    timeframes.m15=Research.aggregateCandles(m5,'5m','15m',{asOf}).candles;
    timeframes.h1=Research.aggregateCandles(m5,'5m','1h',{asOf}).candles;
    timeframes.h4=Research.aggregateCandles(m5,'5m','4h',{asOf}).candles;
    timeframes.d1=Research.aggregateCandles(m5,'5m','1d',{asOf}).candles;
    assertNoLookahead(timeframes,asOf);
    return {asOf,timeframes,counts:Object.fromEntries(Object.entries(timeframes).map(([name,rows])=>[name,rows.length]))};
  }
  function assertNoLookahead(timeframes,asOf){
    const aliases={m5:'5m',m15:'15m',h1:'1h',h4:'4h',d1:'1d'};
    for(const [name,rows] of Object.entries(timeframes||{})){const interval=Research.INTERVAL_MS[aliases[name]||name];for(const candle of rows||[]){if(!Number.isFinite(finite(candle.time))||finite(candle.time)+interval>asOf)throw new Error(`LOOKAHEAD_REJECTED: ${name} contains an incomplete or future candle`);}}
    return true;
  }
  function readiness(snapshotResult){const needed={m5:60,m15:60,h1:60,h4:60,d1:60},missing=Object.entries(needed).filter(([key,count])=>(snapshotResult?.counts?.[key]||0)<count).map(([key,count])=>`${key} ${snapshotResult?.counts?.[key]||0}/${count}`);return{ready:!missing.length,missing};}
  return {VERSION,TIMEFRAMES,snapshot,assertNoLookahead,readiness};
});
