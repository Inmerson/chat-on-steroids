/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectiveCapabilities, defaultConfig } from '../src/main/config.js';
import { lastRequestAt, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

// ---------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(urlStr: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

let nextId = 1;

/** A 2025-era request: a plain JSON-RPC body with no _meta envelope. */
async function legacy(method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.url,
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const PROTOCOL_2026 = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard
 * headers the spec requires the client to mirror the body with.
 */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(endpoint.url, JSON.stringify(body), headers);
  return { status: res.status, body: decode(res) };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await writeTree(approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(outside, { 'passwords.txt': 'hunter2' });
  await fs.writeFile(
    path.join(approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  ctx = {
    roots: [{ name: 'workspace', path: approved }] as Root[],
    caps: withCaps({}),
    readOnly: true
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('binds to loopback only', () => {
    expect(endpoint.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.url);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/wrong-token']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.url);
    const token = url.pathname.slice('/mcp/'.length);
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header', async () => {
    const res = await rawPost(endpoint.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      host: 'files.example.com'
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects a cross-site Origin header', async () => {
    const res = await rawPost(endpoint.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      origin: 'https://evil.example.com'
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.url);
    for (const p of ['/', '/mcp', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('separates "ChatGPT arrived" from "ChatGPT was allowed to run a tool"', async () => {
    // The whole point of keeping two clocks: a connect that handshakes and lists
    // tools but never calls one is what Developer mode being off looks like here,
    // and it is indistinguishable from success on every other signal.
    expect(lastRequestAt()).toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await legacy('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await legacy('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await legacy('tools/call', { name: 'list_roots', arguments: {} });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    // A disabled tool still proves ChatGPT is allowed to reach the tool layer, which
    // is the only thing this clock is asked about.
    await legacy('tools/list');
    ctx.caps = withCaps({ read: false });
    const res = await legacy('tools/call', { name: 'read_file', arguments: { path: '/workspace/notes.txt' } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    // Anyone else claiming the header without the per-session value is just a caller.
    await rawPost(endpoint.url, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
      }),
      tunnelProbeHeaders()
    );
    expect(lastRequestAt()).toBeNull();
  });

  it('serves protected resource metadata at the token-qualified well-known path', async () => {
    const url = new URL(endpoint.url);
    url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
    const res = await rawGet(url.toString());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const metadata = JSON.parse(res.text);
    // RFC 9728 requires `resource`; it must name this exact endpoint.
    expect(metadata.resource).toBe(endpoint.url);
    // No authorization server means "not OAuth protected", which is the truth here
    // and stops a client from starting a flow it can never complete.
    expect(metadata.authorization_servers).toEqual([]);
  });

  it('does not leak the secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.url);
    const token = url.pathname.slice('/mcp/'.length);
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 * 1024)
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      // Deliberately never finished: the guard must answer on the headers alone.
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(endpoint.url, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await legacy('tools/list');
    expect(toolNames(after)).toContain('list_roots');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.url, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await legacy('tools/list');
    expect(toolNames(after)).toContain('list_roots');
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await legacy('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('chatgpt-local-files');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the server instructions', async () => {
    const reply = await legacy('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    // Progress guidance lives once at server level rather than bloating every tool description.
    expect(instructions).toContain('Keep the user visibly informed more than usual while you work');
    // Short enough not to burn the model's context on every conversation.
    expect(instructions.length).toBeLessThan(1500);
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await legacy('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read_file');
  });

  it('calls a tool', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/src/app.ts' }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('returns a local image as native MCP image content', async () => {
    const reply = await legacy('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/pixel.png' }
    });
    expect(reply.status).toBe(200);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
    expect(Buffer.from(String(image?.data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('2026-07-28 clients', () => {
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read_file');
  });

  it('calls a tool', async () => {
    const reply = await modern('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/src/app.ts' }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read_file', arguments: { path: '/workspace/notes.txt' } }, {
      'Mcp-Name': 'list_roots'
    });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it('hides every write tool in read-only mode', async () => {
    // Everything on, but read-only, which is the state that must still be safe.
    ctx.caps = withCaps({
      create: true,
      edit: true,
      move: true,
      deleteFile: true,
      deleteFolder: true,
      powershell: true,
      command: true
    });
    const config = { ...defaultConfig(), capabilities: ctx.caps, readOnly: true };
    ctx.caps = effectiveCapabilities(config);

    const names = toolNames(await legacy('tools/list'));
    expect(names).toEqual([
      'file_info',
      'list_directory',
      'list_roots',
      'read_file',
      'read_files',
      'search_files',
      'view_image'
    ]);
  });

  it('exposes write tools only when read-only is off', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true, deleteFolder: true });
    const names = toolNames(await legacy('tools/list'));
    expect(names).toContain('create_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('edit_files');
    expect(names).toContain('move_path');
    expect(names).toContain('delete_file');
    expect(names).toContain('delete_directory');
    expect(names).toContain('write_binary_file');
    expect(names).not.toContain('run_powershell');
    expect(names).not.toContain('run_command');
  });

  it('writes binary assets with create/edit permission split enforced', async () => {
    const target = path.join(approved, 'generated.bin');
    await fs.rm(target, { force: true });
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false });

    let reply = await legacy('tools/call', {
      name: 'write_binary_file',
      arguments: { path: '/workspace/generated.bin', dataBase64: Buffer.from([0, 1, 2, 255]).toString('base64') }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(await fs.readFile(target)).toEqual(Buffer.from([0, 1, 2, 255]));

    reply = await legacy('tools/call', {
      name: 'write_binary_file',
      arguments: { path: '/workspace/generated.bin', dataBase64: Buffer.from('new').toString('base64'), overwrite: true }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('Edit files permission');

    ctx.caps = withCaps({ create: false, edit: true });
    reply = await legacy('tools/call', {
      name: 'write_binary_file',
      arguments: { path: '/workspace/generated.bin', dataBase64: Buffer.from('new').toString('base64'), overwrite: true }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect((await fs.readFile(target)).toString('utf8')).toBe('new');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({});
    expect(toolNames(await legacy('tools/list'))).not.toContain('run_powershell');

    ctx.caps = withCaps({ powershell: true, command: true });
    const listed = await legacy('tools/list');
    const names = toolNames(listed);
    expect(names).toContain('run_powershell');
    expect(names).toContain('run_command');
    expect(names).toContain('launch_app');
    expect(names).toContain('process');
    expect(names).toContain('open_url');

    const processTool = (listed.body?.result?.tools as Array<any>).find((tool) => tool.name === 'process');
    expect(processTool?.inputSchema?.type).toBe('object');
    expect(processTool?.inputSchema?.properties).toHaveProperty('action');
    expect(processTool?.inputSchema?.properties).toHaveProperty('command');
    expect(processTool?.inputSchema?.properties).toHaveProperty('id');
    expect(processTool?.inputSchema?.properties).toHaveProperty('text');
    expect(processTool?.inputSchema?.properties).toHaveProperty('env');
  });

  it('manages a long-running process through the MCP tool', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
    const started = await legacy('tools/call', {
      name: 'process',
      arguments: {
        action: 'start',
        command: process.execPath,
        args: [
          '-e',
          'console.log("mcp-ready"); setTimeout(() => console.log("mcp-later"), 250); setInterval(() => {}, 1000)'
        ],
        cwd: '/workspace'
      }
    });
    expect(started.body.result?.isError).not.toBe(true);
    const id = textOf(started).match(/^(p\d+)\b/m)?.[1];
    expect(id).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'status', id, lines: 20 }
    });
    expect(textOf(status)).toContain('mcp-ready');
    expect(textOf(status)).toContain('running');
    const cursor = textOf(status).match(/^cursor: (.+)$/m)?.[1];
    expect(cursor).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const delta = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'status', id, lines: 20, cursor }
    });
    expect(textOf(delta)).toContain('mcp-later');
    expect(textOf(delta)).not.toContain('mcp-ready');
    expect(textOf(delta)).toContain('stdout delta');
    const nextCursor = textOf(delta).match(/^cursor: (.+)$/m)?.[1];

    const stopped = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'stop', id, lines: 20, cursor: nextCursor }
    });
    expect(stopped.body.result?.isError).not.toBe(true);
    expect(textOf(stopped)).toContain('exited');
    expect(textOf(stopped)).toMatch(/stop: (graceful|forced)/);
  });

  it('writes to managed process stdin through MCP and preserves cursor deltas', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
    const started = await legacy('tools/call', {
      name: 'process',
      arguments: {
        action: 'start',
        command: process.execPath,
        args: ['-e', 'process.stdin.setEncoding("utf8"); console.log("env="+(process.env.MCP_TEST_ENV ?? "missing")); process.stdin.once("data", d => { console.log("stdin="+d.trim()); process.exit(0); });'],
        env: { MCP_TEST_ENV: 'mcp-env-ok' },
        cwd: '/workspace'
      }
    });
    const id = textOf(started).match(/^(p\d+)\b/m)?.[1];
    expect(id).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'status', id, lines: 20 }
    });
    expect(textOf(first)).toContain('env=mcp-env-ok');
    const cursor = textOf(first).match(/^cursor: (.+)$/m)?.[1];

    const written = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'write', id, text: 'hello-mcp', cursor, lines: 20 }
    });
    expect(written.body.result?.isError).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const delta = await legacy('tools/call', {
      name: 'process',
      arguments: { action: 'status', id, lines: 20, cursor }
    });
    expect(textOf(delta)).toContain('stdin=hello-mcp');
    expect(textOf(delta)).not.toContain('env=mcp-env-ok');
  });

  it('keeps clipboard read and write as separate permissions', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ clipboardRead: true, clipboardWrite: false });
    let names = toolNames(await legacy('tools/list'));
    expect(names).toContain('read_clipboard');
    expect(names).not.toContain('write_clipboard');

    const config = {
      ...defaultConfig(),
      capabilities: withCaps({ clipboardRead: true, clipboardWrite: true }),
      readOnly: true
    };
    ctx.readOnly = true;
    ctx.caps = effectiveCapabilities(config);
    names = toolNames(await legacy('tools/list'));
    expect(names).toContain('read_clipboard');
    expect(names).not.toContain('write_clipboard');
  });

  it('is off by default', () => {
    const config = defaultConfig();
    expect(config.readOnly).toBe(true);
    expect(config.capabilities.powershell).toBe(false);
    expect(config.capabilities.command).toBe(false);
    for (const [name, on] of Object.entries(effectiveCapabilities(config))) {
      if (['browse', 'search', 'read', 'metadata'].includes(name)) continue;
      expect(on, name).toBe(false);
    }
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await legacy('tools/call', {
      name: 'delete_file',
      arguments: { path: '/workspace/notes.txt' }
    });
    // Either a JSON-RPC error or a tool error, but never a deletion.
    const failed = reply.body.error !== undefined || reply.body.result?.isError === true;
    expect(failed).toBe(true);
  });

  it('hides individual read tools when their capability is off', async () => {
    ctx.caps = withCaps({ search: false, metadata: false });
    const names = toolNames(await legacy('tools/list'));
    expect(names).not.toContain('search_files');
    expect(names).not.toContain('file_info');
    expect(names).toContain('read_file');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await legacy('tools/list'))).not.toContain('create_file');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await legacy('tools/list'))).toContain('create_file');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await legacy('tools/list'))).toContain('create_file');

    ctx.caps = withCaps({ create: false });
    const names = toolNames(await legacy('tools/list'));
    expect(names).toContain('create_file');

    const reply = await legacy('tools/call', {
      name: 'create_file',
      arguments: { path: '/workspace/should-not-exist.txt', content: 'nope' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
  });

  it('always offers list_roots so the model can orient itself', async () => {
    ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    expect(toolNames(await legacy('tools/list'))).toEqual(['list_roots']);
  });
});

