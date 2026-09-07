'use strict';

// Research-only, asset-scale-invariant sequence construction.  The source
// candle must have fully closed at or before the signal decision timestamp.
const INTERVALS=Object.freeze({m5:300000,m15:900000,h1:3600000});
const WINDOWS=Object.freeze([32,64,128,256]);
const VERSION='candle-sequence-v1';
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const stdev=values=>{const centre=mean(values);return centre==null||values.length<2?null:Math.sqrt(mean(values.map(value=>(value-centre)**2)));};
function valid(row){return row&&[row.time,row.open,row.high,row.low,row.close,row.volume].every(value=>Number.isFinite(finite(value)))&&finite(row.open)>0&&finite(row.high)>=Math.max(finite(row.open),finite(row.close))&&finite(row.low)<=Math.min(finite(row.open),finite(row.close));}
function closed(rows,interval,signalTime){
  const out=(Array.isArray(rows)?rows:[]).filter(valid).map(row=>({time:finite(row.time),open:finite(row.open),high:finite(row.high),low:finite(row.low),close:finite(row.close),volume:finite(row.volume)})).sort((left,right)=>left.time-right.time);
  if(out.some(row=>row.time+interval>signalTime))throw new Error('LOOKAHEAD_REJECTED: candle sequence includes incomplete or future candle');
  return out;
}
function atr(rows,index,period=14){
  const start=Math.max(1,index-period+1),ranges=[];
  for(let cursor=start;cursor<=index;cursor++){const row=rows[cursor],previous=rows[cursor-1];ranges.push(Math.max(row.high-row.low,Math.abs(row.high-previous.close),Math.abs(row.low-previous.close)));}
  return mean(ranges);
}
function encode(rows,window){
  if(rows.length<window)return null;
  const slice=rows.slice(-window),high=Math.max(...slice.map(row=>row.high)),low=Math.min(...slice.map(row=>row.low));
  return slice.map((row,index)=>{
    const absolute=rows.length-window+index,previous=rows[absolute-1]||row,local=rows.slice(Math.max(0,absolute-20),absolute),volumeMean=mean(local.map(item=>item.volume).filter(value=>value>0)),currentAtr=atr(rows,absolute),base=Math.max(previous.close,Number.EPSILON),range=Math.max(row.high-row.low,Number.EPSILON);
    const recentReturns=rows.slice(Math.max(0,absolute-20),absolute+1).slice(1).map((item,offset)=>Math.log(item.close/rows[Math.max(0,absolute-20)+offset].close));
    return {time:row.time,close_to_close:row.close/base-1,open_close:(row.close-row.open)/base,high_low:(row.high-row.low)/base,upper_wick:(row.high-Math.max(row.open,row.close))/range,lower_wick:(Math.min(row.open,row.close)-row.low)/range,relative_volume:volumeMean?row.volume/volumeMean:null,atr_normalized_move:currentAtr?(row.close-previous.close)/currentAtr:null,rolling_volatility:stdev(recentReturns),distance_recent_high:high?row.close/high-1:null,distance_recent_low:low?row.close/low-1:null};
  });
}
function build(timeframes,signalTime){
  const result={version:VERSION,signal_timestamp:signalTime,windows:WINDOWS,timeframes:{}};
  for(const [name,interval] of Object.entries(INTERVALS)){
    const rows=closed(timeframes?.[name],interval,signalTime),encoded=encode(rows,Math.max(...WINDOWS));
    result.timeframes[name]={interval_ms:interval,window_end:rows.at(-1)?.time+interval||null,source_count:rows.length,available:Boolean(encoded),rows:encoded};
  }
  return result;
}
function assertNoFuture(sequence,signalTime){
  for(const frame of Object.values(sequence?.timeframes||{}))if((frame.window_end||0)>signalTime)throw new Error('LOOKAHEAD_REJECTED: sequence window exceeds signal timestamp');
  return true;
}
module.exports={VERSION,INTERVALS,WINDOWS,closed,encode,build,assertNoFuture};
