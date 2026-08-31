import assert from 'node:assert/strict';
import {activeMlModel,resolvedMlRows,stableHash,validShadowSelection} from './worker.mjs';

const resolved={signal_id:'resolved-1',timestamp:100,targets_json:JSON.stringify({status:'RESOLVED',TP1_BEFORE_SL:true,FINAL_R:1.2})};
const pending={signal_id:'pending-1',timestamp:101,targets_json:JSON.stringify({status:'PENDING_OUTCOME'})};
assert.deepEqual(resolvedMlRows([pending,resolved]).map(row=>row.signal_id),['resolved-1']);
assert.equal(stableHash({b:2,a:[1,2]}),stableHash({a:[1,2],b:2}));

const artifact={target:'TP1_BEFORE_SL',model:{featureNames:['quality'],coefficients:[0],means:[0],stds:[1]}};
const db={prepare(sql){return{all:async()=>({results:sql.includes("'CHALLENGER'")?[]:[{id:'incumbent',status:'RESEARCH',algorithm:'regularized-logistic',dataset_hash:'old',metadata_json:JSON.stringify(artifact),created_at:1}]})};}};
const active=await activeMlModel(db);
assert.equal(active.id,'incumbent');
assert.equal(active.status,'RESEARCH');
assert.equal(validShadowSelection({asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',regime:'UPTREND',entry:100,stop:95,target1:110,target2:120,quantScore:70,combinedScore:71,featureHash:'frozen'}).featureHash,'frozen');
assert.equal(validShadowSelection({asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',entry:100,stop:105,target1:110,target2:120,quantScore:70,combinedScore:71,featureHash:'frozen'}),null);
console.log('Worker autonomous ML safety tests passed');
