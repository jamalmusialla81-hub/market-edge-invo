'use strict';

// Pure research adapter.  Candidate construction is delegated to the shared
// Market Edge quant engine; this file never calls a feed, database, model, or
// customer-facing scanner.
const Quant = require('../quant-engine.js');
const Replay = require('../replay-engine.js');
const Features = require('./feature-engine.js');

const VERSION = 'HISTORICAL-RANK-PILOT-V1';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC'];
const BASE_MS = 300000;
const OUTCOME_BARS = 288;
const SETTINGS = Object.freeze({balance:7,riskPct:.01,maxLeverage:10,minQuality:72,minRR:1.8,maxExposurePct:1,minNotional:10,requireMTF:true,rankingMode:true});
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function hash(value) { let h=0x811c9dc5, text=stable(value); for (let i=0;i<text.length;i++) { h^=text.charCodeAt(i); h=Math.imul(h,0x01000193); } return (h>>>0).toString(16).padStart(8,'0'); }
function geometry(candidate) {
  const entry=finite(candidate.entry), stop=finite(candidate.stop), tp1=finite(candidate.target1), tp2=finite(candidate.target2), rr=finite(candidate.rr1 ?? candidate.rr), direction=candidate.direction;
  const valid=direction==='long' ? stop<entry && tp1>entry && tp2>=tp1 : direction==='short' ? stop>entry && tp1<entry && tp2<=tp1 : false;
  return {entry,stop,tp1,tp2,rr,valid:Boolean(valid && rr>0)};
}
function preEntryFeatures(timeframes,timestamp,candidate) {
  const result={};
  for (const name of ['m5','m15','h1','h4','d1']) { const frame=timeframes?.[name]||{}; result[name]={price:finite(frame.price),rsi:finite(frame.rsi),atr:finite(frame.atr),roc5:finite(frame.roc5),relativeVolume:finite(frame.relativeVolume),ema20:finite(frame.ema20),ema50:finite(frame.ema50),trend:frame.structure?.trend||null,support:finite(frame.structure?.support),resistance:finite(frame.structure?.resistance)}; }
  result.objective=Features.snapshot({timeframes,signalTime:timestamp,trade:{direction:candidate.direction,entry:finite(candidate.idealEntry ?? candidate.entry),tp1:finite(candidate.target1)}});
  result.feature_definition_version=Features.VERSION;
  return result;
}
function candidateRows({scanId,timestamp,asset,timeframes,sourceHash,instrument=null}) {
  if (!ASSETS.includes(asset)) throw new Error('Unsupported historical rank asset');
  Replay.assertNoLookahead(timeframes,timestamp);
  const candidates=Quant.evaluateSetupCandidates({timeframes,settings:SETTINGS});
  const evaluated=candidates.map((candidate,index) => {
    const plan=geometry(candidate), features=preEntryFeatures(timeframes,timestamp,candidate), quant=finite(candidate.setupQuality ?? candidate.quality), valid=plan.valid;
    return {candidate_id:`hrp1-${hash([scanId,asset,index,candidate.strategy,candidate.direction,plan.entry,plan.stop])}`,asset,invo_instrument:instrument,direction:candidate.direction||null,strategy:candidate.strategy||null,reference_price:finite(candidate.entry),entry:plan.entry,stop:plan.stop,tp1:plan.tp1,tp2:plan.tp2,rr:plan.rr,setup_quality:quant,entry_quality:candidate.entryQuality||null,quant_score:quant,ml_applicability:'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP',ml_raw_score:null,combined_score:quant,regime:candidate.regime||'UNCLASSIFIED',feature_json:features,feature_hash:hash(features),valid_current_geometry:valid,invalidation_reason:valid?null:(candidate.reason||'Candidate did not supply valid current geometry'),candidate_rank:null,candidate_count:0,targets:{status:'PENDING_OUTCOME'},candidate_hash:null};
  });
  const ranked=evaluated.filter(row=>row.valid_current_geometry).sort((a,b)=>(b.quant_score??-Infinity)-(a.quant_score??-Infinity)||a.strategy.localeCompare(b.strategy)||a.direction.localeCompare(b.direction));
  ranked.forEach((row,index)=>{row.candidate_rank=index+1;});
  evaluated.forEach(row=>{row.candidate_count=evaluated.length; row.candidate_hash=hash({...row,targets:undefined,candidate_hash:undefined});});
  return evaluated;
}
function snapshot({scanId,timestamp,universe,sourceHash,cadenceMs,candidates}) {
  const value={scan_id:scanId,scan_timestamp:timestamp,data_timestamp:timestamp,universe_mode:'HISTORICAL_DATA_UNIVERSE_PROXY',eligible_universe:universe,engine_version:VERSION,strategy_version:'quant-engine-shared',quant_version:'quant-engine-shared',ml_version:'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP',feature_version:Features.VERSION,source_dataset_hash:sourceHash,scan_cadence_ms:cadenceMs,candidate_count:candidates.length};
  return {...value,snapshot_hash:hash(value)};
}
function resolveCandidate(candidate,future) {
  if (!candidate?.valid_current_geometry || !Array.isArray(future) || future.length < OUTCOME_BARS) return null;
  const first=future[0], rawEntry=finite(first.open), plannedStop=finite(candidate.stop); if (!rawEntry || !plannedStop) return null;
  const direction=candidate.direction, distance=Math.abs(rawEntry-plannedStop); if (!distance) return null;
  const entry=rawEntry*(direction==='long'?1.0003:.9997), stop=direction==='long'?entry-distance:entry+distance, tp1=direction==='long'?entry+distance*candidate.rr:entry-distance*candidate.rr, tp2=direction==='long'?entry+distance*Math.max(candidate.rr+1,3):entry-distance*Math.max(candidate.rr+1,3);
  let tp1Hit=false,tp2Hit=false,stopHit=false,mfe=0,mae=0,finalR=0,bars=0;
  for (const candle of future.slice(0,OUTCOME_BARS)) { bars++; const high=finite(candle.high),low=finite(candle.low),close=finite(candle.close); if (![high,low,close].every(Number.isFinite)) return null; const favourable=(direction==='long'?high-entry:entry-low)/distance, adverse=(direction==='long'?low-entry:entry-high)/distance; mfe=Math.max(mfe,favourable); mae=Math.min(mae,adverse); const activeStop=tp1Hit?entry:stop, hitStop=direction==='long'?low<=activeStop:high>=activeStop, hitOne=direction==='long'?high>=tp1:low<=tp1, hitTwo=direction==='long'?high>=tp2:low<=tp2;
    // Conservative ambiguity: stop is tested first on each completed candle.
    if (hitStop) { stopHit=true; finalR=tp1Hit?candidate.rr*.5:-1; break; }
    if (!tp1Hit && hitOne) tp1Hit=true;
    if (tp1Hit && hitTwo) { tp2Hit=true; finalR=candidate.rr*.5+Math.max(candidate.rr+1,3)*.5; break; }
    finalR=(direction==='long'?close-entry:entry-close)/distance;
  }
  const costR=.0016/(distance/entry);
  return {status:'RESOLVED',TP1_BEFORE_SL:tp1Hit,FINAL_R:finalR-costR,MFE:mfe,MAE:mae,STOP_HIT:stopHit,TP2_HIT:tp2Hit,duration_bars:bars,BREAKOUT_FAILURE:candidate.strategy==='BREAKOUT + RETEST'&&!tp1Hit,execution:'next-valid 5m open with directional slippage; conservative stop-first same-candle ordering; 0.16% round-trip cost'};
}
module.exports={VERSION,ASSETS,BASE_MS,OUTCOME_BARS,SETTINGS,hash,geometry,preEntryFeatures,candidateRows,snapshot,resolveCandidate};
