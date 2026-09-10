import type { McpServer } from '@modelcontextprotocol/server';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { pluginManager } from '../plugins/manager.js';
import { getConfig } from '../config.js';
import { noteOutcome } from './call-context.js';
import { inboundRequestId } from './inbound.js';
import { dispatch, fail, type ToolResult } from './kernel.js';

/** Dedicated raw-schema proxy for reviewed external MCP plugins. */
export function registerPluginTools(server: McpServer): PluginToolSchema[] {
  const tools = pluginManager.tools();
  server.server.setRequestHandler('tools/list', async () => ({ tools }));
  server.server.setRequestHandler('tools/call', async (request, context) => {
    const tool = tools.find((item) => item.name === request.params.name);
    const result = await dispatch(
      request.params.name,
      request.params.arguments ?? {},
      context.sessionId ?? null,
      inboundRequestId(),
      'plugins',
      async () => {
        if (getConfig().readOnly) {
          return fail('TOOL_DISABLED: external plugins are unavailable while Chat On Steroids read-only mode is on.');
        }
        return await pluginManager.call(request.params.name, request.params.arguments ?? {}, noteOutcome) as ToolResult;
      }
    );
    return server.server.projectCallToolResult(result, tool?.outputSchema);
  });
  return tools.map((tool) => ({ ...tool, description: tool.description ?? '' }));
}