describe('desktop capabilities', () => {
  it('hides the desktop tools until they are turned on', async () => {
    ctx.readOnly = false;
    const names = toolNames(await legacy('tools/list'));
    expect(names).not.toContain('screenshot');
    expect(names).not.toContain('list_windows');
    expect(names).not.toContain('computer');
  });

  it('offers looking at the screen without offering control of it', async () => {
    ctx.caps = withCaps({ screen: true });
    const names = toolNames(await legacy('tools/list'));
    expect(names).toContain('screenshot');
    expect(names).toContain('list_windows');
    expect(names).toContain('wait_for_window');
    expect(names).not.toContain('computer');
  });

  // Seeing the screen changes nothing, so it survives read-only mode; driving the
  // mouse and keyboard can do anything the user can, so it must not.
  it('keeps seeing but not touching in read-only mode', async () => {
    const config = { ...defaultConfig(), capabilities: withCaps({ screen: true, control: true }) };

    ctx.readOnly = true;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: true });
    expect(ctx.caps.screen).toBe(true);
    expect(ctx.caps.control).toBe(false);
    const readOnlyNames = toolNames(await legacy('tools/list'));
    expect(readOnlyNames).toContain('screenshot');
    expect(readOnlyNames).not.toContain('computer');

    ctx.readOnly = false;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: false });
    expect(toolNames(await legacy('tools/list'))).toContain('computer');
  });

  it('marks screenshots read-only and control destructive', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const tools = (await legacy('tools/list')).body.result.tools as Array<{
      name: string;
      annotations?: Record<string, boolean>;
    }>;
    const shot = tools.find((t) => t.name === 'screenshot');
    const computer = tools.find((t) => t.name === 'computer');
    expect(shot?.annotations?.readOnlyHint).toBe(true);
    expect(computer?.annotations?.readOnlyHint).toBe(false);
    expect(computer?.annotations?.destructiveHint).toBe(true);
  });

  it('rejects a malformed action before it reaches the desktop', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    // No coordinates, so there is nothing to click; this must fail as a tool error
    // rather than being passed on to the helper.
    const reply = await legacy('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click' }] }
    });
    const failed = reply.body.error !== undefined || reply.body.result?.isError === true;
    expect(failed).toBe(true);
  });
});

