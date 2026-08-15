/**
 * MCP tool definitions.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running
 * MCP endpoint the exposed surface is monotonic: if that permission is later revoked,
 * the tool stays registered so a cached ChatGPT tool snapshot does not break, while
 * the live handler returns TOOL_DISABLED. Read-only mode is applied upstream in
 * effectiveCapabilities, so a fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so
 * every genuinely read-only tool is marked as such.
 */

import { rawPromises as fs } from '../rawfs.js';
import { clipboard, shell } from 'electron';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Capabilities, Root } from '../../shared/types.js';
import {
  DEFAULT_READ_BYTES,
  MAX_BATCH_EDIT_FILES,
  MAX_BATCH_EDIT_OPS,
  MAX_BINARY_BASE64_CHARS,
  MAX_READ_BYTES,
  appendTextFile,
  assertWritableSize,
  countFileLines,
  decodeBase64Data,
  editTextFile,
  editTextFiles,
  formatBytes,
  FsOpError,
  listDirectory,
  readImageFile,
  readTextFile,
  replaceTextFile,
  statInfo,
  type FileInfo
} from '../fsops.js';
import { logInfo, logWarn } from '../logger.js';
import { SandboxError, resolvePath, toVirtualPath } from '../sandbox.js';
import { DEFAULT_EXCLUDES, search, searchOneFile } from '../search.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_ENV_KEY_CHARS,
  MAX_ENV_VALUE_CHARS,
  MAX_ENV_VARS,
  MAX_TIMEOUT_MS,
  ExecError,
  launchCommand,
  normaliseTimeout,
  runCommand,
  runPowerShell
} from '../exec.js';
import {
  getManagedProcess,
  listManagedProcesses,
  MAX_PROCESS_INPUT_CHARS,
  ProcessError,
  startManagedProcess,
  stopManagedProcess,
  writeManagedProcess,
  type ManagedProcessStatus
} from '../process-manager.js';
import {
  ComputerError,
  DEFAULT_SCREENSHOT_WIDTH,
  MAX_SCREENSHOT_WIDTH,
  act,
  activeWindow,
  findUi,
  listWindows,
  screenshot,
  waitForWindow,
  type Action
} from '../computer/index.js';
import { serverInstructions } from './instructions.js';
import { getConfig } from '../config.js';
import {
  AgentError,
  acknowledgeOffers,
  agentConversation,
  agentForCaller,
  bindConversation,
  createAgents,
  finishAgent,
  identify,
  joinAgent,
  joinBoundConversation,
  offerMessages,
  pendingWorkerSpawns,
  PRIME_ID,
  sendMessage,
  swarmState
} from '../agents.js';
import {
  currentCaller,
  emptyEvidence,
  noteChange,
  noteChanges,
  noteCount,
  noteDetail,
  noteExec,
  noteOutcome,
  runInCallContext,
  type CallContext
} from './call-context.js';
import { liveConversations, recordAgentMessage, recordToolCall, soleGeneratingConversation } from '../session/recorder.js';
import { formatDelta } from '../diffstat.js';
import { APP_VERSION } from '../version.js';
import { findHandoff, latestHandoff, readEvents, readOverflowText } from '../session/store.js';
import type { SessionEvent, StoredText } from '../../shared/session.js';

