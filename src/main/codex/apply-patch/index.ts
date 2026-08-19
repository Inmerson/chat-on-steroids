/**
 * Port of `codex-rs/apply-patch/src/lib.rs` plus the thin runtime wrapper in
 * `codex-rs/core/src/tools/runtimes/apply_patch.rs`.
 *
 * Codex writes to real stdout/stderr because `apply_patch` is also a standalone executable; the
 * runtime hands it two in-memory buffers and reports `exit_code = failed ? 1 : 0` with
 * `aggregated_output = stdout + stderr`. This port keeps the buffers and drops the executable.
 *
 * Codex's `anyhow` contexts are reproduced as the message of a single thrown error, because
 * `anyhow::Error`'s `Display` prints only the outermost context — and that string is exactly what
 * Codex writes to stderr, and therefore what the model reads.
 */

import nodePath from 'node:path';

import { createDirectory, getMetadata, invalidInput, readFileText, remove, writeFile } from '../filesystem.js';
import { ApplyPatchError, PatchParseError } from './errors.js';
import { deriveNewContentsFromChunks } from './file-update.js';
import { hunkPath, type Hunk } from './hunk.js';
import { DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE, type ApplyPatchFileUpdateMode } from './mode.js';
import { parsePatch } from './parser.js';

export { ApplyPatchError, PatchParseError } from './errors.js';
export { parsePatch, parsePatchText, type ApplyPatchArgs } from './parser.js';
export { StreamingPatchParser } from './streaming-parser.js';
export type { Hunk, UpdateFileChunk } from './hunk.js';
export {
  DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
  type ApplyPatchFileUpdateMode
} from './mode.js';

/**
 * `AffectedPaths`: file paths affected by applying a patch, preserving the path spelling from the
 * patch for user-facing summaries.
 */
export interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** Resolves a path as spelled in the patch. Throwing here rejects the whole patch. */
export type PatchPathResolver = (spelledPath: string, cwd: string) => string;

const defaultPathResolver: PatchPathResolver = (spelledPath, cwd) => nodePath.resolve(cwd, spelledPath);

/** `AppliedPatchFileChange`. */
export type AppliedPatchFileChange =
  | { kind: 'add'; content: string; overwrittenContent: string | null }
  | { kind: 'delete'; content: string }
  | {
      kind: 'update';
      movePath: string | null;
      oldContent: string;
      overwrittenMoveContent: string | null;
      newContent: string;
    };

/** `AppliedPatchChange`: a committed file change, preserved in the order it was applied. */
export interface AppliedPatchChange {
  path: string;
  change: AppliedPatchFileChange;
}

/** `AppliedPatchDelta`: the textual file changes actually committed while applying a patch. */
export interface AppliedPatchDelta {
  changes: AppliedPatchChange[];
  /** False once a partial write means the recorded changes may not describe what is on disk. */
  exact: boolean;
}

function emptyDelta(): AppliedPatchDelta {
  return { changes: [], exact: true };
}

/** `ApplyPatchFailure`: a failure together with the mutations committed before it was observed. */
export class ApplyPatchFailure extends Error {
  readonly error: ApplyPatchError;
  readonly delta: AppliedPatchDelta;

  constructor(error: ApplyPatchError, delta: AppliedPatchDelta) {
    super(error.message, { cause: error });
    this.name = 'ApplyPatchFailure';
    this.error = error;
    this.delta = delta;
  }
}

/** Stands in for Codex's `impl std::io::Write`; the runtime always passes in-memory buffers. */
export interface Writer {
  text: string;
}

