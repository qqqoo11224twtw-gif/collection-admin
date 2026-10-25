import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync('deploy/telegram-ocr/review.js','utf8').split('export function initializeOcr')[0].replace('export function','function')+';placeOcrRow';
const place=runInNewContext(source);
class Row {
 constructor(id){this.id=id;this.parentElement=null}
 querySelector(){return null}
 get nextElementSibling(){const list=this.parentElement?.children??[];return list[list.indexOf(this)+1]??null}
 replaceWith(row){const parent=this.parentElement,index=parent.children.indexOf(this);if(row.parentElement){const list=row.parentElement.children;list.splice(list.indexOf(row),1)}parent.children[index]=row;row.parentElement=parent;this.parentElement=null;parent.writes++}
}
const container={children:[],writes:0,insertBefore(row,cursor){if(cursor && cursor.parentElement!==this)throw Error('detached cursor');if(row.parentElement){const list=row.parentElement.children;list.splice(list.indexOf(row),1)}this.children.splice(cursor?this.children.indexOf(cursor):this.children.length,0,row);row.parentElement=this;this.writes++}};
const a=new Row('a'),b=new Row('b');container.insertBefore(a,null);container.insertBefore(b,null);container.writes=0;
assert.equal(place(container,a,a,a),b);assert.equal(container.writes,0);
const replacement=new Row('a-new');assert.equal(place(container,replacement,a,a),b);assert.deepEqual(container.children,[replacement,b]);
const c=new Row('c');assert.equal(place(container,c,null,b),b);assert.deepEqual(container.children,[replacement,c,b]);
place(container,b,b,replacement);assert.deepEqual(container.children,[b,replacement,c]);
console.log(JSON.stringify({unchangedRowsKeepSameNodes:true,noUnchangedDomWrites:true,changedCurrentRowReplacedSafely:true,newRowsAndReorderingHandled:true}));
