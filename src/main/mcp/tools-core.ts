/**
 * The Core connector: reading, changing and running code on this PC.
 *
 * Seven tools at the absolute maximum, and usually five. That number is the design (see
 * `docs/tool-surface.md` §3): a no-query discovery pull against this connector returns
 * every schema here at once, so the surface is sized for the worst case rather than for
 * the case where the harness happens to ask a narrow question.
 *
 * What used to be forty-five tools did not become seven by dropping capability. It became
 * seven by separating *primitives* from *procedures*: `exec_command` can run git, so `git`
 * is a skill rather than a tool; `read` can open a directory, a text file or an image,
 * because those are three shapes of one question. Anything that reads as "and also, for
 * this special case…" belongs in a skill over these primitives, not in a schema every
 * conversation pays for.
 */

import { rawPromises as fs } from '../rawfs.js';
import nodePath from 'node:path';
import { z } from 'zod';
import { DEFAULT_READ_BYTES, MAX_READ_BYTES, formatBytes } from '../fsops.js';
import { listDirectoryLevel, readTextFile, statInfo, walkFiles } from '../codex/read-backend.js';
import {
  VIEW_IMAGE_DESCRIPTION,
  VIEW_IMAGE_PATH_DESCRIPTION,
  ViewImageError,
  viewImage
} from '../codex/view-image.js';
import { logInfo, logWarn } from '../logger.js';
import { SandboxError, isNativeWindowsPath, resolvePath } from '../sandbox.js';
import { currentWorkspace, setCurrentWorkspace } from '../workspace.js';
import type { Capabilities, Root } from '../../shared/types.js';
import type { FileChange, SessionEvent, StoredText } from '../../shared/session.js';
import { DEFAULT_EXCLUDES, globToRegExp, search, searchOneFile } from '../search.js';
import {
  ApplyPatchError,
  PatchParseError,
  executeApplyPatch,
  parsePatch,
  verifyApplyPatchArgs,
  type AppliedPatchDelta,
  type Hunk,
  type PatchPathResolver
} from '../codex/apply-patch/index.js';
import { DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE } from '../codex/apply-patch/mode.js';
import { hunkPath } from '../codex/apply-patch/hunk.js';
import { maybeParseApplyPatchForExec } from '../codex/apply-patch/invocation.js';
import { formatExecOutputForModel, newStreamOutput } from '../codex/exec-output.js';
import { DEFAULT_TRUNCATION_POLICY, unifiedExecManager } from '../codex/manager.js';
import {
  execOwnershipDenied,
  forgetExecOwner,
  noteExecOwner,
  provenConversation
} from '../codex/ownership.js';
import {
  UnifiedExecError,
  applyUnifiedExecEnv,
  execCommandResponseText,
  execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../codex/unified-exec.js';
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_TTY,
  DEFAULT_WRITE_STDIN_YIELD_TIME_MS
} from '../codex/unified-exec-constants.js';
import { defaultUserShell, deriveExecArgs, getShellByModelProvidedPath, shlexJoin } from '../codex/shell.js';
import {
  APPLY_PATCH_ARGUMENT_DESCRIPTION,
  APPLY_PATCH_DESCRIPTION,
  EXEC_COMMAND_CMD_DESCRIPTION,
  EXEC_COMMAND_DESCRIPTION,
  EXEC_COMMAND_LOGIN_DESCRIPTION,
  EXEC_COMMAND_SHELL_DESCRIPTION,
  EXEC_COMMAND_TTY_DESCRIPTION,
  EXEC_COMMAND_WORKDIR_DESCRIPTION,
  EXEC_COMMAND_YIELD_TIME_DESCRIPTION,
  MAX_OUTPUT_TOKENS_DESCRIPTION,
  WRITE_STDIN_CHARS_DESCRIPTION,
  WRITE_STDIN_DESCRIPTION,
  WRITE_STDIN_SESSION_ID_DESCRIPTION,
  WRITE_STDIN_YIELD_TIME_DESCRIPTION
} from '../codex/tool-specs.js';
import { lineDelta } from '../diffstat.js';
import {
  agentForCaller,
  finishAgent,
  identify,
  join,
  PRIME_ID,
  sendMessage,
  spawn,
  swarmRunning,
  swarmState,
  type Caller
} from '../agents.js';
import {
  currentCall,
  currentCaller,
  noteChanges,
  noteCount,
  noteDetail,
  noteExec
} from './call-context.js';
import {
  awaitFreshCallOrigin,
  recordAgentMessage,
  sessionIdForConversation,
  sessionTokens
} from '../session/recorder.js';
import { getSession, readEvents, readRecentEvents } from '../session/store.js';
import { getConfig } from '../config.js';
import { tokenPressure } from '../../shared/session.js';
import {
  adoptAgent,
  chunkText,
  describeEvent,
  expandStored,
  fail,
  formatFileInfo,
  friendlyError,
  guard,
  MAX_HISTORY_CALL_CHARS,
  numberReadLines,
  IDENTITY_EVIDENCE_MS,
  JOIN_EVIDENCE_MS,
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

// Codex advertises these as JSON Schema `number`, but serde still deserializes them into
// integer Rust types. Refinements preserve the model-visible number schema while rejecting
// values Rust would reject before the handler runs.
const int32Number = z
  .number()
  .refine((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647);
const unsignedIntegerNumber = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);

const unifiedExecOutputSchema = z
  .object({
    chunk_id: z.string().optional().describe('Chunk identifier included when the response reports one.'),
    wall_time_seconds: z.number().describe('Elapsed wall time spent waiting for output in seconds.'),
    exit_code: z.number().optional().describe('Process exit code when the command finished during this call.'),
    session_id: z
      .number()
      .optional()
      .describe('Session identifier to pass to write_stdin when the process is still running.'),
    original_token_count: z.number().optional().describe('Approximate token count before output truncation.'),
    output: z.string().describe('Command output text, possibly truncated.')
  })
  .strict();

const viewImageOutputSchema = z
  .object({
    image_url: z.string().describe('Data URL for the loaded image.'),
    detail: z
      .enum(['high', 'original'])
      .describe(
        'Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved.'
      )
  })
  .strict();

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
            .describe(
              'Paths inside approved roots. Use virtual paths such as /project/src/main.ts or paste native Windows paths such as C:\\work\\project\\src\\main.ts; native paths are normalized to the same virtual sandbox. Globs are supported in either spelling.'
            ),
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

  // -------------------------------------------------------------- view_image

  if (exposedCaps.read) {
    reg.register(
      'view_image',
      {
        description: VIEW_IMAGE_DESCRIPTION,
        inputSchema: z
          .object({
            path: z.string().describe(VIEW_IMAGE_PATH_DESCRIPTION)
          })
          .strict(),
        outputSchema: viewImageOutputSchema
      },
      async ({ path }) =>
        guard('view_image', async () => {
          if (!caps.read) {
            return fail(
              'TOOL_DISABLED: view_image is disabled by the current ChatGPT Local Files permissions. Ask the user to enable reading in the app.'
            );
          }
          const resolved = await resolveIn(ctx.roots, path);
          try {
            const image = await viewImage(resolved.real, null, undefined, resolved.virtual);
            logInfo(`tool view_image ${resolved.virtual} (${formatBytes(image.bytes)})`);
            return {
              content: [{ type: 'image' as const, data: image.base64, mimeType: image.mimeType }],
              structuredContent: { image_url: image.imageUrl, detail: image.detail }
            };
          } catch (error) {
            if (error instanceof ViewImageError) return fail(error.message);
            throw error;
          }
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
          path: pathArg
            .optional()
            .describe('File or folder to search. Virtual and native Windows paths inside approved roots are accepted. Defaults to every approved root.'),
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
          const deadline = Date.now() + 10_000;
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
                maxResults: limit,
                deadline
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
            if (Date.now() >= deadline) {
              stopReasons.add('time');
              break;
            }
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
              maxResults: limit - hits.length,
              deadline
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
        description: APPLY_PATCH_DESCRIPTION,
        inputSchema: z
          .object({
            patch: z.string().describe(APPLY_PATCH_ARGUMENT_DESCRIPTION)
          })
          .strict()
      },
      async ({ patch }) =>
        guard('apply_patch', async () => {
          if (!caps.create && !caps.edit && !caps.move && !caps.deleteFile) {
            return fail(
              'TOOL_DISABLED: apply_patch is disabled by the current ChatGPT Local Files permissions. Ask the user to enable changing files in the app.'
            );
          }

          let args: { patch: string; hunks: Hunk[]; workdir: string | null; environmentId: string | null };
          try {
            args = parsePatch(patch);
          } catch (error) {
            return fail(`apply_patch verification failed: ${applyPatchErrorText(error)}`);
          }

          // This connector exposes one local environment. Current Codex accepts the hidden
          // `*** Environment ID:` preamble only when spec_plan enabled multi-environment
          // selection; in the single-environment case the handler rejects it verbatim.
          if (args.environmentId !== null) {
            return fail('apply_patch environment selection is unavailable for this turn');
          }
          const workspace = currentWorkspace();
          if (!workspace && swarmRunning()) {
            return fail(
              'WORKSPACE_REQUIRED: this multi-agent chat has no proven workspace. Use an absolute path in another tool first so the approved project can be learned.'
            );
          }
          const baseVirtual = workspace?.virtual ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : null);
          if (baseVirtual === null) {
            return fail('No folder is approved, so there is nowhere to apply the patch.');
          }
          const base = await resolveIn(ctx.roots, baseVirtual);
          return (await runParsedPatch(args, ctx.roots, base, caps)).result;
        })
    );
  }

  // ------------------------------------------------------- exec / write_stdin

  if (exposedCaps.command) {
    reg.register(
      'exec_command',
      {
        description: EXEC_COMMAND_DESCRIPTION,
        inputSchema: z
          .object({
            cmd: z.string().describe(EXEC_COMMAND_CMD_DESCRIPTION),
            workdir: z.string().optional().describe(EXEC_COMMAND_WORKDIR_DESCRIPTION),
            tty: z.boolean().optional().describe(EXEC_COMMAND_TTY_DESCRIPTION),
            yield_time_ms: unsignedIntegerNumber.optional().describe(EXEC_COMMAND_YIELD_TIME_DESCRIPTION),
            max_output_tokens: unsignedIntegerNumber.optional().describe(MAX_OUTPUT_TOKENS_DESCRIPTION),
            shell: z.string().optional().describe(EXEC_COMMAND_SHELL_DESCRIPTION),
            login: z.boolean().optional().describe(EXEC_COMMAND_LOGIN_DESCRIPTION)
          })
          .strict(),
        outputSchema: unifiedExecOutputSchema
      },
      async (input) =>
        reg.guarded('command', 'exec_command', async () => {
          const dir = await resolveCwd(ctx, input.workdir);
          const shell = input.shell === undefined ? defaultUserShell() : getShellByModelProvidedPath(input.shell);
          const command = deriveExecArgs(shell, input.cmd, input.login ?? true);
          const processId = unifiedExecManager.allocateProcessId();
          try {
            // Current Codex intercepts an explicit `apply_patch` shell invocation before spawning
            // the shell process. The parser is the port of apply-patch/src/invocation.rs and uses
            // the same tree-sitter-bash grammar/query as upstream.
            const interceptedPatch = maybeParseApplyPatchForExec(command, dir.real);
            if (interceptedPatch.kind === 'correctness_error') {
              unifiedExecManager.releaseProcessId(processId);
              return fail(`apply_patch verification failed: ${interceptedPatch.error.message}`);
            }
            if (interceptedPatch.kind === 'body') {
              try {
                const patchRun = await runParsedPatch(interceptedPatch.args, ctx.roots, dir);
                if (patchRun.result.isError || patchRun.content === null) return patchRun.result;

                // `exec_command.rs` converts a successful intercepted patch into an
                // ExecCommandToolOutput with zero wall time and no process/exit/chunk metadata.
                const output: ExecCommandToolOutput = {
                  chunkId: '',
                  wallTimeMs: 0,
                  rawOutput: Buffer.from(patchRun.content, 'utf8'),
                  truncationPolicy: DEFAULT_TRUNCATION_POLICY,
                  maxOutputTokens: input.max_output_tokens,
                  processId: null,
                  exitCode: null,
                  originalTokenCount: null,
                  outputOmittedBytes: null
                };
                noteExec({ running: false, exitCode: null, timedOut: false, durationMs: 0 });
                noteDetail(input.cmd.replace(/\s+/g, ' ').slice(0, 120));
                return {
                  content: [{ type: 'text' as const, text: execCommandResponseText(output) }],
                  structuredContent: execCommandStructuredOutput(output)
                };
              } finally {
                unifiedExecManager.releaseProcessId(processId);
              }
            }

            const output = await unifiedExecManager.execCommand({
              command,
              shellType: shell.shellType,
              hookCommand: input.cmd,
              processId,
              yieldTimeMs: input.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
              maxOutputTokens: input.max_output_tokens,
              truncationPolicy: DEFAULT_TRUNCATION_POLICY,
              cwd: dir.real,
              displayCwd: dir.virtual,
              env: applyUnifiedExecEnv(process.env),
              tty: input.tty ?? DEFAULT_TTY
            });
            // Which chat may later write to this session id. Codex gets this for free from a
            // per-conversation manager; see codex/ownership.ts for why one is needed here.
            if (output.processId === null) {
              forgetExecOwner(processId);
            } else {
              let owner = provenConversation(currentCaller().requestId, currentCaller().conversationId);
              const call = currentCall();
              if (!owner && call?.caller.requestId) {
                owner = await awaitFreshCallOrigin('exec_command', call.startedAt, IDENTITY_EVIDENCE_MS, {
                  requestId: call.caller.requestId
                });
                if (owner) call.caller.conversationId = owner;
              }
              noteExecOwner(output.processId, owner);
            }
            noteExec({
              ...(output.processId === null ? {} : { id: String(output.processId) }),
              running: output.processId !== null,
              exitCode: output.exitCode,
              timedOut: false,
              durationMs: output.wallTimeMs
            });
            noteDetail(input.cmd.replace(/\s+/g, ' ').slice(0, 120));
            logInfo(`tool exec_command ${shell.shellType} -> ${output.processId ?? `exit ${output.exitCode ?? 'unknown'}`}`);
            return {
              content: [{ type: 'text' as const, text: execCommandResponseText(output) }],
              structuredContent: execCommandStructuredOutput(output)
            };
          } catch (error) {
            const detail = error instanceof UnifiedExecError ? error.debug() : friendlyError(error);
            return fail(`exec_command failed for \`${shlexJoin(command)}\`: ${detail}`);
          }
        })
    );

    reg.register(
      'write_stdin',
      {
        description: WRITE_STDIN_DESCRIPTION,
        inputSchema: z
          .object({
            session_id: int32Number.describe(WRITE_STDIN_SESSION_ID_DESCRIPTION),
            chars: z.string().optional().describe(WRITE_STDIN_CHARS_DESCRIPTION),
            yield_time_ms: unsignedIntegerNumber.optional().describe(WRITE_STDIN_YIELD_TIME_DESCRIPTION),
            max_output_tokens: unsignedIntegerNumber.optional().describe(MAX_OUTPUT_TOKENS_DESCRIPTION)
          })
          .strict(),
        outputSchema: unifiedExecOutputSchema
      },
      async (input) =>
        reg.guarded('command', 'write_stdin', async () => {
          // A session id is a small integer that means nothing outside the chat that was given
          // it, and every chat reaches the same manager here. Refuse only what is proven to
          // belong elsewhere; an unproven caller keeps working exactly as before.
          let asking = provenConversation(currentCaller().requestId, currentCaller().conversationId);
          const call = currentCall();
          if (!asking && call?.caller.requestId) {
            asking = await awaitFreshCallOrigin('write_stdin', call.startedAt, IDENTITY_EVIDENCE_MS, {
              requestId: call.caller.requestId
            });
            if (asking) call.caller.conversationId = asking;
          }
          if (execOwnershipDenied(input.session_id, asking)) {
            return fail(
              `write_stdin failed: session ${input.session_id} is not proven to belong to this ChatGPT conversation. Start your own with exec_command or retry after the extension reconnects.`
            );
          }
          try {
            const output = await unifiedExecManager.writeStdin({
              processId: input.session_id,
              input: input.chars ?? '',
              yieldTimeMs: input.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
              maxOutputTokens: input.max_output_tokens,
              truncationPolicy: DEFAULT_TRUNCATION_POLICY
            });
            if (output.processId === null) forgetExecOwner(input.session_id);
            noteExec({
              ...(output.processId === null ? {} : { id: String(output.processId) }),
              running: output.processId !== null,
              exitCode: output.exitCode,
              timedOut: false,
              durationMs: output.wallTimeMs
            });
            logInfo(`tool write_stdin ${input.session_id} (${(input.chars ?? '').length} chars)`);
            return {
              content: [{ type: 'text' as const, text: execCommandResponseText(output) }],
              structuredContent: execCommandStructuredOutput(output)
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return fail(`write_stdin failed: ${message}`);
          }
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
        'history — read the recent timeline by default, search full recorded text with nearby context, or pass call_id to expand one recorded call with its surrounding timeline. ' +
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

        const callerSession = async (): Promise<string | null> => {
          const call = currentCall();
          let conversationId = currentCaller().conversationId;
          if (!conversationId && call?.caller.requestId) {
            conversationId = await awaitFreshCallOrigin('session', call.startedAt, IDENTITY_EVIDENCE_MS, {
              requestId: call.caller.requestId
            });
            if (conversationId) call.caller.conversationId = conversationId;
          }
          return sessionIdForConversation(conversationId);
        };

        if (input.action === 'status') {
          const config = getConfig();
          const id = input.session_id ?? (await callerSession());
          // One manager serves every chat, so an unfiltered list would show one conversation
          // the session ids of another's terminals — and `write_stdin` refuses those anyway.
          const asking = provenConversation(currentCaller().requestId, currentCaller().conversationId);
          const running = unifiedExecManager
            .listProcesses()
            .filter((entry) => !execOwnershipDenied(entry.processId, asking));
          const processLines =
            running.length === 0
              ? 'running commands: none'
              : `running commands (${running.length}):\n` +
                running
                  .slice(0, 10)
                  .map(
                    (entry) =>
                      `  ${entry.processId}  pid ${entry.pid}  ${entry.command.replace(/\s+/g, ' ').slice(0, 100)}`
                  )
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
        const id = input.session_id ?? (await callerSession());
        if (!id) return fail('No recorded session is available.');
        const cap = Math.min(100, Math.max(1, Math.floor(input.limit ?? 40)));
        const recentOnly = !input.call_id && !input.query && input.from === undefined;
        const events = recentOnly
          ? await readRecentEvents(id, cap, input.kind ? { kinds: [input.kind] } : {})
          : await readEvents(id, input.call_id ? {} : input.kind ? { kinds: [input.kind] } : {});
        if (events.length === 0) return fail(`Session ${id} has no recorded events.`);

        if (input.call_id) {
          const foundIndex = events.findIndex(
            (event) => event.kind === 'tool_call' && event.call.callId === input.call_id
          );
          const found = foundIndex >= 0 ? events[foundIndex] : undefined;
          if (!found || found.kind !== 'tool_call') return fail(`No recorded tool call with id ${input.call_id}.`);
          const call = found.call;
          // Anything too long for the log line was written beside it in full, so the exact
          // payload is genuinely recoverable rather than described as exact and quietly cut.
          const args = await expandStored(id, call.args);
          const result = await expandStored(id, call.result);
          const nearby = historyNeighborhood(events, foundIndex, 3)
            .map(({ event, focus }) => `${focus ? '>>' : '  '} ${describeEvent(event)}`)
            .join('\n');
          const whole =
            `#${found.seq} ${call.tool} — ${call.outcome} in ${call.durationMs} ms\n` +
            `nearby timeline:\n${nearby}\n\n` +
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

        const eligible = input.from === undefined ? events : events.filter((event) => event.seq >= input.from!);

        if (input.query) {
          const matches: number[] = [];
          for (let index = 0; index < eligible.length; index++) {
            if (await historyEventMatches(id, eligible[index]!, input.query)) matches.push(index);
          }
          if (matches.length === 0) {
            noteCount(0);
            return ok(`No matching entries in session ${id}.`);
          }
          const selected = historyContext(eligible, matches, cap);
          const lines = selected.map(({ event, focus }) => `${focus ? '>>' : '  '} ${describeEvent(event)}`);
          noteCount(matches.length);
          return ok(
            `Session ${id} — ${matches.length} match${matches.length === 1 ? '' : 'es'}, ${lines.length} context entr${
              lines.length === 1 ? 'y' : 'ies'
            } of ${events.length} recorded\n` +
              lines.join('\n') +
              '\n\n(>> marks a direct match; pass call_id to expand a tool call)'
          );
        }

        const window = recentOnly
          ? eligible
          : input.from === undefined
            ? eligible.slice(Math.max(0, eligible.length - cap))
            : eligible.slice(0, cap);
        const lines = window.map((event) => describeEvent(event));
        noteCount(lines.length);
        if (lines.length === 0) return ok(`No matching entries in session ${id}.`);
        const total = recentOnly ? (await getSession(id))?.events ?? events.length : events.length;
        return ok(
          `Session ${id} — ${lines.length} ${input.from === undefined ? 'latest ' : ''}entr${
            lines.length === 1 ? 'y' : 'ies'
          } of ${total} recorded\n` +
            lines.join('\n') +
            '\n\n(pass call_id to expand a tool call, or from/limit to page forward)'
        );
      })
  );
}

function historyStoredTexts(event: SessionEvent): StoredText[] {
  switch (event.kind) {
    case 'user_message':
    case 'progress':
    case 'chat_error':
    case 'note':
      return [event.message];
    case 'assistant_message':
      return [event.message, ...(event.renderedHtml ? [event.renderedHtml] : [])];
    case 'tool_call':
      return [event.call.args, event.call.result];
    case 'agent_message':
      return [event.message];
    default:
      return [];
  }
}

function normaliseHistoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function historyTextMatches(haystack: string, query: string): boolean {
  const text = normaliseHistoryText(haystack);
  const wanted = normaliseHistoryText(query);
  if (!wanted) return true;
  if (text.includes(wanted)) return true;
  const terms = [...new Set(wanted.split(' ').filter((term) => term.length > 1))];
  return terms.length > 1 && terms.every((term) => text.includes(term));
}

async function historyEventMatches(sessionId: string, event: SessionEvent, query: string): Promise<boolean> {
  if (historyTextMatches(JSON.stringify(event), query)) return true;
  for (const stored of historyStoredTexts(event)) {
    if (!stored.truncated || !stored.assetId) continue;
    const expanded = await expandStored(sessionId, stored);
    if (historyTextMatches(expanded.text, query)) return true;
  }
  return false;
}

function historyNeighborhood(
  events: readonly SessionEvent[],
  focusIndex: number,
  radius: number
): Array<{ event: SessionEvent; focus: boolean }> {
  const from = Math.max(0, focusIndex - radius);
  const to = Math.min(events.length, focusIndex + radius + 1);
  return events.slice(from, to).map((event, offset) => ({ event, focus: from + offset === focusIndex }));
}

function historyContext(
  events: readonly SessionEvent[],
  matches: readonly number[],
  cap: number
): Array<{ event: SessionEvent; focus: boolean }> {
  const picked = new Map<number, boolean>();
  for (const match of matches) {
    for (let index = Math.max(0, match - 2); index <= Math.min(events.length - 1, match + 2); index++) {
      if (!picked.has(index) && picked.size >= cap) break;
      picked.set(index, picked.get(index) === true || index === match);
    }
    if (picked.size >= cap) break;
  }
  return [...picked.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, focus]) => ({ event: events[index]!, focus }));
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
        'spawn — create workers for parts of the task; the chat that calls it becomes the prime agent of the run, and each worker opens in its own ChatGPT conversation, already bound to its slot, with its task as the first message. Workers start with no conversation or project context, so every task brief must contain enough context to understand and execute the assignment on its own. ' +
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
              task: z
                .string()
                .min(1)
                .max(4000)
                .describe('The worker sees this task rather than the prime conversation. Write the assignment itself from the ground up with project/location, objective, relevant context/files, constraints, allowed changes, validation and expected handoff; avoid boilerplate about having no prior context.')
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
            'join: the one-time recovery key copied from that worker’s row in the ChatGPT Local Files Chat/Swarm UI. Only for a worker chat whose binding was lost — there is no ordinary reason to send this.'
          ),
        to: z.string().min(1).max(40).optional().describe('message: recipient, e.g. prime or worker-2.'),
        text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
        result: z.string().min(1).max(4000).optional().describe('finish: what you did, what is left, what broke.')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      // One clock for one MCP call. The dispatcher owns startedAt and the recorder later uses
      // that exact value to consume any page request reserved while proving caller identity.
      // Taking a second Date.now() here made callerNow reserve evidence under one timestamp
      // and recordToolCall look for it under another, leaving the first request permanently
      // reserved until TTL and breaking the very next worker control call.
      const startedAt = currentCall()?.startedAt ?? Date.now();
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
 * tool calls no authority from "the only chat that has been active lately" — that is not
 * proof that the chat made this call, and stale page state once authenticated prime calls as
 * worker-1. So identity is proven here per call by joining ChatGPT's inbound MCP HTTP
 * `x-request-id` to the same request id reported from one concrete conversation's message
 * model. The page evidence may arrive just before or just after the MCP request; the id, not
 * timing, is the join. If its exact mate never appears, the broker refuses the operation.
 * Missing request-id evidence never falls back to a visible row, active/generating chat,
 * agent key, or recent browser state.
 *
 * The proven identity is then adopted for the rest of the call, so this result is recorded
 * against the right agent and carries the right inbox.
 */
async function callerNow(startedAt: number, options: { exact?: boolean } = {}): Promise<Caller> {
  const base = currentCaller();
  // `exact` marks the two actions that bind a run — spawn and join. They are the calls whose
  // refusal the model cannot absorb, so they get the longer ceiling; every other `agents`
  // action can be declined and asked again on the next tool call.
  const window = base.requestId ? (options.exact ? JOIN_EVIDENCE_MS : IDENTITY_EVIDENCE_MS) : PRIME_EVIDENCE_MS;
  const resolved =
    base.conversationId ??
    (await awaitFreshCallOrigin('agents', startedAt, window, {
      ...options,
      // ChatGPT's own id for this request, when it sent one. It names the conversation
      // outright, so two workers calling at the same moment are no longer a hard case.
      requestId: base.requestId
    }));
  const caller: Caller = {
    ...base,
    conversationId: resolved
  };
  if (resolved) {
    const call = currentCall();
    if (call) call.caller.conversationId = resolved;
  }
  if (!resolved) {
    logWarn(
      base.requestId
        ? `agents caller not identified: no page evidence matched HTTP request ${base.requestId.slice(0, 20)}…`
        : 'agents caller not identified: this MCP request carried no request id and page evidence was insufficient'
    );
  }
  await adoptAgent(agentForCaller(caller));
  return caller;
}

// ---------------------------------------------------------------------------
// apply_patch adapter helpers
// ---------------------------------------------------------------------------

function applyPatchErrorText(error: unknown): string {
  return error instanceof PatchParseError || error instanceof ApplyPatchError ? error.message : friendlyError(error);
}

interface ParsedPatchRun {
  result: ToolResult;
  content: string | null;
  exitCode: number | null;
}

/** Shared execution path for the standalone tool and exec_command's upstream apply_patch intercept. */
async function runParsedPatch(
  args: { patch: string; hunks: Hunk[]; workdir: string | null; environmentId: string | null },
  roots: readonly Root[],
  base: { real: string; virtual: string },
  caps?: Capabilities
): Promise<ParsedPatchRun> {
  if (caps !== undefined) {
    // Product permission gates around the otherwise ported Codex patch runtime. exec_command's
    // interception deliberately omits this extra gate because command execution already grants
    // shell-equivalent mutation ability, matching Codex's shell-tool interception path.
    const denial = patchCapabilityDenial(args.hunks, caps);
    if (denial !== null) return { result: fail(denial), content: null, exitCode: null };
  }

  // `invocation.rs` turns `cd foo && apply_patch ...` into `args.workdir = "foo"`. Resolve that
  // once against the selected exec environment, then clear it before handing the already-effective
  // cwd to the verifier/runtime. The patch text itself never contains this shell-level workdir.
  let effectiveBase = base;
  let effectiveArgs = args;
  if (args.workdir !== null) {
    try {
      // Preserve the shell gate from `cd dir && apply_patch`: interception must not execute a
      // patch that the submitted shell command would never have reached. The cwd must already
      // exist and be a directory; patch-created parents apply only to paths *inside* it.
      effectiveBase = await resolveIn(roots, args.workdir, { base: base.virtual });
      const stat = await fs.stat(effectiveBase.real);
      if (!stat.isDirectory()) {
        return { result: fail('apply_patch workdir must be an existing folder'), content: null, exitCode: null };
      }
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
    effectiveArgs = { ...args, workdir: null };
  }

  // Every path the patch names is resolved through the connector environment up front, and the
  // synchronous resolver handed into the Codex port reads that table back.
  let resolution: PatchResolution;
  try {
    resolution = await resolvePatchPaths(roots, effectiveBase.virtual, effectiveArgs.hunks);
  } catch (error) {
    return { result: fail(friendlyError(error)), content: null, exitCode: null };
  }

  try {
    await verifyApplyPatchArgs(
      effectiveArgs,
      effectiveBase.real,
      DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
      resolution.resolve
    );
  } catch (error) {
    return {
      result: fail(`apply_patch verification failed: ${safePatchOutput(applyPatchErrorText(error), resolution)}`),
      content: null,
      exitCode: null
    };
  }

  const execution = await executeApplyPatch({
    patch: effectiveArgs.patch,
    cwd: effectiveBase.real,
    updateFileMode: DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
    resolvePath: resolution.resolve
  });
  const stdout = safePatchOutput(execution.stdout, resolution);
  const stderr = safePatchOutput(execution.stderr, resolution);
  const aggregatedOutput = safePatchOutput(execution.aggregatedOutput, resolution);
  const content = formatExecOutputForModel(
    {
      exitCode: execution.exitCode,
      stdout: newStreamOutput(stdout),
      stderr: newStreamOutput(stderr),
      aggregatedOutput: newStreamOutput(aggregatedOutput),
      durationMs: execution.durationMs,
      timedOut: false
    },
    DEFAULT_TRUNCATION_POLICY
  );

  noteChanges(patchFileChanges(execution.delta, resolution.virtualPaths));
  logInfo(`tool apply_patch (${execution.delta.changes.length} file(s), exit ${execution.exitCode})`);
  return {
    result: execution.exitCode === 0 ? ok(content) : fail(content),
    content,
    exitCode: execution.exitCode
  };
}

/** Product permission gates around the otherwise ported Codex patch runtime. */
function patchCapabilityDenial(hunks: readonly Hunk[], caps: Capabilities): string | null {
  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      if (!caps.create) return 'TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.';
      continue;
    }
    if (hunk.kind === 'delete_file') {
      if (!caps.deleteFile) return 'TOOL_DISABLED: this patch deletes a file but Delete files is disabled.';
      continue;
    }

    // Current Codex rejects an entirely empty Update hunk, including a move-only one. A rename
    // can still be expressed with a context-only chunk (` old` == `new`), so distinguish that
    // no-op content check from a real rewrite and preserve this app's separate Move permission.
    const contentChange =
      hunk.movePath === null ||
      hunk.chunks.some(
        (chunk) =>
          chunk.oldLines.length !== chunk.newLines.length ||
          chunk.oldLines.some((line, index) => line !== chunk.newLines[index])
      );
    if (contentChange && !caps.edit) {
      return 'TOOL_DISABLED: this patch updates a file but Edit files is disabled.';
    }
    if (hunk.movePath !== null && !caps.move) {
      return 'TOOL_DISABLED: this patch moves a file but Move / rename is disabled.';
    }
  }
  return null;
}

interface PatchResolution {
  resolve: PatchPathResolver;
  /** Real path -> safe virtual path, used only for recorder change evidence. */
  virtualPaths: Map<string, string>;
  /** Exact model-visible/real spellings that must never be echoed back as native paths. */
  displayRewrites: Map<string, string>;
}

function safePatchOutput(text: string, resolution: PatchResolution): string {
  let safe = text;
  const rewrites = [...resolution.displayRewrites].sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of rewrites) {
    if (from === '' || from === to || !safe.includes(from)) continue;
    safe = safe.split(from).join(to);
  }
  return safe;
}