export interface ToolContext {
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type ToolResult = { content: ToolContent[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Lines in a string, for the "+214" on a newly created file. */
function countTextLines(text: string): number {
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r\n|\n|\r/).length;
}

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by Windows';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty. Pass recursive to delete it.';
  if (code === 'EEXIST') return 'Already exists';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 */
let toolCallSeenAt: number | null = null;

export function lastToolCallAt(): number | null {
  return toolCallSeenAt;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  toolCallSeenAt = null;
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcome('rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcome('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (err instanceof SandboxError || err instanceof ComputerError || err instanceof FsOpError || err instanceof ExecError || err instanceof ProcessError || err instanceof AgentError) {
      noteOutcome('rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcome('error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
}

/**
 * The one field every tool gains while multi-agent mode is exposed.
 *
 * There is no way to tell two ChatGPT conversations apart from inside an ordinary tool
 * call: the connector transport is stateless and supplies no session id (measured, not
 * assumed — see transportIdentityStatus below), and the HTTP request is identical
 * whichever chat produced it. Without something the caller carries, a worker's file
 * edits cannot be attributed and messages cannot be handed back on ordinary results.
 *
 * So each agent gets an unguessable key when it joins and passes it here. It is added
 * centrally rather than to thirty handlers, validated centrally in dispatch, and never
 * written to disk. An agent that omits it is not guessed at: its calls are recorded as
 * unattributed and its messages wait for an explicit agent_inbox.
 */
const agentKeyArg = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe(
    'Multi-agent mode only. The agent key you were given by join_agent, or when you created the workers. ' +
      'Pass it on every call so this app knows which agent is acting and can deliver messages waiting for you. ' +
      'Leave it out if this conversation is not part of an agent run.'
  );

function agentKeyOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = (args as Record<string, unknown>)['agent_key'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether the MCP transport ever gave us a session id, once a real call has arrived.
 *
 * Recorded rather than assumed, because the entire identity design hangs on it: if a
 * future ChatGPT connector does supply a stable session, binding to it is strictly
 * better than a key the model has to remember to pass. This is what the Activity log
 * reports on the first tool call of each run.
 */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? 'MCP transport supplied a session id — agent identity can be bound to the transport'
      : 'MCP transport supplied no session id (stateless connector) — agent identity relies on per-agent keys'
  );
}

/**
 * Appends the messages waiting for this agent to the tool result.
 *
 * This is the push-like delivery: an agent that passes its key gets whatever has been
 * said to it since its last call, at the end of every result, with no polling loop. It
 * only works for a caller that identified itself — which is exactly why the key exists
 * — and the tool descriptions say so rather than promising delivery that cannot happen.
 *
 * Messages are *offered* here, not retired. They are retired when this agent calls
 * again, because that is the first real evidence this result reached ChatGPT.
 */
function withInbox(agent: string | null, result: ToolResult): ToolResult {
  if (!agent) return result;
  const messages = offerMessages(agent);
  if (messages.length === 0) return result;
  const lines = messages
    .map(
      (message) =>
        `• [${message.id}] from ${message.from}${message.offers > 1 ? ' (repeat — you may have seen this)' : ''}: ${message.text}`
    )
    .join('\n');
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- ${messages.length} message(s) for ${agent} ---\n${lines}` }
    ]
  };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each of the thirty handlers, so the arguments
 * and the result recorded are exactly the ones that crossed the wire — the recorder
 * never has to reconstruct a call from a log line — and so identity is resolved in one
 * place instead of thirty.
 */
async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  const caller = { transportKey, secret: agentKeyOf(args) };
  const agent = agentForCaller(caller);
  // This call is the proof that the previous result reached the agent's conversation,
  // so anything offered then can finally be retired and written to its history.
  if (agent) {
    for (const message of acknowledgeOffers(agent)) await recordAgentMessage(message, 'delivered');
  }
  const context: CallContext = {
    transportKey,
    agent,
    caller,
    outcome: null,
    evidence: emptyEvidence()
  };
  const startedAt = Date.now();
  const result = await runInCallContext(context, run);
  const durationMs = context.evidence.durationMs ?? Date.now() - startedAt;
  await recordToolCall({
    tool: name,
    args,
    content: result.content,
    outcome: context.outcome ?? (result.isError ? 'rejected' : 'ok'),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent
  });
  return withInbox(context.agent, result);
}

/** The working directory a command tool may use, restricted to an approved root. */
async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<string> {
  const target = virtualPath ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : '');
  if (!target) throw new SandboxError('No folder is approved, so there is nowhere to run');
  const resolved = await resolvePath(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError('cwd must be a folder');
  return resolved.real;
}

const pathArg = z.string().min(1).max(4096);
const lineNumberArg = z.number().int().min(1).max(100_000_000);
const windowIdArg = z.number().int().min(1).max(4_294_967_295);
const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
const pointArg = z.object({ x: imageCoordinateArg, y: imageCoordinateArg });
const cropArg = z.object({
  x: z.number().int().min(0).max(100_000),
  y: z.number().int().min(0).max(100_000),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000)
});
const mouseButtonArg = z.enum(['left', 'right', 'middle']);
const commandEnvArg = z
  .record(
    z.string().min(1).max(MAX_ENV_KEY_CHARS).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().max(MAX_ENV_VALUE_CHARS)
  )
  .refine((value) => Object.keys(value).length <= MAX_ENV_VARS, {
    message: `At most ${MAX_ENV_VARS} environment variables are allowed`
  })
  .describe(`Optional environment overrides. At most ${MAX_ENV_VARS}; values are not logged. CLF_* names are reserved.`);
function enabledToolNames(caps: Capabilities): string[] {
  const names = ['list_roots'];
  if (caps.browse) names.push('list_directory');
  if (caps.search) names.push('search_files');
  if (caps.read) names.push('read_file', 'read_files', 'view_image');
  if (caps.metadata) names.push('file_info');
  if (caps.create) names.push('create_file', 'create_directory');
  if (caps.edit) names.push('edit_file', 'edit_files', 'write_file', 'append_file');
  if (caps.create || caps.edit) names.push('write_binary_file');
  if (caps.move) names.push('move_path');
  if (caps.deleteFile) names.push('delete_file');
  if (caps.deleteFolder) names.push('delete_directory');
  if (caps.powershell) names.push('run_powershell');
  if (caps.command) names.push('inspect_repo', 'run_command', 'launch_app', 'process_status', 'process', 'open_url');
  if (caps.screen) names.push('screenshot', 'list_windows', 'get_active_window', 'find_ui', 'wait_for_window');
  if (caps.control) names.push('computer');
  if (caps.clipboardRead) names.push('read_clipboard');
  if (caps.clipboardWrite) names.push('write_clipboard');
  return names;
}

const computerActionArg = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: imageCoordinateArg,
    y: imageCoordinateArg,
    button: mouseButtonArg.optional()
  }),
  z.object({
    type: z.literal('double_click'),
    x: imageCoordinateArg,
    y: imageCoordinateArg,
    button: mouseButtonArg.optional()
  }),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }),
  z.object({
    type: z.literal('drag'),
    path: z.array(pointArg).min(2).max(64),
    button: mouseButtonArg.optional()
  }),
  z.object({
    type: z.literal('scroll'),
    x: imageCoordinateArg,
    y: imageCoordinateArg,
    scroll_x: z.number().int().min(-10_000).max(10_000).optional(),
    scroll_y: z.number().int().min(-10_000).max(10_000).optional()
  }),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) }),
  z.object({ type: z.literal('focus'), window: windowIdArg }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() })
]);

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'chatgpt-local-files', version: APP_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(ctx) }
  );

  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;

  /**
   * Adds the central agent capability field while multi-agent mode is exposed.
   *
   * Guarded on ZodObject because that is what every tool here uses; anything else is
   * left untouched rather than being coerced into a shape it was not written for.
   */
  const withAgentKey = <Schema extends z.ZodType>(schema: Schema): z.ZodType => {
    if (!agentToolsExposed) return schema;
    if (schema instanceof z.ZodObject) return schema.extend({ agent_key: agentKeyArg });
    return schema;
  };

  /**
   * Registers a tool. Identical to server.registerTool, except that the call runs
   * inside the recorder's context so arguments, result and evidence are captured once
   * in one place instead of thirty times at the call sites, and the caller's identity
   * is resolved once from the transport and the agent key.
   */
  const register = <Schema extends z.ZodType>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Schema;
      annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
      };
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void => {
    const registered = { ...config, inputSchema: withAgentKey(config.inputSchema) };
    server.registerTool(name, registered, ((args: z.output<Schema>, mcpCtx?: { sessionId?: string }) =>
      dispatch(name, args, mcpCtx?.sessionId ?? null, () => handler(args))) as never);
  };

  /** Refusal used when a whole feature is off but its tools are still exposed. */
  const featureDisabled = (feature: string, setting: string): ToolResult =>
    fail(
      `FEATURE_DISABLED: ${feature} is switched off in ChatGPT Local Files. ` +
        `Ask the user to enable "${setting}" in the app, then try again.`
    );

  const guarded = (cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> =>
    guard(name, async () => {
      if (!caps[cap]) {
        return fail(
          `TOOL_DISABLED: ${name} is disabled by the current ChatGPT Local Files permissions. ` +
            'Enable the permission in the app before retrying. Start a new ChatGPT conversation after permission changes if the current conversation still has the old tool list.'
        );
      }
      return fn();
    });

  // ---------------------------------------------------------------- roots

  register(
    'list_roots',
    {
      title: 'List approved folders',
      description:
        'List the virtual roots this connector can reach and what it is currently allowed to do. Call this first if you are unsure which paths exist.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () =>
      guard('list_roots', async () => {
        if (ctx.roots.length === 0) {
          return ok('No folders are approved yet. The user must add one in the ChatGPT Local Files app.');
        }
        const lines = ctx.roots.map((r) => `/${r.name}`);
        const enabled = Object.entries(caps)
          .filter(([, on]) => on)
          .map(([key]) => key)
          .join(', ');
        const tools = enabledToolNames(caps).join(', ');
        return ok(
          `${lines.join('\n')}\n\nSafety mode: ${ctx.readOnly ? 'read only' : 'normal (writes still require enabled capabilities)'}\nRead-only mode: ${ctx.readOnly ? 'on' : 'off'}\nPrivacy screenshots: ${ctx.privacyScreenshots ? 'on (defaults to foreground window)' : 'off'}\nEnabled capabilities: ${enabled || 'nothing'}\nEnabled tools: ${tools}`
        );
      })
  );

  // ---------------------------------------------------------------- browse

  if (exposedCaps.browse) {
    register(
      'list_directory',
      {
        title: 'List a folder',
        description:
          'List the contents of a folder. Entry names are relative to the folder you listed. Set recursive to walk subfolders; heavy build folders are skipped when recursing.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path, e.g. /project or /project/src'),
          recursive: z.boolean().optional().describe('Walk subfolders too. Default false.'),
          maxEntries: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe('Cap on returned entries. Default 300.'),
          exclude: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe('Folder names to skip while recursing. A trailing * means prefix match. Replaces the defaults; pass [] to recurse everywhere.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p, recursive, maxEntries, exclude }) =>
        guarded('browse', 'list_directory', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const stat = await fs.stat(resolved.real);
          if (!stat.isDirectory()) return fail(`${resolved.virtual} is a file, not a folder`);
          const limit = Math.min(2000, Math.max(1, Math.floor(maxEntries ?? 300)));
          const { entries, truncated } = await listDirectory(resolved.real, resolved.virtual, {
            recursive: recursive === true,
            maxEntries: limit,
            exclude: exclude ?? DEFAULT_EXCLUDES
          });
          logInfo(`tool list_directory ${resolved.virtual}`);
          noteCount(entries.length);
          if (entries.length === 0) return ok(`${resolved.virtual} is empty`);
          const prefixLength = resolved.virtual.length + 1;
          const body = entries
            .map((e) => {
              const rel = e.virtualPath.slice(prefixLength);
              const kind = e.type === 'directory' ? 'd' : e.type === 'file' ? 'f' : '?';
              const size = e.bytes === null ? '' : `  ${formatBytes(e.bytes)}`;
              return `${kind} ${rel}${size}`;
            })
            .join('\n');
          const note = truncated ? `\n\n(stopped at ${limit} entries — narrow the path or raise maxEntries)` : '';
          return ok(`${resolved.virtual}  —  ${entries.length} entries\n${body}${note}`);
        })
    );
  }

  // ---------------------------------------------------------------- search

  if (exposedCaps.search) {
    register(
      'search_files',
      {
        title: 'Search files',
        description:
          'Find files by name, or find text inside files. Prefer this over listing and reading everything. Content matches come back as path:line: text. Build and dependency folders are skipped unless you pass your own exclude list.',
        inputSchema: z.object({
          query: z.string().max(1000).describe('Text to look for'),
          path: pathArg.optional().describe('File or folder to search. Defaults to every approved root.'),
          mode: z
            .enum(['name', 'content'])
            .optional()
            .describe('"name" matches file names, "content" searches inside files. Default name.'),
          include: z
            .string()
            .max(200)
            .optional()
            .describe('Glob filter such as **/*.ts or *.md. Supports * ? and **.'),
          exclude: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe('Folder names to skip. A trailing * means prefix match. Replaces the defaults — pass [] to search everywhere.'),
          caseSensitive: z.boolean().optional().describe('Default false.'),
          maxResults: z.number().int().min(1).max(500).optional().describe('Default 50.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ query, path: p, mode, include, exclude, caseSensitive, maxResults }) =>
        guarded('search', 'search_files', async () => {
          const limit = Math.min(500, Math.max(1, Math.floor(maxResults ?? 50)));
          const scopes: Array<{ real: string; virtual: string }> = [];
          if (p) {
            const resolved = await resolvePath(ctx.roots, p);
            const stat = await fs.stat(resolved.real);
            if (stat.isFile()) {
              const outcome = await searchOneFile(resolved.real, resolved.virtual, {
                query,
                mode: mode ?? 'name',
                include,
                caseSensitive: caseSensitive === true,
                maxResults: limit
              });
              const hits = outcome.hits.map((hit) =>
                hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`
              );
              const meta = `files_scanned: ${outcome.filesScanned}\nelapsed_ms: ${outcome.elapsedMs}\nresults_returned: ${hits.length}`;
              noteCount(hits.length);
              return ok(hits.length === 0 ? `No matches\n\n${meta}` : `${hits.length} matches\n${hits.join('\n')}\n\n${meta}`);
            }
            if (!stat.isDirectory()) return fail(`${resolved.virtual} is not a regular file or folder`);
            scopes.push({ real: resolved.real, virtual: resolved.virtual });
          } else {
            for (const root of ctx.roots) {
              const resolved = await resolvePath(ctx.roots, `/${root.name}`);
              scopes.push({ real: resolved.real, virtual: resolved.virtual });
            }
          }
          if (scopes.length === 0) return fail('No folders are approved');

          const hits: string[] = [];
          const stopReasons = new Set<string>();
          let truncated = false;
          let scanned = 0;
          let elapsedMs = 0;
          for (const scope of scopes) {
            if (hits.length >= limit) break;
            const outcome = await search({
              realDir: scope.real,
              virtualDir: scope.virtual,
              query,
              mode: mode ?? 'name',
              include,
              exclude: exclude ?? DEFAULT_EXCLUDES,
              caseSensitive: caseSensitive === true,
              maxResults: limit - hits.length
            });
            scanned += outcome.filesScanned;
            elapsedMs += outcome.elapsedMs;
            truncated = truncated || outcome.truncated;
            if (outcome.stoppedBecause) stopReasons.add(outcome.stoppedBecause);
            for (const hit of outcome.hits) {
              hits.push(hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`);
            }
          }
          logInfo(`tool search_files mode=${mode ?? 'name'} query="${query.slice(0, 60)}"`);
          noteCount(hits.length);
          const stats = `${scanned} files scanned, ${elapsedMs} ms`;
          const reason = stopReasons.size > 0 ? [...stopReasons].join(',') : null;
          if (hits.length === 0) {
            const meta = reason
              ? `truncated: true\nreason: ${reason}\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: 0`
              : `files_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: 0`;
            return ok(`No matches\n\n${meta}`);
          }
          const note = reason
            ? `\n\ntruncated: true\nreason: ${reason}\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: ${hits.length}`
            : `\n\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: ${hits.length}`;
          return ok(`${hits.length} matches\n${hits.join('\n')}${note}`);
        })
    );
  }

  // ---------------------------------------------------------------- read

  if (exposedCaps.read) {
    register(
      'read_file',
      {
        title: 'Read a file',
        description:
          'Read a text file. Output is capped, so pass startLine and endLine for large files. The response states which lines you got. For PNG/JPEG/GIF/WebP use view_image; other binary files are refused — use file_info instead.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path, e.g. /project/src/main.ts'),
          startLine: lineNumberArg.optional().describe('First line to return, 1-based.'),
          endLine: lineNumberArg.optional().describe('Last line to return, inclusive.'),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_READ_BYTES)
            .optional()
            .describe(`Byte cap for the returned text. Default ${DEFAULT_READ_BYTES}, max ${MAX_READ_BYTES}.`)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p, startLine, endLine, maxBytes }) =>
        guarded('read', 'read_file', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const result = await readTextFile(resolved.real, { startLine, endLine, maxBytes });
          logInfo(`tool read_file ${resolved.virtual}`);
          if (result.lastLine >= result.firstLine) noteDetail(`lines ${result.firstLine}–${result.lastLine}`);
          // The total is only known when the file was read to the end; rather than
          // print "of ?", the note below tells the model where to resume instead.
          const range =
            result.lastLine < result.firstLine
              ? result.truncated && result.bytesReturned === 0
                ? `no complete line fits in the ${formatBytes(maxBytes ?? DEFAULT_READ_BYTES)} cap`
                : 'no lines in that range'
              : result.totalLines === null
                ? `lines ${result.firstLine}-${result.lastLine}`
                : `lines ${result.firstLine}-${result.lastLine} of ${result.totalLines}`;
          const note = result.truncated
            ? `\n\n(truncated at ${formatBytes(result.bytesReturned)} — continue from line ${result.lastLine + 1})`
            : result.hasMore
              ? `\n\n(more lines follow — continue from line ${result.lastLine + 1})`
              : '';
          return ok(`${resolved.virtual}  —  ${range}\n${result.text}${note}`);
        })
    );

    register(
      'read_files',
      {
        title: 'Read several files',
        description:
          'Read several text files in one call for repository work. Each item can request a line range. Total returned file text is capped across the whole call.',
        inputSchema: z.object({
          files: z
            .array(
              z.object({
                path: pathArg.describe('Virtual path'),
                startLine: lineNumberArg.optional(),
                endLine: lineNumberArg.optional(),
                maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional()
              })
            )
            .min(1)
            .max(20)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ files }) =>
        guarded('read', 'read_files', async () => {
          const sections: string[] = [];
          let remaining = MAX_READ_BYTES;
          let failures = 0;
          for (const item of files) {
            if (remaining <= 0) {
              sections.push('(batch output cap reached; call read_files again for the remaining files)');
              break;
            }
            try {
              const resolved = await resolvePath(ctx.roots, item.path);
              const cap = Math.min(item.maxBytes ?? DEFAULT_READ_BYTES, remaining);
              const result = await readTextFile(resolved.real, {
                startLine: item.startLine,
                endLine: item.endLine,
                maxBytes: cap
              });
              remaining -= result.bytesReturned;
              const range =
                result.lastLine < result.firstLine
                  ? result.truncated && result.bytesReturned === 0
                    ? `no complete line fits in the ${formatBytes(cap)} cap`
                    : 'no lines in that range'
                  : result.totalLines === null
                    ? `lines ${result.firstLine}-${result.lastLine}`
                    : `lines ${result.firstLine}-${result.lastLine} of ${result.totalLines}`;
              const note = result.truncated
                ? `\n(truncated — continue from line ${result.lastLine + 1})`
                : result.hasMore
                  ? `\n(more lines follow — continue from line ${result.lastLine + 1})`
                  : '';
              sections.push(`--- ${resolved.virtual} — ${range} ---\n${result.text}${note}`);
            } catch (err) {
              failures++;
              // Keep one stale/missing/binary path from destroying the useful reads
              // from every other requested file. The requested virtual path is safe to
              // echo; friendlyError deliberately never exposes resolved Windows paths.
              sections.push(`--- ${item.path} — ERROR ---\n${friendlyError(err)}`);
            }
          }
          logInfo(`tool read_files (${files.length} requested, ${failures} failed)`);
          noteCount(files.length);
          return ok(sections.join('\n\n'));
        })
    );

    register(
      'view_image',
      {
        title: 'View a local image',
        description:
          'Load a PNG, JPEG, GIF or WebP from an approved folder and return it as native image content for vision. Use this instead of opening the file on the desktop just to inspect it.',
        inputSchema: z.object({ path: pathArg.describe('Virtual path of the local image') }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p }) =>
        guarded('read', 'view_image', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const image = await readImageFile(resolved.real);
          logInfo(`tool view_image ${resolved.virtual} (${formatBytes(image.bytes)})`);
          return {
            content: [
              { type: 'text', text: `${resolved.virtual} — ${formatBytes(image.bytes)} (${image.mimeType})` },
              { type: 'image', data: image.data, mimeType: image.mimeType }
            ]
          };
        })
    );
  }

  // ---------------------------------------------------------------- metadata

  if (exposedCaps.metadata) {
    register(
      'file_info',
      {
        title: 'File metadata',
        description:
          'Size, timestamps, line count and binary status for one file/folder or a small batch. Pass path for one item or paths for up to 20. Set hash to also return SHA-256.',
        inputSchema: z
          .object({
            path: pathArg.optional().describe('Virtual path to one file or folder'),
            paths: z.array(pathArg).min(1).max(20).optional().describe('Virtual paths to inspect in one call'),
            hash: z.boolean().optional().describe('Also compute SHA-256 for files. Default false.')
          })
          .refine((value) => Boolean(value.path) !== Boolean(value.paths), {
            message: 'Provide exactly one of path or paths'
          }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p, paths, hash }) =>
        guarded('metadata', 'file_info', async () => {
          const requested = paths ?? [p!];
          const sections: string[] = [];
          let failures = 0;
          for (const requestedPath of requested) {
            try {
              const resolved = await resolvePath(ctx.roots, requestedPath);
              const info = await statInfo(resolved.real, resolved.virtual, { hash: hash === true });
              sections.push(formatFileInfo(info));
            } catch (err) {
              failures++;
              sections.push(`path: ${requestedPath}\nerror: ${friendlyError(err)}`);
            }
          }
          logInfo(`tool file_info (${requested.length} requested, ${failures} failed)`);
          return ok(sections.join('\n\n---\n\n'));
        })
    );
  }

  // ---------------------------------------------------------------- create

  if (exposedCaps.create) {
    register(
      'create_file',
      {
        title: 'Create a file',
        description: 'Create a new text file. Fails if the path already exists.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path of the new file'),
          content: z.string().describe('Full file contents')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ path: p, content }) =>
        guarded('create', 'create_file', async () => {
          assertWritableSize(content);
          const resolved = await resolvePath(ctx.roots, p, { allowMissing: true });
          await fs.writeFile(resolved.real, content, { encoding: 'utf8', flag: 'wx' });
          logInfo(`tool create_file ${resolved.virtual}`);
          noteChange({ path: resolved.virtual, added: countTextLines(content), removed: 0, approximate: false });
          return ok(`Created ${resolved.virtual} (${formatBytes(Buffer.byteLength(content, 'utf8'))})`);
        })
    );

    register(
      'create_directory',
      {
        title: 'Create a folder',
        description: 'Create a folder, including any missing parent folders.',
        inputSchema: z.object({ path: pathArg.describe('Virtual path of the new folder') }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p }) =>
        guarded('create', 'create_directory', async () => {
          const resolved = await resolvePath(ctx.roots, p, { allowMissing: true });
          await fs.mkdir(resolved.real, { recursive: true });
          logInfo(`tool create_directory ${resolved.virtual}`);
          return ok(`Created ${resolved.virtual}`);
        })
    );
  }

  // ---------------------------------------------------------------- edit

  if (exposedCaps.edit) {
    register(
      'edit_file',
      {
        title: 'Edit a file',
        description:
          'Replace exact snippets of text in a file. This is the preferred way to change a file — it avoids rewriting content you did not intend to touch. Each oldText must match exactly once unless replaceAll is set.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path of the file to edit'),
          edits: z
            .array(
              z.object({
                oldText: z.string().min(1).describe('Exact text to find, including indentation'),
                newText: z.string().describe('Replacement text'),
                replaceAll: z.boolean().optional().describe('Replace every occurrence. Default false.')
              })
            )
            .min(1)
            .max(64)
            .describe('Applied in order')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ path: p, edits }) =>
        guarded('edit', 'edit_file', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const result = await editTextFile(resolved.real, edits);
          noteChange({ path: resolved.virtual, ...result.delta });
          logInfo(`tool edit_file ${resolved.virtual} (${result.replacements} replacements)`);
          return ok(
            `Edited ${resolved.virtual} — ${result.replacements} replacement(s), ${formatDelta(result.delta) ?? 'no line change'}, now ${formatBytes(result.bytes)}`
          );
        })
    );

    register(
      'edit_files',
      {
        title: 'Edit several files',
        description:
          'Apply exact-snippet edits across several existing text files in one call. Every path and edit is preflighted before any target changes; completed replacements are staged first and commit failures trigger safe rollback where possible. Use this for coherent cross-file code changes.',
        inputSchema: z.object({
          files: z
            .array(
              z.object({
                path: pathArg.describe('Virtual path of the existing text file'),
                edits: z
                  .array(
                    z.object({
                      oldText: z.string().min(1).describe('Exact text to find, including indentation'),
                      newText: z.string().describe('Replacement text'),
                      replaceAll: z.boolean().optional().describe('Replace every occurrence. Default false.')
                    })
                  )
                  .min(1)
                  .max(64)
              })
            )
            .min(1)
            .max(MAX_BATCH_EDIT_FILES)
            .describe(`Up to ${MAX_BATCH_EDIT_FILES} files; at most ${MAX_BATCH_EDIT_OPS} edits total across the batch.`)
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ files }) =>
        guarded('edit', 'edit_files', async () => {
          const resolvedFiles = [];
          for (const file of files) {
            const resolved = await resolvePath(ctx.roots, file.path);
            resolvedFiles.push({ realPath: resolved.real, virtualPath: resolved.virtual, edits: file.edits });
          }
          const results = await editTextFiles(resolvedFiles);
          const replacements = results.reduce((sum, result) => sum + result.replacements, 0);
          noteChanges(results.map((result) => ({ path: result.virtualPath, ...result.delta })));
          logInfo(`tool edit_files (${results.length} files, ${replacements} replacements)`);
          return ok(
            `Edited ${results.length} file(s), ${replacements} replacement(s) total\n` +
              results
                .map(
                  (result) =>
                    `${result.virtualPath} — ${result.replacements} replacement(s), ${formatDelta(result.delta) ?? 'no line change'}, now ${formatBytes(result.bytes)}`
                )
                .join('\n')
          );
        })
    );

    register(
      'write_file',
      {
        title: 'Overwrite a file',
        description:
          'Replace a file’s entire contents. Prefer edit_file unless you are rewriting the whole file on purpose.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path of the file'),
          content: z.string().describe('New full contents')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p, content }) =>
        guarded('edit', 'write_file', async () => {
          assertWritableSize(content);
          const resolved = await resolvePath(ctx.roots, p);
          const stat = await fs.stat(resolved.real);
          if (!stat.isFile()) return fail(`${resolved.virtual} is not a file`);
          const result = await replaceTextFile(resolved.real, content);
          noteChange({ path: resolved.virtual, ...result.delta });
          logInfo(`tool write_file ${resolved.virtual}`);
          return ok(
            `Wrote ${resolved.virtual} (${formatBytes(result.bytes)}${formatDelta(result.delta) ? `, ${formatDelta(result.delta)}` : ''})`
          );
        })
    );

    register(
      'append_file',
      {
        title: 'Append to a file',
        description: 'Add text to the end of a file, creating it if it does not exist.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path of the file'),
          content: z.string().describe('Text to append')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ path: p, content }) =>
        guarded('edit', 'append_file', async () => {
          assertWritableSize(content);
          const resolved = await resolvePath(ctx.roots, p, { allowMissing: true });
          const result = await appendTextFile(resolved.real, content);
          noteChange({ path: resolved.virtual, added: result.added, removed: 0, approximate: false });
          logInfo(`tool append_file ${resolved.virtual}`);
          return ok(`Appended ${formatBytes(result.bytes)} to ${resolved.virtual}`);
        })
    );
  }

  // ------------------------------------------------------------- binary write

  if (exposedCaps.create || exposedCaps.edit) {
    register(
      'write_binary_file',
      {
        title: 'Write a binary file',
        description:
          'Write base64-encoded binary data inside an approved folder. Creates a new file by default; set overwrite=true to replace an existing file. New files require Create permission; replacing files requires Edit permission. Intended for generated images and other small assets.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual destination path'),
          dataBase64: z
            .string()
            .min(1)
            .max(MAX_BINARY_BASE64_CHARS)
            .describe('Base64-encoded file bytes, standard or URL-safe base64'),
          overwrite: z.boolean().optional().describe('Replace an existing file. Default false.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ path: p, dataBase64, overwrite }) =>
        guard('write_binary_file', async () => {
          const resolved = await resolvePath(ctx.roots, p, { allowMissing: true });
          let exists = false;
          try {
            const stat = await fs.stat(resolved.real);
            if (!stat.isFile()) return fail(`${resolved.virtual} is not a file`);
            exists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }

          if (exists) {
            if (overwrite !== true) return fail(`${resolved.virtual} already exists. Set overwrite=true to replace it.`);
            if (!caps.edit) {
              return fail('TOOL_DISABLED: replacing a binary file needs the Edit files permission.');
            }
          } else if (!caps.create) {
            return fail('TOOL_DISABLED: creating a binary file needs the Create files and folders permission.');
          }

          const data = decodeBase64Data(dataBase64);
          await fs.writeFile(resolved.real, data, { flag: exists ? 'w' : 'wx' });
          logInfo(`tool write_binary_file ${resolved.virtual} (${formatBytes(data.length)})`);
          return ok(`${exists ? 'Wrote' : 'Created'} ${resolved.virtual} (${formatBytes(data.length)})`);
        })
    );
  }

  // ---------------------------------------------------------------- move

  if (exposedCaps.move) {
    register(
      'move_path',
      {
        title: 'Move or rename',
        description: 'Move or rename a file or folder. Both paths must be inside approved folders.',
        inputSchema: z.object({
          from: pathArg.describe('Existing virtual path'),
          to: pathArg.describe('New virtual path'),
          overwrite: z.boolean().optional().describe('Replace the destination. Default false.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ from, to, overwrite }) =>
        guarded('move', 'move_path', async () => {
          const src = await resolvePath(ctx.roots, from);
          const dest = await resolvePath(ctx.roots, to, { allowMissing: true });
          if (overwrite !== true) {
            const exists = await fs
              .stat(dest.real)
              .then(() => true)
              .catch(() => false);
            if (exists) return fail(`${dest.virtual} already exists. Set overwrite to replace it.`);
          }
          await fs.rename(src.real, dest.real);
          logInfo(`tool move_path ${src.virtual} -> ${dest.virtual}`);
          noteDetail(`${src.virtual} → ${dest.virtual}`);
          return ok(`Moved ${src.virtual} to ${dest.virtual}`);
        })
    );
  }

  // ---------------------------------------------------------------- delete

  if (exposedCaps.deleteFile) {
    register(
      'delete_file',
      {
        title: 'Delete a file',
        description: 'Permanently delete a single file. This does not use the Recycle Bin.',
        inputSchema: z.object({ path: pathArg.describe('Virtual path of the file') }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p }) =>
        guarded('deleteFile', 'delete_file', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const stat = await fs.lstat(resolved.real);
          if (stat.isDirectory()) return fail('That is a folder. Use delete_directory.');
          // Counted before the file stops existing; this is the only chance to know.
          const lines = await countFileLines(resolved.real);
          await fs.unlink(resolved.real);
          logInfo(`tool delete_file ${resolved.virtual}`);
          noteChange({ path: resolved.virtual, added: 0, removed: lines ?? 0, approximate: lines === null });
          return ok(`Deleted ${resolved.virtual}`);
        })
    );
  }

  if (exposedCaps.deleteFolder) {
    register(
      'delete_directory',
      {
        title: 'Delete a folder',
        description:
          'Permanently delete a folder. Without recursive it only removes an empty folder. This does not use the Recycle Bin.',
        inputSchema: z.object({
          path: pathArg.describe('Virtual path of the folder'),
          recursive: z.boolean().optional().describe('Delete contents too. Default false.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ path: p, recursive }) =>
        guarded('deleteFolder', 'delete_directory', async () => {
          const resolved = await resolvePath(ctx.roots, p);
          const stat = await fs.lstat(resolved.real);
          if (!stat.isDirectory()) return fail('That is a file. Use delete_file.');
          // Deleting a whole approved root would silently revoke the user's own setup.
          if (resolved.virtual === `/${resolved.root.name}`) {
            return fail('Refusing to delete an approved root folder itself');
          }
          if (recursive === true) {
            await fs.rm(resolved.real, { recursive: true, force: false });
          } else {
            await fs.rmdir(resolved.real);
          }
          logInfo(`tool delete_directory ${resolved.virtual} recursive=${recursive === true}`);
          return ok(`Deleted ${resolved.virtual}`);
        })
    );
  }

  // ---------------------------------------------------------------- commands

  if (exposedCaps.powershell) {
    register(
      'run_powershell',
      {
        title: 'Run PowerShell',
        description:
          'Run a PowerShell script as the current Windows user, starting in an approved folder. IMPORTANT: the process is not sandboxed to that folder and may access anything the Windows account can access. No elevation is requested. Output and runtime are capped.',
        inputSchema: z.object({
          script: z.string().min(1).max(8000).describe('PowerShell to run'),
          cwd: pathArg.optional().describe('Approved folder to run in. Defaults to the first root.'),
          timeoutMs: z
            .number()
            .int()
            .min(1000)
            .max(MAX_TIMEOUT_MS)
            .optional()
            .describe(`Timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`)
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ script, cwd, timeoutMs }) =>
        guarded('powershell', 'run_powershell', async () => {
          const dir = await resolveCwd(ctx, cwd);
          logInfo(`tool run_powershell (${script.length} chars)`);
          const result = await runPowerShell(script, dir, normaliseTimeout(timeoutMs));
          noteExec(result);
          return result.timedOut ? fail(formatExec(result)) : ok(formatExec(result));
        })
    );
  }

  if (exposedCaps.command) {
    register(
      'inspect_repo',
      {
        title: 'Inspect a Git repository',
        description:
          'Read-only Git inspection in an approved folder. Supports status, HEAD, diff, show and log without accepting arbitrary Git flags. It invokes git directly (no shell), disables pagers, fsmonitor, external diffs and textconv, performs no network access, and does not mutate the repository.',
        inputSchema: z.object({
          action: z.enum(['status', 'head', 'diff', 'show', 'log']).describe('Read-only repository query.'),
          cwd: pathArg.optional().describe('Approved repository folder. Defaults to the first root.'),
          staged: z.boolean().optional().describe('diff only: inspect the staged diff instead of the working-tree diff.'),
          ref: z.string().min(1).max(200).optional().describe('show only: revision to inspect. Defaults to HEAD. Values beginning with - are refused.'),
          count: z.number().int().min(1).max(100).optional().describe('log only: number of commits. Default 20.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ action, cwd, staged, ref, count }) =>
        guarded('command', 'inspect_repo', async () => {
          const dir = await resolveCwd(ctx, cwd);
          if (ref?.startsWith('-')) return fail('ref must not begin with -');
          const common = [
            '-c',
            'core.pager=cat',
            '-c',
            'pager.status=false',
            '-c',
            'pager.log=false',
            '-c',
            'pager.diff=false',
            '-c',
            'core.fsmonitor=false'
          ];
          let args: string[];
          if (action === 'status') {
            args = [...common, 'status', '--short', '--branch', '--untracked-files=normal'];
          } else if (action === 'head') {
            args = [...common, 'rev-parse', '--abbrev-ref', 'HEAD', 'HEAD'];
          } else if (action === 'diff') {
            args = [
              ...common,
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              ...(staged === true ? ['--cached'] : [])
            ];
          } else if (action === 'show') {
            args = [
              ...common,
              'show',
              '--no-ext-diff',
              '--no-textconv',
              '--format=fuller',
              '--stat',
              '--patch',
              ref ?? 'HEAD'
            ];
          } else {
            args = [...common, 'log', '--oneline', '--decorate=short', '-n', String(count ?? 20)];
          }
          logInfo(`tool inspect_repo ${action}`);
          const result = await runCommand('git', args, dir, DEFAULT_TIMEOUT_MS, { GIT_OPTIONAL_LOCKS: '0' });
          noteExec(result);
          noteDetail(`git ${action}`);
          return result.timedOut || (result.exitCode !== null && result.exitCode !== 0)
            ? fail(formatExec(result))
            : ok(formatExec(result));
        })
    );

    register(
      'run_command',
      {
        title: 'Run a command',
        description:
          'Run a program as the current Windows user, starting in an approved folder. IMPORTANT: the process is not sandboxed to that folder and may access anything the Windows account can access. Arguments are passed literally; shell syntax such as pipes is not interpreted.',
        inputSchema: z.object({
          command: z.string().min(1).max(500).describe('Executable name or path, e.g. git'),
          args: z.array(z.string().max(2000)).max(128).optional().describe('Arguments, one per array item'),
          cwd: pathArg.optional().describe('Approved folder to run in. Defaults to the first root.'),
          env: commandEnvArg.optional(),
          timeoutMs: z
            .number()
            .int()
            .min(1000)
            .max(MAX_TIMEOUT_MS)
            .optional()
            .describe(`Timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`)
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ command, args, cwd, env, timeoutMs }) =>
        guarded('command', 'run_command', async () => {
          const dir = await resolveCwd(ctx, cwd);
          logInfo(`tool run_command ${command}`);
          const result = await runCommand(command, args ?? [], dir, normaliseTimeout(timeoutMs), env);
          noteExec(result);
          noteDetail([command, ...(args ?? [])].join(' ').slice(0, 120));
          return result.timedOut ? fail(formatExec(result)) : ok(formatExec(result));
        })
    );

    register(
      'launch_app',
      {
        title: 'Launch an app',
        description:
          'Spawn an executable as the current Windows user and return immediately with its process id. This only confirms that Windows accepted the spawn; use process for long-running work whose output or exit status you need to inspect.',
        inputSchema: z.object({
          command: z.string().min(1).max(500).describe('Executable name or path, e.g. notepad.exe'),
          args: z.array(z.string().max(2000)).max(128).optional().describe('Literal arguments, one per array item'),
          cwd: pathArg.optional().describe('Approved folder to start in. Defaults to the first root.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ command, args, cwd }) =>
        guarded('command', 'launch_app', async () => {
          const dir = await resolveCwd(ctx, cwd);
          const result = await launchCommand(command, args ?? [], dir);
          return ok(`Process spawned: ${command} (pid ${result.pid}). Execution after spawn is not verified.`);
        })
    );

    register(
      'process_status',
      {
        title: 'Inspect background processes',
        description:
          'Read-only status for managed long-running processes. Lists managed processes or returns bounded stdout/stderr for one process. It cannot start, write to or stop anything.',
        inputSchema: z.object({
          id: z.string().min(1).max(32).optional().describe('Managed process id. Omit to list all managed processes.'),
          lines: z.number().int().min(1).max(200).optional().describe('Lines per stream. Default 80.'),
          cursor: z.string().min(1).max(100).optional().describe('Previous opaque cursor for delta-only output.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ id, lines, cursor }) =>
        guarded('command', 'process_status', async () => {
          if (!id) {
            const entries = listManagedProcesses();
            if (entries.length === 0) return ok('No managed processes in this app session.');
            return ok(entries.map((entry) => formatManagedProcess(entry, false)).join('\n'));
          }
          return ok(formatManagedProcess(getManagedProcess(id, lines ?? 80, cursor)));
        })
    );

    register(
      'process',
      {
        title: 'Manage a background process',
        description:
          'Start, inspect, write to or stop a managed long-running process such as a dev server, watcher, build or test run. Output is bounded; reuse opaque cursors for delta-only logs. start supports bounded environment overrides; write sends stdin without a shell and can optionally close stdin. Stop has bounded graceful and forced tree termination. Managed processes are also stopped when this app quits.',
        // Keep this flat rather than a top-level discriminated union: some MCP hosts
        // collapse union schemas to an unhelpful generic object and hide every action field.
        inputSchema: z.object({
          action: z.enum(['start', 'status', 'write', 'stop']).describe('Operation to perform.'),
          command: z.string().min(1).max(500).optional().describe('start: executable name or path, e.g. npm'),
          args: z.array(z.string().max(2000)).max(128).optional().describe('start: literal arguments, one per array item'),
          cwd: pathArg.optional().describe('start: approved folder. Defaults to the first root.'),
          env: commandEnvArg.optional().describe('start: optional environment overrides; values are never logged.'),
          id: z.string().min(1).max(32).optional().describe('status/write/stop: managed process id. status may omit it to list all.'),
          text: z.string().max(MAX_PROCESS_INPUT_CHARS).optional().describe('write: text to send to stdin.'),
          newline: z.boolean().optional().describe('write: append a newline after text. Default true.'),
          close: z.boolean().optional().describe('write: close stdin after writing. Default false.'),
          lines: z.number().int().min(1).max(200).optional().describe('status/write/stop: lines per stream. Default 80.'),
          cursor: z.string().min(1).max(100).optional().describe('status/write/stop: previous opaque cursor for delta-only output.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async (input) =>
        guarded('command', 'process', async () => {
          if (input.action === 'start') {
            if (!input.command) return fail('process start requires command');
            const dir = await resolveCwd(ctx, input.cwd);
            const result = await startManagedProcess(input.command, input.args ?? [], dir, input.env);
            logInfo(`tool process start ${input.command} -> ${result.id}`);
            return ok(formatManagedProcess(result));
          }
          if (input.action === 'status') {
            if (!input.id) {
              const entries = listManagedProcesses();
              if (entries.length === 0) return ok('No managed processes in this app session.');
              return ok(entries.map((entry) => formatManagedProcess(entry, false)).join('\n'));
            }
            return ok(formatManagedProcess(getManagedProcess(input.id, input.lines ?? 80, input.cursor)));
          }
          if (!input.id) return fail(`process ${input.action} requires id`);
          if (input.action === 'write') {
            if (input.text === undefined && input.close !== true) return fail('process write requires text or close=true');
            const result = await writeManagedProcess(
              input.id,
              input.text ?? '',
              input.newline ?? true,
              input.close ?? false,
              input.lines ?? 80,
              input.cursor
            );
            logInfo(`tool process write ${input.id} (${input.text?.length ?? 0} chars${input.close ? ', close' : ''})`);
            return ok(formatManagedProcess(result));
          }
          const result = await stopManagedProcess(input.id, input.lines ?? 80, input.cursor);
          logInfo(`tool process stop ${input.id}`);
          return ok(formatManagedProcess(result));
        })
    );

    register(
      'open_url',
      {
        title: 'Open a URL',
        description:
          'Open an http or https URL in the Windows default browser. This changes the desktop but does not interpret shell syntax.',
        inputSchema: z.object({ url: z.string().url().max(4000) }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      async ({ url }) =>
        guarded('command', 'open_url', async () => {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return fail('Only http and https URLs are allowed');
          }
          await shell.openExternal(parsed.toString());
          noteDetail(`${parsed.origin}${parsed.pathname}`);
          return ok(`Opened ${parsed.origin}${parsed.pathname}`);
        })
    );
  }

  // ---------------------------------------------------------------- clipboard

  if (exposedCaps.clipboardRead) {
    register(
      'read_clipboard',
      {
        title: 'Read clipboard',
        description:
          'Read current text from the Windows clipboard. This permission is separate because clipboard contents may be sensitive. Output is capped.',
        inputSchema: z.object({
          maxChars: z.number().int().min(1).max(100_000).optional().describe('Default 20000, max 100000.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ maxChars }) =>
        guarded('clipboardRead', 'read_clipboard', async () => {
          const limit = Math.min(100_000, Math.max(1, Math.floor(maxChars ?? 20_000)));
          const text = clipboard.readText();
          if (text.length <= limit) return ok(text || '(clipboard has no text)');
          return ok(`${text.slice(0, limit)}\n\n(truncated at ${limit} characters; clipboard contains ${text.length})`);
        })
    );
  }

  if (exposedCaps.clipboardWrite) {
    register(
      'write_clipboard',
      {
        title: 'Write clipboard',
        description:
          'Replace the Windows clipboard text directly, without focusing a field or synthesizing keystrokes.',
        inputSchema: z.object({ text: z.string().max(100_000) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
      },
      async ({ text }) =>
        guarded('clipboardWrite', 'write_clipboard', async () => {
          clipboard.writeText(text);
          return ok(`Clipboard text replaced (${text.length} characters)`);
        })
    );
  }

  // ---------------------------------------------------------------- computer

  if (exposedCaps.screen) {
    register(
      'screenshot',
      {
        title: 'See the screen',
        description:
          'Take a picture of the screen. Coordinates in the picture are what every pointing action expects. Defaults to the main monitor; pass a window id to photograph one window. To reduce image size after a broad screenshot, pass crop in coordinates of the most recent returned frame.',
        inputSchema: z.object({
          window: windowIdArg.optional().describe('Window id from list_windows. Omit for the whole screen.'),
          full: z
            .boolean()
            .optional()
            .describe('Include every monitor instead of only the main one. Default false.'),
          maxWidth: z
            .number()
            .int()
            .min(320)
            .max(MAX_SCREENSHOT_WIDTH)
            .optional()
            .describe(`Width to scale to. Default ${DEFAULT_SCREENSHOT_WIDTH}, max ${MAX_SCREENSHOT_WIDTH}.`),
          crop: cropArg
            .optional()
            .describe('Crop in pixels of the most recent returned screenshot frame. Cannot be combined with window or full.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ window, full, maxWidth, crop }) =>
        guarded('screen', 'screenshot', async () => {
          let targetWindow = window;
          if (ctx.privacyScreenshots && targetWindow === undefined && full !== true && crop === undefined) {
            targetWindow = (await activeWindow()).window?.id;
          }
          const shot = await screenshot({ window: targetWindow, full, maxWidth, crop });
          logInfo(`tool screenshot ${shot.width}x${shot.height}`);
          noteDetail(`${shot.width}×${shot.height}`);
          return {
            content: [
              {
                type: 'text',
                text:
                  `Screen frame ${shot.frameId}, ${shot.width}x${shot.height}. ` +
                  `Point using image coordinates from this frame. Desktop region: ` +
                  `${shot.region.x},${shot.region.y} ${shot.region.width}x${shot.region.height}.`
              },
              { type: 'image', data: shot.data, mimeType: 'image/png' }
            ]
          };
        })
    );

    register(
      'list_windows',
      {
        title: 'List open windows',
        description:
          'List the visible windows, with the program that owns each one, where it is and whether it is in front or minimised. Use the id to focus or photograph a window.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async () =>
        guarded('screen', 'list_windows', async () => {
          const { windows, screen } = await listWindows();
          logInfo(`tool list_windows (${windows.length})`);
          noteCount(windows.length);
          if (windows.length === 0) return ok('No visible windows.');
          const lines = windows.map(
            (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
          );
          return ok(
            `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
          );
        })
    );

