import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { initSessionStore, readRecentEvents } from '../src/main/session/store.js';

let root='';
beforeAll(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'clf-tail-probe-'));
  initSessionStore(root);
  const id='2026-08-20-deadbeef';
  const dir=path.join(root,'sessions',id);
  await fs.mkdir(dir,{recursive:true});
  const stream=(await import('node:fs')).createWriteStream(path.join(dir,'events.jsonl'));
  for(let i=1;i<=250_000;i++){
    stream.write(JSON.stringify({seq:i,time:i,source:'app',kind:'progress',message:{text:'x'.repeat(48),truncated:false,chars:48}})+'\n');
  }
  await new Promise<void>((resolve,reject)=>{stream.end(resolve);stream.on('error',reject)});
  await fs.writeFile(path.join(dir,'messages.json'),'{}');
});
afterAll(async()=>{ if(root) await fs.rm(root,{recursive:true,force:true}); });

it('probe: a 1-row recent read stays bounded', async()=>{
  const id='2026-08-20-deadbeef';
  const file=path.join(root,'sessions',id,'events.jsonl');
  const bytes=(await fs.stat(file)).size;
  const before=process.memoryUsage().heapUsed;
  const started=performance.now();
  const rows=await readRecentEvents(id,1);
  const elapsed=performance.now()-started;
  const heapDelta=process.memoryUsage().heapUsed-before;
  console.log(JSON.stringify({bytes,returned:rows.length,elapsedMs:Math.round(elapsed),heapDeltaMiB:+(heapDelta/1048576).toFixed(1)}));
  expect(rows).toHaveLength(1);
});
