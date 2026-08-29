(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeForward = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2.0.0';
  const SCHEMA = 'market-edge-forward-v2';

  function stableHash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function blankLedger() { return { schema:SCHEMA, version:VERSION, signals:[], outcomes:{} }; }

  function migrate(input) {
    if (!input) return blankLedger();
    if (input.schema === SCHEMA && Array.isArray(input.signals) && input.outcomes && typeof input.outcomes === 'object') {
      return { schema:SCHEMA, version:VERSION, signals:input.signals.map(signal=>({...signal})), outcomes:{...input.outcomes} };
    }
    if (!Array.isArray(input)) return blankLedger();
    const ledger=blankLedger();
    input.forEach(record=>{
      if (!record || !record.symbol || !record.timestamp) return;
      const id=record.id||stableHash(`${record.key||record.symbol}|${record.direction}|${record.timestamp}`);
      const {status,resultR,closedAt,...signal}=record;
      ledger.signals.push({...signal,id,recordedAt:record.recordedAt||record.timestamp,schemaVersion:VERSION});
      if (status && status!=='open') ledger.outcomes[id]={status,resultR:Number.isFinite(resultR)?resultR:null,closedAt:closedAt||null,migrated:true};
    });
    return ledger;
  }

  function validateSignal(signal) {
    const required=['symbol','direction','strategy','timestamp','entry','stop','target1','target2','rr1','rr2'];
    const missing=required.filter(key=>signal?.[key]===undefined||signal?.[key]===null||signal?.[key]==='');
    if (missing.length) return {valid:false,reason:`Missing ${missing.join(', ')}`};
    if (!['long','short'].includes(signal.direction)) return {valid:false,reason:'Direction must be long or short'};
    if (![signal.timestamp,signal.entry,signal.stop,signal.target1,signal.target2,signal.rr1,signal.rr2].every(Number.isFinite)) return {valid:false,reason:'Signal prices, timestamp and R values must be finite'};
    if (signal.direction==='long' && !(signal.stop<signal.entry&&signal.target1>signal.entry&&signal.target2>=signal.target1)) return {valid:false,reason:'Invalid LONG price ordering'};
    if (signal.direction==='short' && !(signal.stop>signal.entry&&signal.target1<signal.entry&&signal.target2<=signal.target1)) return {valid:false,reason:'Invalid SHORT price ordering'};
    return {valid:true,reason:null};
  }

  function signalId(signal) {
    return stableHash([signal.symbol,signal.direction,signal.strategy,signal.timestamp,signal.entry,signal.stop,signal.target1,signal.datasetHash||'live',signal.engineVersion||'unknown'].join('|'));
  }

  function appendSignal(ledgerInput, signalInput, now=Date.now()) {
    const ledger=migrate(ledgerInput), validation=validateSignal(signalInput);
    if (!validation.valid) return {ledger,added:false,reason:validation.reason};
    const id=signalInput.id||signalId(signalInput);
    if (ledger.signals.some(signal=>signal.id===id)) return {ledger,added:false,reason:'Duplicate signal',id};
    const signal={...JSON.parse(JSON.stringify(signalInput)),id,recordedAt:now,schemaVersion:VERSION,evidenceType:'automatic-paper-forward',executionModel:signalInput.executionModel||'next-observed-bar; stop-first if ambiguous; 50% TP1 / 50% TP2'};
    return {ledger:{...ledger,signals:[...ledger.signals,signal].slice(-500),outcomes:{...ledger.outcomes}},added:true,id,signal};
  }

  function resolveSignal(signal, candles, options={}) {
    const maxBars=Math.max(1,Number(options.maxBars)||30),feePct=Math.max(0,Number(options.feePct??.0005)),slippagePct=Math.max(0,Number(options.slippagePct??.0003));
    const future=(candles||[]).filter(candle=>Number.isFinite(candle?.time)&&candle.time>signal.timestamp).sort((a,b)=>a.time-b.time).slice(0,maxBars);
    if (!future.length) return null;
    const riskDistance=Math.abs(signal.entry-signal.stop),costR=riskDistance?((feePct+slippagePct)*2)/(riskDistance/signal.entry):0;
    let tp1Hit=false;
    for (let index=0;index<future.length;index++) {
      const candle=future[index],activeStop=tp1Hit?signal.entry:signal.stop;
      const stopHit=signal.direction==='long'?candle.low<=activeStop:candle.high>=activeStop;
      const tp1=signal.direction==='long'?candle.high>=signal.target1:candle.low<=signal.target1;
      const tp2=signal.direction==='long'?candle.high>=signal.target2:candle.low<=signal.target2;
      if (stopHit) return {status:tp1Hit?'partial':'loss',resultR:(tp1Hit?signal.rr1*.5:-1)-costR,closedAt:candle.time,barsHeld:index+1,tp1Hit,reason:tp1Hit?'Breakeven stop after TP1':'Stop hit (conservative same-candle priority)',costR};
      if (!tp1Hit&&tp1) tp1Hit=true;
      if (tp1Hit&&tp2) return {status:'win',resultR:signal.rr1*.5+signal.rr2*.5-costR,closedAt:candle.time,barsHeld:index+1,tp1Hit:true,reason:'TP1 and TP2 completed',costR};
    }
    if (future.length<maxBars) return null;
    const last=future.at(-1),move=(signal.direction==='long'?last.close-signal.entry:signal.entry-last.close)/riskDistance;
    return {status:tp1Hit?'partial':'timed',resultR:(tp1Hit?signal.rr1*.5+Math.max(0,move)*.5:move)-costR,closedAt:last.time,barsHeld:future.length,tp1Hit,reason:'Maximum holding window reached',costR};
  }

  function settle(ledgerInput, candleMap, options={}) {
    const ledger=migrate(ledgerInput),outcomes={...ledger.outcomes};
    ledger.signals.forEach(signal=>{
      if (outcomes[signal.id]) return;
      const outcome=resolveSignal(signal,candleMap?.[signal.symbol]||[],options);
      if (outcome) outcomes[signal.id]={...outcome,recordedAt:options.now||Date.now(),signalHash:stableHash(signal)};
    });
    return {...ledger,outcomes};
  }

  function stats(ledgerInput) {
    const ledger=migrate(ledgerInput),completed=Object.values(ledger.outcomes).filter(outcome=>Number.isFinite(outcome.resultR));
    const wins=completed.filter(outcome=>outcome.resultR>0).length,losses=completed.filter(outcome=>outcome.resultR<=0).length;
    return {signals:ledger.signals.length,open:ledger.signals.length-completed.length,completed:completed.length,wins,losses,winRate:completed.length?wins/completed.length:0,averageR:completed.length?completed.reduce((sum,outcome)=>sum+outcome.resultR,0)/completed.length:0,sampleTier:completed.length>=100?'decision-useful':completed.length>=30?'directional':completed.length>=10?'early':'tiny'};
  }

  return {VERSION,SCHEMA,stableHash,blankLedger,migrate,validateSignal,signalId,appendSignal,resolveSignal,settle,stats};
});
