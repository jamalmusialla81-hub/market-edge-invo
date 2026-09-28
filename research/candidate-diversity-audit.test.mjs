import test from 'node:test';
import assert from 'node:assert/strict';
import {closestMissGate} from './candidate-diversity-audit.mjs';

function frame(overrides={}){
  return {available:true,price:100,ema20:100,ema50:100,ema20Slope:0,rsi:50,atr:1,volumeAvailable:true,relativeVolume:1,
    structure:{trend:'neutral',retest:null,liquiditySweep:null,rejection:null,exhaustion:null},...overrides};
}

test('closestMissGate reports FRAME_UNAVAILABLE when the frame itself is unavailable',()=>{
  assert.equal(closestMissGate({available:false}),'FRAME_UNAVAILABLE');
});

test('closestMissGate reports NO_TREND_STRUCTURE when neither uptrend nor downtrend structure exists',()=>{
  assert.equal(closestMissGate(frame()),'NO_TREND_STRUCTURE');
});

test('closestMissGate reports EXTENDED_FROM_EMA20 when price has run too far from EMA20 in a trend',()=>{
  const f=frame({price:110,ema20:100,ema50:90,ema20Slope:1,atr:2,structure:{trend:'long'}});
  assert.equal(closestMissGate(f),'EXTENDED_FROM_EMA20');
});

test('closestMissGate reports RSI_OUTSIDE_CONTINUATION_BAND for an uptrend with RSI outside 48-68',()=>{
  const f=frame({price:105,ema20:100,ema50:95,ema20Slope:1,atr:5,rsi:80,structure:{trend:'long'}});
  assert.equal(closestMissGate(f),'RSI_OUTSIDE_CONTINUATION_BAND');
});

test('closestMissGate reports LOW_RELATIVE_VOLUME once trend and RSI both clear',()=>{
  const f=frame({price:105,ema20:100,ema50:95,ema20Slope:1,atr:5,rsi:55,relativeVolume:.5,structure:{trend:'long'}});
  assert.equal(closestMissGate(f),'LOW_RELATIVE_VOLUME');
});

test('closestMissGate prefers a present-but-unconfirmed reversal/retest structure over a trend verdict',()=>{
  const f=frame({structure:{trend:'neutral',retest:'long'}});
  assert.equal(closestMissGate(f),'RANGE_OR_REVERSAL_SETUP_PRESENT_BUT_UNCONFIRMED');
});

test('closestMissGate falls back to TREND_PRESENT_BUT_NO_MOMENTUM_CONFIRMATION once every checked gate clears',()=>{
  const f=frame({price:105,ema20:100,ema50:95,ema20Slope:1,atr:5,rsi:55,relativeVolume:1,structure:{trend:'long'}});
  assert.equal(closestMissGate(f),'TREND_PRESENT_BUT_NO_MOMENTUM_CONFIRMATION');
});