function writeLine(out: Writer, line: string): void {
  out.text += `${line}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rust's `.with_context(|| ...)`: replaces the message the caller will see while keeping the
 * original error reachable as the cause.
 */
async function withContext<T>(work: Promise<T>, context: () => string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Error(context(), { cause: error });
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** `apply_patch`: applies the patch and writes the result to the given buffers. */
export async function applyPatch(
  patch: string,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  return await applyPatchWithMode(
    patch,
    DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
    cwd,
    stdout,
    stderr,
    resolvePath
  );
}

/** `apply_patch_with_mode`. */
export async function applyPatchWithMode(
  patch: string,
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  let hunks: Hunk[];
  try {
    hunks = parsePatch(patch).hunks;
  } catch (error) {
    if (!(error instanceof PatchParseError)) throw error;
    if (error.kind === 'invalid_patch') {
      writeLine(stderr, `Invalid patch: ${error.detail}`);
    } else {
      writeLine(stderr, `Invalid patch hunk on line ${error.lineNumber}: ${error.detail}`);
    }
    throw new ApplyPatchFailure(ApplyPatchError.fromParseError(error), emptyDelta());
  }

  return await applyHunksWithMode(hunks, updateFileMode, cwd, stdout, stderr, resolvePath);
}

/** `apply_hunks_with_mode`. */
export async function applyHunksWithMode(
  hunks: readonly Hunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  const delta = emptyDelta();
  try {
    const affectedPaths = await applyHunksToFiles(hunks, updateFileMode, cwd, resolvePath, delta);
    printSummary(affectedPaths, stdout);
    return delta;
  } catch (error) {
    const message = messageOf(error);
    writeLine(stderr, message);
    const applyPatchError =
      error instanceof ApplyPatchError ? error : ApplyPatchError.io('I/O error', error);
    throw new ApplyPatchFailure(applyPatchError, delta);
  }
}

/**
 * `apply_hunks_to_files`: applies each parsed patch hunk to the filesystem, reporting which files
 * were added, modified, or deleted.
 */
async function applyHunksToFiles(
  hunks: readonly Hunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  resolvePath: PatchPathResolver,
  delta: AppliedPatchDelta
): Promise<AffectedPaths> {
  if (hunks.length === 0) throw new Error('No files were modified.');

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  // A failed write can still have modified the target before surfacing an error (for example by
  // truncating before ENOSPC), so the accumulated delta is no longer exact when a write fails.
  const tryWrite = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      delta.exact = false;
      throw error;
    }
  };

  for (const hunk of hunks) {
    const affectedPath = hunkPath(hunk);
    const resolved = resolveHunkPath(hunk, cwd, resolvePath);

    if (hunk.kind === 'add_file') {
      const overwrittenContent = await readOptionalFileTextForDelta(resolved, delta);
      await tryWrite(writeFileWithMissingParentRetry(resolved, hunk.contents));
      delta.changes.push({
        path: resolved,
        change: { kind: 'add', content: hunk.contents, overwrittenContent }
      });
      added.push(affectedPath);
      continue;
    }

    if (hunk.kind === 'delete_file') {
      await noteExistingPathDeltaSupport(resolved, delta);
      let deletedContent: string | null = null;
      try {
        deletedContent = await readFileText(resolved);
      } catch {
        delta.exact = false;
      }
      await withContext(ensureNotDirectory(resolved), () => `Failed to delete file ${resolved}`);
      try {
        await withContext(
          remove(resolved, { recursive: false, force: false }),
          () => `Failed to delete file ${resolved}`
        );
      } catch (error) {
        const sideEffectFree = await removeFailureWasSideEffectFree(resolved, deletedContent);
        delta.exact = delta.exact && sideEffectFree;
        throw error;
      }
      if (deletedContent !== null) {
        delta.changes.push({ path: resolved, change: { kind: 'delete', content: deletedContent } });
      }
      deleted.push(affectedPath);
      continue;
    }

    await noteExistingPathDeltaSupport(resolved, delta);
    const { originalContents, newContents } = await deriveNewContentsFromChunks(
      resolved,
      hunk.chunks,
      updateFileMode
    );

    if (hunk.movePath !== null) {
      const destination = resolvePath(hunk.movePath, cwd);
      const overwrittenMoveContent = await readOptionalFileTextForDelta(destination, delta);
      await tryWrite(writeFileWithMissingParentRetry(destination, newContents));
      const destinationChangeIndex = delta.changes.length;
      delta.changes.push({
        path: destination,
        change: { kind: 'add', content: newContents, overwrittenContent: overwrittenMoveContent }
      });
      await withContext(ensureNotDirectory(resolved), () => `Failed to remove original ${resolved}`);
      try {
        await withContext(
          remove(resolved, { recursive: false, force: false }),
          () => `Failed to remove original ${resolved}`
        );
      } catch (error) {
        const sideEffectFree = await removeFailureWasSideEffectFree(resolved, originalContents);
        delta.exact = delta.exact && sideEffectFree;
        throw error;
      }
      delta.changes[destinationChangeIndex] = {
        path: resolved,
        change: {
          kind: 'update',
          movePath: destination,
          oldContent: originalContents,
          overwrittenMoveContent,
          newContent: newContents
        }
      };
      modified.push(affectedPath);
      continue;
    }

    await tryWrite(
      withContext(writeFile(resolved, newContents), () => `Failed to write file ${resolved}`)
    );
    delta.changes.push({
      path: resolved,
      change: {
        kind: 'update',
        movePath: null,
        oldContent: originalContents,
        overwrittenMoveContent: null,
        newContent: newContents
      }
    });
    modified.push(affectedPath);
  }

  return { added, modified, deleted };
}

/** `Hunk::resolve_path`, routed through the caller's resolver so it can reject a path. */
function resolveHunkPath(hunk: Hunk, cwd: string, resolvePath: PatchPathResolver): string {
  const spelled = hunk.kind === 'update_file' ? hunk.path : hunkPath(hunk);
  return resolvePath(spelled, cwd);
}

async function ensureNotDirectory(path: string): Promise<void> {
  const metadata = await getMetadata(path);
  if (metadata.isDirectory) throw invalidInput('path is a directory');
}

async function removeFailureWasSideEffectFree(
  path: string,
  expectedContent: string | null
): Promise<boolean> {
  if (expectedContent === null) return false;
  try {
    return (await readFileText(path)) === expectedContent;
  } catch {
    return false;
  }
}

async function readOptionalFileTextForDelta(path: string, delta: AppliedPatchDelta): Promise<string | null> {
  await noteExistingPathDeltaSupport(path, delta);
  try {
    return await readFileText(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    delta.exact = false;
    return null;
  }
}

async function noteExistingPathDeltaSupport(path: string, delta: AppliedPatchDelta): Promise<void> {
  try {
    const metadata = await getMetadata(path);
    if (!(metadata.isFile && !metadata.isSymlink)) delta.exact = false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') delta.exact = false;
  }
}

async function writeFileWithMissingParentRetry(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents);
    return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new Error(`Failed to write file ${path}`, { cause: error });
    }
  }
  const parent = nodePath.dirname(path);
  await withContext(
    createDirectory(parent, { recursive: true }),
    () => `Failed to create parent directories for ${path}`
  );
  await withContext(writeFile(path, contents), () => `Failed to write file ${path}`);
}

/** `print_summary`: the summary of changes, in git-style format. */
export function printSummary(affected: AffectedPaths, out: Writer): void {
  writeLine(out, 'Success. Updated the following files:');
  for (const path of affected.added) writeLine(out, `A ${path}`);
  for (const path of affected.modified) writeLine(out, `M ${path}`);
  for (const path of affected.deleted) writeLine(out, `D ${path}`);
}

/** What `ApplyPatchRuntime::run` produces for the tool layer. */
export interface ApplyPatchExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  aggregatedOutput: string;
  durationMs: number;
  delta: AppliedPatchDelta;
}

/** `ApplyPatchRuntime::run`: applies a patch and reports it as if it were an exec call. */
export async function executeApplyPatch(options: {
  patch: string;
  cwd: string;
  updateFileMode?: ApplyPatchFileUpdateMode;
  resolvePath?: PatchPathResolver;
}): Promise<ApplyPatchExecution> {
  const startedAt = performance.now();
  const stdout: Writer = { text: '' };
  const stderr: Writer = { text: '' };
  let delta: AppliedPatchDelta;
  let failed = false;
  try {
    delta = await applyPatchWithMode(
      options.patch,
      options.updateFileMode ?? DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
      options.cwd,
      stdout,
      stderr,
      options.resolvePath ?? defaultPathResolver
    );
  } catch (error) {
    failed = true;
    if (error instanceof ApplyPatchFailure) {
      delta = error.delta;
    } else {
      // A resolver rejection, or any other error raised outside the ported control flow.
      delta = emptyDelta();
      writeLine(stderr, messageOf(error));
    }
  }
  return {
    exitCode: failed ? 1 : 0,
    stdout: stdout.text,
    stderr: stderr.text,
    aggregatedOutput: `${stdout.text}${stderr.text}`,
    durationMs: performance.now() - startedAt,
    delta
  };
}

/** `ApplyPatchFileChange`: what verification says a hunk would do, before anything is written. */
export type ApplyPatchFileChange =
  | { kind: 'add'; content: string }
  | { kind: 'delete'; content: string }
  | { kind: 'update'; movePath: string | null; newContent: string };

/**
 * `ApplyPatchAction`: the result of verifying a parsed patch.
 *
 * Codex also carries a unified diff per update for its approval UI; see `file-update.ts` for why
 * this port does not compute one.
 */
export interface ApplyPatchAction {
  changes: Map<string, ApplyPatchFileChange>;
  updateFileMode: ApplyPatchFileUpdateMode;
  patch: string;
  cwd: string;
}

/**
 * `try_verify_apply_patch_args`: resolves every hunk and works out what it would do.
 *
 * This is a dry run against the real filesystem, so a delete of a missing file or an update whose
 * context cannot be located fails here, before any file is touched. Codex reports those failures
 * to the model as `apply_patch verification failed: {error}` rather than as a patch that ran and
 * exited non-zero.
 */
export async function verifyApplyPatchArgs(
  args: { patch: string; hunks: readonly Hunk[]; workdir: string | null },
  cwd: string,
  updateFileMode: ApplyPatchFileUpdateMode,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<ApplyPatchAction> {
  const effectiveCwd = args.workdir === null ? cwd : resolvePath(args.workdir, cwd);
  const changes = new Map<string, ApplyPatchFileChange>();

  for (const hunk of args.hunks) {
    const path = resolveHunkPath(hunk, effectiveCwd, resolvePath);
    if (changes.has(path)) {
      throw ApplyPatchError.fromParseError(
        PatchParseError.invalidPatch(`multiple operations target ${path}`)
      );
    }
    if (hunk.kind === 'add_file') {
      changes.set(path, { kind: 'add', content: hunk.contents });
      continue;
    }
    if (hunk.kind === 'delete_file') {
      let content: string;
      try {
        content = await readFileText(path);
      } catch (error) {
        throw ApplyPatchError.io(`Failed to read ${path}`, error);
      }
      changes.set(path, { kind: 'delete', content });
      continue;
    }
    const { newContents } = await deriveNewContentsFromChunks(path, hunk.chunks, updateFileMode);
    changes.set(path, {
      kind: 'update',
      movePath: hunk.movePath === null ? null : resolvePath(hunk.movePath, effectiveCwd),
      newContent: newContents
    });
  }

  return { changes, updateFileMode, patch: args.patch, cwd: effectiveCwd };
}
