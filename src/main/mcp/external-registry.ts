import { z } from 'zod';

export const EXTERNAL_MCP_TRANSPORTS = ['stdio', 'streamable-http', 'sse'] as const;
export type ExternalMcpTransport = (typeof EXTERNAL_MCP_TRANSPORTS)[number];

const SERVER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_COMPONENT = /[^a-z0-9_-]+/g;
const DANGEROUS_ENVIRONMENT_KEYS = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_V8_COVERAGE',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'BASH_ENV', 'ENV'
]);

export class ExternalMcpRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalMcpRegistryError';
  }
}

export interface ExternalMcpServer {
  id: string;
  transport: ExternalMcpTransport;
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: Record<string, string>;
  description?: string;
  allowedTools: string[];
}

const inputSchema = z.object({
  id: z.string().trim().regex(SERVER_ID, 'Server ID must start with a letter and contain only lowercase letters, digits, dashes, or underscores').max(64),
  transport: z.enum(['stdio', 'streamable-http', 'sse', 'http']),
  enabled: z.boolean().optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  args: z.array(z.string().max(4096)).max(32).optional(),
  cwd: z.string().trim().min(1).max(4096).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  env: z.record(z.string().max(128), z.string().max(4096)).optional(),
  description: z.string().trim().max(500).optional(),
  allowedTools: z.array(z.string().trim().min(1).max(128)).max(128).optional()
}).strict();

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validateRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExternalMcpRegistryError('External MCP endpoint must be a valid URL');
  }
  if (url.username || url.password) throw new ExternalMcpRegistryError('External MCP endpoint must not embed credentials');
  if (url.hash) throw new ExternalMcpRegistryError('External MCP endpoint must not contain a fragment');
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.toString();
  throw new ExternalMcpRegistryError('External MCP endpoint must use HTTPS, except for loopback HTTP development servers');
}

function validateEnvironment(environment: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ExternalMcpRegistryError('External MCP environment contains an invalid key');
    }
    if (DANGEROUS_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      throw new ExternalMcpRegistryError(`External MCP environment key ${key} is not allowed`);
    }
  }
  return Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
}

/** Validates persisted external-MCP data without starting a process or opening a network connection. */
export function normalizeExternalMcpServer(input: unknown): ExternalMcpServer {
  const value = inputSchema.parse(input);
  const transport: ExternalMcpTransport = value.transport === 'http' ? 'streamable-http' : value.transport;
  if (transport === 'stdio') {
    if (!value.command) throw new ExternalMcpRegistryError('A stdio MCP server requires a command');
    if (value.url) throw new ExternalMcpRegistryError('A stdio MCP server must not include an endpoint URL');
  } else {
    if (!value.url) throw new ExternalMcpRegistryError('A remote MCP server requires an endpoint URL');
    if (value.command || value.args?.length || value.cwd || value.env) {
      throw new ExternalMcpRegistryError('A remote MCP server must not include process launch settings');
    }
  }
  return {
    id: value.id,
    transport,
    enabled: value.enabled ?? false,
    ...(transport === 'stdio' ? { command: value.command!, cwd: value.cwd } : { url: validateRemoteUrl(value.url!) }),
    args: value.args ?? [],
    env: transport === 'stdio' ? validateEnvironment(value.env ?? {}) : {},
    ...(value.description ? { description: value.description } : {}),
    allowedTools: [...new Set(value.allowedTools ?? [])]
  };
}

export function safeServerPrefix(name: string): string {
  const normalized = name.trim().toLowerCase().replace(SAFE_COMPONENT, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const candidate = normalized || 'mcp-server';
  return /^[a-z]/.test(candidate) ? candidate : `mcp-${candidate}`;
}

function safeToolComponent(name: string): string {
  const normalized = name.trim().toLowerCase().replace(SAFE_COMPONENT, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return normalized || 'tool';
}

export function safeExternalToolName(serverName: string, toolName: string): string {
  return `${safeServerPrefix(serverName)}__${safeToolComponent(toolName)}`;
}
