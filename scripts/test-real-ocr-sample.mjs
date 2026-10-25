import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const vars=parseEnv(readFileSync(resolve(root,'apps/server/.dev.vars'),'utf8'));
const sample=JSON.parse(readFileSync(resolve(root,'.secrets/ocr-real-sample.json'),'utf8'));
const {recognizeOcrBytes}=await import('../.wrangler/ocr-engine-check.mjs');
const start=performance.now();
try {
 const result=await recognizeOcrBytes(vars,new Uint8Array(readFileSync(sample.imagePath)),'image/png');
 const checks=Object.fromEntries(Object.entries(sample.expected).map(([key,value])=>[key,result.fields[key].value===value]));
 const report={seconds:Math.round((performance.now()-start)/100)/10,checks,allCorrect:Object.values(checks).every(Boolean),requiresManualReview:true,sampleCount:1};
 writeFileSync(resolve(root,'.secrets/ocr-real-sample-result.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 if(!report.allCorrect)process.exitCode=1;
} catch(error) {
 console.error(JSON.stringify({realSamplePassed:false,code:error.diagnosticCode??'SAMPLE_TEST_FAILED',credentialsPrinted:false}));process.exitCode=1;
}
