/**
 * The Core connector: reading, changing and running code on this PC.
 *
 * Six tools at the absolute maximum, and usually four. That number is the design (see
 * `docs/tool-surface.md` §3): a no-query discovery pull against this connector returns
 * every schema here at once, so the surface is sized for the worst case rather than for
 * the case where the harness happens to ask a narrow question.
 *
 * What used to be forty-five tools did not become six by dropping capability. It became
 * six by separating *primitives* from *procedures*: `exec_command` can run git, so `git`
 * is a skill rather than a tool; `read` can open a directory, a text file or an image,
 * because those are three shapes of one question. Anything that reads as "and also, for
 * this special case…" belongs in a skill over these primitives, not in a schema every
 * conversation pays for.
 */

import { rawPromises as fs } from '../rawfs.js';
import nodePath from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_READ_BYTES,
  MAX_READ_BYTES,
  formatBytes,
  listDirectory,
  readImageFile,
  readTextFile,
  statInfo
} from '../fsops.js';
import { logInfo } from '../logger.js';
import { SandboxError, resolvePath, type Resolved } from '../sandbox.js';
import { currentWorkspace, setCurrentWorkspace } from '../workspace.js';
import type { Root } from '../../shared/types.js';
import { DEFAULT_EXCLUDES, globToRegExp, search, searchOneFile } from '../search.js';
import { parsePatch, PatchError, type PatchFileOperation } from '../patch.js';
import { applyResolvedPatch, type ResolvedPatchOperation } from '../patch-files.js';
import {
  DEFAULT_TTY_COLS,
  DEFAULT_TTY_ROWS,
  getManagedProcess,
  listManagedProcesses,
  MAX_EXEC_YIELD_MS,
  MAX_PROCESS_INPUT_CHARS,
  startManagedShellProcess,
  stopManagedProcess,
  waitManagedProcess,
  writeManagedProcess
} from '../process-manager.js';
import {
  agentForCaller,
  finishAgent,
  identify,
  join,
  PRIME_ID,
  sendMessage,
  spawn,
  swarmState,
  type Caller
} from '../agents.js';
import {
  currentCaller,
  noteChanges,
  noteCount,
  noteDetail,
  noteExec,
  noteProcess
} from './call-context.js';
import {
  awaitFreshCallOrigin,
  activeSessionId,
  recordAgentMessage,
  sessionTokens
} from '../session/recorder.js';
import { formatDelta } from '../diffstat.js';
import { readEvents } from '../session/store.js';
import { getConfig } from '../config.js';
import { tokenPressure } from '../../shared/session.js';
import {
  adoptAgent,
  chunkText,
  commandEnvArg,
  describeEvent,
  expandStored,
  fail,
  formatFileInfo,
  formatManagedProcess,
  friendlyError,
  guard,
  MAX_HISTORY_CALL_CHARS,
  numberReadLines,
  PRIME_EVIDENCE_MS,
  ok,
  pathArg,
  lineNumberArg,
  resolveCwd,
  resolveIn,
  type SurfaceRegistrar,
  type ToolResult
} from './kernel.js';

