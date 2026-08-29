(function (root, factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.MarketEdgeResearch=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const VERSION='1.0.0';
  const INTERVAL_MS=Object.freeze({'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000});
  const SAMPLE_TIERS=Object.freeze([
    {min:200,label:'LARGE SAMPLE'},
    {min:100,label:'MODERATE SAMPLE'},
    {min:50,label:'EARLY EVIDENCE'},
    {min:20,label:'VERY LOW CONFIDENCE'},
    {min:0,label:'INSUFFICIENT'}
  ]);

  function finite(value){return Number.isFinite(Number(value))?Number(value):null;}
  function median(values){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;}
  function stable(value){
    if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
    if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function hashValue(value){
    const text=stable(value);let hash=0x811c9dc5;
    for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,0x01000193);}
    return (hash>>>0).toString(16).padStart(8,'0');
  }
  function sampleTier(count){return SAMPLE_TIERS.find(tier=>count>=tier.min).label;}
  function intervalValue(interval){const value=typeof interval==='string'?INTERVAL_MS[interval]:Number(interval);if(!Number.isFinite(value)||value<=0)throw new Error(`Unsupported interval: ${interval}`);return value;}
  function candleValue(input){return {time:finite(input?.time),open:finite(input?.open),high:finite(input?.high),low:finite(input?.low),close:finite(input?.close),volume:finite(input?.volume)};}

  function inspectDataset(input,options={}){
    const interval=intervalValue(options.interval||'5m'),asOf=Number.isFinite(options.asOf)?options.asOf:Date.now(),source=String(options.source||'UNKNOWN'),exchange=String(options.exchange||source),symbol=String(options.symbol||'UNKNOWN');
    const rows=Array.isArray(input)?input:[],errors=[],warnings=[],candles=[],seen=new Set();let duplicates=0,partial=0,future=0,nonMonotonic=0,invalidOhlc=0,brokenVolume=0;
    rows.forEach((row,index)=>{
      const candle=candleValue(row),previous=candles.at(-1);
      if(![candle.time,candle.open,candle.high,candle.low,candle.close,candle.volume].every(Number.isFinite)){errors.push(`Row ${index+1} contains NaN, infinity or a missing field`);return;}
      if(candle.time>asOf+120000){future+=1;errors.push(`Row ${index+1} has a future timestamp`);return;}
      if(seen.has(candle.time)){duplicates+=1;errors.push(`Duplicate timestamp ${candle.time}`);return;}
      if(previous&&candle.time<=previous.time){nonMonotonic+=1;errors.push(`Non-monotonic timestamp at row ${index+1}`);return;}
      if([candle.open,candle.high,candle.low,candle.close].some(value=>value<=0)||candle.high<candle.low||candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)){
        invalidOhlc+=1;errors.push(`Invalid OHLC relationship at row ${index+1}`);return;
      }
      if(candle.volume<0){brokenVolume+=1;errors.push(`Negative volume at row ${index+1}`);return;}
      seen.add(candle.time);
      if(candle.time+interval>asOf){partial+=1;warnings.push(`Excluded incomplete candle at ${candle.time}`);return;}
      candles.push(candle);
    });
    let missing=0,gaps=0;
    for(let index=1;index<candles.length;index++){
      const distance=candles[index].time-candles[index-1].time;
      if(distance!==interval){gaps+=1;if(distance>interval)missing+=Math.max(0,Math.round(distance/interval)-1);else errors.push(`Unexpected interval at ${candles[index].time}`);}
    }
    const returns=candles.slice(1).map((candle,index)=>Math.abs(Math.log(candle.close/candles[index].close))),baseline=median(returns.filter(Number.isFinite)),spikeThreshold=Math.max(.35,baseline*25),spikes=returns.filter(value=>value>spikeThreshold).length;
    if(spikes)warnings.push(`${spikes} extreme one-candle spike${spikes===1?'':'s'} require review`);
    if(candles.length&&candles.every(candle=>candle.volume===0)){brokenVolume+=candles.length;warnings.push('All candle volumes are zero');}
    const expected=candles.length?Math.round((candles.at(-1).time-candles[0].time)/interval)+1:0,coverage=expected?candles.length/expected:0;
    let score=100;
    score-=Math.min(60,(1-coverage)*100);score-=Math.min(20,spikes*2);score-=Math.min(20,partial*.25);if(brokenVolume)score-=10;if(errors.length)score=0;
    score=Math.max(0,Math.min(100,score));
    const status=errors.length?'REJECTED':coverage>=.995&&!spikes&&!brokenVolume?'HIGH':coverage>=.98?'MEDIUM':'LOW';
    const hash=hashValue(candles.map(candle=>[candle.time,candle.open,candle.high,candle.low,candle.close,candle.volume]));
    return {candles,meta:{asset:String(options.asset||symbol.replace(/(?:USDT|USD|PERP)$/i,'')),exchange,symbol,interval:options.interval||interval,source,firstTimestamp:candles[0]?.time||null,lastTimestamp:candles.at(-1)?.time||null,downloadTime:options.downloadTime||null,candleCount:candles.length,expectedCandleCount:expected,missingCandleCount:missing,duplicateCount:duplicates,gapCount:gaps,partialCandleCount:partial,futureTimestampCount:future,nonMonotonicCount:nonMonotonic,invalidOhlcCount:invalidOhlc,brokenVolumeCount:brokenVolume,extremeSpikeCount:spikes,coverage,dataHealthScore:+score.toFixed(2),dataQualityStatus:status,datasetHash:hash,datasetVersion:`${exchange}:${symbol}:${options.interval||interval}:${hash}`},errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
  }

  function aggregateCandles(baseInput,baseIntervalInput,targetIntervalInput,options={}){
    const baseInterval=intervalValue(baseIntervalInput),targetInterval=intervalValue(targetIntervalInput),asOf=Number.isFinite(options.asOf)?options.asOf:Infinity;
    if(targetInterval<baseInterval||targetInterval%baseInterval)throw new Error('Target interval must be an exact multiple of the base interval');
    const base=(Array.isArray(baseInput)?baseInput:[]).map(candleValue),expectedPerBucket=targetInterval/baseInterval,buckets=new Map();
    base.forEach(candle=>{
      if(!Number.isFinite(candle.time)||candle.time+baseInterval>asOf)return;
      const start=Math.floor(candle.time/targetInterval)*targetInterval;
      if(start+targetInterval>asOf)return;
      if(!buckets.has(start))buckets.set(start,[]);buckets.get(start).push(candle);
    });
    const candles=[],skippedBuckets=[];
    [...buckets.entries()].sort((a,b)=>a[0]-b[0]).forEach(([start,rows])=>{
      rows.sort((a,b)=>a.time-b.time);
      const exact=rows.length===expectedPerBucket&&rows.every((row,index)=>row.time===start+index*baseInterval);
      if(!exact){skippedBuckets.push(start);return;}
      candles.push({time:start,open:rows[0].open,high:Math.max(...rows.map(row=>row.high)),low:Math.min(...rows.map(row=>row.low)),close:rows.at(-1).close,volume:rows.reduce((sum,row)=>sum+row.volume,0)});
    });
    return {candles,skippedBuckets,baseInterval,targetInterval,asOf};
  }

  function assertNoLookahead(timeframes,signalTime){
    Object.entries(timeframes||{}).forEach(([timeframe,candles])=>{
      const interval=intervalValue(timeframe);
      (candles||[]).forEach(candle=>{if(candle.time+interval>signalTime)throw new Error(`LOOKAHEAD_REJECTED: ${timeframe} candle closes after signal time`);});
    });
    return true;
  }
  function alignTimeframes(baseInput,baseIntervalInput,signalTime,timeframes=['5m','15m','1h','4h','1d']){
    const baseInterval=intervalValue(baseIntervalInput),state={};
    timeframes.forEach(timeframe=>{state[timeframe]=aggregateCandles(baseInput,baseInterval,timeframe,{asOf:signalTime}).candles;});
    assertNoLookahead(state,signalTime);
    return {signalTime,baseInterval,timeframes:state,lastCompleted:Object.fromEntries(Object.entries(state).map(([key,candles])=>[key,candles.at(-1)||null]))};
  }

  function chronologicalPartition(candles,options={}){
    const rows=Array.isArray(candles)?candles:[],trainRatio=Number(options.trainRatio??.6),validationRatio=Number(options.validationRatio??.2);
    if(trainRatio<=0||validationRatio<=0||trainRatio+validationRatio>=1)throw new Error('Chronological split ratios are invalid');
    const trainEnd=Math.floor(rows.length*trainRatio),validationEnd=Math.floor(rows.length*(trainRatio+validationRatio)),datasetHash=options.datasetHash||hashValue(rows),generationId=hashValue({datasetHash,trainEnd,validationEnd,engineVersion:options.engineVersion||VERSION,createdAt:options.createdAt||'deterministic'});
    return {generationId,datasetHash,boundaries:{trainEnd,validationEnd,total:rows.length},train:rows.slice(0,trainEnd),validation:rows.slice(trainEnd,validationEnd),untouched:{id:`test-${generationId}`,consumed:false,consumedAt:null,rows:rows.slice(validationEnd)}};
  }
  function consumeUntouched(partition,consumedAt=new Date().toISOString()){
    if(!partition?.untouched)throw new Error('Untouched test partition is missing');
    if(partition.untouched.consumed)throw new Error('Untouched test has already been consumed');
    return {...partition,untouched:{...partition.untouched,consumed:true,consumedAt}};
  }

  async function paginateHistorical(fetchPage,options={}){
    if(typeof fetchPage!=='function')throw new Error('A page loader is required');
    const interval=intervalValue(options.interval||'5m'),end=Number(options.end),limit=Math.max(1,Math.min(5000,Number(options.limit)||1000)),maxPages=Math.max(1,Number(options.maxPages)||10000);let cursor=Number(options.start),pages=0;const byTime=new Map();
    if(!Number.isFinite(cursor)||!Number.isFinite(end)||cursor>=end)throw new Error('Pagination range is invalid');
    while(cursor<end&&pages<maxPages){
      const rows=await fetchPage({start:cursor,end,limit,page:pages});pages+=1;
      if(!Array.isArray(rows)||!rows.length)break;
      let maxTime=-Infinity;
      rows.forEach(row=>{
        const candle=candleValue(row);if(!Number.isFinite(candle.time))throw new Error('Page contained an invalid timestamp');
        const existing=byTime.get(candle.time);if(existing&&stable(existing)!==stable(candle))throw new Error(`Conflicting duplicate candle at ${candle.time}`);
        byTime.set(candle.time,candle);maxTime=Math.max(maxTime,candle.time);
      });
      const next=maxTime+interval;if(!Number.isFinite(next)||next<=cursor)throw new Error('Historical pagination did not advance');cursor=next;
      if(rows.length<limit)break;
    }
    if(pages>=maxPages&&cursor<end)throw new Error('Historical pagination reached its safety limit');
    return {candles:[...byTime.values()].sort((a,b)=>a.time-b.time).filter(candle=>candle.time<end),pages,nextCursor:cursor};
  }

  return {VERSION,INTERVAL_MS,SAMPLE_TIERS,finite,median,stable,hashValue,sampleTier,intervalValue,inspectDataset,aggregateCandles,assertNoLookahead,alignTimeframes,chronologicalPartition,consumeUntouched,paginateHistorical};
});
