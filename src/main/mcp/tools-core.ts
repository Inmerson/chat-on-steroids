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
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { z } from 'zod';
import { DEFAULT_READ_BYTES, MAX_READ_BYTES, formatBytes } from '../fsops.js';
import { BinaryReadError, listDirectoryLevel, readTextFile, statInfo, walkFiles } from '../codex/read-backend.js';
import {
  VIEW_IMAGE_DESCRIPTION,
  VIEW_IMAGE_PATH_DESCRIPTION,
  ViewImageError,
  viewImage
} from '../codex/view-image.js';
import { logInfo, logWarn } from '../logger.js';
import { SandboxError, isNativeWindowsPath, resolvePath, strayVirtualPath } from '../sandbox.js';
import { currentWorkspace } from '../workspace.js';
import type { Capabilities, Root } from '../../shared/types.js';
import type { FileChange } from '../../shared/session.js';
import { DEFAULT_EXCLUDES, MAX_CONTENT_FILE_BYTES, globToRegExp, search, searchOneFile } from '../search.js';
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
  benignExitNote,
  bindBundledRipgrep,
  execRecoveryHints,
  nonZeroExitIsBenign,
  normalizeShellCommand,
  repairPowerShellQuoting,
  withExecNotes
} from '../exec-hints.js';
import { childEnv } from '../exec.js';
import { locateRipgrep } from '../ripgrep.js';
import { ensureDevToolchain } from '../toolchain.js';
import { ANTIGRAVITY_MODEL, formatAntigravityInvestigation, investigateWithAntigravity } from '../antigravity/investigator.js';
import { routeAntigravityInvestigation } from '../delegation-router.js';
import {
  agentForCaller,
  currentRunId,
  identify,
  persistCriticalSwarmNow,
  PRIME_ID,
  requestWorkerBootstraps,
  stageFinishAgent,
  stageMessages,
  stageSpawn,
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
  recordAgentMessage
} from '../session/recorder.js';
import {
  adoptAgent,
  fail,
  formatFileInfo,
  friendlyError,
  guard,
  IDENTITY_EVIDENCE_MS,
  PRIME_EVIDENCE_MS,
  SPAWN_EVIDENCE_MS,
  ok,
  pathArg,
  lineNumberArg,
  resolveCwd,
  resolveIn,
  type SurfaceRegistrar,
  type ToolResult
} from './kernel.js';
import { registerSessionTool as registerSessionSearchReadTool } from './session-tool.js';

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

/** Whether the one-time note about a discovered toolchain has already been logged. */
let toolchainLogged = false;

/**
 * The environment `exec_command` hands its child.
 *
 * Built through `normalizeEnvironment` rather than by spreading `process.env`, because
 * `ensureDevToolchain` has to edit PATH and env.ts exists precisely to stop a second
 * spelling of it appearing beside the first. `applyUnifiedExecEnv` stays last so the Codex
 * pager/colour contract is still the final word, exactly as it was before.
 */