/** Entries one `read` of a directory returns before it says it stopped. */
const MAX_DIR_ENTRIES = 200;
/** Files one glob may expand to. A pattern is a convenience, not a way to bulk-read a repo. */
const MAX_GLOB_MATCHES = 20;
/** Files a single `read` call may touch after every path and glob is expanded. */
const MAX_READ_TARGETS = 40;
/** Entries a glob walk will look at before giving up on the pattern. */
const GLOB_SCAN_LIMIT = 5_000;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function registerCoreTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  // ------------------------------------------------------------------- read

  // Registered whenever any of the three reading permissions is on, because one tool now
  // answers all three questions. Which of them a given path actually gets is decided per
  // path below, so a user who granted metadata but not content still gets exactly that.
  if (exposedCaps.read || exposedCaps.browse || exposedCaps.metadata) {
    reg.register(
      'read',
      {
        title: 'Read files and folders',
        description:
          'Read what is at one or more paths. A folder is listed one level deep, a text file comes back as numbered lines, ' +
          'a PNG/JPEG/GIF/WebP comes back as an image, and anything else returns its metadata and why it was not decoded. ' +
          'Paths may contain * ? and ** and are expanded here. Every result starts with a header giving size, timestamps and line count. ' +
          `The line-number prefix is display metadata, not file content — strip it before quoting text into apply_patch. ` +
          `Line ranges apply only when you ask for exactly one path. Output is capped at ${formatBytes(MAX_READ_BYTES)} for the whole call.`,
        inputSchema: z.object({
          paths: z
            .array(pathArg)
            .min(1)
            .max(20)
            .describe('Virtual paths, e.g. /project/src/main.ts, /project/src, /project/**/*.test.ts'),
          start_line: lineNumberArg.optional().describe('First line, 1-based. Only when the call reads exactly one file; otherwise it is refused.'),
          end_line: lineNumberArg.optional().describe('Last line, inclusive. Only when the call reads exactly one file; otherwise it is refused.'),
          max_bytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_READ_BYTES)
            .optional()
            .describe(`Per-file byte cap. Default ${DEFAULT_READ_BYTES}.`)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ paths, start_line, end_line, max_bytes }) =>
        guard('read', async () => {
          if (!caps.read && !caps.browse && !caps.metadata) {
            return fail(
              'TOOL_DISABLED: read is disabled by the current ChatGPT Local Files permissions. Ask the user to enable reading in the app.'
            );
          }
          const targets: string[] = [];
          const notes: string[] = [];
          for (const requested of paths) {
            if (targets.length >= MAX_READ_TARGETS) {
              notes.push(`(stopped expanding at ${MAX_READ_TARGETS} paths)`);
              break;
            }
            if (!hasGlob(requested)) {
              targets.push(requested);
              continue;
            }
            const expanded = await expandGlob(ctx.roots, requested);
            if (expanded.matches.length === 0) {
              notes.push(`${requested}: no matches`);
              continue;
            }
            targets.push(...expanded.matches.slice(0, MAX_READ_TARGETS - targets.length));
            if (expanded.truncated) notes.push(`${requested}: more than ${MAX_GLOB_MATCHES} matches, narrow the pattern`);
          }

          const single = targets.length === 1;
          // A line range asked for once and quietly dropped is worse than a refusal: the
          // reply looks like an answer, every file arrives from line 1 until the byte cap,
          // and nothing says the range went away. Globs are checked after expansion, since
          // one pattern is what usually turns a single-path call into a multi-path one.
          if (targets.length > 1 && (start_line !== undefined || end_line !== undefined)) {
            return fail(
              `INVALID_ARGUMENT: start_line/end_line apply to one file, but this call resolves to ${targets.length} ` +
                `(${targets.slice(0, 4).join(', ')}${targets.length > 4 ? ', …' : ''}). ` +
                'Read the one file you want a range from, or drop the range.'
            );
          }
          const sections: string[] = [];
          const images: Array<{ data: string; mimeType: string }> = [];
          let remaining = MAX_READ_BYTES;
          let failures = 0;

          for (const target of targets) {
            if (remaining <= 0) {
              sections.push('(output cap reached; read the remaining paths in another call)');
              break;
            }
            try {
              const section = await readOne(target, {
                roots: ctx.roots,
                canRead: caps.read,
                canBrowse: caps.browse,
                startLine: single ? start_line : undefined,
                endLine: single ? end_line : undefined,
                maxBytes: Math.min(max_bytes ?? DEFAULT_READ_BYTES, remaining)
              });
              remaining -= section.bytes;
              sections.push(section.text);
              if (section.image) images.push(section.image);
            } catch (err) {
              failures++;
              // One stale or missing path must not destroy the useful reads. The requested
              // virtual path is safe to echo; friendlyError never exposes real paths.
              sections.push(`--- ${target} — ERROR ---\n${friendlyError(err)}`);
            }
          }

          logInfo(`tool read (${targets.length} target(s), ${failures} failed)`);
          noteCount(targets.length);
          const text = [...sections, ...notes].join('\n\n');
          if (images.length === 0) return ok(text || 'Nothing to read.');
          return {
            content: [
              { type: 'text' as const, text },
              ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
            ]
          };
        })
    );
  }

  // ------------------------------------------------------------------- find
  //
  // Only when commands are unavailable. With `exec_command` present, ripgrep through the
  // shell is strictly better than anything this can offer, and a seventh Core schema that
  // duplicates a capability the model already has is exactly the kind of weight this
  // surface exists to refuse.
  //
  // `reg.findExposed` rather than `!exposedCaps.command && exposedCaps.search`: the second
  // form reads a monotonically widening value, so switching command execution on mid-run
  // would delete `find` from under a cached tool list. The decision is frozen for the life
  // of the endpoint instead, which is the same rule every other tool here follows.
  if (reg.findExposed) {
    reg.register(
      'find',
      {
        title: 'Find files or text',
        description:
          'Find files by name, or find text inside files, without running a command. ' +
          'Content matches come back as path:line: text. Build and dependency folders are skipped unless you pass your own exclude list.',
        inputSchema: z.object({
          query: z.string().max(1000).describe('Text to look for'),
          path: pathArg.optional().describe('File or folder to search. Defaults to every approved root.'),
          mode: z.enum(['name', 'content']).optional().describe('Default name.'),
          include: z.string().max(200).optional().describe('Glob filter such as **/*.ts'),
          exclude: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe('Folder names to skip; trailing * is a prefix match. Replaces the defaults — pass [] to search everywhere.'),
          case_sensitive: z.boolean().optional().describe('Default false.'),
          regex: z.boolean().optional().describe('Content mode only: treat query as a regex. Default false.'),
          max_results: z.number().int().min(1).max(500).optional().describe('Default 50.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ query, path: p, mode, include, exclude, case_sensitive, regex, max_results }) =>
        reg.guarded('search', 'find', async () => {
          const limit = Math.min(500, Math.max(1, Math.floor(max_results ?? 50)));
          const scopes: Array<{ real: string; virtual: string }> = [];
          if (p) {
            const resolved = await resolveIn(ctx.roots, p);
            const stat = await fs.stat(resolved.real);
            if (stat.isFile()) {
              const outcome = await searchOneFile(resolved.real, resolved.virtual, {
                query,
                mode: mode ?? 'name',
                include,
                caseSensitive: case_sensitive === true,
                regex: regex === true,
                maxResults: limit
              });
              const hits = outcome.hits.map((hit) =>
                hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`
              );
              noteCount(hits.length);
              return ok(hits.length === 0 ? 'No matches' : `${hits.length} matches\n${hits.join('\n')}`);
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
              caseSensitive: case_sensitive === true,
              regex: regex === true,
              maxResults: limit - hits.length
            });
            scanned += outcome.filesScanned;
            elapsedMs += outcome.elapsedMs;
            if (outcome.stoppedBecause) stopReasons.add(outcome.stoppedBecause);
            for (const hit of outcome.hits) {
              hits.push(hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`);
            }
          }
          noteCount(hits.length);
          const reason = stopReasons.size > 0 ? `\ntruncated: ${[...stopReasons].join(',')}` : '';
          const meta = `\n\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: ${hits.length}${reason}`;
          if (hits.length === 0) return ok(`No matches${meta}`);
          return ok(`${hits.length} matches\n${hits.join('\n')}${meta}`);
        })
    );
  }

  // ------------------------------------------------------------- apply_patch

  if (exposedCaps.create || exposedCaps.edit || exposedCaps.move || exposedCaps.deleteFile) {
    reg.register(
      'apply_patch',
      {
        title: 'Apply a code patch',
        description:
          'The only way to change files. Applies a multi-file patch: *** Begin Patch, *** Add File:, *** Update File:, *** Delete File:, *** Move to:, @@ context hunks, *** End of File, *** End Patch. ' +
          'Adding a file creates its parent folders; deleting and moving are patch operations too, so there is no separate tool for them. ' +
          'Matching is line-based and tolerates CRLF/LF, trailing whitespace, indentation drift and smart quotes, so context copied out of read lands correctly; repeated context is fine — hunks apply in order, each searching on from the previous one. ' +
          'Every file and hunk is checked before the first change and commit failures roll back where safe, so a patch either lands or does not. ' +
          'A file may be updated more than once in one patch; the blocks apply in order, each seeing the previous one’s result. ' +
          'Write context lines as they appear in the file, without read’s line-number prefix. Relative paths resolve from cwd, else from the folder this chat is working in.',
        inputSchema: z.object({
          patch: z.string().min(1).max(1_000_000).describe('Patch text from *** Begin Patch through *** End Patch.'),
          cwd: pathArg.optional().describe('Approved folder for relative patch paths.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ patch, cwd }) =>
        guard('apply_patch', async () => {
          let parsed: PatchFileOperation[];
          try {
            parsed = parsePatch(patch);
          } catch (error) {
            return fail(`PATCH_INVALID: ${error instanceof PatchError ? error.message : friendlyError(error)}`);
          }

          let baseVirtual: string;
          if (cwd) {
            const base = await resolveIn(ctx.roots, cwd);
            const stat = await fs.stat(base.real);
            if (!stat.isDirectory()) return fail('apply_patch cwd must be a folder');
            baseVirtual = base.virtual;
          } else if (currentWorkspace()) {
            // The folder this chat has been working in, before the first root. Patching
            // `src/main/patch.ts` after reading it should hit the file that was read.
            baseVirtual = currentWorkspace()!.virtual;
          } else if (ctx.roots[0]) {
            baseVirtual = `/${ctx.roots[0].name}`;
          } else {
            return fail('No folder is approved, so there is nowhere to apply the patch.');
          }

          // The patch path goes to the sandbox exactly as it was written, with the base
          // passed alongside rather than pasted on in front. Joining and normalising here is
          // what let `../../elsewhere` become a clean absolute path before any check ran:
          // `posix.normalize` erases the very `..` that `checkSegment` exists to refuse, and
          // nothing downstream can tell the result apart from a path that was always that.
          // Patch paths now meet the same containment, `..` and symlink checks as a path
          // given to read or exec.
          const patchTarget = (raw: string, allowMissing?: boolean): Promise<Resolved> =>
            resolveIn(ctx.roots, raw, { base: baseVirtual, ...(allowMissing ? { allowMissing } : {}) });

          const resolved: ResolvedPatchOperation[] = [];
          for (const operation of parsed) {
            if (operation.kind === 'add') {
              if (!caps.create) return fail('TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.');
              const target = await patchTarget(operation.path, true);
              resolved.push({ kind: 'add', path: target, content: operation.content });
              continue;
            }
            if (operation.kind === 'delete') {
              if (!caps.deleteFile) return fail('TOOL_DISABLED: this patch deletes a file but Delete files is disabled.');
              const target = await patchTarget(operation.path);
              resolved.push({ kind: 'delete', path: target });
              continue;
            }
            // Move and edit stayed separate permissions when the file tools were folded
            // into apply_patch, so the checks stay separate too: a rename carrying no
            // hunks is a move and must not demand Edit, while a move that also rewrites
            // the file is both operations and needs both.
            const contentChange = operation.hunks.length > 0 || !operation.moveTo;
            if (contentChange && !caps.edit) {
              return fail('TOOL_DISABLED: this patch updates a file but Edit files is disabled.');
            }
            const target = await patchTarget(operation.path);
            let moveTo = null;
            if (operation.moveTo) {
              if (!caps.move) return fail('TOOL_DISABLED: this patch moves a file but Move / rename is disabled.');
              moveTo = await patchTarget(operation.moveTo, true);
            }
            resolved.push({ kind: 'update', path: target, moveTo, hunks: operation.hunks });
          }

          const results = await applyResolvedPatch(resolved);
          noteChanges(
            results.map((result) => ({
              path: result.destination ?? result.path,
              ...result.delta
            }))
          );
          logInfo(`tool apply_patch (${results.length} files)`);
          const lines = results.map((result) => {
            const verb = result.kind === 'add' ? 'A' : result.kind === 'delete' ? 'D' : result.kind === 'move' ? 'M→' : 'M';
            const target = result.destination ? `${result.path} -> ${result.destination}` : result.path;
            const delta = formatDelta(result.delta);
            const shown = delta && result.delta.approximate ? `~${delta}` : delta;
            return `${verb} ${target}${shown ? ` (${shown})` : ''}`;
          });
          // Placement notes, not failures. The patch is already on disk; these say where a
          // hunk landed when the file offered more than one plausible home for it.
          const notes = results.flatMap((result) => (result.warnings ?? []).map((note) => `${result.path}: ${note}`));
          return ok(
            `Applied patch to ${results.length} file(s)\n${lines.join('\n')}` +
              (notes.length > 0 ? `\n\nNotes:\n${notes.join('\n')}` : '')
          );
        })
    );
  }

  // ------------------------------------------------------- exec / write_stdin

  if (exposedCaps.command) {
    reg.register(
      'exec_command',
      {
        title: 'Run a command',
        description:
          'Run one PowerShell command (or cmd) in an approved folder, wait briefly, and return the output. ' +
          'This is how git, npm, builds, tests, linters and everything else on this PC are run. ' +
          'A non-zero exit is reported in the output rather than raised as an error. ' +
          'If the process is still running when the wait ends you get a session_id back: it can run as long as it needs to — dev servers, watchers, long builds — and you continue it with write_stdin. ' +
          'By default stdin/stdout are pipes, so a program that insists on a console will not work; tty=true gives it a real Windows console, which is what interactive CLIs, prompts and REPLs need. ' +
          'With tty=true stderr is interleaved into stdout and colour/cursor control is stripped. ' +
          'The command is not sandboxed to the folder: it can reach anything this Windows account can.',
        inputSchema: z.object({
          cmd: z.string().min(1).max(32_000).describe('Shell command or script to execute.'),
          cwd: pathArg.optional().describe('Approved working folder. Defaults to the first root.'),
          shell: z.enum(['powershell', 'cmd']).optional().describe('Default powershell.'),
          env: commandEnvArg.optional(),
          tty: z.boolean().optional().describe('Attach a real console instead of pipes. Default false.'),
          cols: z.number().int().min(20).max(500).optional().describe(`Console width when tty. Default ${DEFAULT_TTY_COLS}.`),
          rows: z.number().int().min(20).max(500).optional().describe(`Console height when tty. Default ${DEFAULT_TTY_ROWS}.`),
          yield_time_ms: z
            .number()
            .int()
            .min(0)
            .max(MAX_EXEC_YIELD_MS)
            .optional()
            .describe(`How long to wait before returning a live session. Default 10000, max ${MAX_EXEC_YIELD_MS}.`),
          max_lines: z.number().int().min(1).max(200).optional().describe('Captured lines per stream. Default 80.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('command', 'exec_command', async () => {
          const dir = await resolveCwd(ctx, input.cwd);
          const shellKind = input.shell ?? 'powershell';
          const started = await startManagedShellProcess(input.cmd, shellKind, dir.real, input.env, {
            tty: input.tty,
            cols: input.cols,
            rows: input.rows
          });
          const result = await waitManagedProcess(started.id, input.yield_time_ms ?? 10_000, input.max_lines ?? 80);
          logInfo(`tool exec_command ${shellKind} -> ${result.id}${result.running ? ' running' : ' exited'}`);
          noteExec({
            id: result.id,
            running: result.running,
            exitCode: result.exitCode,
            timedOut: false,
            durationMs: result.durationMs
          });
          noteDetail(input.cmd.replace(/\s+/g, ' ').slice(0, 120));
          // Asking for a console and silently not getting one is the kind of thing a model
          // cannot diagnose from the output, so say it in the reply rather than in a log.
          const downgraded =
            input.tty === true && !result.tty
              ? 'NOTE: a real console was not available on this machine, so this ran on pipes. Interactive prompts will not work.\n'
              : '';
          const header = result.running
            ? `session_id: ${result.id}\nStill running. Continue it with write_stdin, or end it with write_stdin signal=kill.\n`
            : '';
          // Which folder this actually ran in, every time. A defaulted cwd says so outright:
          // `npm run build` from the wrong root looks identical in the output otherwise.
          const where = `cwd: ${dir.virtual}${dir.defaulted ? ' (default — no cwd was given)' : ''}\n`;
          return ok(`${downgraded}${where}${header}${formatManagedProcess(result)}`);
        })
    );

    reg.register(
      'write_stdin',
      {
        title: 'Continue a running command',
        description:
          'Continue a session_id returned by exec_command: send input, poll for more output, or end it. ' +
          'chars are sent raw with no automatic newline — send a trailing \\r for Enter — and an empty chars just waits. ' +
          'Pass the cursor from the previous reply to get only what is new; when a reply says lines are waiting, call again with its cursor until nothing is left. ' +
          'close=true closes stdin. signal=int is Ctrl-C (it reaches a tty session; on a pipe session it closes stdin instead) and signal=kill terminates the process tree. ' +
          'On a pipe session this cannot answer prompts that read the console directly; on a tty session it can, and the console echoes your keystrokes back.',
        inputSchema: z.object({
          session_id: z.string().min(1).max(32).describe('Session id returned by exec_command.'),
          chars: z.string().max(MAX_PROCESS_INPUT_CHARS).optional().describe('Raw characters to send. Default empty, which only waits.'),
          yield_time_ms: z
            .number()
            .int()
            .min(0)
            .max(MAX_EXEC_YIELD_MS)
            .optional()
            .describe(`How long to wait for output or exit. Default 250 after input, 5000 when polling; max ${MAX_EXEC_YIELD_MS}.`),
          max_lines: z.number().int().min(1).max(200).optional().describe('Captured lines per stream. Default 80.'),
          cursor: z.string().min(1).max(100).optional().describe('Cursor from the previous reply, for new output only.'),
          close: z.boolean().optional().describe('Close stdin after sending chars. Default false.'),
          signal: z.enum(['int', 'kill']).optional().describe('int = Ctrl-C, kill = terminate the process tree.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('command', 'write_stdin', async () => {
          const lines = input.max_lines ?? 80;
          if (input.signal === 'kill') {
            const stopped = await stopManagedProcess(input.session_id, lines, input.cursor);
            noteProcess(stopped);
            logInfo(`tool write_stdin ${input.session_id} kill`);
            noteDetail('kill');
            return ok(formatManagedProcess(stopped));
          }
          if (input.signal === 'int') {
            // Ctrl-C only exists for a process that owns a console. On a pipe session the
            // honest equivalent is closing stdin, and the reply says which one happened so
            // the model does not conclude the program ignored an interrupt it never got.
            const status = getManagedProcess(input.session_id, 0);
            const viaConsole = status.tty;
            await writeManagedProcess(input.session_id, viaConsole ? '\x03' : '', false, !viaConsole, lines, input.cursor);
            const after = await waitManagedProcess(input.session_id, input.yield_time_ms ?? 1_000, lines, input.cursor);
            noteProcess(after);
            logInfo(`tool write_stdin ${input.session_id} int (${viaConsole ? 'ctrl-c' : 'stdin closed'})`);
            noteDetail(viaConsole ? 'ctrl-c' : 'stdin closed');
            const note = viaConsole
              ? 'Sent Ctrl-C to the console.\n'
              : 'This is a pipe session with no console, so Ctrl-C cannot be delivered; stdin was closed instead. Use signal=kill to stop it outright.\n';
            return ok(`${note}${formatManagedProcess(after)}`);
          }

          const chars = input.chars ?? '';
          const waitMs = input.yield_time_ms ?? (chars.length === 0 && input.close !== true ? 5_000 : 250);
          if (chars.length > 0 || input.close === true) {
            await writeManagedProcess(input.session_id, chars, false, input.close ?? false, lines, input.cursor);
          }
          const result = await waitManagedProcess(input.session_id, waitMs, lines, input.cursor);
          noteProcess(result);
          logInfo(`tool write_stdin ${input.session_id} (${chars.length} chars${input.close ? ', close' : ''})`);
          const header = result.running ? `session_id: ${result.id}\n` : '';
          return ok(`${header}${formatManagedProcess(result)}`);
        })
    );
  }

  // ---------------------------------------------------------------- session

  if (reg.sessionToolsExposed) registerSessionTool(reg);

  // ----------------------------------------------------------------- agents

  if (reg.agentToolsExposed) registerAgentsTool(reg);
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/**
 * One tool, two actions, both about the local recording of this work.
 *
 * There is no `resume` here and no `save_handoff`. Compaction is one app-owned transaction
 * end to end — the brief is the compacted chat's own final answer, and the replacement chat
 * is opened with that text already in it — so a tool for carrying a session from one chat to
 * another would be a second way of doing the one thing that must only happen once.
 */
function registerSessionTool(reg: SurfaceRegistrar): void {
  reg.register(
    'session',
    {
      title: 'Session recording',
      description:
        'Work with this app’s local recording of the current and previous sessions. ' +
        'history — search the raw recording (user messages, tool calls, errors) for detail the conversation no longer holds; pass call_id to get one recorded call in full. ' +
        'status — how much of the recorded session has accumulated, and which commands are still running.',
      inputSchema: z.object({
        action: z.enum(['history', 'status']).describe('What to do.'),
        part: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Rarely needed. Only when a result says it was split; it will tell you the part to ask for.'),
        session_id: z.string().max(64).optional().describe('history: session to search. Omit for the current one.'),
        query: z.string().max(200).optional().describe('history: case-insensitive text filter.'),
        kind: z
          .enum(['user_message', 'assistant_message', 'tool_call', 'chat_error', 'progress', 'handoff'])
          .optional()
          .describe('history: only entries of this kind.'),
        call_id: z.string().max(64).optional().describe('history: return one recorded tool call in full.'),
        from: z.number().int().min(0).max(10_000_000).optional().describe('history: first sequence number.'),
        limit: z.number().int().min(1).max(100).optional().describe('history: maximum entries. Default 40.')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) =>
      guard('session', async () => {
        if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Record sessions');

        if (input.action === 'status') {
          const config = getConfig();
          const id = input.session_id ?? activeSessionId() ?? null;
          const running = listManagedProcesses().filter((entry) => entry.running);
          const processLines =
            running.length === 0
              ? 'running commands: none'
              : `running commands (${running.length}):\n` +
                running
                  .slice(0, 10)
                  .map((entry) => `  ${entry.id}  pid ${entry.pid}  ${entry.command.replace(/\s+/g, ' ').slice(0, 100)}`)
                  .join('\n');
          if (!id) return ok(`No session is being recorded right now.\n${processLines}`);
          const pressure = tokenPressure(
            await sessionTokens(id),
            config.sessions.advisoryTokens,
            config.sessions.limitTokens
          );
          // Said plainly because the number is ours and it is not ChatGPT's: a model that
          // reports it as "your context" would be telling the user something false.
          return ok(
            `session: ${id}\n` +
              `recorded so far: ~${pressure.estimated.toLocaleString('en-US')} tokens (this app’s own estimate of what it recorded — four characters to a token — not ChatGPT’s private context counter)\n` +
              `advisory: ${pressure.advisory.toLocaleString('en-US')}  limit: ${pressure.limit.toLocaleString('en-US')}  level: ${pressure.level}\n` +
              (pressure.level === 'ok'
                ? 'There is room to keep going.'
                : 'This session is long. Suggest the user press "Compact & Resume in New Chat" when they reach a natural break.') +
              `\n${processLines}`
          );
        }

        // history
        const id = input.session_id ?? activeSessionId() ?? null;
        if (!id) return fail('No recorded session is available.');
        const events = await readEvents(id, input.kind ? { kinds: [input.kind] } : {});
        if (events.length === 0) return fail(`Session ${id} has no recorded events.`);

        if (input.call_id) {
          const found = events.find((event) => event.kind === 'tool_call' && event.call.callId === input.call_id);
          if (!found || found.kind !== 'tool_call') return fail(`No recorded tool call with id ${input.call_id}.`);
          const call = found.call;
          // Anything too long for the log line was written beside it in full, so the exact
          // payload is genuinely recoverable rather than described as exact and quietly cut.
          const args = await expandStored(id, call.args);
          const result = await expandStored(id, call.result);
          const whole =
            `#${found.seq} ${call.tool} — ${call.outcome} in ${call.durationMs} ms\n` +
            `arguments (${call.args.chars} chars${args.complete ? '' : ', partial'}):\n${args.text}\n\n` +
            `result (${call.result.chars} chars${result.complete ? '' : ', partial'}):\n${result.text}`;
          const parts = chunkText(whole, MAX_HISTORY_CALL_CHARS);
          const index = Math.min(Math.max(1, Math.floor(input.part ?? 1)), parts.length);
          noteDetail(`part ${index}/${parts.length}`);
          const more = index < parts.length ? `\n\n(continues — call again with part=${index + 1})` : '';
          return ok(
            `${parts[index - 1] ?? ''}${more}` + (parts.length > 1 ? `\n[part ${index} of ${parts.length}]` : '')
          );
        }

        const needle = input.query?.toLowerCase() ?? null;
        const cap = Math.min(100, Math.max(1, Math.floor(input.limit ?? 40)));
        const lines: string[] = [];
        for (const event of events) {
          if (input.from !== undefined && event.seq < input.from) continue;
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
            '\n\n(pass call_id to expand a tool call, or from/limit to page)'
        );
      })
  );
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/**
 * One tool, five actions, registered only while multi-agent mode is on — which is off by
 * default, so most users never see this schema at all.
 *
 * The identity model is the whole design, and it is the same one for every role: an agent *is*
 * the ChatGPT conversation it runs in. A chat becomes the prime by spawning from its own proven
 * conversation; a worker is the chat the app opened for its slot, bound and activated by the
 * extension's report before the model there reads its task. Neither is anything the model can
 * assert, so there is no key to carry, no takeover, no promotion and no inference — a call this
 * app cannot place is refused rather than guessed at, and a chat that is not in the run learns
 * only that a run exists.
 *
 * `join` is not part of that. It is the manual way back from one specific failure — the
 * extension's report never arrived, so a chat that is doing a worker's work is a stranger to
 * the run — and it is the only action that takes a key.
 */
function registerAgentsTool(reg: SurfaceRegistrar): void {
  reg.register(
    'agents',
    {
      title: 'Multi-agent run',
      description:
        'Coordinate a run of ChatGPT worker agents on this machine. ' +
        'spawn — create workers for parts of the task; the chat that calls it becomes the prime agent of the run, and each worker opens in its own ChatGPT conversation, already bound to its slot, with its task as the first message. ' +
        'message — the prime may message any worker; a worker may only message "prime". Replies arrive at the end of a later tool result, so never wait or poll. ' +
        'status — every agent, what it was asked to do, and what is waiting. ' +
        'finish — workers only, terminal: hand your final result to the prime and stop. ' +
        'join — recovery only, and normally never used: it exists for a worker chat whose binding was lost, and needs the recovery key from the app. ' +
        'Every agent is identified by the ChatGPT conversation it is in, so no call here ever carries a key.',
      inputSchema: z.object({
        action: z.enum(['spawn', 'join', 'message', 'status', 'finish']).describe('What to do.'),
        workers: z
          .array(
            z.object({
              label: z.string().max(60).optional().describe('Short name shown to the user'),
              task: z.string().min(1).max(4000).describe('Self-contained brief. The worker sees only this.')
            })
          )
          .min(1)
          .max(8)
          .optional()
          .describe('spawn: the workers to create.'),
        join_key: z
          .string()
          .min(8)
          .max(200)
          .optional()
          .describe(
            'join: the recovery key, from the ChatGPT Local Files log. Only for a worker chat whose binding was lost — there is no ordinary reason to send this.'
          ),
        to: z.string().min(1).max(40).optional().describe('message: recipient, e.g. prime or worker-2.'),
        text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
        result: z.string().min(1).max(4000).optional().describe('finish: what you did, what is left, what broke.')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      // Taken before any work, because it is what makes page evidence *fresh*: only a block
      // the page rendered after this call began can belong to this call.
      const startedAt = Date.now();
      return guard('agents', async () => {
        if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');

        if (input.action === 'spawn') {
          if (!input.workers) return fail('agents action=spawn requires workers.');
          // One atomic operation: it either claims this exact conversation as prime and
          // creates the workers, or it creates nothing at all. There is no "create the
          // workers and find out who the prime was later" — that ordering is what produced a
          // run whose workers could talk to a prime nobody could authenticate as.
          //
          // And the identity behind it is the exact kind: a generic connector row would let
          // an uninvolved chat that happened to call something else in the same window
          // become the prime of this run.
          const { created, becamePrime, runId } = spawn({
            workers: input.workers,
            caller: await callerNow(startedAt, { exact: true })
          });
          await adoptAgent(PRIME_ID);
          return ok(
            (becamePrime
              ? `This conversation is now the prime agent of run ${runId}. The role is bound to this conversation, so ` +
                'there is no key to carry here or anywhere else.\n\n'
              : '') +
              `Created ${created.length} worker(s):\n` +
              created.map((info) => `${info.id} — ${info.label}`).join('\n') +
              '\n\nTheir chats are being opened with their tasks already in them, so each starts work straight away ' +
              'and reports back when it has something. Messages addressed to you arrive ' +
              'at the end of your tool results, and action=status collects whatever is waiting. Message a worker at any ' +
              'time with action=message — a short correction while it is still working is much cheaper than the ' +
              'alternative. Nothing here is worth waiting or polling for.'
          );
        }

        if (input.action === 'join') {
          // Recovery, and only ever recovery: an ordinary worker is already active by the time
          // it reads anything, so the interesting thing this can return is "you were bound all
          // along" — which is exactly the correction a model that came here by mistake needs.
          const info = join(await callerNow(startedAt, { exact: true }), input.join_key);
          await adoptAgent(info.id);
          return ok(
            `You are ${info.id} (${info.label}). Later calls need nothing from you: this app knows which ` +
              `conversation you are.\n\nYour task:\n${info.task}\n\n` +
              'Message the prime agent with agents action=message to="prime" when you find something that changes what ' +
              'should be done, when you have to choose between real alternatives, or when you are blocked — bundled into ' +
              'one substantial message, not a running commentary. Then keep working; a reply comes back at the end of a ' +
              'later tool result, so there is nothing to wait for and never anything to poll. Use action=finish when the ' +
              'work is actually done — it is terminal, so do not finish while an answer you asked for could still change ' +
              'your result. You cannot message other workers.'
          );
        }

        if (input.action === 'message') {
          if (!input.to || !input.text) return fail('agents action=message requires to and text.');
          const message = sendMessage(await callerNow(startedAt), input.to, input.text);
          await recordAgentMessage(message, 'sent');
          return ok(
            `Sent to ${input.to} (message ${message.id}). Carry on with the work — if there is a reply it will appear at ` +
              'the end of a later tool result.'
          );
        }

        if (input.action === 'finish') {
          if (!input.result) return fail('agents action=finish requires result.');
          const { info, report, repeat } = finishAgent(await callerNow(startedAt), input.result);
          if (report) await recordAgentMessage(report, 'sent');
          // A retry is answered as a retry. Repeating "marked finished" would read as a
          // second finish and invite the model to keep going until it gets a different
          // answer, which is how one lost result became a queue of identical reports.
          return ok(
            repeat
              ? `${info.id} was already ${info.state} and the prime agent already has that result, so nothing was sent ` +
                'again. You are done: stop working and stop calling tools.'
              : `${info.id} marked finished. The prime agent has your result. You are done: stop working and stop ` +
                'calling tools.'
          );
        }

        // status. Read-only, and deliberately small: it is the run as its own members see it,
        // and `identify` is what decides whether this caller is one of them. An unrelated
        // chat is told AGENTS_BUSY and nothing else — not who the prime is, not how many
        // workers there are, not what any of them are doing.
        const me = identify(await callerNow(startedAt));
        const state = swarmState();
        const failed = state.agents.filter((info) => info.state === 'failed');
        return ok(
          `You are ${me.id}.\n` +
            state.agents
              .map(
                (info) =>
                  `${info.id}  ${info.role}  ${info.state}  waiting ${info.pending}  ${info.label}` +
                  (info.result
                    ? `\n    ${info.state === 'failed' ? 'failure' : info.state === 'finished' ? 'result' : 'result so far (not finished)'}: ${info.result.slice(0, 300)}`
                    : '')
              )
              .join('\n') +
            // Said in words as well as in the table: a failed worker is one whose chat never
            // opened, and waiting for it is the mistake this line prevents.
            (failed.length > 0
              ? `\n\n${failed.map((info) => info.id).join(', ')} never got a working ChatGPT tab and will not report. ` +
                'Do that work yourself or create a replacement worker; do not wait for them.'
              : '')
        );
      });
    }
  );
}

/**
 * Who is making this `agents` call, established for this call alone.
 *
 * The prime holds no credential by design, and the dispatcher deliberately hands ordinary
 * tool calls no page evidence at all — "the only chat that has been active lately" is not
 * proof that that chat is the one calling, and treating it as proof would let stale page
 * state authorise swarm control. So identity is proven here, per call, from a connector block
 * rendered *after* this call began, in exactly one conversation. Anything less resolves to
 * nothing and the operation is refused by the broker, by name.
 *
 * A worker with a code pays for the same evidence: its conversation is what routes it, and
 * the code is the recovery path for the turns where the page says nothing about it.
 *
 * `exact` is for the one operation that creates a binding it can never take back — see the
 * comment in `spawn` above.
 *
 * The proven identity is then adopted for the rest of the call, so this result is recorded
 * against the right agent and carries the right inbox.
 */
async function callerNow(startedAt: number, options: { exact?: boolean } = {}): Promise<Caller> {
  const base = currentCaller();
  const caller: Caller = {
    ...base,
    conversationId:
      base.conversationId ??
      (await awaitFreshCallOrigin('agents', startedAt, PRIME_EVIDENCE_MS, {
        ...options,
        // ChatGPT's own id for this request, when it sent one. It names the conversation
        // outright, so two workers calling at the same moment are no longer a hard case.
        requestId: base.requestId
      }))
  };
  await adoptAgent(agentForCaller(caller));
  return caller;
}

// ---------------------------------------------------------------------------
// read helpers
// ---------------------------------------------------------------------------

function hasGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

/**
 * Expands a glob to real virtual paths, bounded twice over.
 *
 * Bounded on the walk (`GLOB_SCAN_LIMIT`) so a pattern rooted at a huge tree cannot spend
 * minutes, and bounded on the result (`MAX_GLOB_MATCHES`) so a pattern cannot quietly turn
 * one call into a bulk read of a repository. Both bounds are reported rather than silently
 * applied — a truncated expansion the model does not know about is worse than no expansion.
 */
async function expandGlob(
  roots: Parameters<typeof resolvePath>[0],
  pattern: string
): Promise<{ matches: string[]; truncated: boolean }> {
  const normalised = pattern.replace(/\\/g, '/');
  const segments = normalised.split('/');
  const baseSegments: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    baseSegments.push(segment);
  }
  const base = baseSegments.join('/') || '/';
  const rest = segments.slice(baseSegments.length).join('/');
  if (!rest) return { matches: [normalised], truncated: false };

  const resolved = await resolveIn(roots, base);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError(`${resolved.virtual} is not a folder, so it cannot be globbed`);

  const { entries } = await listDirectory(resolved.real, resolved.virtual, {
    recursive: rest.includes('**'),
    maxEntries: GLOB_SCAN_LIMIT,
    exclude: DEFAULT_EXCLUDES
  });
  const matcher = globToRegExp(rest, false);
  const prefixLength = resolved.virtual.length + 1;
  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (!matcher.test(entry.virtualPath.slice(prefixLength))) continue;
    matches.push(entry.virtualPath);
    if (matches.length >= MAX_GLOB_MATCHES) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

interface ReadOneOptions {
  roots: Parameters<typeof resolvePath>[0];
  canRead: boolean;
  canBrowse: boolean;
  startLine?: number;
  endLine?: number;
  maxBytes: number;
}

/**
 * One path, one section of output, and the byte cost of producing it.
 *
 * The three result shapes are decided here rather than by an action argument, because from
 * the caller's side they are one question — what is at this path — and asking a model to
 * pick the right verb for a path it has not looked at yet is how `read_file` on a directory
 * became a routine error.
 */
async function readOne(
  requested: string,
  options: ReadOneOptions
): Promise<{ text: string; bytes: number; image?: { data: string; mimeType: string } }> {
  const resolved = await resolveIn(options.roots, requested);
  const info = await statInfo(resolved.real, resolved.virtual);

  if (info.type === 'directory') {
    if (!options.canBrowse) {
      return { text: `--- ${resolved.virtual} ---\nTOOL_DISABLED: listing folders needs the Browse folders permission.`, bytes: 0 };
    }
    const { entries, truncated } = await listDirectory(resolved.real, resolved.virtual, {
      recursive: false,
      maxEntries: MAX_DIR_ENTRIES,
      exclude: DEFAULT_EXCLUDES
    });
    const prefixLength = resolved.virtual.length + 1;
    const body = entries
      .map((entry) => {
        const kind = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?';
        const size = entry.bytes === null ? '' : `  ${formatBytes(entry.bytes)}`;
        return `${kind} ${entry.virtualPath.slice(prefixLength)}${size}`;
      })
      .join('\n');
    const note = truncated
      ? `\n(stopped at ${MAX_DIR_ENTRIES} entries — read a subfolder, or use a glob such as ${resolved.virtual}/**/*.ts)`
      : '';
    const text =
      entries.length === 0
        ? `--- ${resolved.virtual} — empty folder ---`
        : `--- ${resolved.virtual} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, one level ---\n${body}${note}`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  if (info.type !== 'file') {
    return { text: `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\nNot a regular file, so there is nothing to read.`, bytes: 0 };
  }

  if (!options.canRead) {
    // Metadata without content is a real answer when the user granted exactly that, and it
    // is strictly better than refusing the path outright.
    return { text: `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\n(file contents need the Read files permission)`, bytes: 0 };
  }

  const extension = nodePath.extname(resolved.virtual).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    const image = await readImageFile(resolved.real);
    logInfo(`tool read image ${resolved.virtual} (${formatBytes(image.bytes)})`);
    return {
      text: `--- ${resolved.virtual} — ${formatBytes(image.bytes)} ${image.mimeType} ---`,
      bytes: image.bytes,
      image: { data: image.data, mimeType: image.mimeType }
    };
  }

  if (info.binary) {
    // Never dumped as base64. A model that asked to read a .dll wanted to know what it is,
    // and several megabytes of base64 answers a question nobody asked at ruinous cost.
    return {
      text:
        `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\n` +
        'Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.',
      bytes: 0
    };
  }

  const result = await readTextFile(resolved.real, {
    startLine: options.startLine,
    endLine: options.endLine,
    maxBytes: options.maxBytes
  });
  if (result.lastLine >= result.firstLine) noteDetail(`lines ${result.firstLine}–${result.lastLine}`);
  // The total is only known when the file was read to the end; rather than print "of ?",
  // the note below tells the model where to resume instead.
  const range =
    result.lastLine < result.firstLine
      ? result.truncated && result.bytesReturned === 0
        ? `no complete line fits in the ${formatBytes(options.maxBytes)} cap`
        : 'no lines in that range'
      : result.totalLines === null
        ? `lines ${result.firstLine}-${result.lastLine}`
        : `lines ${result.firstLine}-${result.lastLine} of ${result.totalLines}`;
  const note = result.truncated
    ? `\n(truncated at ${formatBytes(result.bytesReturned)} — continue from line ${result.lastLine + 1})`
    : result.hasMore
      ? `\n(more lines follow — continue from line ${result.lastLine + 1})`
      : '';
  const header = `--- ${resolved.virtual} — ${range}, ${formatBytes(info.bytes)}, modified ${info.modified} ---`;
  return {
    text: `${header}\n${numberReadLines(result.text, result.firstLine)}${note}`,
    bytes: result.bytesReturned
  };
}

export type { ToolResult };
