import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  createSession,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import * as backend from '../src/main/codex/read-backend.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let endpoint: McpEndpoint;
let ctx: ToolContext;
let rpcId = 0;

async function rpc(
  method: string,
  params: object,
  requestId?: string,
  surface: 'core' | 'desktop' | 'steromi' = 'core'
): Promise<any> {
  const response = await fetch(endpoint.urls[surface], {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(requestId ? { 'x-request-id': `${requestId}/attempt` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

async function identity() {
  const conversationId = randomUUID();
  const requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Code mode integration' });
  expect(
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId: session.id,
      messageId: randomUUID(),
      tool: 'exec',
      observedAt: Date.now()
    })
  ).toBe('stored');
  return { conversationId, requestId, session };
}

const text = (response: any): string =>
  (response.result?.content ?? [])
    .filter((item: any) => item.type === 'text')
    .map((item: any) => item.text)
    .join('\n');

beforeAll(async () => {
  directory = await makeTempDir('clf-code-mode-mcp-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, readOnly: false, multiAgent: { ...config.multiAgent, enabled: false } });
  await fs.writeFile(path.join(directory, 'alpha.txt'), 'alpha PRIVATE_ALPHA');
  await fs.writeFile(path.join(directory, 'beta.txt'), 'beta PRIVATE_BETA');
  ctx = {
    roots: [{ name: 'workspace', path: directory }],
    caps: config.capabilities,
    readOnly: false,
    sessionTools: true,
    agentTools: false
  };
  endpoint = await startMcpServer(() => ctx);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await endpoint?.stop();
  await flushRecorder();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('publishes one standard Code Mode exec on Core, Desktop and Steromi', async () => {
  const originalCaps = ctx.caps;
  ctx.caps = { ...ctx.caps, screen: true, control: true };
  try {
    for (const surface of ['core', 'desktop', 'steromi'] as const) {
      const declarations = (await rpc('tools/list', {}, undefined, surface)).result.tools as Array<{
        name: string;
        inputSchema: any;
      }>;
      const exec = declarations.find((tool) => tool.name === 'exec');
      expect(exec?.inputSchema.required, surface).toEqual(['code']);
      expect(exec?.inputSchema.additionalProperties, surface).toBe(false);
    }
  } finally {
    ctx.caps = originalCaps;
  }
});

it('publishes exactly one exec on Steromi and never exposes recursive exec inside Code Mode', async () => {
  const originalCaps = ctx.caps;
  ctx.caps = { ...ctx.caps, screen: true, control: true };
  try {
    const declarations = (await rpc('tools/list', {}, undefined, 'steromi')).result.tools as Array<{ name: string }>;
    expect(declarations.filter((tool) => tool.name === 'exec')).toHaveLength(1);

    const who = await identity();
    const response = await rpc(
      'tools/call',
      { name: 'exec', arguments: { code: 'text(typeof tools.exec)' } },
      who.requestId,
      'steromi'
    );
    expect(text(response)).toBe('undefined');
  } finally {
    ctx.caps = originalCaps;
  }
});

it('publishes exec and runs parallel nested Core tools under the exact session principal', async () => {
  const declarations = (await rpc('tools/list', {})).result.tools as Array<{ name: string; inputSchema: any }>;
  const exec = declarations.find((tool) => tool.name === 'exec');
  expect(exec?.inputSchema.required).toEqual(['code']);
  expect(exec?.inputSchema.additionalProperties).toBe(false);
  expect(declarations.some((tool) => tool.name === 'read')).toBe(true);

  const who = await identity();
  const original = backend.readTextFile;
  const contexts: Array<ReturnType<typeof currentCall>> = [];
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>((done) => { release = done; });
  vi.spyOn(backend, 'readTextFile').mockImplementation(async (...args) => {
    contexts.push(currentCall());
    if (++entered === 2) release();
    await both;
    return original(...args);
  });

  const response = await rpc(
    'tools/call',
    {
      name: 'exec',
      arguments: {
        code: 'const r=await Promise.all(["alpha","beta"].map(n=>tools.read({paths:["/workspace/"+n+".txt"]}))); text(r.map(x=>({ok:!x.isError,found:x.content.some(c=>c.text?.includes("PRIVATE"))})));'
      }
    },
    who.requestId
  );
  expect(response.result?.isError, text(response)).not.toBe(true);
  expect(JSON.parse(text(response))).toEqual([{ ok: true, found: true }, { ok: true, found: true }]);
  expect(JSON.stringify(response)).not.toContain('PRIVATE_ALPHA');
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(contexts[0]!.evidence).not.toBe(contexts[1]!.evidence);
  for (const context of contexts) {
    expect(context!.caller).toMatchObject({
      requestId: who.requestId,
      conversationId: who.conversationId,
      sessionId: who.session.id
    });
  }
  await flushRecorder();
  const events = (await readEvents(who.session.id)).filter((event) => event.kind === 'tool_call');
  expect(events.map((event) => event.call.tool).sort()).toEqual(['exec', 'read', 'read']);
  expect(new Set(events.map((event) => event.call.callId)).size).toBe(3);
  expect(JSON.stringify(events.filter((event) => event.call.tool === 'read'))).toContain('PRIVATE_ALPHA');
  expect(JSON.stringify(events.filter((event) => event.call.tool === 'exec'))).not.toContain('PRIVATE_ALPHA');
});

it('refuses Code Mode without exact request/session proof', async () => {
  const response = await rpc('tools/call', {
    name: 'exec',
    arguments: { code: 'text("SHOULD_NOT_RUN")' }
  });
  expect(text(response)).toContain('CALLER_IDENTITY_REQUIRED');
  expect(text(response)).not.toContain('SHOULD_NOT_RUN');
});
