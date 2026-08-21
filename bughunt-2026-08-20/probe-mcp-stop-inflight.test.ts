import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { startMcpServer } from '../src/main/mcp/server.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { initDurableStore } from '../src/main/durable.js';

let dir=''; let stop: null|(()=>Promise<void>)=null;
afterAll(async()=>{ if(stop) await stop().catch(()=>{}); resetSessionStoreForTests(); if(dir) await fs.rm(dir,{recursive:true,force:true}); });
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

it('probe: stopping endpoint drops response but does not cancel in-flight side effects', async()=>{
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'clf-mcp-stop-'));
 initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
 const cfg=defaultConfig(); await saveConfig({...cfg,roots:[{name:'probe',path:dir}],readOnly:false,capabilities:{...cfg.capabilities,command:true}});
 const endpoint=await startMcpServer(()=>({roots:[{name:'probe',path:dir}],caps:{...cfg.capabilities,command:true},readOnly:false,sessionTools:false,agentTools:false}));
 stop=endpoint.stop;
 const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'exec_command',arguments:{cmd:"Set-Content -LiteralPath started.txt -Value started; Start-Sleep -Seconds 2; Set-Content -LiteralPath after-stop.txt -Value after",workdir:dir,yield_time_ms:5000}}};
 const request=fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify(body)}).then(async r=>({ok:true,status:r.status,text:await r.text()})).catch(e=>({ok:false,error:String(e)}));
 for(let i=0;i<100;i++){ try{await fs.access(path.join(dir,'started.txt'));break}catch{} await sleep(20); }
 expect(await fs.readFile(path.join(dir,'started.txt'),'utf8')).toContain('started');
 const stopStarted=performance.now(); await endpoint.stop(); stop=null; const stopMs=performance.now()-stopStarted;
 const result=await request;
 await sleep(2400);
 const after=await fs.readFile(path.join(dir,'after-stop.txt'),'utf8').catch(()=>null);
 console.log(JSON.stringify({stopMs:Math.round(stopMs),client:result,afterStopFile:after?.trim()??null}));
 expect(result.ok).toBe(false);
 expect(after).toContain('after');
});
