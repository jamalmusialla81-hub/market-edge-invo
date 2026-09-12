#!/usr/bin/env node
// Produces a small, sequential Phase 5 replay plan.  It deliberately overlaps
// the most recent batch: completed immutable scans become no-ops, while a
// crash between snapshot and outcome is retried instead of silently skipped.
const TOKEN=process.env.CLOUDFLARE_API_TOKEN||'',ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||'8ea7796a8fb13ffb612245e8a08a55d6',DB=process.env.MARKET_EDGE_D1_DATABASE_ID||'39a4082e-41a4-45e9-9b76-99cf10eaca01',ENGINE=process.env.HISTORICAL_RANK_ENGINE_VERSION||'HISTORICAL-RANK-V1';
const BATCH_SIZE=4,BATCHES=5,OVERLAP=BATCH_SIZE;
if(!/^[A-Z0-9-]+$/.test(ENGINE))throw new Error('Invalid historical rank engine generation');
function plan({scans=0,resolved=0}={}){const start=Math.max(0,Number(scans)-OVERLAP),include=resolved>=1000?[]:Array.from({length:BATCHES},(_,index)=>({start_index:start+index*BATCH_SIZE,scan_count:BATCH_SIZE}));return {start,include,scans:Number(scans),resolved:Number(resolved),target:resolved>=1000?'COMPLETE':resolved>=500?'CONTINUE_TO_1000':'CONTINUE_TO_500'};}
async function d1(sql,params=[]){if(!TOKEN)throw new Error('CLOUDFLARE_API_TOKEN is required');const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:JSON.stringify({sql,params})}),body=await response.json().catch(()=>({}));if(!response.ok||body.success===false)throw new Error(`D1 query failed: ${body?.errors?.[0]?.message||response.status}`);return body.result?.[0]?.results||[];}
async function run(){const [row={}] = await d1(`SELECT COUNT(DISTINCT s.scan_id) AS scans,SUM(CASE WHEN c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' THEN 1 ELSE 0 END) AS resolved FROM historical_scan_snapshots s LEFT JOIN historical_scan_candidates c ON c.scan_id=s.scan_id WHERE s.engine_version=?`,[ENGINE]);const result=plan(row);if(process.env.GITHUB_OUTPUT)await import('node:fs').then(({appendFileSync})=>appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify({include:result.include})}\nphase5_target=${result.target}\n`));console.log(JSON.stringify(result));return result;}
export {plan};
if(import.meta.url===`file://${process.argv[1]}`)run().catch(error=>{console.error(`Phase 5 plan failed: ${error.message}`);process.exitCode=1;});
