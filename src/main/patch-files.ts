import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rawPromises as fs } from './rawfs.js';
import {
  MAX_BATCH_EDIT_BYTES,
  assertWritableSize,
  encodeEditableTextFile,
  FsOpError,
  readEditableTextFile,
  type EditableTextSnapshot
} from './fsops.js';
import { lineDelta, type LineDelta } from './diffstat.js';
import { applyTextPatch, type PatchHunk } from './patch.js';

export interface ResolvedPatchPath {
  real: string;
  virtual: string;
}

export type ResolvedPatchOperation =
  | { kind: 'add'; path: ResolvedPatchPath; content: string }
  | { kind: 'delete'; path: ResolvedPatchPath }
  | { kind: 'update'; path: ResolvedPatchPath; moveTo: ResolvedPatchPath | null; hunks: PatchHunk[] };

export interface PatchFileResult {
  kind: 'add' | 'delete' | 'update' | 'move';
  path: string;
  destination?: string;
  delta: LineDelta;
  bytes: number;
  hunks: number;
  /** Non-fatal placement notes from the matcher. The mutation happened regardless. */
  warnings?: string[];
}

interface PreparedMutation {
  kind: PatchFileResult['kind'];
  source: ResolvedPatchPath | null;
  destination: ResolvedPatchPath | null;
  originalSource: Buffer | null;
  nextDestination: Buffer | null;
  result: PatchFileResult;
}

/**
 * The folders that have to exist before `realPath` can be written, outermost first.
 *
 * `apply_patch` promises in its own description that adding a file creates its parent
 * folders, and it did not: the staging write opened a temp file in a directory nobody had
 * created, so a patch adding `demo/src/main.ts` under a missing `demo/` failed with a bare
 * `Not found` that named neither the missing folder nor the operation. Resolution already
 * permits the missing tail (`allowMissing`), so the gap was only ever here.
 *
 * The walk stops at the first ancestor that exists; the sandbox has already proved the whole
 * path lies inside an approved root, so every level below that point is ours to create.
 */