/**
 * Resolves every spelling before the Codex verifier/runtime sees it.
 *
 * Codex normally does `cwd.join(path)`. This connector must retain its approved-root boundary,
 * so the synchronous resolver handed into the port reads a table that was produced by the same
 * sandbox path resolver every other filesystem tool uses.
 */
async function resolvePatchPaths(
  roots: readonly Root[],
  baseVirtual: string,
  hunks: readonly Hunk[]
): Promise<PatchResolution> {
  const realBySpelling = new Map<string, string>();
  const virtualPaths = new Map<string, string>();
  const displayRewrites = new Map<string, string>();

  const add = async (spelledPath: string, allowMissing: boolean): Promise<void> => {
    const resolved = await resolveIn(roots, spelledPath, { base: baseVirtual, allowMissing });
    realBySpelling.set(spelledPath, resolved.real);
    virtualPaths.set(resolved.real, resolved.virtual);
    displayRewrites.set(resolved.real, resolved.virtual);
    if (isNativeWindowsPath(spelledPath)) displayRewrites.set(spelledPath, resolved.virtual);
  };

  for (const hunk of hunks) {
    await add(hunk.path, hunk.kind === 'add_file');
    if (hunk.kind === 'update_file' && hunk.movePath !== null) await add(hunk.movePath, true);
  }

  const resolve: PatchPathResolver = (spelledPath) => {
    const resolved = realBySpelling.get(spelledPath);
    if (resolved === undefined) {
      throw new SandboxError(`Patch path was not validated before use: ${spelledPath}`);
    }
    return resolved;
  };
  return { resolve, virtualPaths, displayRewrites };
}

