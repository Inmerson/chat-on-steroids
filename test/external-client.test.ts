import { describe, expect, it, vi } from 'vitest';
import { ExternalMcpClientManager } from '../src/main/mcp/external-client.js';
import type { ExternalMcpServer } from '../src/main/mcp/external-registry.js';

const server: ExternalMcpServer = {
  id: 'docs', transport: 'stdio', command: 'fake-mcp', args: [], env: {}, enabled: true, allowedTools: ['search']
};

describe('external MCP client manager', () => {
  it('lazily discovers only explicitly allowed tools and forwards through the original tool name', async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      listTools: async () => ({ tools: [
        { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
        { name: 'delete_everything', inputSchema: { type: 'object' } }
      ] }),
      callTool: async ({ name }: { name: string }) => ({ content: [{ type: 'text', text: name }] }),
      close
    }));
    const manager = new ExternalMcpClientManager({ connect });

    expect(connect).not.toHaveBeenCalled();
    const tools = await manager.toolsFor(server);
    expect(tools).toEqual([expect.objectContaining({ name: 'docs__search', originalName: 'search' })]);
    await expect(manager.call(server, 'search', { query: 'MCP' })).resolves.toMatchObject({ content: [{ text: 'search' }] });
    expect(connect).toHaveBeenCalledTimes(1);
    await manager.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed for a disabled server without connecting', async () => {
    const connect = vi.fn();
    const manager = new ExternalMcpClientManager({ connect });
    await expect(manager.toolsFor({ ...server, enabled: false })).rejects.toThrow(/disabled/i);
    expect(connect).not.toHaveBeenCalled();
  });
});
