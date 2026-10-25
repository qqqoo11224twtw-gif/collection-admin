import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {zipSync} from '../apps/server/node_modules/fflate/esm/index.mjs';
import {parseEnv} from 'node:util';
const root=resolve(import.meta.dirname,'..'), base=resolve(root,'../production-backup/2026-10-25T07-26-10-034Z');
const vars=parseEnv(readFileSync(resolve(root,'apps/server/.dev.vars'),'utf8'));
const secrets=Object.entries(vars).filter(([name,value])=>/KEY|TOKEN|SECRET/.test(name)&&value).map(([,value])=>value);
const data={};let count=0;
function add(dir,prefix){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name),name=`${prefix}/${entry.name}`;if(entry.isDirectory())add(path,name);else{const bytes=readFileSync(path);const text=bytes.toString('utf8');if(secrets.some(s=>text.includes(s))||/AIza[0-9A-Za-z_-]{30,}|sk-proj-[0-9A-Za-z_-]{30,}|\b\d{8,16}:[A-Za-z0-9_-]{30,}\b/.test(text))throw Error('SECRET_SCAN_REJECTED');data[name]=bytes;count++;}}}
for(const worker of ['collection-admin-production-api','collection-admin-production-web'])add(resolve(base,worker),worker);
data['recovery-summary.json']=readFileSync(resolve(base,'recovery-summary.json'));
const zipped=zipSync(data,{level:9});
const out=resolve(root,'../../work');mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,'production-modules.zip'),zipped);
writeFileSync(resolve(out,'production-modules.base64'),Buffer.from(zipped).toString('base64'));
console.log(JSON.stringify({modules:count,zipBytes:zipped.length,base64Bytes:Buffer.from(zipped).toString('base64').length,secretScanPassed:true}));

