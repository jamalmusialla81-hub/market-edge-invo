export const MONITOR_VERSION='1.0.0';
export const INTERVAL_MS={'5m':300_000,'15m':900_000,'1h':3_600_000,'4h':14_400_000,'1d':86_400_000};
export const WATCHLIST=[
  ['BTC','BTCUSDT'],['ETH','ETHUSDT'],['SOL','SOLUSDT'],['XRP','XRPUSDT'],['DOGE','DOGEUSDT'],['LTC','LTCUSDT'],['BNB','BNBUSDT'],['ADA','ADAUSDT'],['AVAX','AVAXUSDT'],['LINK','LINKUSDT'],['SUI','SUIUSDT'],['HYPE','HYPEUSDT'],['BCH','BCHUSDT'],['AAVE','AAVEUSDT'],['ICP','ICPUSDT']
].map(([asset,symbol])=>({asset,symbol,exchange:'BINANCE',backupSources:['COINBASE','BYBIT']}));

function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function hash(value){const text=JSON.stringify(value);let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function mean(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;}
function ema(values,period){if(!values.length)return[];const alpha=2/(period+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(alpha*values[i]+(1-alpha)*out[i-1]);return out;}

export function normalizeBinanceKlines(rows,{asset='UNKNOWN',symbol='UNKNOWN',now=Date.now(),interval='5m'}={}){
  const errors=[],candles=[],seen=new Set(),duration=INTERVAL_MS[interval];
  if(!duration)throw new Error(`Unsupported interval ${interval}`);
  (Array.isArray(rows)?rows:[]).forEach((row,index)=>{
    const candle={time:finite(row?.[0]),open:finite(row?.[1]),high:finite(row?.[2]),low:finite(row?.[3]),close:finite(row?.[4]),volume:finite(row?.[5]),closeTime:finite(row?.[6])};
    if(!Object.values(candle).every(Number.isFinite)){errors.push(`row ${index+1}: missing numeric field`);return;}
    if(candle.time>now+60_000||candle.closeTime>now+60_000){errors.push(`row ${index+1}: future timestamp`);return;}
    if(seen.has(candle.time)){errors.push(`row ${index+1}: duplicate timestamp`);return;}
    if(candle.closeTime<candle.time+duration-1||candle.closeTime>candle.time+duration+60_000){errors.push(`row ${index+1}: invalid close time`);return;}
    if([candle.open,candle.high,candle.low,candle.close].some(value=>value<=0)||candle.volume<0||candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)||candle.low>candle.high){errors.push(`row ${index+1}: invalid OHLCV`);return;}
    seen.add(candle.time);if(candle.closeTime<=now)candles.push(candle);
  });
  candles.sort((a,b)=>a.time-b.time);let gaps=0,missing=0;
  for(let index=1;index<candles.length;index++){const delta=candles[index].time-candles[index-1].time;if(delta!==duration){gaps++;if(delta>duration)missing+=Math.round(delta/duration)-1;else errors.push(`non-monotonic interval at ${candles[index].time}`);}}
  const expected=candles.length?Math.round((candles.at(-1).time-candles[0].time)/duration)+1:0,coverage=expected?candles.length/expected:0;
  const status=errors.length?'INVALID':candles.length<60?'LOW':coverage>=.995?'HIGH':coverage>=.98?'MEDIUM':'LOW';
  const datasetHash=hash(candles.map(c=>[c.time,c.open,c.high,c.low,c.close,c.volume]));
  return {asset,symbol,interval,candles,errors,gaps,missing,coverage,status,datasetHash,firstTime:candles[0]?.time||null,lastTime:candles.at(-1)?.time||null};
}

export function normalizeHyperliquidCandles(rows,options={}){
  const duration=INTERVAL_MS[options.interval||'5m'];
  const adapted=(Array.isArray(rows)?rows:[]).map(row=>[row?.t,row?.o,row?.h,row?.l,row?.c,row?.v,row?.T??(Number(row?.t)+duration-1)]);
  return normalizeBinanceKlines(adapted,options);
}

export function aggregateCompleted(base,baseInterval,targetInterval,asOf=Date.now()){
  const sourceDuration=INTERVAL_MS[baseInterval],targetDuration=INTERVAL_MS[targetInterval];
  if(!sourceDuration||!targetDuration||targetDuration%sourceDuration)throw new Error('Invalid aggregation interval');
  const count=targetDuration/sourceDuration,buckets=new Map();
  for(const candle of base||[]){if(candle.time+sourceDuration>asOf)continue;const start=Math.floor(candle.time/targetDuration)*targetDuration;if(start+targetDuration>asOf)continue;(buckets.get(start)||buckets.set(start,[]).get(start)).push(candle);}
  const rows=[];for(const [time,bucket] of [...buckets].sort((a,b)=>a[0]-b[0])){bucket.sort((a,b)=>a.time-b.time);if(bucket.length!==count||!bucket.every((c,i)=>c.time===time+i*sourceDuration))continue;rows.push({time,open:bucket[0].open,high:Math.max(...bucket.map(c=>c.high)),low:Math.min(...bucket.map(c=>c.low)),close:bucket.at(-1).close,volume:bucket.reduce((sum,c)=>sum+c.volume,0),closeTime:time+targetDuration-1});}return rows;
}

export function canonicalState(report,now=Date.now()){
  const candles=report.candles||[],last=candles.at(-1),closes=candles.map(c=>c.close),ema20=ema(closes,20).at(-1),ema50=ema(closes,50).at(-1),price=last?.close??null;
  const stale=last?now-last.closeTime>INTERVAL_MS['5m']*3:true;
  const bias=price&&ema20&&ema50?(price>ema20&&ema20>ema50?'LONG SUPPORT':price<ema20&&ema20<ema50?'SHORT SUPPORT':'NEUTRAL'):'UNAVAILABLE';
  const status=report.status==='INVALID'?'BAD DATA':stale?'WAIT':candles.length<60?'INSUFFICIENT DATA':'ACTIVE';
  return {status,dataHealth:report.status,sourceStatus:stale?'STALE':report.providerStatus||'LIVE',referencePrice:price,referenceTime:last?.closeTime||null,staleAfter:last?.closeTime?last.closeTime+INTERVAL_MS['5m']*3:null,disagreementPct:null,bias,ema20:ema20||null,ema50:ema50||null,candleCount:candles.length,coverage:report.coverage,datasetHash:report.datasetHash,executionDisabled:true,reason:status==='ACTIVE'?'Monitor ingestion is healthy; server-side deterministic five-timeframe strategy evaluation is pending a deep canonical dataset.':'Data quality or depth prevents research qualification.'};
}

async function fetchHyperliquidCandles(asset,fetchImpl,now){
  const started=Date.now(),startTime=now-1_001*INTERVAL_MS['5m'];
  const response=await fetchImpl('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:asset.asset,interval:'5m',startTime,endTime:now}})});
  if(!response.ok)throw new Error(`${asset.asset} Hyperliquid HTTP ${response.status}`);
  const rows=await response.json(),report=normalizeHyperliquidCandles(rows,{asset:asset.asset,symbol:asset.symbol,now,interval:'5m'});
  return {...report,exchange:'HYPERLIQUID',sourceLatencyMs:Date.now()-started,providerStatus:'LIVE · HYPERLIQUID FALLBACK'};
}
export async function fetchAssetCandles(asset,fetchImpl,now=Date.now()){
  const started=Date.now(),url=`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(asset.symbol)}&interval=5m&limit=1000`;
  try {
    const response=await fetchImpl(url,{headers:{accept:'application/json'}});if(!response.ok)throw new Error(`${asset.asset} Binance HTTP ${response.status}`);
    const rows=await response.json(),report=normalizeBinanceKlines(rows,{asset:asset.asset,symbol:asset.symbol,now,interval:'5m'});return {...report,exchange:asset.exchange,sourceLatencyMs:Date.now()-started,providerStatus:'LIVE · BINANCE'};
  } catch(binanceError) {
    try { const fallback=await fetchHyperliquidCandles(asset,fetchImpl,now);return {...fallback,providerError:String(binanceError.message||binanceError).slice(0,180)}; }
    catch(hyperliquidError){throw new Error(`${String(binanceError.message||binanceError).slice(0,90)}; ${String(hyperliquidError.message||hyperliquidError).slice(0,90)}`);}
  }
}

function id(prefix,parts){return `${prefix}-${hash(parts)}`;}
async function writeStatements(db,statements){if(!statements.length)return;for(let index=0;index<statements.length;index+=100)await db.batch(statements.slice(index,index+100));}
export async function persistAsset(db,runId,asset,report,state,now=Date.now()){
  const exchange=report.exchange||asset.exchange,symbol=report.symbol||asset.symbol;
  const candles=report.candles.map(candle=>db.prepare(`INSERT OR REPLACE INTO canonical_candles (asset,exchange,symbol,interval,open_time,close_time,open,high,low,close,volume,source_latency_ms,received_at,dataset_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(asset.asset,exchange,symbol,'5m',candle.time,candle.closeTime,candle.open,candle.high,candle.low,candle.close,candle.volume,report.sourceLatencyMs,now,report.datasetHash));
  candles.push(db.prepare(`INSERT OR REPLACE INTO market_states (asset,exchange,symbol,status,data_health,source_status,reference_price,reference_time,stale_after,disagreement_pct,state_json,dataset_hash,engine_version,updated_at,execution_disabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(asset.asset,exchange,symbol,state.status,state.dataHealth,state.sourceStatus,state.referencePrice,state.referenceTime,state.staleAfter,state.disagreementPct,JSON.stringify(state),report.datasetHash,MONITOR_VERSION,now));
  candles.push(db.prepare(`INSERT OR IGNORE INTO monitor_events (id,run_id,asset,event_type,severity,payload_json,created_at,immutable) VALUES (?,?,?,?,?,?,?,1)`).bind(id('event',[runId,asset.asset,report.datasetHash]),runId,asset.asset,'CANONICAL_STATE_UPDATED',state.status==='BAD DATA'?'ERROR':'INFO',JSON.stringify({state,errors:report.errors.slice(0,5),gaps:report.gaps}),now));
  await writeStatements(db,candles);
  return report.candles.length;
}

export async function runMonitor({db,fetchImpl=fetch,now=Date.now(),watchlist=WATCHLIST,runId=id('run',[now,watchlist.map(item=>item.asset)])}={}){
  if(!db)return {runId,status:'STORAGE_UNAVAILABLE',assetsRequested:watchlist.length,assetsCompleted:0,candlesWritten:0,errors:['D1 binding is unavailable'],executionDisabled:true};
  await db.prepare(`INSERT INTO monitor_runs (id,started_at,status,assets_requested,engine_version,execution_disabled) VALUES (?,?,?,?,?,1)`).bind(runId,now,'RUNNING',watchlist.length,MONITOR_VERSION).run();
  const errors=[];let completed=0,written=0;
  for(const asset of watchlist){try{const report=await fetchAssetCandles(asset,fetchImpl,now),state=canonicalState(report,now);written+=await persistAsset(db,runId,asset,report,state,now);completed++;}catch(error){errors.push(`${asset.asset}: ${String(error.message||error).slice(0,180)}`);}}
  const status=completed?'COMPLETE':'FAILED';
  await db.prepare(`UPDATE monitor_runs SET completed_at=?,status=?,assets_completed=?,candles_written=?,errors_json=? WHERE id=?`).bind(now,status,completed,written,JSON.stringify(errors),runId).run();
  return {runId,status,assetsRequested:watchlist.length,assetsCompleted:completed,candlesWritten:written,errors,executionDisabled:true};
}

export async function latestMonitor(db){
  if(!db)return {storage:'unavailable',latestRun:null,states:[],events:[]};
  const [run,states,events]=await Promise.all([
    db.prepare(`SELECT id,started_at,completed_at,status,assets_requested,assets_completed,candles_written,errors_json,engine_version,execution_disabled FROM monitor_runs ORDER BY started_at DESC LIMIT 1`).first(),
    db.prepare(`SELECT asset,exchange,symbol,status,data_health,source_status,reference_price,reference_time,stale_after,disagreement_pct,state_json,dataset_hash,engine_version,updated_at,execution_disabled FROM market_states ORDER BY asset LIMIT 100`).all(),
    db.prepare(`SELECT id,asset,event_type,severity,payload_json,created_at FROM monitor_events ORDER BY created_at DESC LIMIT 50`).all()
  ]);
  return {storage:'connected',latestRun:run||null,states:states.results||[],events:events.results||[],executionDisabled:true};
}
