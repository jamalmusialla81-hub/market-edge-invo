import assert from 'node:assert/strict';
import {accountError,resolvePrincipal,successfulScan,sydneyUsageDay} from './account-core.mjs';

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
console.log('Account identity and entitlement predicates passed');