function execChildEnvironment(): NodeJS.ProcessEnv {
  // Start from the one shared child-process environment contract. Rebuilding only the PATH
  // casing fix here looked equivalent but quietly dropped two security/correctness guarantees
  // that `childEnv()` already owns: connector secrets are stripped before the child can read
  // them, and the bundled ripgrep directory is put on PATH (plus Windows' irreducible system
  // paths are repaired when the parent environment is sparse). Unified exec used to bypass
  // all three, so `exec_command` was the one launcher that could leak OPENAI_API_KEY and could
  // fail to find the very rg binary the app ships. Extend the shared environment only with the
  // dev-toolchain discovery that is specific to this surface.
  const env = childEnv();
  const added = ensureDevToolchain(env);
  if (added.length > 0 && !toolchainLogged) {
    toolchainLogged = true;
    logInfo(`exec_command: filled in unset toolchain variables (${added.join(', ')})`);
  }
  return applyUnifiedExecEnv(env);
}

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
          `A line range applies to every file the call resolves to. Text/listing output is bounded; the whole call stops after about ${formatBytes(MAX_READ_BYTES)} of returned payload.`,
        inputSchema: z
          .object({
            paths: z
              .array(pathArg)
              .min(1)
              .max(20)
              .describe(
                'Paths inside approved roots. Use virtual paths such as /project/src/main.ts or paste native Windows paths such as C:\\work\\project\\src\\main.ts; native paths are normalized to the same virtual sandbox. Globs are supported in either spelling.'
              ),
            start_line: lineNumberArg
              .optional()
              .describe('First line, 1-based. Applied to every file the call reads, so prefer one path when the range is file-specific.'),
            end_line: lineNumberArg
              .optional()
              .describe('Last line, inclusive. Applied to every file the call reads, so prefer one path when the range is file-specific.'),
            max_bytes: z
              .number()
              .int()
              .min(1)
              .max(MAX_READ_BYTES)
              .optional()
              .describe(`Per-text-file payload cap. Default ${DEFAULT_READ_BYTES}; maximum ${MAX_READ_BYTES}.`)
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ paths, start_line, end_line, max_bytes }) =>
        guard('read', async () => {
          if (!caps.read && !caps.browse && !caps.metadata) {
            return fail(
              'TOOL_DISABLED: read is disabled by the current Chat On Steroids permissions. Ask the user to enable reading in the app.'
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
              notes.push(
                expanded.truncated === 'scan'
                  ? `${requested}: glob scan stopped after ${GLOB_SCAN_LIMIT} entries before finding a match; narrow the pattern or start from a deeper folder`
                  : `${requested}: no matches`
              );
              continue;
            }
            targets.push(...expanded.matches.slice(0, MAX_READ_TARGETS - targets.length));
            if (expanded.truncated === 'matches') {
              notes.push(`${requested}: more than ${MAX_GLOB_MATCHES} matches, narrow the pattern`);
            } else if (expanded.truncated === 'scan') {
              notes.push(
                `${requested}: glob scan stopped after ${GLOB_SCAN_LIMIT} entries; more matches may exist, narrow the pattern or start from a deeper folder`
              );
            }
          }

          const ranged = start_line !== undefined || end_line !== undefined;
          // A line range asked for once and quietly dropped is worse than a refusal: the
          // reply looks like an answer, every file arrives from line 1 whether or not that
          // was asked for, and nothing says the range went away. That objection is about *silence*, not
          // about the range itself — so the range is now honoured for every file and said
          // out loud, which was the only outcome that discarded neither the caller's intent
          // nor the truth. Each section header already states `lines X-Y of Z`, so a file
          // shorter than the range cannot be mistaken for a complete read.
          //
          // Refusing instead was the single largest source of rejected calls in the recorded
          // sessions, and every one of them was a caller that had already said what it
          // wanted. Globs are still resolved first, since one pattern is what usually turns
          // a single-path call into a multi-path one.
          if (targets.length > 1 && ranged) {
            notes.push(
              `(start_line/end_line applied to each of the ${targets.length} files this call resolved to; ` +
                'every header states the lines actually returned)'
            );
          }
          const sections: string[] = [];
          const images: Array<{ data: string; mimeType: string }> = [];
          let remaining = MAX_READ_BYTES;
          let failures = 0;
          let successes = 0;

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
                startLine: start_line,
                endLine: end_line,
                maxBytes: Math.min(max_bytes ?? DEFAULT_READ_BYTES, remaining),
                aggregateBytes: remaining
              });
              remaining -= section.bytes;
              successes++;
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
          // Count what was actually read, not every target that merely was not observed to
          // fail. Once the aggregate output cap is exhausted the remaining targets are never
          // attempted; `targets.length - failures` therefore counted those unread paths as
          // successful results. That made session evidence claim more files than the response
          // contained, which is especially misleading in the telemetry used to audit tool
          // reliability. `successes` advances only after readOne returned a real section.
          noteCount(successes);
          const text = [...sections, ...notes].join('\n\n');
          // Partial multi-read is intentionally useful: one stale path must not discard the
          // files that did resolve. But zero successful explicit targets is not a successful
          // read. Returning ok(text) in that case made Activity record the call as healthy
          // even though the model received nothing except ERROR sections, biasing the very
          // error-rate telemetry used to find tool problems.
          if (targets.length > 0 && failures === targets.length) return fail(text || 'Nothing could be read.');
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
              'TOOL_DISABLED: view_image is disabled by the current Chat On Steroids permissions. Ask the user to enable reading in the app.'
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
          `Content matches come back as path:line: text; files over ${formatBytes(MAX_CONTENT_FILE_BYTES)} are skipped rather than loaded into search. ` +
          'Build and dependency folders are skipped unless you pass your own exclude list.',
        inputSchema: z
          .object({
            query: z
              .string()
              .max(1000)
              .refine((value) => value.trim().length > 0, 'query must contain non-whitespace text')
              .describe('Text to look for'),
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
          })
          .superRefine((input, ctx) => {
            if ((input.mode ?? 'name') !== 'content' && input.regex === true) {
              ctx.addIssue({
                code: 'custom',
                path: ['regex'],
                message: 'regex=true is only valid with mode=content'
              });
            }
          })
          .strict(),
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
              if (outcome.stoppedBecause === 'size') {
                return fail(
                  `File was not searched: content search skips files over ${formatBytes(MAX_CONTENT_FILE_BYTES)}. ` +
                    'Narrow it with read start_line/end_line, or use exec_command when command execution is available.'
                );
              }
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
          const contentLimit = (mode ?? 'name') === 'content' ? `\ncontent_file_limit: ${formatBytes(MAX_CONTENT_FILE_BYTES)}` : '';
          const meta = `\n\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: ${hits.length}${contentLimit}${reason}`;
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
              'TOOL_DISABLED: apply_patch is disabled by the current Chat On Steroids permissions. Ask the user to enable changing files in the app.'
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
          const virtualCommandPath = strayVirtualPath(input.cmd, ctx.roots);
          if (virtualCommandPath) {
            return fail(
              `INVALID_COMMAND_PATH: ${virtualCommandPath} is an app virtual path, but shell commands do not understand virtual paths. ` +
                `Use workdir plus a relative path, or use the approved folder's native Windows path. No command was run.`
            );
          }
          const shell = input.shell === undefined ? defaultUserShell() : getShellByModelProvidedPath(input.shell, dir.real);
          if (!shell) {
            return fail(
              `SHELL_NOT_FOUND: the explicitly requested shell ${JSON.stringify(input.shell)} could not be resolved. ` +
                'No command was run. Omit shell to use the configured default, or provide an existing recognised shell binary.'
            );
          }
          // Does only what the shell itself would have done — today, expanding a bare filename
          // glob PowerShell hands to a native program uninterpreted. Anything it does not
          // understand reaches the shell exactly as the model wrote it. A listing is read
          // lazily from the resolved workdir or one validated relative child directory, so a
          // command with no eligible glob in it never touches the disk here.
          // Normalize first, bind second, and the order is load-bearing. The normalizer
          // recognises ripgrep by its leading program token; binding rewrites that token into
          // `& '<path>\rg.exe'`, which the normalizer does not read as ripgrep at all. Running
          // the bind first therefore silently switched off glob and brace expansion for every
          // ordinary `rg` call — the single failure this file exists to prevent — while looking
          // entirely correct. Binding only ever replaces the program token, so it composes
          // cleanly on top of an already-expanded argument list.
          // Repair before normalising, because everything downstream reads this line by its
          // quotes. A command carrying a bash-style backslash-quote has no coherent quoting
          // to read: the normalizer would tokenize past the end of an argument the shell was
          // going to reject outright. Repairing first means the rest of the pipeline sees a
          // line PowerShell can actually parse, and a line it cannot repair is left exactly
          // as written for the shell to refuse and the hint to explain.
          const repaired = repairPowerShellQuoting(input.cmd, shell.shellType);
          const normalized = normalizeShellCommand(repaired.cmd, shell.shellType, (relativeDirectory = '.') =>
            nodeFs.readdirSync(nodePath.resolve(dir.real, relativeDirectory))
          );
          // PowerShell resolves profile functions/aliases before applications on PATH. The app
          // deliberately ships ripgrep, parses rg's flags against that exact version, and puts
          // it first on child PATH, so a profile-defined `rg` is not a harmless customization:
          // it breaks the assumptions of the normalizer and makes exit-code attribution
          // unknowable. Bind ordinary bare rg/ripgrep invocations to the shipped executable.
          const boundCommand = bindBundledRipgrep(
            normalized.cmd,
            shell.shellType,
            shell.shellType === 'powershell' ? locateRipgrep() : null
          );
          const useLoginShell = input.login ?? true;
          const command = deriveExecArgs(shell, boundCommand, useLoginShell);
          const processId = unifiedExecManager.allocateProcessId();
          // Process ids are deliberately small/reusable, while chat ownership lives in a
          // separate registry from the Codex process manager. An exited session may be
          // evicted by the manager without passing through write_stdin, so its old owner row
          // can outlive the reservation. Clear that row at the *new allocation boundary*,
          // before the child is inserted into the manager. Otherwise a recycled numeric id
          // briefly authorizes the old chat to write/interrupt the new chat's process during
          // this exec_command's initial yield, before noteExecOwner below publishes the new
          // owner. No caller should own a brand-new id until this call actually returns it.
          forgetExecOwner(processId);
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
              hookCommand: boundCommand,
              processId,
              yieldTimeMs: input.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
              maxOutputTokens: input.max_output_tokens,
              truncationPolicy: DEFAULT_TRUNCATION_POLICY,
              cwd: dir.real,
              displayCwd: dir.virtual,
              env: execChildEnvironment(),
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
            const responseText = execCommandResponseText(output);
            // A search that found nothing exits 1 and has not failed. Recording it as an
            // error made a session's error count meaningless; see exec-hints.ts for why this
            // cannot launder a real failure. `benign` only ever *withholds* the error mark —
            // it never turns a genuine non-zero exit into a success.
            const benign = nonZeroExitIsBenign(boundCommand, output.exitCode, responseText);
            noteExec({
              ...(output.processId === null ? {} : { id: String(output.processId) }),
              running: output.processId !== null,
              exitCode: output.exitCode,
              timedOut: false,
              durationMs: output.wallTimeMs,
              benignExit: benign
            });
            noteDetail(input.cmd.replace(/\s+/g, ' ').slice(0, 120));
            logInfo(`tool exec_command ${shell.shellType} -> ${output.processId ?? `exit ${output.exitCode ?? 'unknown'}`}`);
            // `benign` was previously spent only on the error count, leaving the model to read
            // `Process exited with code 1` under an empty body and re-run a search that had
            // already answered. It is the same classification, now also said out loud.
            const notes = [
              ...repaired.notes,
              ...normalized.notes,
              ...(benign ? [benignExitNote(boundCommand)] : []),
              ...execRecoveryHints(boundCommand, responseText)
            ];
            return {
              content: [{ type: 'text' as const, text: withExecNotes(responseText, notes) }],
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

  if (reg.sessionToolsExposed) registerSessionSearchReadTool(reg);

  // ----------------------------------------------------------------- agents

  if (reg.agentToolsExposed) registerAgentsTool(reg);
}


// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/**
 * One tool, four actions, registered only while multi-agent mode is on. Fresh installs enable
 * it; existing configs keep their stored choice, so a user who has it off never sees this schema.
 *
 * The identity model is the whole design, and it is the same one for every role: an agent *is*
 * the ChatGPT conversation it runs in. A chat becomes the prime by spawning from its own proven
 * conversation; a worker is the chat the app opened for its slot, bound and activated by the
 * extension's report before the model there reads its task. Neither is anything the model can
 * assert, so there is no key to carry, no takeover, no promotion and no inference — a call this
 * app cannot place is refused rather than guessed at, and a chat that is not in the run learns
 * only that a run exists.
 *
 * There is no `join`, and no key field anywhere in this schema. There used to be one manual
 * recovery action for the case where the extension's binding report was lost: it was a second
 * way to become a worker, it was the only thing in the app that put a credential into a model's
 * hands, and a run whose binding report never arrived is better restarted than repaired.
 *
 * Every result here also carries `structuredContent`. The text half is what the model should
 * act on and is kept to a sentence or two; ids, states and counts are machine state and belong
 * in a shape the caller can read without parsing English.
 */
function registerAgentsTool(reg: SurfaceRegistrar): void {
  reg.register(
    'agents',
    {
      title: 'Multi-agent run',
      description:
        'Run ChatGPT workers or bounded read-only Antigravity reconnaissance. ' +
        'spawn creates workers (shared context once, per-worker task); message sends one or a batch; status reports the run; finish is terminal for workers. ' +
        'investigate is advisory repository reconnaissance that Prime must verify independently. No agent call carries a key.',
      inputSchema: z.object({
        action: z.enum(['spawn', 'message', 'status', 'finish', 'investigate']).describe('What to do.'),
        context: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'spawn: what every worker here needs, written once — the app puts it in front of each task, so never ' +
              'repeat it there. Repo, conventions file, what not to touch, how to validate, what to report. ' +
              'e.g. "Work in C:\\repo. Follow AGENTS.md. Change nothing unrelated. Run npm test. Do not commit."'
          ),
        workers: z
          .array(
            z.object({
              label: z.string().max(60).optional().describe('Short name shown to the user, e.g. "Security".'),
              task: z
                .string()
                .min(1)
                .max(4000)
                .describe(
                  'This worker\'s own job — with "context", all it sees: objective, files, constraints, what to hand ' +
                    'back. Workers write code as readily as they report, so name the files this one may edit. ' +
                    'e.g. {"label":"Security","task":"Audit attribution in session/correlation.ts; list paths that ' +
                    'misattribute a call. Read only."} · {"label":"Implementer","task":"Make delivery all-or-nothing ' +
                    'in agents.ts, update its test, run npm test, report the diff."}'
                )
            }).strict()
          )
          .min(1)
          .max(8)
          .optional()
          .describe('spawn: the workers to create.'),
        messages: z
          .array(
            z.object({
              to: z.string().min(1).max(40).describe('Recipient.'),
              text: z.string().min(1).max(4000).describe('What to say.')
            }).strict()
          )
          .min(1)
          .max(16)
          .optional()
          .describe(
            'message: several at once, delivered together or not at all — prefer this to one call per recipient. ' +
              'e.g. [{"to":"worker-1","text":"Ignore the UI."},{"to":"worker-3","text":"Check the README."}]'
          ),
        to: z.string().min(1).max(40).optional().describe('message: one recipient, e.g. prime or worker-2.'),
        text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
        result: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            'finish: your handoff to the prime, all it ever sees of your work. Four headings, in order, factual: ' +
              'RESULT (what you found or did), CHANGES (each file created/edited/deleted, one per line, or None), ' +
              'VALIDATION (what you ran and what it said, or None), BLOCKERS (or None).'
          ),
        task: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe('investigate: narrow read-only reconnaissance question; never final verification or mutation.'),
        workdir: pathArg
          .optional()
          .describe('investigate: approved workspace; defaults to current workspace or first approved root.')
      })
      .superRefine((input, ctx) => {
        const reject = (
          field: 'context' | 'workers' | 'messages' | 'to' | 'text' | 'result' | 'task' | 'workdir',
          message: string
        ): void => {
          if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
        };
        if (input.action !== 'spawn') {
          reject('context', 'context is only valid with action=spawn');
          reject('workers', 'workers is only valid with action=spawn');
        }
        if (input.action !== 'message') {
          reject('messages', 'messages is only valid with action=message');
          reject('to', 'to is only valid with action=message');
          reject('text', 'text is only valid with action=message');
        }
        if (input.action !== 'finish') reject('result', 'result is only valid with action=finish');
        if (input.action !== 'investigate') {
          reject('task', 'task is only valid with action=investigate');
          reject('workdir', 'workdir is only valid with action=investigate');
        }
      })
      .strict(),
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

        if (input.action === 'investigate') {
          if (!input.task) return fail('agents action=investigate requires task.');
          // Route before any workspace resolution or process launch. A trivial or unsafe task
          // should cost Prime only this deterministic classification.
          const route = routeAntigravityInvestigation(input.task);
          if (!route.delegated) {
            noteCount(0);
            noteDetail(`Antigravity router kept task with Prime (score ${route.score})`);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Delegation router: not delegated. Prime should do this directly. ${route.reasons.join('; ')}`
                }
              ],
              structuredContent: {
                action: 'investigate',
                provider: 'antigravity',
                delegated: false,
                router_score: route.score,
                router_reasons: route.reasons
              }
            };
          }
          const cwd = await resolveCwd(reg.ctx, input.workdir);
          const report = await investigateWithAntigravity({ task: input.task, cwd: cwd.real });
          noteCount(report.observedFiles.length);
          noteDetail(
            `Antigravity Flash: ${report.toolCalls} tool call(s), ${report.observedFiles.length} source file(s) observed`
          );
          return {
            content: [{ type: 'text' as const, text: formatAntigravityInvestigation(report) }],
            structuredContent: {
              action: 'investigate',
              provider: 'antigravity',
              delegated: true,
              router_score: route.score,
              router_reasons: route.reasons,
              model: ANTIGRAVITY_MODEL,
              workdir: cwd.virtual,
              conversation_id: report.conversationId,
              duration_seconds: report.durationSeconds,
              total_tokens: report.totalTokens,
              partial: report.partial,
              budget_exceeded: report.budgetExceeded,
              report: report.report,
              observed_files: report.observedFiles,
              tool_errors: report.toolErrors,
              tool_calls: report.toolCalls
            }
          };
        }

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
          const staged = stageSpawn({
            workers: input.workers,
            context: input.context ?? null,
            caller: await callerNow(startedAt, { exact: true })
          });
          let accepted = false;
          try {
            let durable = false;
            try {
              durable = await persistCriticalSwarmNow();
            } catch (error) {
              throw new Error(
                `The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request. (${error instanceof Error ? error.message : String(error)})`
              );
            }
            if (!durable) {
              throw new Error(
                'The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.'
              );
            }
            staged.commit();
            accepted = true;
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const { created, becamePrime, runId } = staged;
          // Browser tabs are a publication side effect, never part of planning. They become
          // visible only after the exact broker revision above is durable.
          requestWorkerBootstraps(created.map((worker) => worker.id));
          await adoptAgent(PRIME_ID);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  (becamePrime ? `This conversation is now the prime agent of run ${runId}. ` : '') +
                  `${created.length} worker(s) starting: ${created.map((info) => `${info.id} (${info.label})`).join(', ')}. ` +
                  'Their chats are opening with their briefs already in them. Carry on with your own work — results and ' +
                  'messages arrive at the end of later tool results, so there is nothing to wait for and never anything ' +
                  'to poll. A short correction with action=message while a worker is still going is far cheaper than ' +
                  'the alternative.'
              }
            ],
            structuredContent: {
              action: 'spawn',
              run_id: runId,
              self: PRIME_ID,
              became_prime: becamePrime,
              workers: created.map((info) => ({ id: info.id, label: info.label, state: info.state }))
            }
          };
        }

        if (input.action === 'message') {
          // Two spellings of one operation. A single message is the common case and stays a
          // pair of scalars; `messages` is the same thing in bulk. Both in one call is a
          // request whose intended order nobody can read, so it is refused rather than
          // guessed at.
          const batch = input.messages ?? [];
          const single = input.to && input.text ? [{ to: input.to, text: input.text }] : [];
          if (batch.length > 0 && single.length > 0) {
            return fail('agents action=message takes either to+text or messages, not both.');
          }
          const items = batch.length > 0 ? batch : single;
          if (items.length === 0) return fail('agents action=message requires to and text, or a messages array.');
          // One call, one identity resolution, one all-or-nothing delivery: a prime
          // redirecting its whole run cannot end up with two of its three messages sent.
          const staged = stageMessages(await callerNow(startedAt), items);
          let accepted = false;
          try {
            let durable = false;
            try {
              durable = await persistCriticalSwarmNow();
            } catch (error) {
              throw new Error(
                `The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request. (${error instanceof Error ? error.message : String(error)})`
              );
            }
            if (!durable) {
              throw new Error('The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.');
            }
            staged.commit();
            accepted = true;
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const sent = staged.messages;
          for (const message of sent) await recordAgentMessage(message, 'sent');
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Queued for ${sent.map((message) => message.to).join(', ')}. Carry on with the work — a reply, if ` +
                  'there is one, arrives at the end of a later tool result.'
              }
            ],
            structuredContent: {
              action: 'message',
              queued: sent.map((message) => ({ id: message.id, to: message.to }))
            }
          };
        }

        if (input.action === 'finish') {
          if (!input.result) return fail('agents action=finish requires result.');
          const staged = stageFinishAgent(await callerNow(startedAt), input.result);
          let accepted = staged.repeat;
          try {
            if (!staged.repeat) {
              let durable = false;
              try {
                durable = await persistCriticalSwarmNow();
              } catch (error) {
                throw new Error(
                  `The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result. (${error instanceof Error ? error.message : String(error)})`
                );
              }
              if (!durable) {
                throw new Error(
                  'The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result.'
                );
              }
              staged.commit();
              accepted = true;
            }
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const { info, report, repeat } = staged;
          if (report) await recordAgentMessage(report, 'sent');
          // A retry is answered as a retry. Repeating "marked finished" would read as a
          // second finish and invite the model to keep going until it gets a different
          // answer, which is how one lost result became a queue of identical reports.
          return {
            content: [
              {
                type: 'text' as const,
                text: repeat
                  ? `${info.id} was already ${info.state} and the prime agent already has that result, so nothing was ` +
                    'sent again. You are done: stop working and stop calling tools.'
                  : `${info.id} marked finished. The prime agent has your result. You are done: stop working and stop ` +
                    'calling tools.'
              }
            ],
            structuredContent: { action: 'finish', self: info.id, state: info.state, repeat }
          };
        }

        // status. Read-only, and deliberately small: it is the run as its own members see it,
        // and `identify` is what decides whether this caller is one of them. An unrelated
        // chat is told AGENTS_BUSY and nothing else — not who the prime is, not how many
        // workers there are, not what any of them are doing.
        const me = identify(await callerNow(startedAt));
        const state = swarmState();
        const failed = state.agents.filter((info) => info.state === 'failed');
        return {
          content: [
            {
              type: 'text' as const,
              text:
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
                // Said in words as well as in the table: a failed worker will not report, and
                // waiting for it is the mistake this line prevents.
                (failed.length > 0
                  ? `\n\n${failed.map((info) => info.id).join(', ')} will not report. Do that work yourself or create ` +
                    'a replacement worker; do not wait for them.'
                  : '')
            }
          ],
          structuredContent: {
            action: 'status',
            run_id: currentRunId(),
            self: me.id,
            agents: state.agents.map((info) => ({
              id: info.id,
              role: info.role,
              label: info.label,
              state: info.state,
              waiting: info.pending,
              result: info.result ?? null
            }))
          }
        };
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
  // `exact` marks the one action that binds a run: spawn. It is the call whose refusal the
  // model cannot absorb, so it gets the longer ceiling; every other `agents` action can be
  // declined and asked again on the next tool call.
  const window = base.requestId ? (options.exact ? SPAWN_EVIDENCE_MS : IDENTITY_EVIDENCE_MS) : PRIME_EVIDENCE_MS;
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
): Promise<{ matches: string[]; truncated: 'matches' | 'scan' | null }> {
  const normalised = pattern.replace(/\\/g, '/');
  const segments = normalised.split('/');
  const baseSegments: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    baseSegments.push(segment);
  }
  // A leading wildcard is workspace-relative. Substituting `/` here silently changed
  // `*.ts` into an absolute virtual-root lookup and made every learned workspace useless.
  const base = baseSegments.join('/') || (normalised.startsWith('/') ? '/' : '');
  const rest = segments.slice(baseSegments.length).join('/');
  if (!rest) return { matches: [normalised], truncated: null };

  const resolved = await resolveIn(roots, base);
  const info = await statInfo(resolved.real, resolved.virtual, { scanContent: false });
  if (info.type !== 'directory') throw new SandboxError(`${resolved.virtual} is not a folder, so it cannot be globbed`);

  // `**` walks with Codex's bounded breadth-first walk; a single-level pattern needs one
  // directory read and nothing more.
  let candidates: string[];
  let scanTruncated = false;
  if (rest.includes('**')) {
    const walked = await walkFiles(resolved.real, resolved.virtual, {
      maxEntries: GLOB_SCAN_LIMIT,
      exclude: DEFAULT_EXCLUDES
    });
    candidates = walked.files;
    scanTruncated = walked.truncated;
  } else {
    const listed = await listDirectoryLevel(resolved.real, resolved.virtual, GLOB_SCAN_LIMIT, false);
    candidates = listed.entries.filter((entry) => entry.type === 'file').map((entry) => entry.virtualPath);
    scanTruncated = listed.truncated;
  }

  const matcher = globToRegExp(rest, false);
  const prefixLength = resolved.virtual.length + 1;
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!matcher.test(candidate.slice(prefixLength))) continue;
    // Truncation means there is an actual omitted match, not merely that the result landed
    // exactly on the cap. Returning `matches` as soon as the 20th item was added made a folder
    // with exactly 20 matches claim "more than 20 matches" and sent the model narrowing a query
    // that had already been answered completely.
    if (matches.length >= MAX_GLOB_MATCHES) return { matches, truncated: 'matches' };
    matches.push(candidate);
  }
  return { matches, truncated: scanTruncated ? 'scan' : null };
}

