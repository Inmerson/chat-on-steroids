import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('drains an accepted MCP mutation before closing its response socket', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-drain-'));
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  await saveConfig({
    ...cfg,
    roots: [{ name: 'probe', path: dir }],
    readOnly: false,
    capabilities: { ...cfg.capabilities, command: true }
  });
  await fs.writeFile(
    path.join(dir, 'slow.cjs'),
    "const fs=require('node:fs'); fs.writeFileSync('started.txt','started'); setTimeout(()=>fs.writeFileSync('after-stop.txt','after'),500); setTimeout(()=>{},600);\n",
    'utf8'
  );

  endpoint = await startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: { ...cfg.capabilities, command: true },
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'exec_command', arguments: { cmd: 'node slow.cjs', workdir: dir, yield_time_ms: 5_000 } }
  };
  const request = fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  }).then(async (response) => ({ ok: true, status: response.status, text: await response.text() }));

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.access(path.join(dir, 'started.txt'));
      break;
    } catch {
      await sleep(20);
    }
  }
  await expect(fs.readFile(path.join(dir, 'started.txt'), 'utf8')).resolves.toContain('started');

  const stopping = endpoint.stop();
  endpoint = null;
  const result = await request;
  await stopping;

  expect(result.ok).toBe(true);
  expect(result.status).toBe(200);
  expect(result.text).toContain('Process exited with code 0');
  await expect(fs.readFile(path.join(dir, 'after-stop.txt'), 'utf8')).resolves.toContain('after');
});
