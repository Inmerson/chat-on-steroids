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
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type ToolResult = { content: ToolContent[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

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
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (err instanceof SandboxError || err instanceof ComputerError || err instanceof FsOpError || err instanceof ExecError || err instanceof ProcessError) {
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
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
  if (caps.command) names.push('run_command', 'launch_app', 'process', 'open_url');
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
    { name: 'chatgpt-local-files', version: '1.4.1' },
    { capabilities: { tools: {} }, instructions: serverInstructions(ctx) }
  );

  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
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

  server.registerTool(
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
    server.registerTool(
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
    server.registerTool(
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
    server.registerTool(
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

    server.registerTool(
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
          return ok(sections.join('\n\n'));
        })
    );

    server.registerTool(
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
    server.registerTool(
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
    server.registerTool(
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
          return ok(`Created ${resolved.virtual} (${formatBytes(Buffer.byteLength(content, 'utf8'))})`);
        })
    );

    server.registerTool(
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
    server.registerTool(
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
          logInfo(`tool edit_file ${resolved.virtual} (${result.replacements} replacements)`);
          return ok(
            `Edited ${resolved.virtual} — ${result.replacements} replacement(s), now ${formatBytes(result.bytes)}`
          );
        })
    );

    server.registerTool(
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
          logInfo(`tool edit_files (${results.length} files, ${replacements} replacements)`);
          return ok(
            `Edited ${results.length} file(s), ${replacements} replacement(s) total\n` +
              results
                .map(
                  (result) =>
                    `${result.virtualPath} — ${result.replacements} replacement(s), now ${formatBytes(result.bytes)}`
                )
                .join('\n')
          );
        })
    );

    server.registerTool(
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
          const bytes = await replaceTextFile(resolved.real, content);
          logInfo(`tool write_file ${resolved.virtual}`);
          return ok(`Wrote ${resolved.virtual} (${formatBytes(bytes)})`);
        })
    );

    server.registerTool(
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
          const bytes = await appendTextFile(resolved.real, content);
          logInfo(`tool append_file ${resolved.virtual}`);
          return ok(`Appended ${formatBytes(bytes)} to ${resolved.virtual}`);
        })
    );
  }

  // ------------------------------------------------------------- binary write

  if (exposedCaps.create || exposedCaps.edit) {
    server.registerTool(
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
    server.registerTool(
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
          return ok(`Moved ${src.virtual} to ${dest.virtual}`);
        })
    );
  }

  // ---------------------------------------------------------------- delete

  if (exposedCaps.deleteFile) {
    server.registerTool(
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
          await fs.unlink(resolved.real);
          logInfo(`tool delete_file ${resolved.virtual}`);
          return ok(`Deleted ${resolved.virtual}`);
        })
    );
  }

  if (exposedCaps.deleteFolder) {
    server.registerTool(
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
    server.registerTool(
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
          return result.timedOut ? fail(formatExec(result)) : ok(formatExec(result));
        })
    );
  }

  if (exposedCaps.command) {
    server.registerTool(
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
          return result.timedOut ? fail(formatExec(result)) : ok(formatExec(result));
        })
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      'open_url',
      {
        title: 'Open a URL',
        description:
          'Open an http or https URL in the Windows default browser. This changes the desktop but does not interpret shell syntax.',
        inputSchema: z.object({ url: z.string().url().max(4000) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ url }) =>
        guarded('command', 'open_url', async () => {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return fail('Only http and https URLs are allowed');
          }
          await shell.openExternal(parsed.toString());
          return ok(`Opened ${parsed.origin}${parsed.pathname}`);
        })
    );
  }

  // ---------------------------------------------------------------- clipboard

  if (exposedCaps.clipboardRead) {
    server.registerTool(
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
    server.registerTool(
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
    server.registerTool(
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

    server.registerTool(
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
          if (windows.length === 0) return ok('No visible windows.');
          const lines = windows.map(
            (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
          );
          return ok(
            `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
          );
        })
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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
    server.registerTool(
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

  return server;
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
