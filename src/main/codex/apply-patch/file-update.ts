/**
 * Port of `codex-rs/apply-patch/src/file_update.rs`.
 *
 * Codex also derives a unified diff here (via the `similar` crate) for its approval UI and patch
 * events. Nothing in that path is model-visible and neither system is in scope, so this port
 * keeps only `derive_new_contents_from_chunks` — the half that decides what the file becomes and
 * produces every content-related error the model sees.
 */

import { ApplyPatchError } from './errors.js';
import type { UpdateFileChunk } from './hunk.js';
import type { ApplyPatchFileUpdateMode } from './mode.js';
import { seekSequence } from './seek-sequence.js';
import { SourceFile, type Replacement } from './text-file.js';
import { readFileText } from '../filesystem.js';

/** `AppliedPatch`. */
export interface AppliedPatch {
  originalContents: string;
  newContents: string;
}

/**
 * Return *only* the new file contents (joined into a single string) after applying the chunks to
 * the file at `path`.
 */
export async function deriveNewContentsFromChunks(
  path: string,
  chunks: readonly UpdateFileChunk[],
  updateFileMode: ApplyPatchFileUpdateMode
): Promise<AppliedPatch> {
  let originalContents: string;
  try {
    originalContents = await readFileText(path);
  } catch (error) {
    throw ApplyPatchError.io(`Failed to read file to update ${path}`, error);
  }

  let newContents: string;
  if (updateFileMode === 'normalize_to_lf') {
    const originalLines = originalContents.split('\n');

    // Drop the trailing empty element that results from the final newline so that line counts
    // match the behaviour of standard `diff`.
    if (originalLines.at(-1) === '') originalLines.pop();

    const replacements = computeReplacements(originalLines, path, chunks, updateFileMode);
    const newLines = applyReplacements(originalLines, replacements);
    if (newLines.at(-1) !== '') newLines.push('');
    newContents = newLines.join('\n');
  } else {
    const sourceFile = SourceFile.parse(originalContents);
    const originalLines = sourceFile.lineTexts();
    const replacements = computeReplacements(originalLines, path, chunks, updateFileMode);
    sourceFile.applyReplacements(replacements);
    newContents = sourceFile.intoContents();
  }

  return { originalContents, newContents };
}

/**
 * Compute a list of replacements needed to transform `originalLines` into the new lines, given
 * the patch `chunks`. Each replacement is returned as `[startIndex, oldLength, newLines]`.
 */
function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
  updateFileMode: ApplyPatchFileUpdateMode
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    // If a chunk has a `changeContext`, we use seekSequence to find it, then adjust our
    // `lineIndex` to continue from there.
    if (chunk.changeContext !== null) {
      const contextLine = chunk.changeContext;
      const index = seekSequence(originalLines, [contextLine], lineIndex, false, updateFileMode);
      if (index === null) {
        throw ApplyPatchError.computeReplacements(`Failed to find context '${contextLine}' in ${path}`);
      }
      lineIndex = index + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Preserve the legacy split representation's handling of a final empty line. `SourceFile`
      // only exposes real source lines, so its insertion point is always after the final line.
      let insertionIndex: number;
      if (updateFileMode === 'normalize_to_lf') {
        insertionIndex = originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
      } else {
        insertionIndex = originalLines.length;
      }
      replacements.push([insertionIndex, 0, [...chunk.newLines]]);
      continue;
    }

    // Otherwise, try to match the existing lines in the file with the old lines from the chunk.
    // In many real-world diffs the last element of `oldLines` is an *empty* string representing
    // the terminating newline of the region being replaced. That sentinel is not present in
    // `originalLines`, so if a direct search fails and the pattern ends with an empty string,
    // retry without that final element.
    let pattern: readonly string[] = chunk.oldLines;
    let newSlice: readonly string[] = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, updateFileMode);

    if (found === null && pattern.at(-1) === '') {
      pattern = pattern.slice(0, pattern.length - 1);
      if (newSlice.at(-1) === '') newSlice = newSlice.slice(0, newSlice.length - 1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, updateFileMode);
    }

    if (found === null) {
      throw ApplyPatchError.computeReplacements(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`
      );
    }

    const startIndex = found;
    if (updateFileMode === 'normalize_to_lf') {
      replacements.push([startIndex, pattern.length, [...newSlice]]);
    } else {
      // Context lines occur in both sides of a patch chunk. Keep those original lines in place so
      // their exact contents and terminators survive, especially when the file has mixed line
      // endings.
      let oldStart = 0;
      let newStart = 0;
      for (const [oldContext, newContext] of chunk.contextLineIndices) {
        // A trailing empty context line can be removed from `pattern` and `newSlice` above when
        // it represents the final newline.
        if (oldContext >= pattern.length || newContext >= newSlice.length) break;
        if (oldStart !== oldContext || newStart !== newContext) {
          replacements.push([
            startIndex + oldStart,
            oldContext - oldStart,
            newSlice.slice(newStart, newContext)
          ]);
        }
        oldStart = oldContext + 1;
        newStart = newContext + 1;
      }
      if (oldStart !== pattern.length || newStart !== newSlice.length) {
        replacements.push([startIndex + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
      }
    }
    lineIndex = startIndex + pattern.length;
  }

  // Rust's `sort_by_key` is stable, as is `Array.prototype.sort`.
  replacements.sort((left, right) => left[0] - right[0]);

  return replacements;
}

/**
 * Apply the `[startIndex, oldLength, newLines]` replacements to `lines`, returning the modified
 * file contents as an array of lines.
 */
function applyReplacements(lines: readonly string[], replacements: readonly Replacement[]): string[] {
  const result = [...lines];
  // We must apply replacements in descending order so that earlier replacements don't shift the
  // positions of later ones.
  for (let index = replacements.length - 1; index >= 0; index--) {
    const [startIndex, oldLength, newSegment] = replacements[index] as Replacement;

    // Remove old lines.
    for (let removed = 0; removed < oldLength; removed++) {
      if (startIndex < result.length) result.splice(startIndex, 1);
    }

    // Insert new lines.
    result.splice(startIndex, 0, ...newSegment);
  }

  return result;
}
