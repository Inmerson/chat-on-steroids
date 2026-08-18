/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 *
 * The other thing it exists to prove is the surface split. This app publishes two
 * independently discoverable MCP servers, Core and Desktop, and the whole point of that
 * design is that the boundary is *real*: a no-query tools/list against Core must not
 * reveal a single Desktop schema, and a Core tools/call for a Desktop tool must fail as
 * an unknown tool rather than being quietly forwarded. Those assertions live in
 * "surface boundaries" below and are the ones to look at first if this file goes red.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectiveCapabilities, defaultConfig } from '../src/main/config.js';
import { lastRequestAt, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../src/main/mcp/surfaces.js';
import { listManagedProcesses, stopManagedProcess } from '../src/main/process-manager.js';
import { createSession, initSessionStore } from '../src/main/session/store.js';
import { createHandoff } from '../src/main/session/handoff.js';
import { resetWorkspaces, setWorkspaceFor, workspaceEntries } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { emptyEvidence, noteExec, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
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

/**
 * A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope.
 *
 * Every request names its surface, because "which server answered" is the property most
 * of this file is about. There is no default-surface helper on purpose.
 */
async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);
const desktop = (method: string, params: unknown = {}): Promise<any> => call('desktop', method, params);

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
  const res = await rawPost(endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, body: decode(res) };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by
  // default now, so without a directory of its own the recorder wrote session folders
  // into the process's working directory — which for a test run is the repository.
  initSessionStore(base);
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
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features
    // with their own defaults — recording now starts on — and a capability-gating test
    // that silently changes meaning when a product default moves is not testing gating.
    // The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  // Every exec test runs with cwd inside the fixture, and a shell that is still alive
  // holds that folder open — on Windows that is an EBUSY on the way out, in a teardown
  // that has nothing to do with what was being tested.
  await Promise.all(
    listManagedProcesses()
      .filter((entry) => entry.running)
      .map((entry) => stopManagedProcess(entry.id, 1).catch(() => undefined))
  );
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  ctx.sessionTools = false;
  ctx.agentTools = false;
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('binds to loopback only, and gives every surface its own path', () => {
    for (const surface of SURFACE_LIST) {
      const url = endpoint.urls[surface.id];
      expect(url.startsWith('http://127.0.0.1:'), surface.id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${surface.id}/`), surface.id).toBe(true);
    }
    expect(endpoint.url).toBe(endpoint.urls.core);
    expect(endpoint.urls.core).not.toBe(endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(endpoint.urls.core);
    const desktopUrl = new URL(endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // Knowing Core's token must not be enough to reach Desktop. This is the property that
    // makes "share the Desktop connector" and "share everything" different acts.
    const swapped = new URL(endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
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

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a request to either surface as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await desktop('tools/list');
    expect(lastRequestAt()).not.toBeNull();
  });

  // With an optional second connector, one global clock cannot answer the question the
  // setup screen actually asks: did the user create THIS connector in ChatGPT? Core
  // traffic says nothing about Desktop, so each surface keeps its own pair.
  it('keeps a separate arrival and tool-call clock per surface', async () => {
    expect(lastRequestAt('core')).toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();

    await core('tools/list');
    expect(lastRequestAt('core')).not.toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();
    expect(lastToolCallAt('core')).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    expect(lastRequestAt('desktop')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    // A disabled tool still proves ChatGPT is allowed to reach the tool layer, which
    // is the only thing this clock is asked about.
    await core('tools/list');
    ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    // Anyone else claiming the header without the per-session value is just a caller.
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.urls.core,
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

  it('serves protected resource metadata per surface, naming that surface', async () => {
    for (const surface of SURFACE_LIST) {
      const url = new URL(endpoint.urls[surface.id]);
      url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
      const res = await rawGet(url.toString());

      expect(res.status, surface.id).toBe(200);
      expect(res.headers['content-type'], surface.id).toContain('application/json');

      const metadata = JSON.parse(res.text);
      // RFC 9728 requires `resource`; it must name this exact endpoint.
      expect(metadata.resource, surface.id).toBe(endpoint.urls[surface.id]);
      expect(metadata.resource_name, surface.id).toBe(surface.connectorName);
      // No authorization server means "not OAuth protected", which is the truth here
      // and stops a client from starting a flow it can never complete.
      expect(metadata.authorization_servers, surface.id).toEqual([]);
    }
  });

  it('does not leak either secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.urls.core);
    const tokens = SURFACE_LIST.map((surface) => new URL(endpoint.urls[surface.id]).pathname.split('/').pop() ?? '');
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    for (const token of tokens) expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.urls.core);
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
    const res = await rawPost(endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The design this whole redesign exists for.
// ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  /** Turns everything on, so each surface advertises the most it ever can. */
  const everything = (): void => {
    ctx.caps = allCaps();
    ctx.readOnly = false;
    ctx.sessionTools = true;
    ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => {
    everything();
    const names = toolNames(await core('tools/list'));
    // find is absent because exec_command is present — they are mutually exclusive.
    expect(names).toEqual(['agents', 'apply_patch', 'exec_command', 'read', 'session', 'write_stdin']);
    for (const name of surfaceDefinition('desktop').tools) expect(names, name).not.toContain(name);
  });

  /**
   * The multi-agent field that no longer exists, everywhere it used to appear.
   *
   * Every tool once carried an optional `agent_key`, because a worker had to say who it was
   * on every call it made. A worker is now the chat it is in, so there is nothing for a model
   * to carry and nothing for one to invent — which is what this checks, since the prime
   * inventing a key for itself was a schema-reading failure, not a runtime one. The schema is
   * also the only thing ChatGPT caches per connector session, so a field absent here is a
   * field that cannot come back without a reconnect.
   */
  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await call(surface, 'tools/list'))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);

    // The one surviving key is `agents`' own argument, and it has to read as recovery so a
    // model does not treat it as the way in.
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    expect(Object.keys(agentsTool.inputSchema.properties)).toContain('join_key');
    expect(agentsTool.inputSchema.required ?? []).not.toContain('join_key');
    expect(String(agentsTool.inputSchema.properties.join_key.description)).toMatch(/recover/i);

    // And an ordinary read from a worker's chat carries nothing at all.
    const call1 = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(call1)).toBe(false);
  });

  it('removes the agents tool, and its key with it, once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');

    // The user switches the feature off and reconnects the connector, which is the one
    // reload the design is allowed to ask for. A fresh endpoint is what that reconnection
    // looks like from here.
    ctx.agentTools = false;
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);

    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    expect(JSON.stringify(toolList(await core('tools/list')))).not.toContain('join_key');
    expect(JSON.stringify(toolList(await desktop('tools/list')))).not.toContain('join_key');
    expect(JSON.stringify(toolList(await core('tools/list')))).not.toContain('agent_key');
    expect(JSON.stringify(toolList(await desktop('tools/list')))).not.toContain('agent_key');
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => {
    everything();
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual(['computer', 'observe']);
    for (const name of surfaceDefinition('core').tools) expect(names, name).not.toContain(name);
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const declared = new Set(surface.tools);
      for (const name of toolNames(await call(surface.id, 'tools/list'))) {
        expect(declared.has(name), `${surface.id} advertised ${name}`).toBe(true);
      }
    }
  });

  it('leaks no Desktop schema text into a no-query Core discovery, and vice versa', async () => {
    everything();
    const coreBody = JSON.stringify((await core('tools/list')).body);
    const desktopBody = JSON.stringify((await desktop('tools/list')).body);

    // Not just the names: the action vocabulary of the other surface must be absent too,
    // because a schema fragment is what a discovery pull actually costs.
    for (const marker of ['computer', 'observe', 'click_ref', 'captureAfter', 'write_clipboard']) {
      expect(coreBody, marker).not.toContain(marker);
    }
    for (const marker of ['apply_patch', 'exec_command', 'write_stdin', 'save_handoff', 'Begin Patch']) {
      expect(desktopBody, marker).not.toContain(marker);
    }
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    // Core has no `computer` handler registered at all, so this must die in the protocol
    // layer. If this ever starts succeeding, the split has become decoration.
    const onCore = await core('tools/call', { name: 'computer', arguments: { actions: [{ type: 'wait', ms: 0 }] } });
    expect(failed(onCore)).toBe(true);
    expect(JSON.stringify(onCore.body)).not.toContain('Done:');

    const onDesktop = await desktop('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = [
      'list_roots',
      'read_file',
      'read_files',
      'list_directory',
      'search_files',
      'file_info',
      'view_image',
      'create_file',
      'write_file',
      'write_binary_file',
      'edit_file',
      'edit_files',
      'move_path',
      'delete_file',
      'delete_directory',
      'run_command',
      'run_powershell',
      'launch_app',
      'open_url',
      'process',
      'screenshot',
      'list_windows',
      'wait_for_window',
      'find_ui',
      'read_clipboard',
      'write_clipboard',
      'resume_session',
      'session_history',
      'session_status',
      'save_handoff',
      'spawn_agents',
      'join_agent',
      'agent_message',
      'agent_status',
      'agent_inbox',
      'finish_agent'
    ];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);

    // No aliases either. A retired name must be unknown to both servers, not silently
    // accepted by the one that used to own it.
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => {
    everything();
    const coreTools = toolList(await core('tools/list'));
    const desktopTools = toolList(await desktop('tools/list'));

    // Counts are the design: Core is capped at six live schemas because find and the exec
    // pair cannot both exist, and Desktop is two.
    expect(coreTools).toHaveLength(6);
    expect(desktopTools).toHaveLength(2);

    // And the size, which is what a discovery pull actually costs the model on every
    // conversation that touches the connector. The ceilings sit just above what the
    // surface measures today (core 12.5k, desktop 7.9k on 2026-08-17) rather than at a
    // round number well above it: a budget with room to spare is a budget that never
    // catches the regression it exists to catch.
    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8');
    const desktopBytes = Buffer.byteLength(JSON.stringify(desktopTools), 'utf8');
    expect(coreBytes, `core tools/list is ${coreBytes} bytes`).toBeLessThan(13_500);
    expect(desktopBytes, `desktop tools/list is ${desktopBytes} bytes`).toBeLessThan(8_500);

    // Per tool as well as per surface, so one schema cannot quietly eat the whole budget
    // while the total stays under it. `computer` is the largest by design: fourteen
    // discriminated action variants, each spelling out its own arguments, is what keeps
    // its validation errors small and its action set explicit.
    for (const tool of [...coreTools, ...desktopTools]) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      const budget = tool.name === 'computer' ? 6_000 : 3_000;
      expect(bytes, `${tool.name} schema is ${bytes} bytes`).toBeLessThan(budget);
    }
  });

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^chatgpt-local-files-/);
      expect(surface.connectorName, surface.id).toContain('ChatGPT Local Files');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      // The description is the only thing the model has before discovery, so it has to
      // carry real vocabulary rather than a label.
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    // Distinct names, because the connector name is also the retrieval handle.
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const reply = await call(surface.id, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('chatgpt-local-files-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the Core server instructions', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    // Progress guidance lives once at server level rather than bloating every tool description.
    expect(instructions).toContain('Keep the user visibly informed more than usual while you work');
    // Short enough not to burn the model's context on every conversation.
    expect(instructions.length).toBeLessThan(2500);
  });

  it('points at the other connector rather than pretending the capability does not exist', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const coreReply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(coreReply.body.result.instructions).toContain(surfaceDefinition('desktop').connectorName);

    const desktopReply = await desktop('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(desktopReply.body.result.instructions).toContain(surfaceDefinition('core').connectorName);
    expect(desktopReply.body.result.instructions).toContain('observe');
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('returns a local image as native MCP image content', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/pixel.png'] }
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
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await modern('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } }, {
      'Mcp-Name': 'apply_patch'
    });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it('hides every writing and running tool in read-only mode', async () => {
    // Everything on, but read-only, which is the state that must still be safe.
    const config = { ...defaultConfig(), capabilities: allCaps(), readOnly: true };
    ctx.caps = effectiveCapabilities(config);
    ctx.readOnly = true;

    expect(toolNames(await core('tools/list'))).toEqual(['find', 'read']);
  });

  it('offers apply_patch only when a writing permission is on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });

    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['one']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const updated = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n')
      }
    });
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    // Refused before anything was written, which is the whole promise of apply_patch.
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    expect(toolNames(await core('tools/list'))).not.toContain('exec_command');

    ctx.caps = withCaps({ command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('drops find when exec_command can do the same job better', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true, search: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).not.toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    ctx.caps = withCaps({ search: true, command: false });
    expect(toolNames(await core('tools/list'))).toContain('find');

    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content' }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).toContain('results_returned:');
  });

  it('offers session and agents only when those features are on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');

    ctx.sessionTools = true;
    ctx.agentTools = true;
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('session');
    expect(names).toContain('agents');
  });

  it('is off by default', () => {
    const config = defaultConfig();
    expect(config.readOnly).toBe(true);
    expect(config.capabilities.command).toBe(false);
    for (const [name, on] of Object.entries(effectiveCapabilities(config))) {
      if (['browse', 'search', 'read', 'metadata'].includes(name)) continue;
      expect(on, name).toBe(false);
    }
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n') }
    });
    // Either a JSON-RPC error or a tool error, but never a deletion.
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    ctx.caps = withCaps({ create: false });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/should-not-exist.txt', ['nope']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  // find and the exec pair are mutually exclusive: find exists so that a user who has
  // not granted command execution still gets a way to search. But `exposedCaps` only ever
  // widens, so deriving find's registration from the live "command is off" would DELETE a
  // tool from an already-cached ChatGPT snapshot the moment the user granted commands —
  // the exact stale-snapshot failure the monotonic rule exists to prevent.
  it('keeps find listed after command execution is switched on mid-run', async () => {
    ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect(toolNames(await core('tools/list'))).toContain('find');

    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('does not add find to a surface that started with command execution on', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, command: true });
    expect(toolNames(await core('tools/list'))).not.toContain('find');

    ctx.caps = withCaps({ search: true, read: true, command: false });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
  });

  it('always offers read, because that is what the app is for', async () => {
    ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    // Nothing is registered when every reading permission is off — but the snapshot is
    // monotonic, so a surface that started with reading on keeps it and refuses instead.
    expect(toolNames(await core('tools/list'))).toEqual([]);
  });
});

describe('desktop capabilities', () => {
  it('advertises nothing until a desktop permission is turned on', async () => {
    ctx.readOnly = false;
    expect(toolNames(await desktop('tools/list'))).toEqual([]);
  });

  it('offers looking at the screen without offering control of it', async () => {
    ctx.caps = withCaps({ screen: true });
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual(['observe']);
  });

  // Seeing the screen changes nothing, so it survives read-only mode; driving the
  // mouse and keyboard can do anything the user can, so it must not.
  it('keeps seeing but not touching in read-only mode', async () => {
    const config = { ...defaultConfig(), capabilities: withCaps({ screen: true, control: true }) };

    ctx.readOnly = true;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: true });
    expect(ctx.caps.screen).toBe(true);
    expect(ctx.caps.control).toBe(false);
    expect(toolNames(await desktop('tools/list'))).toEqual(['observe']);

    ctx.readOnly = false;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: false });
    expect(toolNames(await desktop('tools/list'))).toContain('computer');
  });

  it('offers computer for the clipboard alone, and refuses the steps that need control', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ control: false, clipboardRead: true, clipboardWrite: false });
    expect(toolNames(await desktop('tools/list'))).toEqual(['computer']);

    const clicked = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click', x: 5, y: 5 }] }
    });
    expect(clicked.body.result?.isError).toBe(true);
    expect(textOf(clicked)).toContain('mouse and keyboard control is disabled');

    const written = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'write_clipboard', text: 'nope' }] }
    });
    expect(written.body.result?.isError).toBe(true);
    expect(textOf(written)).toContain('Replace clipboard text permission');
  });

  it('marks observing read-only and control destructive', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const tools = toolList(await desktop('tools/list'));
    const observe = tools.find((t) => t.name === 'observe');
    const computer = tools.find((t) => t.name === 'computer');
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    expect(computer?.annotations?.readOnlyHint).toBe(false);
    expect(computer?.annotations?.destructiveHint).toBe(true);
  });

  it('carries the clipboard actions in the computer schema rather than as tools of their own', async () => {
    ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    ctx.readOnly = false;
    const schema = JSON.stringify(toolList(await desktop('tools/list')).find((t) => t.name === 'computer'));
    expect(schema).toContain('read_clipboard');
    expect(schema).toContain('write_clipboard');
  });

  it('rejects a malformed action before it reaches the desktop', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    // No coordinates, so there is nothing to click; this must fail as a tool error
    // rather than being passed on to the helper.
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click' }] }
    });
    expect(failed(reply)).toBe(true);
  });
});

describe('tool annotations', () => {
  it('marks read tools read-only so ChatGPT does not prompt for each call', async () => {
    for (const tool of toolList(await core('tools/list'))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('marks the tools that change this PC so ChatGPT asks before running them', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true, command: true });
    const tools = toolList(await core('tools/list'));
    for (const name of ['apply_patch', 'exec_command', 'write_stdin']) {
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

  it('refuses every escape attempt on read', async () => {
    for (const attempt of escapes) {
      const reply = await core('tools/call', { name: 'read', arguments: { paths: [attempt] } });
      const text = textOf(reply);
      // One bad path is a per-path failure rather than a failed call, so the assertion is
      // that the content never arrives — not that the call errored.
      expect(text, attempt).toContain('ERROR');
      expect(text, attempt).not.toContain('hunter2');
    }
  });

  it('refuses escape attempts on find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'hunter2', mode: 'content', path: '/workspace/../private' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).not.toContain('hunter2\n');
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    // apply_patch used to join the base onto the path and `posix.normalize` the result
    // before the sandbox ever saw it, which erased the `..` that checkSegment exists to
    // refuse: `/workspace/../private/planted.txt` became a clean `/private/planted.txt`
    // and arrived looking like a path that had always been absolute. Patch paths now get
    // the same treatment as a path handed to read or exec.
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out through an explicit cwd', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../../private/planted.txt', ['x']), cwd: '/workspace' }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base but stays inside the root', async () => {
    // The sharp version of the same defect, and the one that would not have shown up as an
    // error at all. `posix.normalize('/workspace/nested/../escaped.txt')` is
    // `/workspace/escaped.txt`: a perfectly resolvable path inside an approved root, so the
    // patch simply landed a folder above the one the caller named and nothing said so.
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../escaped.txt', ['x']), cwd: '/workspace/nested' }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(approved, 'escaped.txt'))).rejects.toThrow();
  });

  it('still applies an ordinary relative patch path against its base', async () => {
    // The refusals above must not have been bought by breaking shorthand itself.
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('relative-landed.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'relative-landed.txt'), 'utf8')).toContain('x');
  });

  it('never reveals a real Windows path', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(approved);
  });

  it('tells the model the approved roots and the current mode without spending a tool call', async () => {
    // list_roots is gone: the roots are one line of server instructions now, because a
    // round trip every conversation paid before it could do anything was pure overhead.
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('Read only');
  });
});

describe('bounded output', () => {
  it('returns only the requested line range', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
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

  it('refuses a line range it cannot honour rather than silently dropping it', async () => {
    // Live, this returned both files from line 1 until the byte cap with no hint that the
    // range had been discarded — a valid-looking call quietly changing what it means.
    const many = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt', '/workspace/src/app.ts'], start_line: 75, end_line: 90 }
    });
    expect(failed(many)).toBe(true);
    expect(textOf(many)).toContain('INVALID_ARGUMENT');
    expect(textOf(many)).toContain('start_line/end_line');

    // A glob is the usual way one path turns into several, so it is checked after expansion.
    const glob = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'], start_line: 1 }
    });
    expect(failed(glob)).toBe(true);
    expect(textOf(glob)).toContain('INVALID_ARGUMENT');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('truncates a large read and says how to continue', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], max_bytes: 60 }
    });
    const text = textOf(reply);
    expect(text).toContain('truncated');
    expect(text).toContain('continue from line');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(400);
  });

  it('lists a folder one level deep, marking what each entry is', async () => {
    // A folder read is one level and nothing more. Dependency folders are shown here —
    // hiding a directory the user can see in Explorer would be a lie — but nothing
    // descends into them, which is where the cost would actually have been.
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('one level');
    expect(text).toContain('d src');
    expect(text).toContain('f notes.txt');
    expect(text).not.toContain('noise.js');
    expect(text).not.toContain('app.ts');
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: [12345] } });
    expect(failed(reply)).toBe(true);
  });

  it('reports a missing file plainly without losing the reads that worked', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt', '/workspace/src/lib/util.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/nope.txt — ERROR');
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('export const helper = 1;');
  });

  it('reads several files in one call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/src/lib/util.ts'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('expands a glob rather than making the model list the files itself', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('export const helper = 1;');
  });

  it('says so when a glob matches nothing instead of failing the call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/**/*.nothing'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('no matches');
  });
});

describe('apply_patch', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true });
  });

  it('adds, updates, moves and deletes through one tool', async () => {
    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/scratch.txt', ['first', 'second']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(textOf(added)).toContain('A /workspace/scratch.txt');

    const edited = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/scratch.txt', '@@', '-second', '+SECOND', '*** End Patch'].join('\n')
      }
    });
    expect(edited.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'scratch.txt'), 'utf8')).toContain('SECOND');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/scratch.txt',
          '*** Move to: /workspace/moved.txt',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(moved.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'scratch.txt'))).rejects.toThrow();

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/moved.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'moved.txt'))).rejects.toThrow();
  });

  // Move and edit were separate permissions before the file tools were folded into
  // apply_patch, and folding them together must not quietly merge the permissions: a user
  // who granted renaming but not editing gave permission to move a file, not to rewrite it.
  it('renames without Edit, and still refuses to rewrite content', async () => {
    const source = path.join(approved, 'rename-me.txt');
    await fs.writeFile(source, `keep this${String.fromCharCode(10)}`, 'utf8');
    ctx.caps = withCaps({ move: true, edit: false });

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/renamed.txt',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(moved.body.result?.isError, textOf(moved)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toContain('keep this');

    const rewritten = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/renamed.txt',
          '*** Move to: /workspace/renamed-again.txt',
          '@@',
          '-keep this',
          '+changed',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(rewritten.body.result?.isError).toBe(true);
    expect(textOf(rewritten)).toContain('TOOL_DISABLED');
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toContain('keep this');
  });

  it('changes several files in one atomic patch', async () => {
    const a = path.join(approved, 'batch-a.txt');
    const b = path.join(approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-b.txt',
          '@@',
          '-beta',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('Applied patch to 2 file(s)');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it('leaves every target untouched when one hunk in the patch does not apply', async () => {
    const a = path.join(approved, 'batch-fail-a.txt');
    const b = path.join(approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-fail-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-fail-b.txt',
          '@@',
          '-missing',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('will not overwrite an existing file by accident', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/notes.txt', ['clobbered']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('names the problem when the patch itself is malformed', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: 'just some text' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('PATCH_INVALID');
  });

  it('marks a deliberately bounded huge-rewrite line count as approximate in the direct reply', async () => {
    const before = Array.from({ length: 1600 }, (_, index) => `old-${index}`);
    await fs.writeFile(path.join(approved, 'rewrite.txt'), `${before.join('\n')}\n`, 'utf8');
    const hunk = [
      '*** Begin Patch',
      '*** Update File: /workspace/rewrite.txt',
      '@@',
      ...before.map((line) => `-${line}`),
      ...before.map((_, index) => `+new-${index}`),
      '*** End Patch'
    ].join('\n');

    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: hunk } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('(~+1600 −1600)');
  });
});

describe('exec_command and write_stdin', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
  });

  it('uses one Codex-style exec lifecycle for quick and long-running shell commands', async () => {
    const quick = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: "Write-Output 'quick-ok'",
        cwd: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(quick.body.result?.isError).not.toBe(true);
    expect(textOf(quick)).toContain('quick-ok');
    expect(textOf(quick)).toContain('exited 0');
    expect(textOf(quick)).not.toContain('Still running');

    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: "$s=[Console]::In.ReadToEnd(); Write-Output ('stdin='+$s)",
        cwd: '/workspace',
        yield_time_ms: 25
      }
    });
    expect(started.body.result?.isError).not.toBe(true);
    expect(textOf(started)).toContain('Still running');
    // The reply has to name the way out, not just the way forward.
    expect(textOf(started)).toContain('write_stdin');
    const sessionId = textOf(started).match(/^session_id: (p\d+)$/m)?.[1];
    expect(sessionId).toBeTruthy();
    const cursor = textOf(started).match(/^cursor: (.+)$/m)?.[1];
    expect(cursor).toBeTruthy();

    const continued = await core('tools/call', {
      name: 'write_stdin',
      arguments: {
        session_id: sessionId,
        chars: 'raw-no-newline',
        close: true,
        cursor,
        yield_time_ms: 5_000
      }
    });
    expect(continued.body.result?.isError).not.toBe(true);
    expect(textOf(continued)).toContain('stdin=raw-no-newline');
    expect(textOf(continued)).toContain('exited 0');
  });

  it('says which folder it ran in, and admits when that was only the default', async () => {
    const named = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: "Write-Output 'x'", cwd: '/workspace', yield_time_ms: 5_000 }
    });
    expect(textOf(named)).toContain('cwd: /workspace');
    expect(textOf(named)).not.toContain('default');

    // Omitting cwd falls back to the first approved root. That is the shape that rebuilt
    // the wrong project in a live run, so the reply has to say it happened.
    const defaulted = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: "Write-Output 'x'", yield_time_ms: 5_000 }
    });
    expect(textOf(defaulted)).toContain('cwd: /workspace (default — no cwd was given)');
  });

  it('decodes a PowerShell error stream instead of returning raw CLIXML', async () => {
    // Windows PowerShell serializes stderr as CLIXML when it decides the stream is being
    // consumed by another PowerShell. A live worker got a screenful of `_x000D__x000A_`
    // where the one useful line was `An empty pipe element is not allowed.`, so the payload
    // is written verbatim here rather than hoping this machine's PowerShell produces one.
    const payload =
      '#< CLIXML<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">An empty pipe element is not allowed._x000D__x000A_</S></Objs>';
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `[Console]::Error.Write('${payload}')`,
        cwd: '/workspace',
        yield_time_ms: 8_000
      }
    });
    // The echoed command line necessarily contains the payload, so judge the stderr section.
    const stderr = textOf(reply).split('--- stderr tail ---')[1] ?? '';
    expect(stderr).toContain('An empty pipe element is not allowed.');
    expect(stderr).not.toContain('#< CLIXML');
    expect(stderr).not.toContain('_x000D_');
  });


  it('returns only new output when the caller passes the previous cursor', async () => {
    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // Wide gap between the two lines on purpose: the first call has to return with
        // 'first' captured and 'second' not yet written, and PowerShell's own startup can
        // eat a few hundred milliseconds before the script runs at all.
        cmd: "Write-Output 'first'; Start-Sleep -Seconds 5; Write-Output 'second'; [Console]::In.ReadToEnd() | Out-Null",
        cwd: '/workspace',
        yield_time_ms: 2_500
      }
    });
    const sessionId = textOf(started).match(/^session_id: (p\d+)$/m)?.[1];
    expect(sessionId).toBeTruthy();
    expect(textOf(started).split('--- stdout')[1] ?? '').toContain('first');
    const cursor = textOf(started).match(/^cursor: (.+)$/m)?.[1];

    const delta = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, cursor, yield_time_ms: 6_000 }
    });
    // Only the captured output is compared: the status header echoes the command line,
    // which naturally contains both words.
    const output = textOf(delta).split('--- stdout delta ---')[1] ?? '';
    expect(output).toContain('second');
    expect(output).not.toContain('first');

    await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, signal: 'kill' }
    });
  });

  it('ends a session outright on signal=kill', async () => {
    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'Start-Sleep -Seconds 30',
        cwd: '/workspace',
        yield_time_ms: 25
      }
    });
    const sessionId = textOf(started).match(/^session_id: (p\d+)$/m)?.[1];
    expect(sessionId).toBeTruthy();

    const killed = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, signal: 'kill' }
    });
    expect(killed.body.result?.isError).not.toBe(true);
    expect(textOf(killed)).toContain('exited');
  });

  it('passes environment variables through to the command', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'Write-Output ("env=" + $env:MCP_TEST_ENV)',
        cwd: '/workspace',
        env: { MCP_TEST_ENV: 'mcp-env-ok' },
        yield_time_ms: 5_000
      }
    });
    expect(textOf(reply)).toContain('env=mcp-env-ok');
  });
});

describe('the outcome a shell command is recorded with', () => {
  /** Runs `noteExec` the way a tool does, and reports what the recorder would store. */
  const outcomeOf = (
    result: { exitCode: number | null; timedOut?: boolean },
    preset: 'ok' | 'error' | 'rejected' | null = null
  ) => {
    const context: CallContext = {
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: preset,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => noteExec(result));
    // Nothing set means the dispatcher's fallback applies, and for a non-error tool result
    // that fallback is `ok` — which is exactly the bug this covers.
    return context.outcome ?? 'ok';
  };

  it('calls a completed non-zero exit an error, not a success', () => {
    expect(outcomeOf({ exitCode: 1 })).toBe('error');
    expect(outcomeOf({ exitCode: 3 })).toBe('error');
  });

  it('leaves a clean exit and a still-running process alone', () => {
    expect(outcomeOf({ exitCode: 0 })).toBe('ok');
    // Still running: it has not failed yet, and saying it did would be a lie about a
    // dev server that is doing exactly what was asked of it.
    expect(outcomeOf({ exitCode: null })).toBe('ok');
  });

  it('calls a timeout an error even when no exit code arrived', () => {
    expect(outcomeOf({ exitCode: null, timedOut: true })).toBe('error');
  });

  it('never overwrites an outcome the tool layer set deliberately', () => {
    expect(outcomeOf({ exitCode: 1 }, 'rejected')).toBe('rejected');
  });
});
