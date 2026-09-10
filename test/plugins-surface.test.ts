import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initConfigPath, loadConfig, getConfig, updateConfig, effectiveCapabilities } from '../src/main/config.js';
import { initSessionStore } from '../src/main/session/store.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const plugin = vi.hoisted(() => ({
  enabled: true,
  declaration: {
    name: 'inspect_scene', description: 'Read a scene',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  call: vi.fn(async () => ({ content: [{ type: 'text', text: 'scene' }], structuredContent: { count: 1 } }))
}));

vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: {
  tools: () => plugin.enabled ? [plugin.declaration] : [],
  call: async (...args: unknown[]) => plugin.enabled ? plugin.call(...args as []) : { isError: true, content: [{ type: 'text', text: 'PLUGIN_DISABLED' }] },
  redact: (value: unknown) => value,
  redactResult: (value: unknown) => value
} }));

let directory = '';
let endpoint: McpEndpoint;
let sequence = 0;
async function rpc(surface: 'plugins' | 'core' | 'desktop' | 'steromi', method: string, params = {}): Promise<any> {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

beforeAll(async () => {
  directory = await makeTempDir('clf-plugins-surface-');
  initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
  await updateConfig(config => ({ ...config, multiAgent: { ...config.multiAgent, enabled: false } }));
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
});
beforeEach(async () => { plugin.enabled = true; plugin.call.mockClear(); await updateConfig(config => ({ ...config, readOnly: false })); });
afterAll(async () => { await endpoint?.stop(); await flushRecorder(); resetDurableForTests(); await removeTempDir(directory); });

it('publishes plugin schemas only on the dedicated fourth surface', async () => {
  expect(new Set(Object.values(endpoint.urls)).size).toBe(4);
  expect((await rpc('plugins', 'tools/list')).result.tools).toEqual([plugin.declaration]);
  for (const surface of ['core', 'desktop', 'steromi'] as const) {
    expect((await rpc(surface, 'tools/list')).result.tools.some((tool: { name: string }) => tool.name === plugin.declaration.name)).toBe(false);
  }
});

it('refuses stale/disabled plugin calls and never leaks device_id into undeclared schemas', async () => {
  plugin.enabled = false;
  expect((await rpc('plugins', 'tools/list')).result.tools).toEqual([]);
  expect((await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { device_id: 'dev_0123456789abcdef0123456789abcdef' } })).result.isError).toBe(true);
  expect(plugin.call).not.toHaveBeenCalled();
});

it('fails closed for external plugins while global read-only mode is enabled', async () => {
  await updateConfig(config => ({ ...config, readOnly: true }));
  const result = await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { name: 'scene' } });
  expect(result.result.isError).toBe(true);
  expect(plugin.call).not.toHaveBeenCalled();
});
