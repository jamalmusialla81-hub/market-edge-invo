'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Recovery=require('./outcome-recovery.js'),Rank=require('./historical-rank.js');
const start=1_700_000_000_000,candidate={asset:'BTC',timestamp:start,direction:'long',stop:95,rr:1.8,strategy:'TREND CONTINUATION',valid_current_geometry:true};
const rows=Array.from({length:Rank.OUTCOME_BARS},(_,index)=>({time:start+index*Rank.BASE_MS,open:100,high:110,low:94,close:100,volume:1,close_time:start+(index+1)*Rank.BASE_MS-1}));
test('Binance proxy resolver requires a contiguous complete outcome window',()=>{assert.equal(Recovery.symbolFor('BTC'),'BTCUSDT');assert.equal(Recovery.symbolFor('LTC'),null);assert.equal(Recovery.completeWindow(rows,start).ok,true);assert.equal(Recovery.completeWindow(rows.filter((_,index)=>index!==4),start).ok,false);});
test('Binance proxy outcome retains conservative stop-first outcome semantics',()=>{const result=Recovery.resolveProxy(candidate,rows);assert.equal(result.status,'RESOLVED');assert.equal(result.STOP_HIT,true);assert.equal(result.TP1_BEFORE_SL,false);assert.equal(result.outcome_source,'BINANCE_PROXY');assert.equal(result.outcome_candle_start,start);});
