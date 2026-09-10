import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let endpoint: McpEndpoint;

function resultBody(raw: string): any {
  if (!raw.startsWith('event:') && !raw.startsWith('data:')) return JSON.parse(raw);
  const line = raw.split('\n').find((part) => part.startsWith('data:'));
  return JSON.parse(line!.slice(5));
}

async function call(requestId: string) {
  const response = await fetch(endpoint.urls.core, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': `${requestId}/att1` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'read', arguments: { paths: ['/workspace/example.txt'] } } })
  });
  return resultBody(await response.text());
}

beforeEach(async () => {
  directory = await makeTempDir('cos-input-kernel-22-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  const config = defaultConfig(); await saveConfig(config);
  await fs.writeFile(path.join(directory, 'example.txt'), 'base result');
  resetInputForTests(); resetCorrelationRegistryForTests();
  endpoint = await startMcpServer(() => ({ roots: [{ name: 'workspace', path: directory }], caps: config.capabilities, readOnly: true, sessionTools: false, agentTools: false }));
});
afterEach(async () => {
  await endpoint.stop(); resetInputForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('injects queued input only into the exact correlated MCP result and acknowledges it on the next exact call', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Kernel input', conversationId });
  const queued = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Also verify the checksum', attachments: [], images: [] });
  const firstRequest = 'wfr_input_22_first';
  expect(observeRequestCorrelation({ requestId: firstRequest, conversationId, sessionId: session.id, messageId: 'm-1', tool: 'read', observedAt: Date.now() })).toBe('stored');
  const first = await call(firstRequest);
  expect(first.result.isError).not.toBe(true);
  expect(first.result.content.some((item: any) => item.type === 'text' && item.text.includes(queued.text))).toBe(true);
  expect((await listInputs()).find((row) => row.id === queued.id)).toMatchObject({ state: 'tool', owner: firstRequest });

  const secondRequest = 'wfr_input_22_second';
  expect(observeRequestCorrelation({ requestId: secondRequest, conversationId, sessionId: session.id, messageId: 'm-2', tool: 'read', observedAt: Date.now() + 1 })).toBe('stored');
  const second = await call(secondRequest);
  expect(second.result.content.some((item: any) => item.type === 'text' && item.text.includes(queued.text))).toBe(false);
  expect((await listInputs()).find((row) => row.id === queued.id)).toMatchObject({ state: 'sent', messageId: `input:${queued.id}` });
});

it('does not inject the input into a different correlated conversation', async () => {
  const targetConversation = randomUUID();
  const otherConversation = randomUUID();
  const target = await createSession({ title: 'Target', conversationId: targetConversation });
  const other = await createSession({ title: 'Other', conversationId: otherConversation });
  const queued = await enqueueInput({ id: randomUUID(), sessionId: target.id, text: 'Target only', attachments: [], images: [] });
  const requestId = 'wfr_input_22_other';
  observeRequestCorrelation({ requestId, conversationId: otherConversation, sessionId: other.id, messageId: 'm-o', tool: 'read', observedAt: Date.now() });
  const reply = await call(requestId);
  expect(reply.result.content.some((item: any) => item.type === 'text' && item.text.includes(queued.text))).toBe(false);
  expect((await listInputs()).find((row) => row.id === queued.id)?.state).toBe('queued');
});
