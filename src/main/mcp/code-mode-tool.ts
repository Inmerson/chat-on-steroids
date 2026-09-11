import { currentCall, type CallContext } from './call-context.js';
import { fail, guard, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { CODE_MODE_LIMITS, codeModeSchema, runCodeMode, type CodeModeTool } from './code-mode-runtime.js';
import { toolDeclaration } from './tool-declarations.js';

/**
 * Bounded JavaScript composition over the tools already exposed by one connector.
 * Individual tools remain the authority for live permissions, validation and side effects.
 */
export const codeModeDeclaration = () =>
  toolDeclaration('exec', () => ({
    title: 'Run JavaScript',
    description:
      'Run bounded isolated JavaScript to compose this connector’s existing tools. ' +
      'Use await tools.<name>(args), Promise.all for independent calls, text(value) for explicit text output, ' +
      'and image(value) for an MCP image/data URL. Intermediate tool results stay private unless emitted. ' +
      'Fresh runtime per call; no Node, filesystem, network, imports, timers or persistent globals. ' +
      'Requires exact companion chat/session identity. Limits: 64k source, 32 MiB JS memory, 2s CPU, ' +
      '60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images and 12 MiB emitted payload.',
    inputSchema: codeModeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }));

/** Preserve a real upstream/direct tool named exec rather than replacing its contract. */
export function canAddCodeMode(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.length > 0 && !tools.some((tool) => tool.name === 'exec');
}

export function codeModeHandler(
  getTools: () => CodeModeTool[],
  invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) =>
    guard('exec', async () => {
      const parent = currentCall();
      if (!parent?.caller.requestId || !parent.caller.conversationId || !parent.caller.sessionId) {
        return fail(
          'CALLER_IDENTITY_REQUIRED: Code Mode needs this request’s exact companion chat/session proof. ' +
            'No JavaScript or nested tool ran. Individual tools remain available.'
        );
      }
      return runCodeMode(
        code,
        getTools().filter((tool) => tool.name !== 'exec'),
        (name, args) => invoke(name, args, parent),
        CODE_MODE_LIMITS
      );
    });
}

export function registerCodeMode(reg: SurfaceRegistrar): void {
  if (!canAddCodeMode(reg.descriptions())) return;
  reg.register(
    'exec',
    codeModeDeclaration(),
    codeModeHandler(() => reg.descriptions(), (name, args, parent) => reg.invokeNested(name, args, parent))
  );
}

export const CODE_MODE_INSTRUCTIONS =
  'Code Mode: when exec is listed, use {code:"…"} to compose this connector’s listed tools inside bounded isolated JavaScript. ' +
  'Call tools.<name>(args), emit only with text(...) or image(...), and keep dependent mutations sequential. ' +
  'Nested calls keep this chat/session identity and live permissions and are recorded separately.';
