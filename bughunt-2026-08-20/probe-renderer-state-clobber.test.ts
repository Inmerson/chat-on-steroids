import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, expect, it, vi } from 'vitest';

let dom: JSDOM | null = null;
afterAll(()=>dom?.window.close());

it('probe: an unsolicited state push clobbers text currently being edited', async()=>{
  const html=await fs.readFile(path.join(process.cwd(),'src','renderer','index.html'),'utf8');
  dom=new JSDOM(html,{url:'https://local.test/',pretendToBeVisual:true});
  const w=dom.window;
  Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,DocumentFragment:w.DocumentFragment,HTMLInputElement:w.HTMLInputElement,HTMLSelectElement:w.HTMLSelectElement,HTMLButtonElement:w.HTMLButtonElement});
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView=()=>{};

  let stateListener:(state:any)=>void=()=>{};
  const config={
    roots:[{name:'repo',path:'C:\\repo'}], readOnly:true,
    capabilities:{browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
    tunnel:{kind:'openai',tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',desktopTunnelId:'',binaryPath:''},
    ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'light'},
    sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
    compaction:{auto:true,autoTokens:300000}, multiAgent:{enabled:false,maxWorkers:2}
  };
  const state={config,status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},hasApiKey:false,resolvedBinary:null,bundledTunnelVersion:null,bridge:{running:true,port:8765,paired:false,lastSeenAt:null}};
  const ok=(data:any)=>Promise.resolve({ok:true,data});
  const api:any=new Proxy({
    getState:()=>ok(state), getLog:()=>ok([]), getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
    onStateChanged:(fn:any)=>{stateListener=fn;return()=>{}}, onLogEntry:()=>()=>{}, onSwarmChanged:()=>()=>{}, onSessionChanged:()=>()=>{},
    listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),
  },{get(target,prop){ if(prop in target)return (target as any)[prop]; return (..._args:any[])=>ok(null); }});
  Object.defineProperty(w,'api',{value:api,configurable:true});
  vi.resetModules();
  await import('../src/renderer/main.js');
  await new Promise(r=>setTimeout(r,0));

  const field=w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(config.tunnel.tunnelId);
  field.focus();
  field.value='tunnel_USER_IS_STILL_TYPING';
  stateListener(structuredClone(state));
  console.log(JSON.stringify({focused:w.document.activeElement===field,before:'tunnel_USER_IS_STILL_TYPING',after:field.value}));
  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe(config.tunnel.tunnelId);
});