function patchFileChanges(delta: AppliedPatchDelta, virtualPaths: ReadonlyMap<string, string>): FileChange[] {
  return delta.changes.map(({ path, change }) => {
    let realPath = path;
    let before: string;
    let after: string;
    if (change.kind === 'add') {
      before = change.overwrittenContent ?? '';
      after = change.content;
    } else if (change.kind === 'delete') {
      before = change.content;
      after = '';
    } else {
      realPath = change.movePath ?? path;
      before = change.oldContent;
      after = change.newContent;
    }
    const counts = lineDelta(before, after);
    return {
      path: virtualPaths.get(realPath) ?? '[unresolved patch path]',
      added: counts.added,
      removed: counts.removed,
      approximate: counts.approximate || !delta.exact
    };
  });
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
  const info = await statInfo(resolved.real, resolved.virtual);
  if (info.type !== 'directory') throw new SandboxError(`${resolved.virtual} is not a folder, so it cannot be globbed`);

  // `**` walks with Codex's bounded breadth-first walk; a single-level pattern needs one
  // directory read and nothing more.
  const candidates = rest.includes('**')
    ? (await walkFiles(resolved.real, resolved.virtual, { maxEntries: GLOB_SCAN_LIMIT, exclude: DEFAULT_EXCLUDES }))
        .files
    : (await listDirectoryLevel(resolved.real, resolved.virtual, GLOB_SCAN_LIMIT)).entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => entry.virtualPath);

  const matcher = globToRegExp(rest, false);
  const prefixLength = resolved.virtual.length + 1;
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!matcher.test(candidate.slice(prefixLength))) continue;
    matches.push(candidate);
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
    const { entries, truncated } = await listDirectoryLevel(resolved.real, resolved.virtual, MAX_DIR_ENTRIES);
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
    // The same loader `view_image` uses, so an image opened through either tool is validated and
    // decoded identically. `view_image` still exists in its own right: it is Codex's tool, with
    // Codex's name, schema and errors, and this branch is only `read` continuing to answer "what
    // is at this path" for a path that happens to be a picture.
    const image = await viewImage(resolved.real, null, undefined, resolved.virtual, options.maxBytes);
    logInfo(`tool read image ${resolved.virtual} (${formatBytes(image.bytes)})`);
    return {
      text: `--- ${resolved.virtual} — ${formatBytes(image.bytes)} ${image.mimeType} ---`,
      bytes: image.bytes,
      image: { data: image.base64, mimeType: image.mimeType }
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
