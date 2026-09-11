import { describe, expect, it } from 'vitest';
import {
  ExternalMcpRegistryError,
  normalizeExternalMcpServer,
  safeExternalToolName,
  safeServerPrefix
} from '../src/main/mcp/external-registry.js';

describe('external MCP registry policy', () => {
  it('normalizes the legacy HTTP label and keeps new servers disabled until explicitly enabled', () => {
    const server = normalizeExternalMcpServer({
      id: 'local-docs',
      transport: 'http',
      url: 'http://127.0.0.1:8787/mcp'
    });

    expect(server.transport).toBe('streamable-http');
    expect(server.enabled).toBe(false);
    expect(server.allowedTools).toEqual([]);
  });

  it('permits an explicit enablement and a bounded allowlist', () => {
    const server = normalizeExternalMcpServer({
      id: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/v1',
      enabled: true,
      allowedTools: ['search', 'read_page']
    });

    expect(server.enabled).toBe(true);
    expect(server.allowedTools).toEqual(['search', 'read_page']);
  });

  it('gives external server tools a deterministic safe namespace', () => {
    expect(safeServerPrefix('Outlook Graph')).toBe('outlook-graph');
    expect(safeServerPrefix('9 tools')).toBe('mcp-9-tools');
    expect(safeExternalToolName('Outlook Graph', 'Send Mail')).toBe('outlook-graph__send-mail');
  });

  it('rejects unsafe remote locations and environment takeover keys', () => {
    expect(() => normalizeExternalMcpServer({
      id: 'metadata', transport: 'streamable-http', url: 'http://169.254.169.254/latest/meta-data'
    })).toThrow(ExternalMcpRegistryError);

    expect(() => normalizeExternalMcpServer({
      id: 'local', transport: 'stdio', command: 'node', env: { NODE_OPTIONS: '--require x' }
    })).toThrow(/environment/i);
  });
});
