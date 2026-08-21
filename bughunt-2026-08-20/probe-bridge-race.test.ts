import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('electron',()=>({
  safeStorage:{ isEncryptionAvailable:()=>true, encryptString:(v:string)=>Buffer.from(v), decryptString:(b:Buffer)=>b.toString('utf8') },
  clipboard:{}, shell:{}
}));
const { initConfigPath, defaultConfig, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { initDurableStore } = await import('../src/main/durable.js');
const { startBridge, stopBridge } = await import('../src/main/bridge.js');
let dir='';

async function reachable(port:number):Promise<boolean>{
 return await new Promise(resolve=>{
   const req=http.request({host:'127.0.0.1',port,path:'/',method:'GET'},res=>{res.resume();res.on('end',()=>resolve(true));});
   req.setTimeout(1000,()=>{req.destroy();resolve(false)}); req.on('error',()=>resolve(false)); req.end();
 });
}

afterAll(async()=>{ await stopBridge().catch(()=>{}); resetSessionStoreForTests(); if(dir) await fs.rm(dir,{recursive:true,force:true}); });

it('probe concurrent startBridge loses one live listener', async()=>{
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'clf-bridge-race-'));
 initConfigPath(dir); initSecretsPath(dir); initSessionStore(dir); initDurableStore(dir);
 const c=defaultConfig(); await saveConfig({...c,sessions:{...c.sessions,record:true}});
 const [a,b]=await Promise.all([startBridge(),startBridge()]);
 console.log(JSON.stringify({a,b}));
 expect(a).not.toBeNull(); expect(b).not.toBeNull(); expect(a).not.toBe(b);
 expect(await reachable(a!)).toBe(true); expect(await reachable(b!)).toBe(true);
 await stopBridge();
 const afterA=await reachable(a!); const afterB=await reachable(b!);
 console.log(JSON.stringify({afterStop:{[String(a)]:afterA,[String(b)]:afterB}}));
 expect([afterA,afterB].filter(Boolean)).toHaveLength(1);
});
