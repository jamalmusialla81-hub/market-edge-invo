import assert from 'node:assert/strict';
import {acceptTrade,accountError,closeTrade,resolvePrincipal,successfulScan,sydneyUsageDay} from './account-core.mjs';

const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-key'};
assert.equal(sydneyUsageDay(Date.parse('2026-10-03T13:30:00Z')),'2026-10-03');
assert.equal(sydneyUsageDay(Date.parse('2026-10-03T16:30:00Z')),'2026-10-04');
assert.equal(sydneyUsageDay(Date.parse('2026-04-04T15:30:00Z')),'2026-04-05');
assert.equal(successfulScan({status:'NO_VALID_SETUP',dataQuality:{coverage:{evaluated:1}}}),true);
assert.equal(successfulScan({status:'DATA_UNAVAILABLE',dataQuality:{coverage:{evaluated:40}}}),false);
assert.equal(successfulScan({status:'WAIT_FOR_ENTRY',dataQuality:{coverage:{evaluated:0}}}),false);
const guest=await resolvePrincipal(new Request('https://worker.test/api/scan'),env,async()=>{throw new Error('guest must not call auth');});
assert.equal(guest.type,'GUEST');assert.match(guest.setCookie,/HttpOnly; Secure; SameSite=None/);
const cookie=guest.setCookie.match(/^market_edge_guest=([^;]+)/)[1];
const restored=await resolvePrincipal(new Request('https://worker.test/api/scan',{headers:{cookie:`market_edge_guest=${cookie}`}}),env,async()=>{throw new Error('guest must not call auth');});
assert.equal(restored.id,guest.id);assert.equal(restored.setCookie,null);
await assert.rejects(()=>resolvePrincipal(new Request('https://worker.test/api/scan',{headers:{authorization:'Bearer forged'}}),env,async()=>new Response('{}',{status:401})),error=>error.code==='AUTH_INVALID'&&error.status===401);
assert.equal(accountError('x','Y',409).code,'Y');

// Server-only journal fixture: it is deliberately in-memory so acceptance
// testing never creates a production trade or market-evidence record.
const ownerId='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const recommendationId='33333333-3333-4333-8333-333333333333';
const tradeId='44444444-4444-4444-8444-444444444444';
const frozenSnapshot={scanId:'fixture-scan-1',trade:{asset:'BTC',direction:'long',entry:100,stop:95,tp1:109,tp2:115,rr1:1.8}};
const recommendation={id:recommendationId,principal_id:ownerId,scan_id:'fixture-scan-1',snapshot:frozenSnapshot};
let storedTrade=null;
const fixtureFetch=async (input,options={})=>{
  const url=new URL(input), body=options.body?JSON.parse(options.body):null;
  if(url.pathname.endsWith('/scan_recommendations')) return new Response(JSON.stringify(url.searchParams.get('principal_id')===`eq.${ownerId}`?[recommendation]:[]),{status:200});
  if(url.pathname.endsWith('/user_trades')) {
    if(options.method==='POST') {
      assert.deepEqual(body.snapshot,frozenSnapshot);
      storedTrade={id:tradeId,...body,created_at:'2026-09-02T00:00:00.000Z'};
      return new Response(JSON.stringify([storedTrade]),{status:201});
    }
    if(options.method==='PATCH') {
      assert.equal(body.snapshot,undefined);
      storedTrade={...storedTrade,status:body.status,exit_price:body.exit_price,closed_at:body.closed_at,realized_r:body.realized_r,updated_at:body.updated_at};
      return new Response(JSON.stringify([storedTrade]),{status:200});
    }
    return new Response(JSON.stringify(storedTrade&&url.searchParams.get('user_id')===`eq.${ownerId}`?[storedTrade]:[]),{status:200});
  }
  throw new Error(`unexpected fixture request: ${url}`);
};
const owner={type:'USER',id:ownerId};
const accepted=await acceptTrade(owner,recommendationId,env,fixtureFetch);
assert.equal(accepted.duplicate,false);assert.deepEqual(accepted.trade.snapshot,frozenSnapshot);
const duplicate=await acceptTrade(owner,recommendationId,env,fixtureFetch);
assert.equal(duplicate.duplicate,true);assert.equal(duplicate.trade.id,tradeId);
await assert.rejects(()=>acceptTrade({type:'USER',id:otherId},recommendationId,env,fixtureFetch),error=>error.code==='RECOMMENDATION_EXPIRED');
const closed=await closeTrade(owner,tradeId,110,env,fixtureFetch,Date.parse('2026-09-02T01:00:00.000Z'));
assert.equal(closed.status,'CLOSED');assert.equal(closed.realized_r,2);assert.deepEqual(closed.snapshot,frozenSnapshot);
console.log('Account identity and entitlement predicates passed');