describe('tool annotations', () => {
  it('marks read tools read-only so ChatGPT does not prompt for each call', async () => {
    const reply = await legacy('tools/list');
    const tools = reply.body.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('marks destructive tools so ChatGPT asks before running them', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ edit: true, move: true, deleteFile: true, deleteFolder: true });
    const reply = await legacy('tools/list');
    const tools = reply.body.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    for (const name of ['write_file', 'move_path', 'delete_file', 'delete_directory']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.destructiveHint, name).toBe(true);
    }
  });
});

describe('sandbox enforcement through the tool layer', () => {
  const escapes = [
    '/workspace/../private/passwords.txt',
    '/workspace/../../private/passwords.txt',
    '\\workspace\\..\\private\\passwords.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/private/passwords.txt',
    '/workspace/notes.txt:stream'
  ];

  it('refuses every escape attempt on read_file', async () => {
    for (const attempt of escapes) {
      const reply = await legacy('tools/call', {
        name: 'read_file',
        arguments: { path: attempt }
      });
      expect(reply.body.result?.isError, attempt).toBe(true);
      expect(textOf(reply), attempt).not.toContain('hunter2');
    }
  });

  it('refuses escape attempts on list_directory and search_files', async () => {
    for (const name of ['list_directory', 'search_files']) {
      const reply = await legacy('tools/call', {
        name,
        arguments: { path: '/workspace/../private', query: 'x' }
      });
      expect(reply.body.result?.isError, name).toBe(true);
    }
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await legacy('tools/call', {
      name: 'create_file',
      arguments: { path: '/workspace/../private/planted.txt', content: 'x' }
    });
    expect(reply.body.result?.isError).toBe(true);
  });

  it('never reveals a real Windows path', async () => {
    const reply = await legacy('tools/call', {
      name: 'list_directory',
      arguments: { path: '/workspace' }
    });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(approved);
  });

  it('reports the approved roots and the current mode', async () => {
    const reply = await legacy('tools/call', { name: 'list_roots', arguments: {} });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).toContain('read only');
  });
});

