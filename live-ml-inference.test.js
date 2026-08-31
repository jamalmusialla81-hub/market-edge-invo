const assert=require('node:assert/strict');
const ML=require('./ml-engine.js');

// Snapshot of the active TP1-LR-GEN1 artifact schema. Its score is deliberately
// tested only as a raw finite model output; the model remains uncalibrated research.
const model={kind:'regularized-logistic',target:'tp1BeforeSl',featureNames:['breakout','h4RelativeVolume','h4Roc5','h4Rsi','liquiditySweep','long','m15RelativeVolume','m15Rsi','quality','rr'],means:[.1956521739130435,1.4992198057342363,1.878635312931539,.6015049654777247,.06521739130434782,.717391304347826,1.3510351092319963,.5372404284372115,.836521739130435,1.7999999999999985],stds:[.396701904149884,.8145793155925722,3.2024639673232684,.2095267113826971,.24690905851305545,.4502677212436515,1.0658537486246098,.13999172924181627,.10179299948818442,1.5543122344752192e-15],coefficients:[.2053323099246981,-1.593506126045291,.3437122048259029,.1537068760668496,-.4932223643399385,-.11503140497756523,-1.081088664859708,-.12797429531264684,.16245215939214971,-.7338831771644178],intercept:-1.1944196775537232,version:'1.0.0'};
const preEntryFeatures={breakout:1,h4RelativeVolume:1.42,h4Roc5:.03,h4Rsi:.58,liquiditySweep:0,long:0,m15RelativeVolume:1.11,m15Rsi:.49,quality:.82,rr:1.8};
const raw=ML.predictProbability(model,preEntryFeatures)*100;
assert.ok(Number.isFinite(raw)&&raw>=0&&raw<=100);
assert.throws(()=>ML.predictProbability(model,{...preEntryFeatures,futureClose:1}),/LEAKAGE_REJECTED/);
assert.throws(()=>ML.predictProbability(model,{...preEntryFeatures,rr:undefined}),/not finite/);
console.log('Live experimental ML inference schema tests passed');
