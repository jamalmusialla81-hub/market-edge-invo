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
  function completedPrefix(rows,interval,asOf){let low=0,high=(rows||[]).length;while(low<high){const middle=(low+high)>>1;if(rows[middle].time+interval<=asOf)low=middle+1;else high=middle;}return rows.slice(0,low);}
  // The historical runner gives us ordered, completed 5m rows. Build every higher
  // timeframe in one pass so a cron chunk does not repeatedly clone and regroup the
  // same 60-day window. The emitted candles are deliberately identical to
  // Research.aggregateCandles(..., {asOf: Infinity}).
  function aggregateDerived(base,targetInterval){
    const baseInterval=Research.INTERVAL_MS['5m'],expected=targetInterval/baseInterval,out=[];
    let bucket=null;
    const flush=()=>{if(bucket&&bucket.valid&&bucket.count===expected)out.push({time:bucket.time,open:bucket.open,high:bucket.high,low:bucket.low,close:bucket.close,volume:bucket.volume});};
    for(const candle of base){
      const time=finite(candle?.time);if(!Number.isFinite(time))continue;
      const start=Math.floor(time/targetInterval)*targetInterval;
      if(!bucket||bucket.time!==start){flush();bucket={time:start,next:start,count:0,valid:true,open:finite(candle.open),high:finite(candle.high),low:finite(candle.low),close:finite(candle.close),volume:finite(candle.volume)||0};}
      else {bucket.high=Math.max(bucket.high,finite(candle.high));bucket.low=Math.min(bucket.low,finite(candle.low));bucket.close=finite(candle.close);bucket.volume+=finite(candle.volume)||0;}
      if(time!==bucket.next)bucket.valid=false;
      bucket.next+=baseInterval;bucket.count++;
    }
    flush();return out;
  }
  function derived(base){
    const input=Array.isArray(base)?base:[],ordered=input.every((row,index)=>!index||finite(input[index-1]?.time)<=finite(row?.time))?input:[...input].sort((a,b)=>a.time-b.time);
    return{m5:ordered,m15:aggregateDerived(ordered,Research.INTERVAL_MS['15m']),h1:aggregateDerived(ordered,Research.INTERVAL_MS['1h']),h4:aggregateDerived(ordered,Research.INTERVAL_MS['4h']),d1:aggregateDerived(ordered,Research.INTERVAL_MS['1d'])};
  }
  function cachedSnapshot(derivedFrames,asOf){if(!Number.isFinite(finite(asOf)))throw new Error('Historical snapshot timestamp is required');const timeframes={m5:completedPrefix(derivedFrames.m5,Research.INTERVAL_MS['5m'],asOf),m15:completedPrefix(derivedFrames.m15,Research.INTERVAL_MS['15m'],asOf),h1:completedPrefix(derivedFrames.h1,Research.INTERVAL_MS['1h'],asOf),h4:completedPrefix(derivedFrames.h4,Research.INTERVAL_MS['4h'],asOf),d1:completedPrefix(derivedFrames.d1,Research.INTERVAL_MS['1d'],asOf)};assertNoLookahead(timeframes,asOf);return{asOf,timeframes,counts:Object.fromEntries(Object.entries(timeframes).map(([name,rows])=>[name,rows.length]))};}
  function assertNoLookahead(timeframes,asOf){
    const aliases={m5:'5m',m15:'15m',h1:'1h',h4:'4h',d1:'1d'};
    for(const [name,rows] of Object.entries(timeframes||{})){const interval=Research.INTERVAL_MS[aliases[name]||name];for(const candle of rows||[]){if(!Number.isFinite(finite(candle.time))||finite(candle.time)+interval>asOf)throw new Error(`LOOKAHEAD_REJECTED: ${name} contains an incomplete or future candle`);}}
    return true;
  }
  function readiness(snapshotResult){const needed={m5:60,m15:60,h1:60,h4:60,d1:60},missing=Object.entries(needed).filter(([key,count])=>(snapshotResult?.counts?.[key]||0)<count).map(([key,count])=>`${key} ${snapshotResult?.counts?.[key]||0}/${count}`);return{ready:!missing.length,missing};}
  return {VERSION,TIMEFRAMES,snapshot,derived,cachedSnapshot,assertNoLookahead,readiness};
});
