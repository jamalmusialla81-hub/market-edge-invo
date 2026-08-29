const assert = require('assert');
const AI = require('./ai-engine.js');

function analysis(verdict='LONG',asset='ETH') {
  return {
    asset,bias:verdict==='SHORT'?'bearish':verdict==='LONG'?'bullish':'neutral',ai_verdict:verdict,setup_type:'breakout retest',
    timeframe_summary:{'5m':'execution test','15m':'confirmation','1h':'setup','4h':'macro','1d':'macro'},
    observations:[{type:'OBSERVED',timeframe:'15m',evidence:'Price visibly rejected the marked level'},{type:'INFERRED',timeframe:'4h',evidence:'Structure may be weakening'}],
    conflicts:[],bull_case:{trigger:'Quant level holds',entry_zone:[100,101],invalidation:'Below quant stop',targets:[104,108]},
    bear_case:{trigger:'Quant support fails',entry_zone:[],invalidation:'UNKNOWN / NOT AVAILABLE',targets:[]},
    risk_notes:['Paper research only'],uncertainties:[],explanation:'Visual context agrees with the supplied quant direction.'
  };
}
function quant(direction='long',decision='TAKE TRADE') {
  return {
    asset:'ETH',price:100,decision,direction,strategy:'BREAKOUT + RETEST',regime:'BREAKOUT RETEST',macroRegime:'WEAK UPTREND',quality:82,
    reason:decision==='TAKE TRADE'?'Quant rules passed':'Quant rules did not pass',entry:100,entryZone:{low:99.5,high:100.5},stop:98,target1:104,target2:108,
    invalidationCondition:'Close below support',trailingRule:'Trail confirmed 15m swings',alignment:{aligned:4,opposed:0},oos:{trades:5,expectancy:.2},
    risk:{valid:true,riskAmount:.057,positionValue:4,margin:2,leverage:2,estimatedLiquidation:55},timeframes:{}
  };
}

const parsed=AI.normalizeAIAnalysis(JSON.stringify(analysis()));
assert.equal(parsed.ai_verdict,'LONG');
assert.equal(parsed.observations[0].type,'OBSERVED');
assert.throws(()=>AI.normalizeAIAnalysis('{bad json'),/malformed JSON/);
assert.throws(()=>AI.normalizeAIAnalysis({...analysis(),ai_verdict:'BUY'}),/unsupported/);

assert.deepEqual(AI.validateImageMeta([]),[]);
const validImages=AI.validateImageMeta([
  {type:'image/png',size:1000,timeframe:'5m',name:'one.png'},
  {type:'image/jpeg',size:1200,timeframe:'4h',name:'two.jpg'}
]);
assert.equal(validImages.length,2);
assert.throws(()=>AI.validateImageMeta([{type:'image/gif',size:1000,timeframe:'5m'}]),/unsupported/);
assert.throws(()=>AI.validateImageMeta([{type:'image/png',size:AI.MAX_IMAGE_BYTES+1,timeframe:'5m'}]),/too large/);
assert.throws(()=>AI.validateImageMeta([{type:'image/png',size:1000,timeframe:'2h'}]),/timeframe/);

assert.equal(AI.fuseDecision(null,analysis()).verdict,'NO TRADE');
assert.equal(AI.fuseDecision(quant('long','WAIT'),analysis('LONG')).verdict,'WAIT');
assert.equal(AI.fuseDecision(quant('long','NO TRADE'),analysis('LONG')).verdict,'NO TRADE');
assert.equal(AI.fuseDecision(quant('long'),analysis('SHORT')).verdict,'WAIT');
assert.equal(AI.fuseDecision(quant('long'),analysis('LONG')).verdict,'LONG');
assert.equal(AI.fuseDecision(quant('short'),analysis('SHORT')).verdict,'SHORT');
assert.equal(AI.fuseDecision(quant('short'),analysis('WAIT')).verdict,'WAIT');

let portfolio=AI.makePortfolio(5.70);
const signal=AI.makePaperSignal({id:'immutable-1',timestamp:'2026-08-29T00:00:00Z',quant:quant('long'),ai:analysis('LONG')});
const originalBefore=JSON.stringify(signal.original);
portfolio=AI.addPaperSignal(portfolio,signal);
assert.equal(portfolio.signals.length,1);
portfolio=AI.updatePaperMarks(portfolio,{ETH:102});
assert(portfolio.outcomes['immutable-1'].unrealizedPnl>0);
portfolio=AI.closePaperSignal(portfolio,'immutable-1',104,{closedAt:'2026-08-29T01:00:00Z',mistake:'entered too early'});
assert.equal(portfolio.outcomes['immutable-1'].status,'closed');
assert(portfolio.outcomes['immutable-1'].rMultiple>0);
assert.equal(JSON.stringify(portfolio.signals[0].original),originalBefore);
assert.equal(AI.portfolioStats(portfolio).closed,1);

const tiny=AI.makePortfolio(5.70),oversized=AI.makePaperSignal({id:'oversized',quant:{...quant('long'),risk:{...quant('long').risk,margin:8,positionValue:16}},ai:analysis('LONG')});
assert.throws(()=>AI.addPaperSignal(tiny,oversized),/cannot support/);
assert.match(AI.historyFeedback(portfolio).messages[0],/Not enough/);
assert.match(AI.explainTerm('OOS','beginner',{quant:quant()}),/ETH/);
assert.match(AI.localQuantAnswer('Why no trade?',quant('long','NO TRADE')),/Do not enter/);
assert.match(AI.localQuantAnswer('What leverage?',quant('long','WAIT')),/Leverage cannot/);
assert.match(AI.localQuantAnswer('What do I put into Invo?',quant('long')),/Entry 99.5–100.5/);
assert.match(AI.localQuantAnswer('What leverage?',quant('long')),/2×/);

console.log('AI fusion and paper portfolio tests passed');
