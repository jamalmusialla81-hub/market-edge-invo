(function () {
  'use strict';
  if (!window.MarketEdgeAI) return;
  const AI=window.MarketEdgeAI,config=window.MARKET_EDGE_AI_CONFIG||{},API_BASE=String(config.apiBase||'').replace(/\/$/,'');
  const ASSETS=['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','SUI','PENGU','BNB','LTC','DOT','NEAR','APT','ARB','OP','UNI','AAVE','INJ'];
  const byId=id=>document.getElementById(id),escape=value=>String(value==null?'':value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const money=value=>Number.isFinite(Number(value))?Number(value).toFixed(Math.abs(Number(value))<1?4:2):'—';
  const price=value=>Number.isFinite(Number(value))?(Number(value)>=1000?Number(value).toLocaleString(undefined,{maximumFractionDigits:2}):Number(value).toLocaleString(undefined,{maximumSignificantDigits:7})):'—';
  const state={quant:null,quantByAsset:{},analysis:null,fusion:null,uploads:[],chat:[],portfolio:loadPortfolio(),busy:false};
  const els={
    asset:byId('aiAsset'),file:byId('chartUpload'),previews:byId('chartPreviews'),question:byId('aiQuestion'),analyze:byId('analyzeCharts'),clear:byId('clearCharts'),
    backend:byId('aiBackendStatus'),result:byId('aiAnalysisResult'),finalBadge:byId('aiFinalBadge'),chatLog:byId('aiChatLog'),chatInput:byId('aiChatInput'),chatSend:byId('aiChatSend'),
    level:byId('explainLevel'),explainResult:byId('explainResult'),paperButton:byId('paperThisSetup'),paperStart:byId('paperStartBalance'),paperReset:byId('paperReset'),
    paperStats:byId('paperStats'),paperPositions:byId('paperPositions'),paperHistory:byId('paperHistory'),journal:byId('journalFeedback')
  };
  function loadPortfolio() {
    try { const parsed=JSON.parse(localStorage.getItem('market-edge-paper-portfolio')||'null'); return parsed?.version===1?parsed:AI.makePortfolio(5.70); }
    catch { return AI.makePortfolio(5.70); }
  }
  function savePortfolio() { localStorage.setItem('market-edge-paper-portfolio',JSON.stringify(state.portfolio)); }
  function toast(message) {
    const node=byId('toast'); if(!node)return;node.textContent=message;node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),3400);
  }
  function setBackend(text,kind='') { if(!els.backend)return;els.backend.textContent=text;els.backend.className=`badge ${kind}`.trim(); }
  function apiError(error) { return error?.message||'AI request failed'; }
  async function fetchJSON(path,payload,timeoutMs=30000) {
    if(!API_BASE) throw new Error('AI backend is not connected yet. The quantitative scanner and paper portfolio still work.');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetch(`${API_BASE}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data?.error?.message||`AI backend returned ${response.status}`);
      return data;
    } catch(error) { if(error.name==='AbortError') throw new Error('AI request timed out. No trade decision was changed.'); throw error; }
    finally { clearTimeout(timer); }
  }
  async function checkBackend() {
    if(!API_BASE) {setBackend('AI backend setup required','watch');return;}
    try { const response=await fetch(`${API_BASE}/health`,{cache:'no-store'}),data=await response.json(); setBackend(data.configured?'AI backend ready':'Backend missing API secret',data.configured?'take':'watch'); }
    catch { setBackend('AI backend unavailable','avoid'); }
  }
  function selectQuant(asset) {
    state.quant=state.quantByAsset[asset]||null;state.analysis=null;state.fusion=null;renderAnalysis();renderPaperButton();
  }
  function handleScan(event) {
    const details=event.detail||{},results=Array.isArray(details.results)?details.results:[];
    state.quantByAsset=Object.fromEntries(results.filter(Boolean).map(result=>[result.asset,result]));
    const current=els.asset.value,assets=Object.keys(state.quantByAsset);
    els.asset.innerHTML=assets.length?assets.map(asset=>`<option value="${escape(asset)}">${escape(asset)}</option>`).join(''):'<option value="">Scan markets first</option>';
    els.asset.value=state.quantByAsset[current]?current:(details.best?.asset||assets[0]||'');
    state.quant=state.quantByAsset[els.asset.value]||null;
    const prices=Object.fromEntries(results.map(result=>[result.asset,result.price]).filter(([,value])=>Number.isFinite(value)));
    state.portfolio=AI.updatePaperMarks(state.portfolio,prices);savePortfolio();renderPortfolio();renderAnalysis();renderPaperButton();
  }
  function fileToDataURL(blob) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read image'));reader.readAsDataURL(blob);}); }
  async function compressImage(file) {
    if(!AI.IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name}: PNG, JPEG or WebP only`);
    if(file.size>12_000_000) throw new Error(`${file.name}: original file is too large`);
    const bitmap=await createImageBitmap(file),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#0b0e0f';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const outputType=file.type==='image/png'?'image/webp':file.type;
    const makeBlob=quality=>new Promise(resolve=>canvas.toBlob(resolve,outputType,quality));
    let blob=await makeBlob(.82);if(blob?.size>AI.MAX_IMAGE_BYTES)blob=await makeBlob(.66);
    if(!blob||blob.size>AI.MAX_IMAGE_BYTES) throw new Error(`${file.name}: image remains too large after compression`);
    return {name:file.name,type:blob.type,size:blob.size,dataUrl:await fileToDataURL(blob),previewUrl:URL.createObjectURL(blob),timeframe:AI.TIMEFRAMES[Math.min(state.uploads.length,AI.TIMEFRAMES.length-1)]};
  }
  async function addFiles(files) {
    const room=AI.MAX_IMAGES-state.uploads.length;if(room<=0){toast(`Maximum ${AI.MAX_IMAGES} charts`);return;}
    for(const file of [...files].slice(0,room)) {
      try { const image=await compressImage(file);AI.validateImageMeta([...state.uploads,image]);state.uploads.push(image); }
      catch(error){toast(error.message);}
    }
    renderUploads();
  }
  function renderUploads() {
    if(!els.previews)return;
    els.previews.innerHTML=state.uploads.length?state.uploads.map((image,index)=>`<article class="chart-preview">
      <img src="${escape(image.previewUrl)}" alt="Uploaded ${escape(image.timeframe)} chart preview">
      <div><strong>${escape(image.name)}</strong><span>${(image.size/1024).toFixed(0)} KB compressed</span></div>
      <select data-timeframe="${index}" aria-label="Timeframe for ${escape(image.name)}">${AI.TIMEFRAMES.map(tf=>`<option value="${tf}" ${tf===image.timeframe?'selected':''}>${tf}</option>`).join('')}</select>
      <button data-remove-chart="${index}" type="button" aria-label="Remove ${escape(image.name)}">Remove</button>
    </article>`).join(''):'<div class="empty compact"><strong>No charts uploaded</strong>Text-only AI analysis is supported, but visual evidence will be marked unavailable.</div>';
    els.previews.querySelectorAll('[data-timeframe]').forEach(node=>node.addEventListener('change',()=>{state.uploads[Number(node.dataset.timeframe)].timeframe=node.value;}));
    els.previews.querySelectorAll('[data-remove-chart]').forEach(node=>node.addEventListener('click',()=>{const index=Number(node.dataset.removeChart);URL.revokeObjectURL(state.uploads[index].previewUrl);state.uploads.splice(index,1);renderUploads();}));
  }
  function list(items,empty='None reported') { return items?.length?`<ul>${items.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`:`<p class="analysis-copy">${escape(empty)}</p>`; }
  function renderAnalysis() {
    if(!els.result)return;
    if(!state.quant) {
      els.finalBadge.textContent='NO TRADE';els.finalBadge.className='badge no-trade';
      els.result.innerHTML='<div class="empty"><strong>Scan a market first</strong>A valid quantitative result is required before AI context can affect the final verdict.</div>';return;
    }
    if(!state.analysis) {
      const q=state.quant;els.finalBadge.textContent=q.decision;els.finalBadge.className=`badge ${q.decision==='WAIT'?'watch':'no-trade'}`;
      els.result.innerHTML=`<div class="fusion-grid"><div class="fusion-view"><span>Quant view</span><strong>${escape(q.decision)}</strong><p>${escape(q.reason)}</p></div><div class="fusion-view"><span>AI chart view</span><strong>Not analysed</strong><p>Upload charts optionally, then run AI analysis. AI cannot override this quant gate.</p></div></div>`;return;
    }
    const a=state.analysis,f=AI.fuseDecision(state.quant,a);state.fusion=f;
    els.finalBadge.textContent=f.verdict;els.finalBadge.className=`badge ${f.verdict==='LONG'?'take':f.verdict==='SHORT'?'short':f.verdict==='WAIT'?'watch':'no-trade'}`;
    const tf=AI.TIMEFRAMES.map(timeframe=>`<div class="metric"><span>${timeframe}</span><strong>${escape(a.timeframe_summary[timeframe])}</strong></div>`).join('');
    const observations=a.observations.length?a.observations.map(item=>`<li><b>${escape(item.type)} · ${escape(item.timeframe)}</b> ${escape(item.evidence)}</li>`).join(''):'<li>No reliable visual observation supplied.</li>';
    els.result.innerHTML=`
      <div class="final-verdict ${f.verdict.toLowerCase().replace(' ','-')}"><span>FINAL VERDICT</span><strong>${escape(f.verdict)}</strong><p>${escape(f.reason)}</p></div>
      <div class="fusion-grid"><div class="fusion-view"><span>Quant view</span><strong>${escape(state.quant.decision)} · ${escape(state.quant.strategy)}</strong><p>${escape(state.quant.reason)}</p></div><div class="fusion-view"><span>AI chart view</span><strong>${escape(a.ai_verdict.replace('_',' '))} · ${escape(a.bias)}</strong><p>${escape(a.explanation)}</p></div></div>
      <div class="metric-grid ai-timeframes">${tf}</div>
      <details class="analysis-details" open><summary>Observed vs inferred chart evidence</summary><ul class="evidence-list">${observations}</ul></details>
      <div class="case-grid"><article><span>Bull case</span><strong>${escape(a.bull_case.trigger)}</strong><p>Invalidation: ${escape(a.bull_case.invalidation)}</p></article><article><span>Bear case</span><strong>${escape(a.bear_case.trigger)}</strong><p>Invalidation: ${escape(a.bear_case.invalidation)}</p></article></div>
      <details class="analysis-details"><summary>Conflicts, uncertainties and risk notes</summary><div class="detail-columns"><div><b>Conflicts</b>${list(a.conflicts)}</div><div><b>Uncertainties</b>${list(a.uncertainties)}</div><div><b>Risk notes</b>${list(a.risk_notes)}</div></div></details>
      ${['WAIT','NO TRADE'].includes(f.verdict)?`<div class="verdict"><strong>What would change the verdict</strong>${list([...a.conflicts,...a.uncertainties].slice(0,6),'A fresh quantitative scan and explicit timeframe confirmation are required.')}</div>`:''}`;
    renderPaperButton();
  }
  async function analyze() {
    if(state.busy)return;state.busy=true;els.analyze.disabled=true;els.analyze.textContent='Analysing…';
    try {
      const images=state.uploads.map(({dataUrl,type,size,timeframe,name})=>({dataUrl,type,size,timeframe,name}));AI.validateImageMeta(images);
      const data=await fetchJSON('/v1/analyze',{asset:state.quant?.asset||els.asset.value,question:els.question.value,quant:state.quant,images,paperContext:AI.portfolioStats(state.portfolio)},35000);
      state.analysis=AI.normalizeAIAnalysis(data.analysis);state.fusion=AI.fuseDecision(state.quant,state.analysis);renderAnalysis();renderPaperButton();setBackend(`AI ready · ${data.model}`,'take');toast('AI chart analysis complete');
    } catch(error) {state.analysis=null;state.fusion=AI.fuseDecision(state.quant,null);renderAnalysis();setBackend(apiError(error),'avoid');toast(apiError(error));}
    finally {state.busy=false;els.analyze.disabled=false;els.analyze.textContent='Analyse with AI';}
  }
  function renderChat() {
    els.chatLog.innerHTML=state.chat.length?state.chat.map(item=>`<div class="chat-message ${item.role}"><span>${item.role==='user'?'You':'Market Edge AI'}</span><p>${escape(item.content)}</p></div>`).join(''):'<div class="empty compact"><strong>Ask about this setup</strong>The answer will use the current quant snapshot, structured chart analysis and paper context—nothing else.</div>';
    els.chatLog.scrollTop=els.chatLog.scrollHeight;
  }
  async function sendChat() {
    const question=els.chatInput.value.trim();if(!question||state.busy)return;state.chat.push({role:'user',content:question});els.chatInput.value='';renderChat();state.busy=true;els.chatSend.disabled=true;
    try {
      const data=await fetchJSON('/v1/chat',{question,quant:state.quant,analysis:state.analysis,history:state.chat.slice(-7,-1),paperContext:{stats:AI.portfolioStats(state.portfolio),feedback:AI.historyFeedback(state.portfolio)},level:els.level.value},25000);
      const answer=String(data.message?.answer||'No answer returned');state.chat.push({role:'assistant',content:answer});setBackend(`AI ready · ${data.model}`,'take');
    } catch(error){state.chat.push({role:'assistant',content:`Unavailable: ${apiError(error)} The quantitative verdict was not changed.`});}
    finally{state.busy=false;els.chatSend.disabled=false;renderChat();}
  }
  function renderPaperButton() {
    const f=state.analysis?AI.fuseDecision(state.quant,state.analysis):null,eligible=f&&['LONG','SHORT'].includes(f.verdict)&&state.quant?.decision==='TAKE TRADE'&&state.quant?.risk?.valid;
    els.paperButton.disabled=!eligible;els.paperButton.textContent=eligible?`Paper ${f.verdict}`:'Paper trade requires LONG/SHORT agreement';
  }
  function paperSetup() {
    try {const signal=AI.makePaperSignal({quant:state.quant,ai:state.analysis});state.portfolio=AI.addPaperSignal(state.portfolio,signal);savePortfolio();renderPortfolio();toast('Qualified paper trade recorded. Original signal fields are locked.');}
    catch(error){toast(error.message);}
  }
  function renderPortfolio() {
    const stats=AI.portfolioStats(state.portfolio),signals=state.portfolio.signals||[],open=signals.filter(signal=>state.portfolio.outcomes[signal.id]?.status==='open'),closed=signals.filter(signal=>state.portfolio.outcomes[signal.id]?.status==='closed');
    els.paperStart.value=state.portfolio.startingBalance;
    els.paperStats.innerHTML=[['Paper equity',`${money(stats.equity)} USDC`],['Realised P&L',`${stats.realizedPnl>=0?'+':''}${money(stats.realizedPnl)}`],['Unrealised',`${stats.unrealizedPnl>=0?'+':''}${money(stats.unrealizedPnl)}`],['Drawdown',money(stats.maxDrawdown)],['Win rate',`${(stats.winRate*100).toFixed(1)}%`],['Expectancy',`${stats.expectancy.toFixed(2)}R`],['Profit factor',stats.profitFactor?stats.profitFactor.toFixed(2):'—'],['Sample',String(stats.sample)]].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
    els.paperPositions.innerHTML=open.length?open.map(signal=>{const o=state.portfolio.outcomes[signal.id],original=signal.original;return `<article class="paper-row"><div><strong>${escape(original.asset)} ${escape(original.direction.toUpperCase())}</strong><span>${escape(original.strategy)} · ${original.leverage}× paper</span></div><div><span>Entry / mark</span><b>${price(original.entry)} / ${price(o.lastPrice)}</b></div><div><span>Unrealised</span><b class="${o.unrealizedPnl>=0?'positive':'negative'}">${money(o.unrealizedPnl)}</b></div><select data-mistake="${escape(signal.id)}" aria-label="Journal category for ${escape(original.asset)}"><option value="">No mistake category</option>${AI.MISTAKE_CATEGORIES.map(item=>`<option value="${escape(item)}">${escape(item)}</option>`).join('')}</select><button class="secondary-button" data-close-paper="${escape(signal.id)}" type="button">Close at mark</button></article>`;}).join(''):'<div class="empty compact"><strong>No open paper positions</strong>Only a final LONG or SHORT with quantitative approval can be recorded.</div>';
    els.paperHistory.innerHTML=closed.length?closed.slice().reverse().map(signal=>{const o=state.portfolio.outcomes[signal.id],original=signal.original;return `<article class="paper-row closed"><div><strong>${escape(original.asset)} ${escape(original.direction.toUpperCase())}</strong><span>${escape(original.strategy)}</span></div><div><span>Result</span><b class="${o.rMultiple>=0?'positive':'negative'}">${o.rMultiple.toFixed(2)}R</b></div><div><span>MFE / MAE</span><b>${Number(o.mfeR||0).toFixed(2)} / ${Number(o.maeR||0).toFixed(2)}R</b></div><div><span>Journal</span><b>${escape(o.mistake||'None')}</b></div></article>`;}).join(''):'<div class="empty compact"><strong>No closed paper trades</strong>History-based feedback needs real recorded outcomes.</div>';
    els.paperPositions.querySelectorAll('[data-close-paper]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.closePaper,select=els.paperPositions.querySelector(`[data-mistake="${CSS.escape(id)}"]`),outcome=state.portfolio.outcomes[id];try{state.portfolio=AI.closePaperSignal(state.portfolio,id,outcome.lastPrice,{mistake:select?.value||''});savePortfolio();renderPortfolio();toast('Paper trade closed; original signal remains unchanged.');}catch(error){toast(error.message);}}));
    const feedback=AI.historyFeedback(state.portfolio);els.journal.innerHTML=`<strong>History-based feedback · ${feedback.sample} closed</strong>${list(feedback.messages)}`;
  }
  function resetPaper() {
    const start=Math.max(.01,Number(els.paperStart.value)||5.70);
    if(state.portfolio.signals.length&&!confirm('Reset the entire local paper portfolio? This removes simulated records from this device.'))return;
    state.portfolio=AI.makePortfolio(start);savePortfolio();renderPortfolio();toast('Paper portfolio reset');
  }
  function bind() {
    window.addEventListener('market-edge:scan',handleScan);els.asset.addEventListener('change',()=>selectQuant(els.asset.value));els.file.addEventListener('change',()=>{addFiles(els.file.files);els.file.value='';});
    els.clear.addEventListener('click',()=>{state.uploads.forEach(item=>URL.revokeObjectURL(item.previewUrl));state.uploads=[];state.analysis=null;state.fusion=null;renderUploads();renderAnalysis();renderPaperButton();});
    els.analyze.addEventListener('click',analyze);els.chatSend.addEventListener('click',sendChat);els.chatInput.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}});
    document.querySelectorAll('[data-explain-term]').forEach(button=>button.addEventListener('click',()=>{els.explainResult.innerHTML=`<strong>${escape(button.dataset.explainTerm)}</strong> ${escape(AI.explainTerm(button.dataset.explainTerm,els.level.value,{quant:state.quant}))}`;}));
    els.paperButton.addEventListener('click',paperSetup);els.paperReset.addEventListener('click',resetPaper);
  }
  els.asset.innerHTML=ASSETS.map(asset=>`<option value="${asset}">${asset}</option>`).join('');
  bind();renderUploads();renderAnalysis();renderChat();renderPortfolio();renderPaperButton();checkBackend();
  window.MarketEdgeAIUI={getState:()=>AI.clone(state),refreshBackend:checkBackend};
})();
