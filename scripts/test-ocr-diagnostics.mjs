import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
await require('esbuild').build({entryPoints:['packages/api/src/bulk-ocr-engine.ts'],bundle:true,platform:'node',format:'esm',outfile:'.wrangler/ocr-engine-check.mjs',logLevel:'silent'});
const {recognizeOcrBytes}=await import('../.wrangler/ocr-engine-check.mjs');
const settings={GOOGLE_VISION_API_KEY:'fixture',OPENAI_API_KEY:'fixture',BULK_OCR_MODEL:'fixture'};
for(const [reply,code] of [[{status:'incomplete'},'OPENAI_INCOMPLETE'],[{status:'completed',output:[]},'OPENAI_RESPONSE_INVALID']]) {
 let calls=0;
 await assert.rejects(recognizeOcrBytes(settings,new Uint8Array([1]),'image/png',async(_,options)=>{
 assert.equal(options.redirect,'manual');
 calls++;if(calls===1)return Response.json({responses:[{fullTextAnnotation:{text:'ATM'}}]});
 assert.equal(JSON.parse(options.body).max_output_tokens,8192);
 return Response.json(reply);
 }),error=>error.diagnosticCode===code && !JSON.stringify(error).includes('fixture'));
}
await assert.rejects(recognizeOcrBytes(settings,new Uint8Array([1]),'image/png',async()=>new Response('private-provider-error',{status:403})),e=>e.diagnosticCode==='GOOGLE_HTTP_403'&&!e.message.includes('private'));
console.log(JSON.stringify({incompleteOutputDiagnosed:true,increasedOutputBudget:true,invalidOutputDiagnosed:true,httpErrorsSanitized:true,realImageTested:false}));

let started=0,releaseFirst;
const first=new Promise(resolve=>releaseFirst=resolve);
const concurrent=recognizeOcrBytes(settings,new Uint8Array([1]),'image/png',async(url)=>{
 started++;
 if(url.includes('googleapis')) { await first; return Response.json({responses:[{fullTextAnnotation:{text:'ATM'}}]}); }
 releaseFirst();return Response.json({status:'incomplete'});
});
await assert.rejects(concurrent,e=>e.diagnosticCode==='OPENAI_INCOMPLETE');
assert.equal(started,2);
console.log(JSON.stringify({independentProvidersConcurrent:true}));
