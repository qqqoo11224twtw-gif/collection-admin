import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const vars=parseEnv(readFileSync(resolve(root,'apps/server/.dev.vars'),'utf8'));
const config=JSON.parse(readFileSync(resolve(root,'.secrets/ocr-real-sample.json'),'utf8'));
const samples=config.samples??[config];
const {recognizeOcrBytes}=await import('../.wrangler/ocr-engine-check.mjs');
const reports=[];
for(const [index,sample] of samples.entries()) {
 const start=performance.now();
 try {
  const result=await recognizeOcrBytes(vars,new Uint8Array(readFileSync(sample.imagePath)),'image/png');
  const checks=Object.fromEntries(Object.entries(sample.expected).map(([key,value])=>[key,result.fields[key].value===value]));
  reports.push({sample:index+1,seconds:Math.round((performance.now()-start)/100)/10,checks,allCorrect:Object.values(checks).every(Boolean)});
 } catch(error) {
  reports.push({sample:index+1,allCorrect:false,code:error.diagnosticCode??'SAMPLE_TEST_FAILED'});
 }
}
const report={sampleCount:reports.length,allCorrect:reports.every(r=>r.allCorrect),requiresManualReview:true,reports};
writeFileSync(resolve(root,'.secrets/ocr-real-sample-result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(!report.allCorrect)process.exitCode=1;