async function missingAncestors(realPath: string): Promise<string[]> {
  const needed: string[] = [];
  let dir = path.dirname(realPath);
  for (;;) {
    const parent = path.dirname(dir);
    try {
      await fs.stat(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    needed.unshift(dir);
    // `path.dirname` is its own fixed point at a filesystem root. Reaching one means the
    // whole chain was missing, which containment should have ruled out; stop rather than spin.
    if (parent === dir) break;
    dir = parent;
  }
  return needed;
}

async function readIfExists(realPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(realPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function mustNotExist(target: ResolvedPatchPath): Promise<void> {
  try {
    await fs.lstat(target.real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new FsOpError(`${target.virtual}: destination already exists`);
}

function pathKey(realPath: string): string {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

async function writeTemp(target: string, bytes: Buffer, kind: string): Promise<string> {
  const temp = path.join(path.dirname(target), `.clf-patch-${kind}-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temp;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreBytes(target: string, bytes: Buffer): Promise<void> {
  const temp = await writeTemp(target, bytes, 'rollback');
  try {
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * One path's state in the patch's own view of the filesystem, as of the block being read.
 *
 * A patch may name the same file more than once, and the second block has to see the first
 * block's work — exactly as a second hunk inside one block does. So preflight resolves
 * against this staged text rather than re-reading the disk, and the disk is read once per
 * path, the first time the patch mentions it.
 *
 * `originalBytes` stays as it was on disk so the commit's optimistic check and the rollback
 * both still compare against the real starting file, however many blocks touched it.
 */
interface StagedPath {
  path: ResolvedPatchPath;
  kind: PatchFileResult['kind'];
  /** Bytes on disk at preflight; null for a path this patch creates. */
  originalBytes: Buffer | null;
  /** Decoded text on disk at preflight; null only for a reserved move destination. */
  originalText: string | null;
  /** Format template for re-encoding. Null for a path this patch creates (plain UTF-8). */
  format: EditableTextSnapshot['format'] | null;
  /** The text as the patch now has it, or null once the patch has removed the path. */
  text: string | null;
  moveTo: ResolvedPatchPath | null;
  delta: LineDelta;
  hunks: number;
  warnings: string[];
  /** True for a destination reserved by a move: nothing lives here yet, but it is spoken for. */
  reserved: boolean;
}

/** How a path was left, for a refusal message that says what actually collided. */
function stateOf(slot: StagedPath): string {
  if (slot.reserved) return 'it is already this patch’s move destination';
  if (slot.kind === 'add') return 'this patch adds it';
  if (slot.kind === 'delete') return 'this patch deletes it';
  if (slot.kind === 'move') return 'this patch moves it away';
  return 'this patch updates it';
}

/**
 * Preflight a whole Codex-style patch and commit it as one bounded local transaction.
 * Every file is read and every hunk is resolved before the first target is modified.
 * Commit failures trigger a conservative rollback that refuses to overwrite a file
 * another process changed after our write.
 */
export async function applyResolvedPatch(operations: readonly ResolvedPatchOperation[]): Promise<PatchFileResult[]> {
  if (operations.length === 0) throw new FsOpError('Patch has no file operations');

  // Insertion-ordered, so results come back in the order the patch first named each path.
  const slots = new Map<string, StagedPath>();

  const refuse = (target: ResolvedPatchPath, slot: StagedPath, what: string): never => {
    throw new FsOpError(`${target.virtual}: patch cannot ${what} because ${stateOf(slot)}`);
  };

  for (const operation of operations) {
    const key = pathKey(operation.path.real);
    const existing = slots.get(key) ?? null;

    if (operation.kind === 'add') {
      // Every prior state of a path is incompatible with adding it: the patch would be
      // adding something it has already created, already updated, or just deleted — and in
      // the last case the intent (replace? or a stale block?) is not ours to guess.
      if (existing) refuse(operation.path, existing, 'add this file');
      await mustNotExist(operation.path);
      assertWritableSize(operation.content);
      slots.set(key, {
        path: operation.path,
        kind: 'add',
        originalBytes: null,
        originalText: '',
        format: null,
        text: operation.content,
        moveTo: null,
        delta: lineDelta('', operation.content),
        hunks: 0,
        warnings: [],
        reserved: false
      });
      continue;
    }

    if (operation.kind === 'delete') {
      // Deleting a path this patch has already worked on is the same ambiguity in reverse.
      if (existing) refuse(operation.path, existing, 'delete this file');
      const snapshot = await readEditableTextFile(operation.path.real, operation.path.virtual);
      slots.set(key, {
        path: operation.path,
        kind: 'delete',
        originalBytes: snapshot.originalBytes,
        originalText: snapshot.text,
        format: snapshot.format,
        text: null,
        moveTo: null,
        delta: lineDelta(snapshot.text, ''),
        hunks: 0,
        warnings: [],
        reserved: false
      });
      continue;
    }

    // An update, which is the one operation a patch may legitimately repeat for a path.
    let slot = existing;
    if (slot) {
      // ...but only from a state that still has a file at this path and no move pending.
      // A second update of a path already moved away would be resolving hunks against text
      // that will not be there, and a second move is two destinations for one file.
      if (slot.text === null || slot.reserved || slot.kind === 'add' || slot.moveTo) {
        refuse(operation.path, slot, 'update this file');
      }
    } else {
      const snapshot = await readEditableTextFile(operation.path.real, operation.path.virtual);
      slot = {
        path: operation.path,
        kind: 'update',
        originalBytes: snapshot.originalBytes,
        originalText: snapshot.text,
        format: snapshot.format,
        text: snapshot.text,
        moveTo: null,
        delta: { added: 0, removed: 0, approximate: false },
        hunks: 0,
        warnings: [],
        reserved: false
      };
      slots.set(key, slot);
    }

    // Against the staged text, so a second block reads the first block's result.
    const applied = applyTextPatch(slot.text!, operation.hunks);
    slot.text = applied.text;
    // The user-visible delta is disk-original -> final staged text, not the sum of each
    // intermediate block. Summing made `one -> two -> three` look like +2/-2 and an undo
    // (`one -> two -> one`) look changed even though the committed file was byte-identical.
    // `lineDelta` is sparse-safe, so distant edits in a large file stay exact here too.
    slot.delta = lineDelta(slot.originalText!, slot.text);
    slot.hunks += applied.hunks;
    slot.warnings.push(...applied.warnings);

    if (operation.moveTo) {
      const moveKey = pathKey(operation.moveTo.real);
      const heldDestination = slots.get(moveKey);
      if (heldDestination) refuse(operation.moveTo, heldDestination, 'move a file here');
      await mustNotExist(operation.moveTo);
      slot.kind = 'move';
      slot.moveTo = operation.moveTo;
      slots.set(moveKey, {
        path: operation.moveTo,
        kind: 'move',
        originalBytes: null,
        originalText: null,
        format: null,
        text: null,
        moveTo: null,
        delta: { added: 0, removed: 0, approximate: false },
        hunks: 0,
        warnings: [],
        reserved: true
      });
    }
  }

  const prepared: PreparedMutation[] = [];
  let totalBytes = 0;
  for (const slot of slots.values()) {
    // A reservation is a claim on a name, not an operation of its own.
    if (slot.reserved) continue;

    if (slot.kind === 'delete') {
      totalBytes += slot.originalBytes!.length;
      prepared.push({
        kind: 'delete',
        source: slot.path,
        destination: null,
        originalSource: slot.originalBytes,
        nextDestination: null,
        result: { kind: 'delete', path: slot.path.virtual, delta: slot.delta, bytes: 0, hunks: 0 }
      });
      continue;
    }

    const next =
      slot.format === null
        ? Buffer.from(slot.text!, 'utf8')
        : encodeEditableTextFile(slot.text!, { format: slot.format });
    totalBytes += Math.max(slot.originalBytes?.length ?? 0, next.length);
    prepared.push({
      kind: slot.kind,
      source: slot.kind === 'add' ? null : slot.path,
      destination: slot.moveTo ?? slot.path,
      originalSource: slot.originalBytes,
      nextDestination: next,
      result: {
        kind: slot.kind,
        path: slot.path.virtual,
        ...(slot.moveTo ? { destination: slot.moveTo.virtual } : {}),
        delta: slot.delta,
        bytes: next.length,
        hunks: slot.hunks,
        ...(slot.warnings.length > 0 ? { warnings: slot.warnings } : {})
      }
    });
  }

  if (totalBytes > MAX_BATCH_EDIT_BYTES) {
    throw new FsOpError(`Patch is too large to apply transactionally (limit ${MAX_BATCH_EDIT_BYTES} bytes)`);
  }

  const staged = new Map<PreparedMutation, string>();
  const committed: PreparedMutation[] = [];
  // Outermost first, so undoing them in reverse removes the deepest folder first.
  const createdDirs: string[] = [];
  try {
    for (const mutation of prepared) {
      if (!mutation.destination || !mutation.nextDestination) continue;
      for (const dir of await missingAncestors(mutation.destination.real)) {
        if (createdDirs.includes(dir)) continue;
        await fs.mkdir(dir);
        createdDirs.push(dir);
      }
    }

    for (const mutation of prepared) {
      if (!mutation.destination || !mutation.nextDestination) continue;
      const temp = await writeTemp(mutation.destination.real, mutation.nextDestination, 'stage');
      staged.set(mutation, temp);
    }

    for (const mutation of prepared) {
      if (mutation.source && mutation.originalSource) {
        const current = await readIfExists(mutation.source.real);
        if (!current?.equals(mutation.originalSource)) {
          throw new FsOpError(`${mutation.source.virtual}: file changed after patch preflight; nothing further was committed`);
        }
      }
      if (mutation.destination && mutation.destination !== mutation.source) {
        await mustNotExist(mutation.destination);
      }

      if (mutation.kind === 'delete') {
        await fs.rm(mutation.source!.real, { force: false });
      } else {
        const temp = staged.get(mutation);
        if (!temp) throw new FsOpError(`${mutation.result.path}: internal patch staging file is missing`);
        await fs.rename(temp, mutation.destination!.real);
        staged.delete(mutation);
        if (mutation.kind === 'move') await fs.rm(mutation.source!.real, { force: false });
      }
      committed.push(mutation);
    }
  } catch (error) {
    const rollbackProblems: string[] = [];
    for (const mutation of [...committed].reverse()) {
      try {
        if (mutation.kind === 'add') {
          const current = await readIfExists(mutation.destination!.real);
          if (current?.equals(mutation.nextDestination!)) await fs.rm(mutation.destination!.real, { force: false });
          else if (current) rollbackProblems.push(`${mutation.destination!.virtual} changed before rollback`);
          continue;
        }

        if (mutation.kind === 'update') {
          const current = await readIfExists(mutation.destination!.real);
          if (current?.equals(mutation.nextDestination!)) {
            await restoreBytes(mutation.destination!.real, mutation.originalSource!);
          } else {
            rollbackProblems.push(`${mutation.destination!.virtual} changed before rollback`);
          }
          continue;
        }

        if (mutation.kind === 'delete') {
          const current = await readIfExists(mutation.source!.real);
          if (current === null) await restoreBytes(mutation.source!.real, mutation.originalSource!);
          else if (!current.equals(mutation.originalSource!)) rollbackProblems.push(`${mutation.source!.virtual} was recreated before rollback`);
          continue;
        }

        const destinationCurrent = await readIfExists(mutation.destination!.real);
        if (destinationCurrent?.equals(mutation.nextDestination!)) {
          await fs.rm(mutation.destination!.real, { force: false });
        } else if (destinationCurrent) {
          rollbackProblems.push(`${mutation.destination!.virtual} changed before rollback`);
        }
        const sourceCurrent = await readIfExists(mutation.source!.real);
        if (sourceCurrent === null) await restoreBytes(mutation.source!.real, mutation.originalSource!);
        else if (!sourceCurrent.equals(mutation.originalSource!)) rollbackProblems.push(`${mutation.source!.virtual} changed before rollback`);
      } catch (rollbackError) {
        rollbackProblems.push(
          `${mutation.result.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    for (const temp of staged.values()) await fs.rm(temp, { force: true }).catch(() => undefined);
    // Deepest first, and only while empty: `rmdir` failing on a folder something else has
    // since populated is the correct outcome, not a rollback problem worth reporting.
    for (const dir of [...createdDirs].reverse()) await fs.rmdir(dir).catch(() => undefined);

    const reason = error instanceof Error ? error.message : String(error);
    if (rollbackProblems.length > 0) {
      throw new FsOpError(`${reason}. Rollback could not safely restore everything: ${rollbackProblems.join('; ')}`);
    }
    throw error;
  }

  return prepared.map((mutation) => mutation.result);
}
