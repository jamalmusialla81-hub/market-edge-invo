(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const AI_VERDICTS = ['LONG', 'SHORT', 'WAIT', 'NO_TRADE'];
  const FINAL_VERDICTS = ['LONG', 'SHORT', 'WAIT', 'NO TRADE'];
  const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 1_750_000;
  const MAX_TOTAL_IMAGE_BYTES = 6_000_000;
  const MISTAKE_CATEGORIES = ['entered too early', 'chased price', 'ignored higher timeframe', 'moved stop', 'overleveraged', 'ignored WAIT', 'entered during chop'];

  const DEFINITIONS = {
    BOS: 'Break of structure: price closes through a confirmed prior swing in the existing trend direction.',
    CHoCH: 'Change of character: an early break against the prior swing sequence that may signal a regime change.',
    'liquidity sweep': 'Price briefly trades beyond a prior swing, then rejects back through it. The reclaim matters more than the wick alone.',
    retest: 'Price returns to a broken level and shows whether that old barrier now holds from the other side.',
    ATR: 'Average True Range: a volatility measure used here to place stops outside normal candle noise.',
    expectancy: 'The average result per trade in R after winners, losers and modeled costs. A positive value still needs a meaningful sample.',
    'R:R': 'Risk-to-reward: the planned reward divided by the distance from entry to stop.',
    drawdown: 'The decline from a prior portfolio peak. It shows how severe a losing stretch was.',
    OOS: 'Out-of-sample: data held back from strategy selection and used only for later evaluation.'
  };

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
  function safeText(value, max = 1200) { return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
  function safeAsset(value) { const asset=safeText(value, 15).toUpperCase(); return /^[A-Z0-9]{2,12}$/.test(asset) ? asset : 'UNKNOWN'; }
  function uniqueStrings(values, maxItems = 12, maxLength = 320) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => safeText(value, maxLength)).filter(Boolean))].slice(0, maxItems);
  }
  function parseAIJSON(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') throw new Error('AI response was not a JSON object');
    const cleaned=value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    let parsed;
    try { parsed=JSON.parse(cleaned); } catch { throw new Error('AI returned malformed JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI response was not a JSON object');
    return parsed;
  }
  function normalizeCase(value) {
    if (!value || typeof value !== 'object') return { trigger:'UNKNOWN / NOT AVAILABLE',entry_zone:[],invalidation:'UNKNOWN / NOT AVAILABLE',targets:[] };
    return {
      trigger:safeText(value.trigger || 'UNKNOWN / NOT AVAILABLE',500),
      entry_zone:(Array.isArray(value.entry_zone)?value.entry_zone:[]).map(finite).filter(Number.isFinite).slice(0,2),
      invalidation:safeText(value.invalidation || 'UNKNOWN / NOT AVAILABLE',500),
      targets:(Array.isArray(value.targets)?value.targets:[]).map(finite).filter(Number.isFinite).slice(0,4)
    };
  }
  function normalizeAIAnalysis(input) {
    const value=parseAIJSON(input);
    const verdict=safeText(value.ai_verdict,20).toUpperCase().replace(/\s+/g,'_');
    if (!AI_VERDICTS.includes(verdict)) throw new Error('AI verdict was missing or unsupported');
    const bias=safeText(value.bias,20).toLowerCase();
    if (!['bullish','bearish','neutral'].includes(bias)) throw new Error('AI bias was missing or unsupported');
    const summaries={};
    TIMEFRAMES.forEach(timeframe=>{ summaries[timeframe]=safeText(value.timeframe_summary?.[timeframe] || 'NOT AVAILABLE',500); });
    const observations=(Array.isArray(value.observations)?value.observations:[]).slice(0,20).map(item=>({
      type:['OBSERVED','INFERRED'].includes(safeText(item?.type,20).toUpperCase())?safeText(item.type,20).toUpperCase():'INFERRED',
      timeframe:TIMEFRAMES.includes(safeText(item?.timeframe,5))?safeText(item.timeframe,5):'unknown',
      evidence:safeText(item?.evidence || item,500)
    })).filter(item=>item.evidence);
    return {
      asset:safeAsset(value.asset),bias,ai_verdict:verdict,setup_type:safeText(value.setup_type || 'No qualified setup',120),
      timeframe_summary:summaries,observations,conflicts:uniqueStrings(value.conflicts),
      bull_case:normalizeCase(value.bull_case),bear_case:normalizeCase(value.bear_case),
      risk_notes:uniqueStrings(value.risk_notes),uncertainties:uniqueStrings(value.uncertainties),
      explanation:safeText(value.explanation || 'No explanation supplied.',1800)
    };
  }
  function sanitizeFrame(frame) {
    if (!frame || typeof frame !== 'object') return null;
    return {
      price:finite(frame.price),rsi:finite(frame.rsi),relativeVolume:finite(frame.relativeVolume),atrPct:finite(frame.atrPct),
      ema20Slope:finite(frame.ema20Slope),regime:safeText(frame.regime,60),structure:safeText(frame.structure?.label || frame.structure,120)
    };
  }
  function sanitizeQuantSnapshot(result) {
    if (!result || typeof result !== 'object') return null;
    const q=result.quant || result;
    const snapshot={
      asset:safeAsset(result.symbol || q.asset),name:safeText(result.name || '',80),price:finite(result.price || q.entry),
      decision:['TAKE TRADE','WAIT','NO TRADE','ANALYSIS UNAVAILABLE'].includes(q.decision)?q.decision:'ANALYSIS UNAVAILABLE',
      direction:['long','short'].includes(q.direction)?q.direction:null,strategy:safeText(q.strategy || 'None',100),
      regime:safeText(q.regime || 'UNKNOWN',80),macroRegime:safeText(q.macroRegime || 'UNKNOWN',80),quality:finite(q.quality),
      reason:safeText(q.reason || 'No quantitative reason supplied',700),entry:finite(q.entry),idealEntry:finite(q.idealEntry),
      entryZone:q.entryZone&&Number.isFinite(q.entryZone.low)&&Number.isFinite(q.entryZone.high)?{low:Number(q.entryZone.low),high:Number(q.entryZone.high)}:null,
      stop:finite(q.stop),target1:finite(q.target1),target2:finite(q.target2),rr1:finite(q.rr1),rr2:finite(q.rr2),
      invalidationCondition:safeText(q.invalidationCondition || '',500),trailingRule:safeText(q.trailingRule || '',500),
      alignment:q.alignment?clone(q.alignment):null,risk:q.risk?{
        valid:!!q.risk.valid,reason:safeText(q.risk.reason || '',300),riskAmount:finite(q.risk.maxLoss),
        positionValue:finite(q.risk.notional),margin:finite(q.risk.margin),leverage:finite(q.risk.leverage),estimatedLiquidation:finite(q.risk.estimatedLiquidation)
      }:null,
      timeframes:{},oos:result.oos?clone(result.oos):null
    };
    const frames=q.timeframes || {};
    Object.entries({ '5m':frames.m5,'15m':frames.m15,'1h':frames.h1,'4h':frames.h4,'1d':frames.d1 }).forEach(([key,frame])=>{ snapshot.timeframes[key]=sanitizeFrame(frame); });
    return snapshot;
  }
  function fuseDecision(quantInput, aiInput) {
    const quant=quantInput?.decision?quantInput:sanitizeQuantSnapshot(quantInput);
    if (!quant || quant.decision==='ANALYSIS UNAVAILABLE') return {verdict:'NO TRADE',reason:'A valid quantitative result is required before AI context can be used.',agreement:false};
    if (quant.decision==='NO TRADE') return {verdict:'NO TRADE',reason:`The quantitative gate rejected the setup: ${quant.reason||'insufficient evidence'}`,agreement:false};
    if (quant.decision==='WAIT') return {verdict:'WAIT',reason:`The quantitative gate is waiting: ${quant.reason||'confirmation is incomplete'}`,agreement:false};
    if (quant.decision!=='TAKE TRADE' || !['long','short'].includes(quant.direction)) return {verdict:'NO TRADE',reason:'The quantitative result is incomplete or unsupported.',agreement:false};
    let ai;
    try { ai=normalizeAIAnalysis(aiInput); } catch (error) { return {verdict:'WAIT',reason:`AI analysis was unavailable: ${error.message}`,agreement:false}; }
    if (ai.ai_verdict==='NO_TRADE') return {verdict:'NO TRADE',reason:'AI chart analysis found a visual invalidation or insufficient readable evidence.',agreement:false};
    if (ai.ai_verdict==='WAIT') return {verdict:'WAIT',reason:'AI chart analysis requires further confirmation.',agreement:false};
    const aiDirection=ai.ai_verdict.toLowerCase(), agreement=aiDirection===quant.direction;
    if (!agreement) return {verdict:'WAIT',reason:`AI reads ${ai.ai_verdict}, while the quantitative setup is ${quant.direction.toUpperCase()}. Higher-confidence agreement is required.`,agreement:false};
    return {verdict:quant.direction==='long'?'LONG':'SHORT',reason:'AI chart context agrees with a quantitatively qualified setup. This remains paper research only.',agreement:true};
  }
  function validateImageMeta(images, options={}) {
    const maxImages=options.maxImages||MAX_IMAGES,maxBytes=options.maxBytes||MAX_IMAGE_BYTES,maxTotal=options.maxTotal||MAX_TOTAL_IMAGE_BYTES;
    if (!Array.isArray(images)) throw new Error('Images must be supplied as a list');
    if (images.length>maxImages) throw new Error(`Use no more than ${maxImages} chart images`);
    let total=0;
    const normalized=images.map((image,index)=>{
      const type=safeText(image?.type,40).toLowerCase(),size=Number(image?.size||0),timeframe=safeText(image?.timeframe,5);
      if (!IMAGE_TYPES.includes(type)) throw new Error(`Image ${index+1} uses an unsupported file type`);
      if (!Number.isFinite(size)||size<=0) throw new Error(`Image ${index+1} is empty or unreadable`);
      if (size>maxBytes) throw new Error(`Image ${index+1} is too large after compression`);
      if (!TIMEFRAMES.includes(timeframe)) throw new Error(`Image ${index+1} needs a valid timeframe`);
      total+=size;
      return {type,size,timeframe,name:safeText(image.name||`Chart ${index+1}`,120)};
    });
    if (total>maxTotal) throw new Error('Combined chart images are too large');
    return normalized;
  }
  function makePortfolio(startingBalance=5.70) {
    const balance=Math.max(.01,Number(startingBalance)||5.70);
    return {version:1,startingBalance:balance,balance,signals:[],outcomes:{},createdAt:new Date().toISOString()};
  }
  function makePaperSignal(params) {
    const quant=params?.quant?.decision?params.quant:sanitizeQuantSnapshot(params?.quant),ai=normalizeAIAnalysis(params?.ai),fusion=fuseDecision(quant,ai);
    if (!['LONG','SHORT'].includes(fusion.verdict) || quant?.decision!=='TAKE TRADE') throw new Error('Only an AI/quant-aligned qualified setup can become a paper trade');
    if (!quant.risk?.valid) throw new Error('A valid risk-sized plan is required');
    const timestamp=params.timestamp||new Date().toISOString(),id=safeText(params.id||`${quant.asset}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,100);
    const original={
      timestamp,asset:quant.asset,direction:quant.direction,strategy:quant.strategy,aiInterpretation:ai,quantInterpretation:quant,
      entry:quant.entry,stop:quant.stop,tp1:quant.target1,tp2:quant.target2,trailingRule:quant.trailingRule,
      positionValue:quant.risk.positionValue,leverage:quant.risk.leverage,riskAmount:quant.risk.riskAmount,regime:quant.regime,
      timeframeAlignment:quant.alignment,qualityBucket:quant.quality>=90?'90+':quant.quality>=80?'80-89':quant.quality>=70?'70-79':'below 70',
      oosStatistics:quant.oos||null,finalVerdict:fusion.verdict
    };
    return {id,original:clone(original)};
  }
  function addPaperSignal(portfolioInput,signal) {
    const portfolio=clone(portfolioInput||makePortfolio());
    if (!signal?.id||!signal.original) throw new Error('Invalid paper signal');
    if (portfolio.signals.some(item=>item.id===signal.id)) return portfolio;
    const requiredMargin=finite(signal.original.quantInterpretation?.risk?.margin) || finite(signal.original.positionValue)/(finite(signal.original.leverage)||1);
    const reserved=portfolio.signals.filter(item=>portfolio.outcomes[item.id]?.status==='open').reduce((sum,item)=>sum+(finite(item.original.quantInterpretation?.risk?.margin)||0),0);
    if (!Number.isFinite(requiredMargin)||requiredMargin<=0||requiredMargin+reserved>portfolio.balance+.000001) throw new Error('Paper balance cannot support the risk-sized margin');
    portfolio.signals.push(clone(signal));
    portfolio.outcomes[signal.id]={status:'open',lastPrice:signal.original.entry,unrealizedPnl:0,mfeR:0,maeR:0,notes:[]};
    return portfolio;
  }
  function updatePaperMarks(portfolioInput,prices) {
    const portfolio=clone(portfolioInput);
    portfolio.signals.forEach(signal=>{
      const outcome=portfolio.outcomes[signal.id]; if (!outcome||outcome.status!=='open') return;
      const price=finite(prices?.[signal.original.asset]); if (!Number.isFinite(price)) return;
      const original=signal.original,side=original.direction==='long'?1:-1,quantity=original.positionValue/original.entry;
      const pnl=(price-original.entry)*quantity*side,risk=Math.max(.000001,original.riskAmount),r=pnl/risk;
      outcome.lastPrice=price;outcome.unrealizedPnl=pnl;outcome.mfeR=Math.max(outcome.mfeR||0,r);outcome.maeR=Math.min(outcome.maeR||0,r);
    });
    return portfolio;
  }
  function closePaperSignal(portfolioInput,id,exitPrice,options={}) {
    const portfolio=clone(portfolioInput),signal=portfolio.signals.find(item=>item.id===id),outcome=portfolio.outcomes[id];
    if (!signal||!outcome||outcome.status!=='open') throw new Error('Open paper trade not found');
    const exit=finite(exitPrice); if (!Number.isFinite(exit)||exit<=0) throw new Error('A valid exit price is required');
    const original=signal.original,side=original.direction==='long'?1:-1,quantity=original.positionValue/original.entry;
    const pnl=(exit-original.entry)*quantity*side,risk=Math.max(.000001,original.riskAmount),r=pnl/risk;
    outcome.status='closed';outcome.exit=exit;outcome.closedAt=options.closedAt||new Date().toISOString();outcome.realizedPnl=pnl;outcome.rMultiple=r;
    outcome.result=r>0?'win':r<0?'loss':'breakeven';outcome.mfeR=Math.max(outcome.mfeR||0,r);outcome.maeR=Math.min(outcome.maeR||0,r);
    if (options.mistake&&MISTAKE_CATEGORIES.includes(options.mistake)) outcome.mistake=options.mistake;
    if (safeText(options.note,500)) outcome.notes=[...(outcome.notes||[]),{timestamp:outcome.closedAt,text:safeText(options.note,500)}];
    portfolio.balance+=pnl;
    return portfolio;
  }
  function portfolioStats(portfolioInput) {
    const portfolio=portfolioInput||makePortfolio(),outcomes=portfolio.outcomes||{},closed=Object.values(outcomes).filter(item=>item.status==='closed'),open=Object.values(outcomes).filter(item=>item.status==='open');
    const rs=closed.map(item=>finite(item.rMultiple)).filter(Number.isFinite),wins=rs.filter(value=>value>0),losses=rs.filter(value=>value<=0);
    const grossWin=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0)),unrealized=open.reduce((sum,item)=>sum+(finite(item.unrealizedPnl)||0),0);
    let equity=portfolio.startingBalance,peak=equity,maxDrawdown=0;
    closed.slice().sort((a,b)=>String(a.closedAt).localeCompare(String(b.closedAt))).forEach(item=>{equity+=finite(item.realizedPnl)||0;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);});
    return {startingBalance:portfolio.startingBalance,balance:portfolio.balance,equity:portfolio.balance+unrealized,open:open.length,closed:closed.length,realizedPnl:portfolio.balance-portfolio.startingBalance,unrealizedPnl:unrealized,winRate:closed.length?wins.length/closed.length:0,expectancy:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0,profitFactor:grossLoss?grossWin/grossLoss:null,maxDrawdown,sample:rs.length};
  }
  function historyFeedback(portfolioInput,minSample=3) {
    const portfolio=portfolioInput||makePortfolio(),records=portfolio.signals.map(signal=>({signal,outcome:portfolio.outcomes?.[signal.id]})).filter(item=>item.outcome?.status==='closed'),messages=[];
    const strategies={}; records.forEach(item=>{ const key=item.signal.original.strategy||'UNKNOWN';(strategies[key]||=[]).push(finite(item.outcome.rMultiple)||0); });
    Object.entries(strategies).forEach(([strategy,rs])=>{ if (rs.length>=minSample) messages.push(`${strategy}: ${rs.length} paper trades, ${(rs.reduce((a,b)=>a+b,0)/rs.length).toFixed(2)}R average.`); });
    const mistakes={};records.forEach(item=>{ if(item.outcome.mistake) mistakes[item.outcome.mistake]=(mistakes[item.outcome.mistake]||0)+1; });
    Object.entries(mistakes).forEach(([mistake,count])=>{ if(count>=minSample) messages.push(`${mistake}: recorded ${count} times in closed paper trades.`); });
    if (!messages.length) messages.push(`Not enough repeated observations for personalized feedback. ${records.length} closed paper trade${records.length===1?'':'s'} recorded; each pattern needs at least ${minSample}.`);
    return {sample:records.length,messages};
  }
  function explainTerm(term,level='beginner',context={}) {
    const key=Object.keys(DEFINITIONS).find(item=>item.toLowerCase()===safeText(term,40).toLowerCase());
    if (!key) return 'Explanation is not available.';
    const base=DEFINITIONS[key],quant=context.quant?.decision?context.quant:sanitizeQuantSnapshot(context.quant),suffix=quant?` Current ${quant.asset} context: ${quant.strategy||'no strategy'} in ${quant.regime||'an unknown regime'}; quantitative decision ${quant.decision}.`:' No current quantitative setup is loaded.';
    if (level==='advanced') return `${base}${suffix} Treat the label as valid only when confirmed by closed candles, unambiguous swing selection and the relevant higher-timeframe regime.`;
    if (level==='intermediate') return `${base}${suffix} It is evidence, not a trade signal by itself.`;
    return `${base}${suffix}`;
  }
  function localQuantAnswer(question,quantInput) {
    const quant=quantInput?.decision?quantInput:sanitizeQuantSnapshot(quantInput),ask=safeText(question,500).toLowerCase();
    if(!quant) return 'Scan the markets first. I need a current quantitative result before I can explain an entry, stop, target, leverage or WAIT decision.';
    const asset=quant.asset||'This market',decision=quant.decision||'ANALYSIS UNAVAILABLE',reason=quant.reason||'the required rules are incomplete';
    const quality=Number.isFinite(Number(quant.quality))?` Setup quality is ${Number(quant.quality).toFixed(0)}/100.`:'';
    const blocked=`${asset} is ${decision} because ${reason}.${quality} Do not enter from this result. Re-scan later and wait for a fully risk-checked TAKE TRADE result.`;
    if(['NO TRADE','WAIT','ANALYSIS UNAVAILABLE'].includes(decision)) {
      if(/leverage|\bx\b/.test(ask)) return `${blocked} Leverage cannot turn a rejected or incomplete setup into a valid one.`;
      if(/stop|loss|target|profit|entry|enter|buy|sell|when/.test(ask)) return `${blocked} There is no entry, stop-loss or take-profit to copy into Invo right now.`;
      return blocked;
    }
    if(decision!=='TAKE TRADE'||!['long','short'].includes(quant.direction)) return `${asset} does not have a complete supported trade plan. Do not enter it.`;
    const zone=quant.entryZone?`${quant.entryZone.low}–${quant.entryZone.high}`:(Number.isFinite(Number(quant.entry))?String(quant.entry):'not available');
    const risk=quant.risk||{},levels=`Entry ${zone}; stop ${Number.isFinite(Number(quant.stop))?quant.stop:'not available'}; target 1 ${Number.isFinite(Number(quant.target1))?quant.target1:'not available'}; target 2 ${Number.isFinite(Number(quant.target2))?quant.target2:'not available'}.`;
    if(/leverage|margin|size|risk/.test(ask)) return `${asset} has a quantitative ${quant.direction.toUpperCase()} plan. Calculated leverage: ${Number.isFinite(Number(risk.leverage))?`${risk.leverage}×`:'not available'}; margin: ${Number.isFinite(Number(risk.margin))?risk.margin:'not available'} USDC; maximum planned loss: ${Number.isFinite(Number(risk.riskAmount))?risk.riskAmount:'not available'} USDC. ${levels} Use this only as a paper-trade plan.`;
    if(/stop|loss|target|profit|entry|enter|buy|sell|when/.test(ask)) return `${asset} has a quantitative ${quant.direction.toUpperCase()} plan. ${levels} Invalidation: ${quant.invalidationCondition||'not available'}. Use this only as a paper-trade plan.`;
    return `${asset} has a quantitative ${quant.direction.toUpperCase()} result using ${quant.strategy||'the qualified strategy'}.${quality} ${levels} Reason: ${reason}. Use this only as a paper-trade plan.`;
  }
  return {VERSION,AI_VERDICTS,FINAL_VERDICTS,TIMEFRAMES,IMAGE_TYPES,MAX_IMAGES,MAX_IMAGE_BYTES,MAX_TOTAL_IMAGE_BYTES,MISTAKE_CATEGORIES,DEFINITIONS,parseAIJSON,normalizeAIAnalysis,sanitizeQuantSnapshot,fuseDecision,validateImageMeta,makePortfolio,makePaperSignal,addPaperSignal,updatePaperMarks,closePaperSignal,portfolioStats,historyFeedback,explainTerm,localQuantAnswer,clone,clamp,safeText,safeAsset};
});