describe('bounded output', () => {
  it('returns only the requested line range', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/notes.txt', startLine: 3, endLine: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 5');
    expect(text).not.toContain('note line 6');
    expect(text).toContain('lines 3-5');
    // The total is unknown after a ranged read, so the model gets a resume point
    // instead of a misleading "of ?".
    expect(text).not.toContain('of ?');
    expect(text).toContain('continue from line 6');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/src/app.ts' }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('truncates a large read and says how to continue', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/notes.txt', maxBytes: 60 }
    });
    const text = textOf(reply);
    expect(text).toContain('truncated');
    expect(text).toContain('continue from line');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(400);
  });

  it('caps a directory listing and says it was capped', async () => {
    const reply = await legacy('tools/call', {
      name: 'list_directory',
      arguments: { path: '/workspace', recursive: true, maxEntries: 2 }
    });
    expect(textOf(reply)).toContain('stopped at 2 entries');
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: 12345 }
    });
    const failed = reply.body.error !== undefined || reply.body.result?.isError === true;
    expect(failed).toBe(true);
  });

  it('reports a missing file plainly', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/nope.txt' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/Not found/i);
  });

  it('reads several source files in one call', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_files',
      arguments: {
        files: [
          { path: '/workspace/src/app.ts' },
          { path: '/workspace/src/lib/util.ts' }
        ]
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('gets metadata for several files in one call while keeping per-item failures useful', async () => {
    const reply = await legacy('tools/call', {
      name: 'file_info',
      arguments: {
        paths: ['/workspace/src/app.ts', '/workspace/missing-info.txt', '/workspace/src/lib/util.ts']
      }
    });
    const text = textOf(reply);
    expect(reply.body.result?.isError).toBeFalsy();
    expect(text).toContain('path: /workspace/src/app.ts');
    expect(text).toContain('path: /workspace/missing-info.txt');
    expect(text).toContain('error: Not found');
    expect(text).toContain('path: /workspace/src/lib/util.ts');
  });

  it('keeps successful batch reads when another requested file fails', async () => {
    const reply = await legacy('tools/call', {
      name: 'read_files',
      arguments: {
        files: [
          { path: '/workspace/src/app.ts' },
          { path: '/workspace/missing-batch.txt' },
          { path: '/workspace/src/lib/util.ts' }
        ]
      }
    });
    const text = textOf(reply);
    expect(reply.body.result?.isError).toBeFalsy();
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/missing-batch.txt — ERROR');
    expect(text).toContain('Not found');
    expect(text).toContain('export const helper = 1;');
  });

  it('lets recursive listing override the default dependency exclusions', async () => {
    const defaultReply = await legacy('tools/call', {
      name: 'list_directory',
      arguments: { path: '/workspace', recursive: true, maxEntries: 100 }
    });
    expect(textOf(defaultReply)).not.toContain('node_modules');
    expect(textOf(defaultReply)).not.toContain('noise.js');

    const everything = await legacy('tools/call', {
      name: 'list_directory',
      arguments: { path: '/workspace', recursive: true, maxEntries: 100, exclude: [] }
    });
    expect(textOf(everything)).toContain('node_modules');
    expect(textOf(everything)).toContain('noise.js');
  });
});