interface ReadOneOptions {
  roots: Parameters<typeof resolvePath>[0];
  canRead: boolean;
  canBrowse: boolean;
  startLine?: number;
  endLine?: number;
  maxBytes: number;
  aggregateBytes: number;
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
  const info = await statInfo(resolved.real, resolved.virtual, { scanContent: !options.canRead });

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
    const text = `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\nNot a regular file, so there is nothing to read.`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  if (!options.canRead) {
    // Metadata without content is a real answer when the user granted exactly that, and it
    // is strictly better than refusing the path outright.
    const text = `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\n(file contents need the Read files permission)`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  const extension = nodePath.extname(resolved.virtual).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    // The same loader `view_image` uses, so an image opened through either tool is validated and
    // decoded identically. `view_image` still exists in its own right: it is Codex's tool, with
    // Codex's name, schema and errors, and this branch is only `read` continuing to answer "what
    // is at this path" for a path that happens to be a picture.
    // Do not inherit the 64 KiB text-section default: ordinary screenshots are not text.
    // The enclosing read call still has a 512 KiB aggregate wire budget, and the base64
    // representation—not merely the smaller compressed file—is what consumes it.
    const image = await viewImage(resolved.real, null, undefined, resolved.virtual);
    logInfo(`tool read image ${resolved.virtual} (${formatBytes(image.bytes)})`);
    const text = `--- ${resolved.virtual} — ${formatBytes(image.bytes)} ${image.mimeType} ---`;
    const responseBytes = Buffer.byteLength(text, 'utf8') + image.base64.length;
    if (responseBytes > options.aggregateBytes) {
      throw new Error(
        `Image response would exceed read's ${formatBytes(MAX_READ_BYTES)} aggregate output cap; use view_image for this file.`
      );
    }
    return {
      text,
      bytes: responseBytes,
      image: { data: image.base64, mimeType: image.mimeType }
    };
  }

