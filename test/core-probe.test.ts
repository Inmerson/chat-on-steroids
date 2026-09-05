import { describe, expect, it, vi } from 'vitest';
import { probeLocalMcp } from '../src/main/core/probe.js';

function rpc(result: unknown, id: number): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
}

describe('probeLocalMcp', () => {
  it('crosses initialize and tools/list and reports the real execution plane healthy', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      methods.push(body.method ?? '');
      if (body.method === 'initialize') {
        return rpc({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } }, 1);
      }
      return rpc({ tools: [{ name: 'read' }, { name: 'find' }] }, 2);
    });

    const result = await probeLocalMcp('http://127.0.0.1:1234/mcp/core/test-token', {
      fetchImpl: fetchImpl as typeof fetch,
      selfTestHeaders: { 'x-local-self-test': 'probe-token' },
      timeoutMs: 1000
    });

    expect(result).toMatchObject({ healthy: true, toolCount: 2 });
    expect(methods).toEqual(['initialize', 'tools/list']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports unhealthy evidence when tools/list does not return a tool array', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === 'initialize') return rpc({ protocolVersion: '2025-06-18', capabilities: {} }, 1);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'local MCP unavailable' } }), { status: 200 });
    });

    const result = await probeLocalMcp('http://127.0.0.1:1234/mcp/core/test-token', {
      fetchImpl: fetchImpl as typeof fetch,
      selfTestHeaders: { 'x-local-self-test': 'probe-token' }
    });

    expect(result.healthy).toBe(false);
    expect(result.toolCount).toBeNull();
    expect(result.detail).toContain('tools/list');
  });

  it('fails closed on timeout or network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network timeout');
    });

    const result = await probeLocalMcp('http://127.0.0.1:1234/mcp/core/test-token', {
      fetchImpl: fetchImpl as typeof fetch,
      selfTestHeaders: { 'x-local-self-test': 'probe-token' },
      timeoutMs: 10
    });

    expect(result).toMatchObject({ healthy: false, toolCount: null });
    expect(result.detail).toContain('No answer');
  });

  it('accepts an SSE JSON-RPC response from Streamable HTTP', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; id?: number };
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {} }
        : { tools: [{ name: 'read' }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200 });
    });

    const result = await probeLocalMcp('http://127.0.0.1:1234/mcp/core/test-token', {
      fetchImpl: fetchImpl as typeof fetch,
      selfTestHeaders: { 'x-local-self-test': 'probe-token' }
    });

    expect(result).toMatchObject({ healthy: true, toolCount: 1 });
  });
});