    register(
      'get_active_window',
      {
        title: 'Get active window',
        description:
          'Cheaply report the current foreground window and its bounds without taking a screenshot. Use this to verify focus changes.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async () =>
        guarded('screen', 'get_active_window', async () => {
          const { window, screen } = await activeWindow();
          logInfo(`tool get_active_window ${window?.id ?? 'none'}`);
          if (!window) return ok(`Desktop ${screen.width}x${screen.height}\nNo foreground window.`);
          return ok(
            `id: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\nbounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
          );
        })
    );

    register(
      'find_ui',
      {
        title: 'Find UI elements',
        description:
          'Find Windows UI Automation elements by visible name/text and/or role, defaulting to the active window. If the element is inside the most recent screenshot frame, image-center coordinates are returned for direct use with computer clicks.',
        inputSchema: z.object({
          window: windowIdArg.optional().describe('Window id. Defaults to the foreground window.'),
          query: z.string().max(300).optional().describe('Case-insensitive substring of element name or automation id.'),
          role: z.string().max(100).optional().describe('Case-insensitive role such as Button, Edit, CheckBox or TabItem.'),
          maxResults: z.number().int().min(1).max(100).optional().describe('Default 30, max 100.')
        }).refine((value) => Boolean(value.query || value.role), {
          message: 'Provide query or role'
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ window, query, role, maxResults }) =>
        guarded('screen', 'find_ui', async () => {
          const result = await findUi({ window, query, role, maxResults });
          noteCount(result.elements.length);
          if (result.elements.length === 0) return ok(`No matching UI elements in window ${result.window}.`);
          const lines = result.elements.map((element, index) => {
            const desktop = `${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`;
            const image = element.imageCenter
              ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}`
              : '';
            const id = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
            const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
            return `${index + 1}. ${element.role} ${JSON.stringify(element.name)}${id} desktop=${desktop}${image}${flags}`;
          });
          return ok(`window: ${result.window}\n${lines.join('\n')}`);
        })
    );

    register(
      'wait_for_window',
      {
        title: 'Wait for a window',
        description:
          'Wait inside one tool call until a visible window matching a title and/or process appears. Set foreground=true to wait until it is the active window instead of polling with fixed sleeps.',
        inputSchema: z.object({
          title: z.string().min(1).max(300).optional().describe('Case-insensitive title substring'),
          process: z.string().min(1).max(200).optional().describe('Case-insensitive process-name substring'),
          foreground: z.boolean().optional().describe('Require the matching window to be foreground. Default false.'),
          timeoutMs: z.number().int().min(0).max(60_000).optional().describe('Default 10000, max 60000.')
        }).refine((value) => Boolean(value.title || value.process), {
          message: 'Provide title or process'
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      async ({ title, process, foreground, timeoutMs }) =>
        guarded('screen', 'wait_for_window', async () => {
          const window = await waitForWindow({ title, process, foreground, timeoutMs });
          return ok(
            `id: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\nbounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
          );
        })
    );
  }

  if (exposedCaps.control) {
    register(
      'computer',
      {
        title: 'Control mouse and keyboard',
        description:
          'Perform actions on the desktop, in order. Coordinates are pixels in the most recent screenshot, so take one first. Batch the steps that belong together — click a field, type into it, press Enter — then take another screenshot to see what happened.',
        inputSchema: z.object({
          actions: z.array(computerActionArg).min(1).max(32),
          captureAfter: z
            .boolean()
            .optional()
            .describe('Return a fresh screenshot in this same tool call after the actions. Default false.'),
          captureWindow: windowIdArg
            .optional()
            .describe('When captureAfter is true, capture this window id instead of the primary monitor.'),
          captureFull: z
            .boolean()
            .optional()
            .describe('When captureAfter is true, include all monitors. Default false.'),
          captureMaxWidth: z
            .number()
            .int()
            .min(320)
            .max(MAX_SCREENSHOT_WIDTH)
            .optional()
            .describe(`When captureAfter is true, screenshot width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
          captureCrop: cropArg
            .optional()
            .describe('When captureAfter is true, crop using coordinates of the frame that was active before the actions.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ actions, captureAfter, captureWindow, captureFull, captureMaxWidth, captureCrop }) =>
        guarded('control', 'computer', async () => {
          const parsed: Action[] = [];
          for (const a of actions) {
            switch (a.type) {
              case 'click':
              case 'double_click':
                parsed.push({ type: a.type, x: a.x, y: a.y, button: a.button });
                break;
              case 'move':
                parsed.push({ type: 'move', x: a.x, y: a.y });
                break;
              case 'scroll':
                if (a.x === undefined || a.y === undefined) return fail('scroll needs x and y');
                parsed.push({ type: 'scroll', x: a.x, y: a.y, scroll_x: a.scroll_x, scroll_y: a.scroll_y });
                break;
              case 'drag':
                if (!a.path || a.path.length < 2) return fail('drag needs a path of at least two points');
                parsed.push({ type: 'drag', path: a.path, button: a.button });
                break;
              case 'type':
                if (a.text === undefined) return fail('type needs text');
                parsed.push({ type: 'type', text: a.text });
                break;
              case 'keypress':
                if (!a.keys || a.keys.length === 0) return fail('keypress needs keys');
                parsed.push({ type: 'keypress', keys: a.keys });
                break;
              case 'focus':
                if (a.window === undefined) return fail('focus needs a window id');
                parsed.push({ type: 'focus', window: a.window });
                break;
              case 'wait':
                parsed.push({ type: 'wait', ms: a.ms });
                break;
            }
          }
          logInfo(`tool computer ${parsed.map((a) => a.type).join(', ')}`);
          noteDetail(parsed.map((a) => a.type).join(', '));
          const result = await act(parsed);
          const cursor = result.cursor;
          const pointer = cursor.image
            ? `Pointer image: ${cursor.image.x},${cursor.image.y} (frame ${cursor.frameId}, ${cursor.imageSize?.width}x${cursor.imageSize?.height}); desktop: ${cursor.screen.x},${cursor.screen.y}.`
            : `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. No screenshot frame is active.`;
          const done = `Done: ${parsed.map((a) => a.type).join(', ')}. ${pointer}`;
          if (captureAfter === true) {
            if (!caps.screen) {
              return fail('TOOL_DISABLED: captureAfter needs the See the screen permission.');
            }
            let targetWindow = captureWindow;
            if (
              ctx.privacyScreenshots &&
              targetWindow === undefined &&
              captureFull !== true &&
              captureCrop === undefined
            ) {
              targetWindow = (await activeWindow()).window?.id;
            }
            const shot = await screenshot({
              window: targetWindow,
              full: captureFull,
              maxWidth: captureMaxWidth,
              crop: captureCrop
            });
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `${done}\nCaptured frame ${shot.frameId}, ${shot.width}x${shot.height}. ` +
                    `Use this new frame for the next pointing coordinates.`
                },
                { type: 'image', data: shot.data, mimeType: 'image/png' }
              ]
            };
          }
          return ok(done);
        })
    );
  }

  // ---------------------------------------------------------------- session

  if (sessionToolsExposed) {
    register(
      'resume_session',
      {
        title: 'Resume a previous session',
        description:
          'Fetch the handoff brief written when the previous ChatGPT session was compacted, and continue that work. Call this first if the user says you are continuing earlier work. Long briefs arrive in parts — keep calling with the next part until the brief says it is complete.',
        inputSchema: z.object({
          handoffId: z
            .string()
            .max(64)
            .optional()
            .describe('Specific handoff id. Omit for the most recent one.'),
          part: z.number().int().min(1).max(50).optional().describe('Part number to fetch. Default 1.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ handoffId, part }) =>
        guard('resume_session', async () => {
          if (!sessionToolsLive) return featureDisabled('Session recording', 'Record sessions');
          const handoff = handoffId ? await findHandoff(handoffId) : await latestHandoff();
          if (!handoff) {
            return fail(
              'No handoff has been saved. Ask the user to press "Compact & Resume in New Chat" in ChatGPT Local Files, or just ask them what to continue.'
            );
          }
          const parts = chunkText(handoff.text, MAX_RESUME_CHARS);
          const index = Math.min(Math.max(1, Math.floor(part ?? 1)), parts.length);
          const header =
            `Handoff ${handoff.id} · session ${handoff.sessionId} · written ${new Date(handoff.createdAt).toISOString()} ` +
            `by ${handoff.model} · part ${index} of ${parts.length}`;
          const notes = handoff.notes.length > 0 ? `\nCaveats: ${handoff.notes.join('; ')}` : '';
          const more =
            index < parts.length
              ? `\n\n(continues — call resume_session with part=${index + 1})`
              : `\n\n(end of brief. Use session_history with sessionId "${handoff.sessionId}" if you need the underlying detail.)`;
          noteDetail(`part ${index}/${parts.length}`);
          return ok(`${header}${notes}\n\n${parts[index - 1] ?? ''}${more}`);
        })
    );

    register(
      'session_history',
      {
        title: 'Look inside a recorded session',
        description:
          'Search the raw local recording of a session — user messages, tool calls, errors — when the handoff brief is not specific enough. Returns compact entries; pass callId to get the exact arguments and result of one recorded tool call.',
        inputSchema: z.object({
          sessionId: z.string().max(64).optional().describe('Session id. Omit to use the most recent handoff’s session.'),
          query: z.string().max(200).optional().describe('Case-insensitive text filter.'),
          kind: z
            .enum(['user_message', 'assistant_message', 'tool_call', 'chat_error', 'progress', 'handoff'])
            .optional()
            .describe('Only entries of this kind.'),
          callId: z.string().max(64).optional().describe('Return the full record of one tool call.'),
          part: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('With callId: which part of a large recorded call to return. Default 1.'),
          from: z.number().int().min(0).max(10_000_000).optional().describe('First sequence number to return.'),
          limit: z.number().int().min(1).max(100).optional().describe('Maximum entries. Default 40.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ sessionId, query, kind, callId, part, from, limit }) =>
        guard('session_history', async () => {
          if (!sessionToolsLive) return featureDisabled('Session recording', 'Record sessions');
          const id = sessionId ?? (await latestHandoff())?.sessionId ?? null;
          if (!id) return fail('No recorded session is available.');
          const events = await readEvents(id, kind ? { kinds: [kind] } : {});
          if (events.length === 0) return fail(`Session ${id} has no recorded events.`);

          if (callId) {
            const found = events.find((event) => event.kind === 'tool_call' && event.call.callId === callId);
            if (!found || found.kind !== 'tool_call') return fail(`No recorded tool call with id ${callId}.`);
            const call = found.call;
            // Anything too long for the log line was written beside it in full, so the
            // exact edit payload or command output is genuinely recoverable rather
            // than described as exact and quietly cut.
            const args = await expandStored(id, call.args);
            const result = await expandStored(id, call.result);
            const whole =
              `#${found.seq} ${call.tool} — ${call.outcome} in ${call.durationMs} ms\n` +
              `arguments (${call.args.chars} chars${args.complete ? '' : ', partial'}):\n${args.text}\n\n` +
              `result (${call.result.chars} chars${result.complete ? '' : ', partial'}):\n${result.text}`;
            const parts = chunkText(whole, MAX_RESUME_CHARS);
            const index = Math.min(Math.max(1, Math.floor(part ?? 1)), parts.length);
            noteDetail(`part ${index}/${parts.length}`);
            const more =
              index < parts.length ? `\n\n(continues — call again with part=${index + 1})` : '';
            return ok(
              `${parts[index - 1] ?? ''}${more}` +
                (parts.length > 1 ? `\n[part ${index} of ${parts.length}]` : '')
            );
          }

          const needle = query?.toLowerCase() ?? null;
          const cap = Math.min(100, Math.max(1, Math.floor(limit ?? 40)));
          const lines: string[] = [];
          for (const event of events) {
            if (from !== undefined && event.seq < from) continue;
            const line = describeEvent(event);
            if (needle && !line.toLowerCase().includes(needle)) continue;
            lines.push(line);
            if (lines.length >= cap) break;
          }
          noteCount(lines.length);
          if (lines.length === 0) return ok(`No matching entries in session ${id}.`);
          return ok(
            `Session ${id} — ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} of ${events.length} recorded\n` +
              lines.join('\n') +
              '\n\n(pass callId to expand a tool call, or from/limit to page)'
          );
        })
    );
  }

  // ----------------------------------------------------------------- agents

  if (agentToolsExposed) {
    /** Every broker tool needs the feature on and the caller proven. */
    const agentGuard = (name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> =>
      guard(name, async () => {
        if (!agentToolsLive) return featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
        return fn();
      });

    register(
      'create_agents',
      {
        title: 'Create worker agents',
        description:
          'Create worker agents for parts of the current task. Each worker opens in its own ChatGPT conversation and reports back to you. You are the prime agent: workers cannot talk to each other, only to you. The first call establishes you as prime and returns your agent key — pass it as agent_key on every later call.',
        inputSchema: z.object({
          workers: z
            .array(
              z.object({
                label: z.string().max(60).optional().describe('Short name shown to the user'),
                task: z.string().min(1).max(4000).describe('Self-contained brief. The worker sees only this.')
              })
            )
            .min(1)
            .max(8)
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      async ({ workers }) =>
        agentGuard('create_agents', async () => {
          const primeConversation = soleGeneratingConversation();
          const { created, primeSecret } = createAgents({ workers, caller: currentCaller() });
          // The first create_agents call itself is still attributed by the active turn,
          // because no prime key existed before it. Bind that proven conversation to
          // prime immediately so every later keyed call stays in the same session and
          // the extension can match it back to ChatGPT's tool blocks.
          if (primeSecret && primeConversation) bindConversation(PRIME_ID, primeConversation);
          // The key is returned to the model and nowhere else: it is stripped from the
          // recorded history, the Activity feed and the logs, so this reply is the only
          // copy that exists.
          const keyLine = primeSecret
            ? `\n\nYour prime agent key is: ${primeSecret}\nPass it as agent_key on every tool call from now on. ` +
              'It is deliberately not stored anywhere in this app, so keep using it from this conversation.'
            : '';
          return ok(
            `Created ${created.length} worker(s):\n` +
              created.map((info) => `${info.id} — ${info.label}`).join('\n') +
              keyLine +
              '\n\nTheir chats are being opened. Each will call join_agent and then report to you. ' +
              'While you pass agent_key, messages addressed to you arrive at the end of every tool result; ' +
              'without it, call agent_inbox to collect them.'
          );
        })
    );

    register(
      'join_agent',
      {
        title: 'Join as a worker agent',
        description:
          'Register this fresh ChatGPT conversation as the worker/prime agent the paired extension opened. Normally call with no arguments; joinKey is only a manual/recovery fallback. Returns your task and agent key.',
        inputSchema: z.object({
          joinKey: z.string().min(8).max(200).optional().describe('Optional one-time fallback key from an older/manual bootstrap')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ joinKey }) =>
        agentGuard('join_agent', async () => {
          let conversation: string | null = null;
          if (!joinKey) {
            const generating = new Set(
              liveConversations().filter((entry) => entry.generating).map((entry) => entry.conversationId)
            );
            const workerCandidates = pendingWorkerSpawns()
              .map((worker) => agentConversation(worker.id))
              .filter((id): id is string => Boolean(id && generating.has(id)));
            if (workerCandidates.length > 1) {
              throw new AgentError(
                'More than one invited worker is trying to join at once. The browser bootstrap queue should serialize joins; retry in a moment.'
              );
            }
            conversation = workerCandidates[0] ?? null;
            // Compact & Resume can hand the existing prime identity to a fresh chat.
            // Prefer an invited worker above, because create_agents normally runs while
            // the prime's own turn is still generating too.
            if (!conversation) {
              const prime = agentConversation(PRIME_ID);
              if (prime && generating.has(prime)) conversation = prime;
            }
          }
          const { info, secret } = joinKey
            ? joinAgent(joinKey, currentCaller())
            : conversation
              ? joinBoundConversation(conversation, currentCaller())
              : (() => {
                  throw new AgentError(
                    'Cannot safely identify this agent chat right now. The paired extension must bind the fresh conversation before join_agent runs. Retry in a moment.'
                  );
                })();
          const keyLine = secret
            ? `Your agent key is: ${secret}\nPass it as agent_key on every tool call from now on — it is how this app knows the work is yours and how messages reach you.\n\n`
            : 'You are already joined; keep using the agent key you were given.\n\n';
          return ok(
            `You are ${info.id} (${info.label}).\n\n${keyLine}Your task:\n${info.task}\n\n` +
              'Report progress and results to the prime agent with send_agent_message, and call finish_agent when you are done. ' +
              'You cannot message other workers.'
          );
        })
    );

    register(
      'send_agent_message',
      {
        title: 'Message another agent',
        description:
          'Send a message. Workers may only message the prime agent; the prime may message any worker. It reaches the recipient on its next tool call if it passes its agent key, and otherwise when it calls agent_inbox.',
        inputSchema: z.object({
          to: z.string().min(1).max(40).describe('Recipient agent id, e.g. prime or worker-2'),
          text: z.string().min(1).max(4000)
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ to, text }) =>
        agentGuard('send_agent_message', async () => {
          const message = sendMessage(currentCaller(), to, text);
          await recordAgentMessage(message, 'sent');
          return ok(`Sent to ${to} (message ${message.id}).`);
        })
    );

    register(
      'agent_inbox',
      {
        title: 'Read agent messages',
        description:
          'Collect the messages waiting for you. If you pass agent_key on your ordinary tool calls, messages also arrive at the end of those results and you rarely need this.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async () =>
        agentGuard('agent_inbox', async () => {
          // Identity is proven the same way as anywhere else; dispatch has already
          // offered and acknowledged for this caller, so this is only the report.
          const info = identify(currentCaller());
          const pending = swarmState().agents.find((entry) => entry.id === info.id)?.pending ?? 0;
          if (pending === 0) return ok(`No messages waiting for ${info.id}.`);
          return ok(`${pending} message(s) waiting for ${info.id}; they are appended to this result.`);
        })
    );

    register(
      'agent_status',
      {
        title: 'Agent status',
        description: 'List every agent in this run, what it was asked to do, and whether it is still working.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async () =>
        agentGuard('agent_status', async () => {
          const state = swarmState();
          if (state.agents.length === 0) return ok('No agents have been created.');
          return ok(
            state.agents
              .map(
                (info) =>
                  `${info.id}  ${info.role}  ${info.state}  waiting ${info.pending} (${info.awaitingAck} unacknowledged)  ${info.label}` +
                  (info.result ? `\n    result: ${info.result.slice(0, 300)}` : '')
              )
              .join('\n')
          );
        })
    );

    register(
      'finish_agent',
      {
        title: 'Finish as an agent',
        description:
          'Mark yourself finished and hand your result to the prime agent. Include what you changed and anything left undone.',
        inputSchema: z.object({
          result: z.string().min(1).max(4000).describe('What you did, what is left, what broke')
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ result }) =>
        agentGuard('finish_agent', async () => {
          const { info, report } = finishAgent(currentCaller(), result);
          if (report) await recordAgentMessage(report, 'sent');
          return ok(`${info.id} marked finished. The prime agent has your result.`);
        })
    );
  }

  return server;
}

/** Per-part cap for a handoff returned through resume_session. */
const MAX_RESUME_CHARS = 12_000;

/**
 * Recovers the complete text behind a stored field.
 *
 * A long tool argument or result is bounded inline in the log and written whole beside
 * it; this reads the whole one back so recovery means the exact payload rather than
 * its first eight thousand characters. `complete` is false only when even the overflow
 * copy could not be written, and the caller says so instead of implying otherwise.
 */
async function expandStored(
  sessionId: string,
  stored: StoredText
): Promise<{ text: string; complete: boolean }> {
  if (!stored.truncated) return { text: stored.text, complete: true };
  if (stored.assetId) {
    const full = await readOverflowText(sessionId, stored.assetId);
    if (full !== null) return { text: full, complete: true };
  }
  return { text: stored.text, complete: false };
}

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size) parts.push(block.slice(at, at + size));
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** One recorded event as a single compact line for session_history. */
function describeEvent(event: SessionEvent): string {
  const stamp = new Date(event.time).toISOString().slice(11, 19);
  const who = event.agent ? ` [${event.agent}]` : '';
  switch (event.kind) {
    case 'user_message':
      return `#${event.seq} ${stamp}${who} USER: ${oneLine(event.message.text, 400)}`;
    case 'assistant_message':
      return `#${event.seq} ${stamp}${who} ASSISTANT: ${oneLine(event.message.text, 300)}`;
    case 'progress':
      return `#${event.seq} ${stamp}${who} progress: ${oneLine(event.message.text, 200)}`;
    case 'chat_error':
      return `#${event.seq} ${stamp}${who} ERROR: ${oneLine(event.message.text, 300)}`;
    case 'tool_call': {
      const call = event.call;
      const metric = call.summary.metric ? ` ${call.summary.metric}` : '';
      return `#${event.seq} ${stamp}${who} ${call.tool} (${call.outcome}) ${call.summary.title}${metric} · callId ${call.callId}`;
    }
    case 'turn_end':
      return `#${event.seq} ${stamp}${who} turn ended: ${event.outcome}${event.detail ? ` — ${event.detail}` : ''}`;
    case 'turn_start':
      return `#${event.seq} ${stamp}${who} turn started`;
    case 'handoff':
      return `#${event.seq} ${stamp} handoff ${event.handoffId} written by ${event.model}`;
    case 'agent_message':
      return (
        `#${event.seq} ${stamp}${who} ${event.delivery === 'sent' ? 'sent to' : 'received from'} ` +
        `${event.delivery === 'sent' ? event.to : event.from} [${event.messageId}]: ${oneLine(event.message.text, 400)}`
      );
    case 'note':
      return `#${event.seq} ${stamp} note: ${oneLine(event.message.text, 200)}`;
    case 'session_start':
      return `#${event.seq} ${stamp} session started: ${event.title}`;
  }
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}

function formatManagedProcess(result: ManagedProcessStatus, includeOutput = true): string {
  const state = result.running
    ? result.stopping
      ? 'stopping'
      : 'running'
    : `exited ${result.exitCode ?? result.signal ?? 'unknown'}`;
  const parts = [`${result.id}  pid ${result.pid}  ${state}  ${result.durationMs} ms  ${result.command}`];
  if (!includeOutput) return parts[0]!;

  const label = result.outputMode === 'delta' ? 'delta' : 'tail';
  if (result.stdout.trim()) parts.push(`--- stdout ${label} ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ${label} ---\n${result.stderr.trimEnd()}`);
  if (result.stdoutCursorLost) parts.push('(stdout cursor fell behind the bounded buffer; oldest unseen stdout was lost)');
  if (result.stderrCursorLost) parts.push('(stderr cursor fell behind the bounded buffer; oldest unseen stderr was lost)');
  if (result.stdoutLinesOmitted > 0) parts.push(`(${result.stdoutLinesOmitted} older stdout delta line(s) omitted by the lines cap)`);
  if (result.stderrLinesOmitted > 0) parts.push(`(${result.stderrLinesOmitted} older stderr delta line(s) omitted by the lines cap)`);
  if (result.outputMode === 'tail' && result.stdoutTruncated) parts.push('(older stdout discarded from bounded buffer)');
  if (result.outputMode === 'tail' && result.stderrTruncated) parts.push('(older stderr discarded from bounded buffer)');
  if (!result.stdout.trim() && !result.stderr.trim()) {
    parts.push(result.outputMode === 'delta' ? '(no new output since cursor)' : '(no captured output yet)');
  }
  if (result.stopMode) parts.push(`stop: ${result.stopMode}`);
  parts.push(`cursor: ${result.cursor}`);
  return parts.join('\n');
}

function formatExec(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}): string {
  const parts = [
    `exit ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}  ${result.durationMs} ms`
  ];
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)');
  if (result.truncated) parts.push('(output truncated)');
  return parts.join('\n');
}

export { toVirtualPath };