  if (info.binary) {
    // Never dumped as base64. A model that asked to read a .dll wanted to know what it is,
    // and several megabytes of base64 answers a question nobody asked at ruinous cost.
    const text =
      `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\n` +
      'Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.';
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  let result;
  try {
    result = await readTextFile(resolved.real, {
      startLine: options.startLine,
      endLine: options.endLine,
      maxBytes: options.maxBytes
    });
  } catch (error) {
    if (!(error instanceof BinaryReadError)) throw error;
    info.binary = true;
    const text =
      `--- ${resolved.virtual} ---\n${formatFileInfo(info)}\n` +
      'Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.';
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }
  if (result.lastLine >= result.firstLine) noteDetail(`lines ${result.firstLine}–${result.lastLine}`);
  /*
   * How long is this file?
   *
   * That is the question the header's line count exists to answer, and it used to go unanswered
   * on exactly the reads that needed it: a range read stopped at `end_line`, so `totalLines` was
   * null and the header said `lines 600-750` with no denominator. The caller could see what it
   * had and not what it was a part of — which is how "600-750" gets mistaken for a whole file,
   * and how a follow-up read gets aimed at a line that does not exist.
   *
   * `info.lines` is no help here: `readOne` calls `statInfo` with `scanContent: !canRead`, so in
   * the ordinary read path the content scan is skipped and `info.lines` is null. The total now
   * comes from the read itself, which counts on past the range (see `MAX_LINE_COUNT_BYTES`).
   *
   * So a total is missing in one case only — a range inside a file too big to be worth counting —
   * and the header then states the range plainly rather than inventing a denominator.
   */
  const numbered = boundedNumberedRead(
    result.text,
    result.firstLine,
    result.lastLine >= result.firstLine,
    options.maxBytes
  );
  const visibleLastLine = numbered.lastLine;
  const range =
    visibleLastLine < result.firstLine
      ? result.totalLines === null
        ? 'no lines in that range'
        : `no lines in that range; the file has ${result.totalLines}`
      : result.totalLines === null
        ? `lines ${result.firstLine}-${visibleLastLine}`
        : `lines ${result.firstLine}-${visibleLastLine} of ${result.totalLines}`;
  const note = result.truncated || numbered.truncated
    ? `\n(output cap reached; continue from line ${visibleLastLine + 1} or raise max_bytes up to ${MAX_READ_BYTES})`
    : result.hasMore
      ? `\n(more lines follow — continue from line ${visibleLastLine + 1})`
      : '';
  const header = `--- ${resolved.virtual} — ${range}, ${formatBytes(info.bytes)}, modified ${info.modified} ---`;
  const text = `${header}${numbered.text === '' && visibleLastLine < result.firstLine ? '' : `\n${numbered.text}`}${note}`;
  return {
    text,
    // Charge the aggregate call budget for what is actually serialized, including headers and
    // line-number prefixes. Counting only raw file bytes let thousands of short lines amplify a
    // nominal 512 KiB cap into a multi-megabyte MCP response.
    bytes: Buffer.byteLength(text, 'utf8')
  };
}

/**
 * Adds the model-visible line-number prefix without letting that metadata amplify a bounded
 * file slice into an unbounded MCP result. `readTextFile` caps raw decoded bytes; a file made of
 * hundreds of thousands of empty/tiny lines can add several extra megabytes of decimal prefixes
 * afterwards. Spend the same budget on the numbered representation too. A real empty logical
 * line is represented by `N\t`; `hasLine=false` is the only case that renders no row.
 */
function boundedNumberedRead(
  text: string,
  firstLine: number,
  hasLine: boolean,
  maxBytes: number
): { text: string; lastLine: number; truncated: boolean } {
  if (!hasLine) return { text: '', lastLine: firstLine - 1, truncated: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const rendered = `${firstLine + index}\t${lines[index] ?? ''}`;
    const cost = Buffer.byteLength(rendered, 'utf8') + (kept.length === 0 ? 0 : 1);
    // Always return the first logical line. The backend already guaranteed that raw line fits
    // the requested budget; the small line-number prefix must not turn that into an empty-page
    // retry loop.
    if (kept.length > 0 && bytes + cost > maxBytes) break;
    kept.push(rendered);
    bytes += cost;
  }
  return {
    text: kept.join('\n'),
    lastLine: firstLine + kept.length - 1,
    truncated: kept.length < lines.length
  };
}

export type { ToolResult };
