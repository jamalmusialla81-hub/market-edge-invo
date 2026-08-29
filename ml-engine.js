(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.MarketEdgeML=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='1.0.0';
  const FORBIDDEN_FEATURE=/^(?:target|label|outcome|result|finalr|final_r|mfe|mae|tp1_before_sl|future|exit|profit|pnl|realized)/i;
  const TARGETS=['tp1BeforeSl','finalR','mfeR','maeR','breakoutFailure','regimeFit'];
  function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
  function mean(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;}
  function std(values){const average=mean(values);return Math.sqrt(mean(values.map(value=>(value-average)**2)))||1;}
  function sigmoid(value){return value>=0?1/(1+Math.exp(-value)):Math.exp(value)/(1+Math.exp(value));}
  function hash(value){const text=JSON.stringify(value);let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(16).padStart(8,'0');}
  function validFeatures(features){
    if(!features||typeof features!=='object'||Array.isArray(features))throw new Error('Features must be an object');
    const entries=Object.entries(features);if(!entries.length)throw new Error('At least one feature is required');
    for(const [key,value] of entries){if(FORBIDDEN_FEATURE.test(key))throw new Error(`LEAKAGE_REJECTED: ${key} cannot be a feature`);if(!Number.isFinite(finite(value)))throw new Error(`Feature ${key} is not finite`);}return Object.fromEntries(entries.map(([key,value])=>[key,finite(value)]));
  }
  function makeSample(input){
    const time=finite(input?.time);if(!Number.isFinite(time))throw new Error('Sample time is required');
    const features=validFeatures(input.features),targets={};for(const target of TARGETS)if(input.targets?.[target]!==undefined){const value=finite(input.targets[target]);if(!Number.isFinite(value))throw new Error(`Target ${target} is not finite`);targets[target]=value;}
    if(!Object.keys(targets).length)throw new Error('At least one post-entry target is required');
    return {id:input.id||`sample-${hash([time,features])}`,time,asset:String(input.asset||'UNKNOWN'),strategy:String(input.strategy||'UNKNOWN'),direction:String(input.direction||'unknown'),regime:String(input.regime||'UNKNOWN'),features,targets};
  }
  function chronologicalSplit(samples,{trainRatio=.6,validationRatio=.2,datasetHash}={}){
    const sorted=[...samples].sort((a,b)=>a.time-b.time),trainEnd=Math.floor(sorted.length*trainRatio),validationEnd=Math.floor(sorted.length*(trainRatio+validationRatio));if(trainEnd<1||validationEnd<=trainEnd||validationEnd>=sorted.length)throw new Error('Insufficient chronological samples');
    const generationId=hash({datasetHash:datasetHash||hash(sorted.map(item=>item.id)),trainEnd,validationEnd,version:VERSION});return{generationId,train:sorted.slice(0,trainEnd),validation:sorted.slice(trainEnd,validationEnd),test:{id:`ml-test-${generationId}`,consumed:false,rows:sorted.slice(validationEnd)}};
  }
  function consumeUntouched(split,registry={},now=new Date().toISOString()){
    if(!split?.test?.id)throw new Error('Untouched ML test is missing');if(split.test.consumed||registry[split.test.id])throw new Error('Untouched ML test has already been consumed');return{split:{...split,test:{...split.test,consumed:true,consumedAt:now}},registry:{...registry,[split.test.id]:now}};
  }
  function matrix(rows,featureNames){return rows.map(row=>featureNames.map(name=>row.features[name]));}
  function normalizer(rows,featureNames){const raw=matrix(rows,featureNames);return{means:featureNames.map((_,index)=>mean(raw.map(row=>row[index]))),stds:featureNames.map((_,index)=>std(raw.map(row=>row[index])))}};
  function normalized(features,model){return model.featureNames.map((name,index)=>(features[name]-model.means[index])/model.stds[index]);}
  function trainLogistic(rows,target,{iterations=800,learningRate=.08,l2=.01}={}){
    if(rows.length<10)throw new Error('At least 10 training samples are required');const featureNames=Object.keys(rows[0].features).sort();if(rows.some(row=>!Object.prototype.hasOwnProperty.call(row.targets,target)))throw new Error(`Target ${target} missing from training sample`);const scale=normalizer(rows,featureNames),model={kind:'regularized-logistic',target,featureNames,means:scale.means,stds:scale.stds,coefficients:new Array(featureNames.length).fill(0),intercept:0,iterations,l2,version:VERSION};
    for(let step=0;step<iterations;step++){let interceptGradient=0;const gradients=new Array(featureNames.length).fill(0);for(const row of rows){const x=normalized(row.features,model),prediction=sigmoid(model.intercept+x.reduce((sum,value,index)=>sum+value*model.coefficients[index],0)),error=prediction-(row.targets[target]>=.5?1:0);interceptGradient+=error;x.forEach((value,index)=>gradients[index]+=error*value);}model.intercept-=learningRate*interceptGradient/rows.length;model.coefficients.forEach((value,index)=>model.coefficients[index]-=learningRate*(gradients[index]/rows.length+l2*value));}
    return model;
  }
  function predictProbability(model,features){const x=normalized(validFeatures(features),model);return sigmoid(model.intercept+x.reduce((sum,value,index)=>sum+value*model.coefficients[index],0));}
  function trainRidge(rows,target,{iterations=800,learningRate=.05,l2=.1}={}){
    if(rows.length<10)throw new Error('At least 10 training samples are required');const featureNames=Object.keys(rows[0].features).sort();if(rows.some(row=>!Object.prototype.hasOwnProperty.call(row.targets,target)))throw new Error(`Target ${target} missing from training sample`);const scale=normalizer(rows,featureNames),model={kind:'ridge-regression',target,featureNames,means:scale.means,stds:scale.stds,coefficients:new Array(featureNames.length).fill(0),intercept:mean(rows.map(row=>row.targets[target])),iterations,l2,version:VERSION};
    for(let step=0;step<iterations;step++){let interceptGradient=0;const gradients=new Array(featureNames.length).fill(0);for(const row of rows){const x=normalized(row.features,model),prediction=model.intercept+x.reduce((sum,value,index)=>sum+value*model.coefficients[index],0),error=prediction-row.targets[target];interceptGradient+=error;x.forEach((value,index)=>gradients[index]+=error*value);}model.intercept-=learningRate*interceptGradient/rows.length;model.coefficients.forEach((value,index)=>model.coefficients[index]-=learningRate*(gradients[index]/rows.length+l2*value));}
    return model;
  }
  function predictR(model,features){const x=normalized(validFeatures(features),model);return model.intercept+x.reduce((sum,value,index)=>sum+value*model.coefficients[index],0);}
  function brier(predictions,actual){return mean(predictions.map((prediction,index)=>(prediction-actual[index])**2));}
  function expectedCalibrationError(predictions,actual,bins=10){let error=0;for(let bin=0;bin<bins;bin++){const low=bin/bins,high=(bin+1)/bins,indices=predictions.map((value,index)=>value>=low&&(bin===bins-1?value<=high:value<high)?index:null).filter(index=>index!==null);if(!indices.length)continue;error+=indices.length/predictions.length*Math.abs(mean(indices.map(index=>predictions[index]))-mean(indices.map(index=>actual[index])));}return error;}
  function calibratePlatt(rawScores,actual){if(rawScores.length<20||rawScores.length!==actual.length)throw new Error('At least 20 matching validation predictions are required for calibration');const rows=rawScores.map((score,index)=>makeSample({time:index+1,features:{rawScore:score},targets:{tp1BeforeSl:actual[index]}}));const model=trainLogistic(rows,'tp1BeforeSl',{iterations:500,learningRate:.08,l2:.01});return{kind:'platt',model,brier:brier(rawScores,actual),calibratedBrier:brier(rawScores.map(score=>predictProbability(model,{rawScore:score})),actual)};}
  function featureImportance(model){return model.featureNames.map((feature,index)=>({feature,weight:model.coefficients[index],importance:Math.abs(model.coefficients[index])})).sort((a,b)=>b.importance-a.importance);}
  function challengerDecision({candidate,baseline,untouchedMetrics,minimumSamples=100}){if(!candidate||!baseline||!untouchedMetrics)return{status:'REJECTED',reason:'Incomplete model comparison'};if(untouchedMetrics.samples<minimumSamples)return{status:'RESEARCH',reason:`Only ${untouchedMetrics.samples}/${minimumSamples} untouched samples`};if(untouchedMetrics.brier>=baseline.brier||untouchedMetrics.expectedR<=baseline.expectedR)return{status:'REJECTED',reason:'No meaningful unseen improvement over baseline'};return{status:'SHADOW',reason:'Improved untouched metrics; shadow evidence is required before any influence',manualPromotionRequired:true};}
  return{VERSION,TARGETS,FORBIDDEN_FEATURE,makeSample,chronologicalSplit,consumeUntouched,trainLogistic,predictProbability,trainRidge,predictR,brier,expectedCalibrationError,calibratePlatt,featureImportance,challengerDecision};
});
