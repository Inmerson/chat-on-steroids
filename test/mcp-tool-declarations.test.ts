import { expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toolDeclaration, toolSchema, toolSchemaJson } from '../src/main/mcp/tool-declarations.js';

async function rpc(
  handler: ReturnType<typeof createMcpHandler>,
  method: string,
  params: Record<string, unknown> = {}
) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  );
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

it('shares declaration work but evicts the previous dynamic description instead of accumulating generations', () => {
  let builds = 0;
  const declaration = (key: string) => toolDeclaration('cache-fixture', () => ({ value: ++builds }), key);
  const first = declaration('A');
  expect(declaration('A')).toBe(first);
  expect(declaration('B')).not.toBe(first);
  expect(declaration('A')).not.toBe(first);
  expect(builds).toBe(3);
});

it('keeps Zod input and output refinements through fresh SDK servers while sharing schema conversion', async () => {
  const input = z
    .object({ left: z.string().optional(), right: z.string().optional() })
    .refine((value) => (value.left === undefined) !== (value.right === undefined), 'choose exactly one');
  const output = z.object({ value: z.string() }).refine((value) => value.value !== 'invalid', 'invalid output');
  const servers = new Set<McpServer>();
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'schema fixture', version: '1' });
    servers.add(server);
    server.registerTool('choose', { inputSchema: toolSchema(input), outputSchema: toolSchema(output) }, async (args) => {
      calls++;
      const value = (args as { left?: string; right?: string }).left ?? (args as { right: string }).right;
      return { content: [{ type: 'text', text: value }], structuredContent: { value } };
    });
    return server;
  });
  try {
    const first = await rpc(handler, 'tools/list');
    const json = toolSchemaJson(input);
    expect(first.result.tools[0].inputSchema).toEqual({ type: 'object', ...json });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'yes' } })).result.structuredContent).toEqual({ value: 'yes' });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'a', right: 'b' } })).result.isError).toBe(true);
    expect(calls).toBe(1);
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'invalid' } })).result.isError).toBe(true);
    expect(calls).toBe(2);
    expect(servers.size).toBe(4);
    expect(toolSchemaJson(input)).toBe(json);
    expect(toolSchema(input)).toBe(toolSchema(input));
  } finally {
    await handler.close();
  }
});
