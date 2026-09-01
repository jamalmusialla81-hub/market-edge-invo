import { runLiveScan } from './scan-core.mjs';
import { activeMlModel } from './worker.mjs';

function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method!=='POST'||url.pathname!=='/internal/evaluate')return json({error:{code:'NOT_FOUND'}},404);
    try {
      const payload=await request.json();
      // The public Worker supplies one scan-start snapshot through the private
      // service binding. This preserves ranking parity while avoiding a model
      // database lookup in every per-market evaluator invocation.
      const model=payload.activeModel&&typeof payload.activeModel==='object'?payload.activeModel:(env.MARKET_EDGE_DB?await activeMlModel(env.MARKET_EDGE_DB).catch(()=>({available:false,status:'UNAVAILABLE'})):{available:false,status:'UNAVAILABLE'});
      const scan=await runLiveScan({market:payload.market?.invoInstrument,marketMetadata:payload.market,settings:payload.settings,now:Number(payload.now)||Date.now(),activeModel:model});
      const result=scan.rankedOpportunities[0];
      if(!result)throw new Error(scan.dataQuality?.failures?.[0]||'Market produced no evaluation result');
      return json({result,completedAt:Date.now()});
    } catch(error) { return json({error:{code:'EVALUATION_FAILED',message:String(error?.message||'Evaluation failed').slice(0,180)}},502); }
  }
};
