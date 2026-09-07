// Read-only probes. Print selected metadata only, never credentials/raw bodies.
import {readFile} from 'node:fs/promises';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
const evaluator = JSON.parse(await readFile(new URL('./evaluator.wrangler.jsonc', import.meta.url), 'utf8'));
const binding = config.d1_databases.find(db => db.binding === 'MARKET_EDGE_DB');
const database = binding.database_id;
const diagnostic = process.argv.includes('--diagnose');
if (!account || !token) throw new Error('DEPLOY_CREDENTIALS_MISSING');
if (evaluator.d1_databases[0].database_id !== database) throw new Error('EVALUATOR_DATABASE_CONFIG_MISMATCH');
console.log(JSON.stringify({check:'WORKFLOW_INPUT',accountId:account,databaseId:database,databaseName:binding.database_name,secretPresent:Boolean(token),tokenHasSurroundingWhitespace:token !== token.trim()}));
async function probe(check,path,body) {
  try {
    const response=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    const payload=await response.json().catch(()=>({}));
    const output={check,httpStatus:response.status,success:response.ok && payload.success===true,errorCodes:(payload.errors||[]).map(error=>error.code)};
    console.log(JSON.stringify(output));
    return {...output,result:payload.result};
  } catch {
    console.log(JSON.stringify({check,success:false,error:'NETWORK_OR_TIMEOUT'}));
    return {success:false};
  }
}
const root=`/accounts/${account}`;
const userVerify=await probe('USER_TOKEN_VERIFY','/user/tokens/verify');
const accountVerify=await probe('ACCOUNT_TOKEN_VERIFY',`${root}/tokens/verify`);
const verified=userVerify.success?userVerify:accountVerify;
if(verified.success){
  console.log(JSON.stringify({check:'TOKEN_IDENTITY',tokenId:verified.result?.id,status:verified.result?.status,type:userVerify.success?'USER':'ACCOUNT'}));
  const metadata=await probe('TOKEN_METADATA',userVerify.success?`/user/tokens/${verified.result.id}`:`${root}/tokens/${verified.result.id}`);
  if(metadata.success)console.log(JSON.stringify({check:'TOKEN_POLICY',id:metadata.result?.id,name:metadata.result?.name,policies:(metadata.result?.policies||[]).map(policy=>({effect:policy.effect,resources:policy.resources,permissions:(policy.permission_groups||[]).map(permission=>permission.name)}))}));
}
const owner=await probe('ACCOUNT_READ',root);
if(owner.success)console.log(JSON.stringify({check:'ACCOUNT_IDENTITY',id:owner.result?.id,name:owner.result?.name}));
const list=await probe('D1_LIST',`${root}/d1/database?per_page=100`);
const matching=list.success&&Array.isArray(list.result)?list.result.filter(db=>db.name===binding.database_name||db.uuid===database):[];
console.log(JSON.stringify({check:'D1_MATCHES',databases:matching.map(db=>({id:db.uuid,name:db.name,ownerAccountId:account}))}));
const detail=await probe('D1_DATABASE_READ',`${root}/d1/database/${database}`);
if(detail.success)console.log(JSON.stringify({check:'DATABASE_IDENTITY',id:detail.result?.uuid,name:detail.result?.name,ownerAccountId:account}));
const query=await probe('D1_SCHEMA_ACCESS',`${root}/d1/database/${database}/query`,{sql:"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('d1_migrations','research_experiments','research_feature_observations') ORDER BY name"});
const tables=query.success?(query.result||[]).flatMap(result=>result.results||[]).map(row=>row.name):[];
console.log(JSON.stringify({tables}));
const gates={tokenAuthenticated:verified.success&&verified.result?.status==='active',accountMatch:owner.success&&owner.result?.id===account||detail.success,databaseMatch:detail.success&&detail.result?.uuid===database&&detail.result?.name===binding.database_name,d1Access:query.success};
console.log(JSON.stringify({check:'DEPLOYMENT_GATES',...gates}));
if(!diagnostic&&!Object.values(gates).every(Boolean))throw new Error('D1_PREFLIGHT_FAILED: see authentication/account/database/access probes');
if(process.argv.includes('--verify-schema')&&!['research_experiments','research_feature_observations'].every(name=>tables.includes(name)))throw new Error('D1_SCHEMA_INCOMPLETE');
