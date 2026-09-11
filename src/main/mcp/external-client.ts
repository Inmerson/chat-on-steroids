import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExternalMcpServer } from './external-registry.js';
import { safeExternalToolName } from './external-registry.js';
import { APP_VERSION } from '../version.js';

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_DISCOVERED_TOOLS = 128;

export class ExternalMcpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalMcpClientError';
  }
}

export interface DiscoveredExternalTool {
  name: string;
  originalName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ExternalMcpConnection {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ExternalMcpClientDeps {
  connect?: (server: ExternalMcpServer) => Promise<ExternalMcpConnection>;
  timeoutMs?: number;
}

interface CachedConnection {
  connection: ExternalMcpConnection;
  tools: DiscoveredExternalTool[];
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExternalMcpClientError(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function defaultConnect(server: ExternalMcpServer): Promise<ExternalMcpConnection> {
  const client = new Client({ name: 'chat-on-steroids-external-mcp', version: APP_VERSION }, { capabilities: {} });
  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  if (server.transport === 'stdio') {
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    transport = new StdioClientTransport({
      command: server.command!, args: server.args, cwd: server.cwd,
      env: { ...inheritedEnvironment, ...server.env }, stderr: 'pipe', maxBufferSize: 1_048_576
    });
  } else if (server.transport === 'streamable-http') {
    transport = new StreamableHTTPClientTransport(new URL(server.url!), { reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 1 } });
  } else {
    transport = new SSEClientTransport(new URL(server.url!));
  }
  await client.connect(transport);
  return {
    listTools: () => client.listTools(),
    callTool: (input) => client.callTool(input),
    close: () => transport.close()
  };
}

/** Owns lazy external-MCP connections. Instances never execute disabled or unallowlisted tools. */
export class ExternalMcpClientManager {
  private readonly connect: (server: ExternalMcpServer) => Promise<ExternalMcpConnection>;
  private readonly timeoutMs: number;
  private readonly cached = new Map<string, CachedConnection>();

  constructor(deps: ExternalMcpClientDeps = {}) {
    this.connect = deps.connect ?? defaultConnect;
    this.timeoutMs = deps.timeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  private async connectionFor(server: ExternalMcpServer): Promise<CachedConnection> {
    if (!server.enabled) throw new ExternalMcpClientError(`External MCP server ${server.id} is disabled`);
    const existing = this.cached.get(server.id);
    if (existing) return existing;
    const connection = await withTimeout(this.connect(server), this.timeoutMs, `External MCP server ${server.id} connection`);
    try {
      const discovery = await withTimeout(connection.listTools(), this.timeoutMs, `External MCP server ${server.id} tool discovery`);
      if (discovery.tools.length > MAX_DISCOVERED_TOOLS) throw new ExternalMcpClientError(`External MCP server ${server.id} advertises too many tools`);
      const allowed = new Set(server.allowedTools);
      const tools = discovery.tools
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => ({ name: safeExternalToolName(server.id, tool.name), originalName: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      const value = { connection, tools };
      this.cached.set(server.id, value);
      return value;
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  }

  async toolsFor(server: ExternalMcpServer): Promise<DiscoveredExternalTool[]> {
    return (await this.connectionFor(server)).tools;
  }

  async call(server: ExternalMcpServer, originalName: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const cached = await this.connectionFor(server);
    if (!cached.tools.some((tool) => tool.originalName === originalName)) {
      throw new ExternalMcpClientError(`External MCP tool ${originalName} is not enabled for ${server.id}`);
    }
    return withTimeout(cached.connection.callTool({ name: originalName, arguments: arguments_ }), CALL_TIMEOUT_MS, `External MCP tool ${server.id}/${originalName}`);
  }

  async dispose(serverId?: string): Promise<void> {
    const entries = serverId ? [[serverId, this.cached.get(serverId)] as const] : [...this.cached.entries()];
    if (serverId) this.cached.delete(serverId);
    else this.cached.clear();
    await Promise.all(entries.map(async ([id, value]) => {
      if (!value) return;
      this.cached.delete(id);
      await withTimeout(value.connection.close(), this.timeoutMs, `External MCP server ${id} shutdown`).catch(() => {});
    }));
  }
}
