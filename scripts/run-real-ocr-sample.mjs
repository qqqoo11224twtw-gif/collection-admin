import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const script of ['test-ocr-diagnostics.mjs','test-real-ocr-sample.mjs']) {
 const result=spawnSync(process.execPath,[resolve(root,'scripts',script)],{cwd:root,stdio:'inherit',windowsHide:true});
 if(result.status!==0){process.exitCode=result.status??1;break;}
}