describe('write tools', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true, deleteFolder: true });
  });

  it('creates, edits, moves and deletes inside a root', async () => {
    const create = await legacy('tools/call', {
      name: 'create_file',
      arguments: { path: '/workspace/scratch.txt', content: 'first\nsecond\n' }
    });
    expect(create.body.result?.isError).toBeFalsy();

    const edit = await legacy('tools/call', {
      name: 'edit_file',
      arguments: { path: '/workspace/scratch.txt', edits: [{ oldText: 'second', newText: 'SECOND' }] }
    });
    expect(textOf(edit)).toContain('1 replacement');

    const read = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/scratch.txt' }
    });
    expect(textOf(read)).toContain('SECOND');

    const move = await legacy('tools/call', {
      name: 'move_path',
      arguments: { from: '/workspace/scratch.txt', to: '/workspace/moved.txt' }
    });
    expect(move.body.result?.isError).toBeFalsy();

    const remove = await legacy('tools/call', {
      name: 'delete_file',
      arguments: { path: '/workspace/moved.txt' }
    });
    expect(remove.body.result?.isError).toBeFalsy();
  });

  it('edits several files atomically enough for a coherent cross-file MCP change', async () => {
    const a = path.join(approved, 'batch-a.txt');
    const b = path.join(approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await legacy('tools/call', {
      name: 'edit_files',
      arguments: {
        files: [
          { path: '/workspace/batch-a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
          { path: '/workspace/batch-b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }
        ]
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('Edited 2 file(s)');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it('leaves every target untouched when cross-file edit preflight fails', async () => {
    const a = path.join(approved, 'batch-fail-a.txt');
    const b = path.join(approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await legacy('tools/call', {
      name: 'edit_files',
      arguments: {
        files: [
          { path: '/workspace/batch-fail-a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
          { path: '/workspace/batch-fail-b.txt', edits: [{ oldText: 'missing', newText: 'BETA' }] }
        ]
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('oldText was not found');
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('will not overwrite an existing file by accident', async () => {
    const reply = await legacy('tools/call', {
      name: 'create_file',
      arguments: { path: '/workspace/notes.txt', content: 'clobbered' }
    });
    expect(reply.body.result?.isError).toBe(true);
    const read = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/notes.txt', endLine: 1 }
    });
    expect(textOf(read)).toContain('note line 1');
  });

  it('keeps create_file and write_file semantics separate', async () => {
    const missingWrite = await legacy('tools/call', {
      name: 'write_file',
      arguments: { path: '/workspace/missing.txt', content: 'must not create' }
    });
    expect(missingWrite.body.result?.isError).toBe(true);

    const create = await legacy('tools/call', {
      name: 'create_file',
      arguments: { path: '/workspace/new.txt', content: 'v1' }
    });
    expect(create.body.result?.isError).toBeFalsy();

    const overwrite = await legacy('tools/call', {
      name: 'write_file',
      arguments: { path: '/workspace/new.txt', content: 'v2' }
    });
    expect(overwrite.body.result?.isError).toBeFalsy();
    const read = await legacy('tools/call', {
      name: 'read_file',
      arguments: { path: '/workspace/new.txt' }
    });
    expect(textOf(read)).toContain('v2');
  });

  it('refuses to delete an approved root itself', async () => {
    const reply = await legacy('tools/call', {
      name: 'delete_directory',
      arguments: { path: '/workspace', recursive: true }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/approved root/);
  });
});
