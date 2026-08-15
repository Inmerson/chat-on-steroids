/**
 * Line add/remove counts for an edit, for the "+18 −4" in the activity timeline.
 *
 * Two passes. Common leading and trailing lines are trimmed first, which alone gives
 * the exact answer for the single contiguous change that `edit_file` usually makes.
 * What remains is compared with a real LCS when it is small enough to be cheap, and
 * only falls back to the trimmed block sizes for very large rewrites — which is why
 * the result says whether it is exact.
 */

/** Above this many lines on either side, the LCS pass is skipped as too expensive. */
const LCS_LINE_LIMIT = 1500;

export interface LineDelta {
  added: number;
  removed: number;
  /** False when the numbers came from a real diff, true when they were bounded. */
  approximate: boolean;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline produces one empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Length of the longest common subsequence of two line arrays, in rolling rows so
 * memory stays at two rows rather than the full matrix.
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length] ?? 0;
}

/** Added and removed line counts between two versions of the same text. */
export function lineDelta(before: string, after: string): LineDelta {
  if (before === after) return { added: 0, removed: 0, approximate: false };

  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  ) {
    end++;
  }

  const oldBlock = oldLines.slice(start, oldLines.length - end);
  const newBlock = newLines.slice(start, newLines.length - end);

  // One side empty means a pure insertion or deletion, which needs no diff at all.
  if (oldBlock.length === 0 || newBlock.length === 0) {
    return { added: newBlock.length, removed: oldBlock.length, approximate: false };
  }
  if (oldBlock.length > LCS_LINE_LIMIT || newBlock.length > LCS_LINE_LIMIT) {
    return { added: newBlock.length, removed: oldBlock.length, approximate: true };
  }

  const common = lcsLength(oldBlock, newBlock);
  return {
    added: newBlock.length - common,
    removed: oldBlock.length - common,
    approximate: false
  };
}

/** "+18 −4", "+214", "−83", or null when nothing changed. */
export function formatDelta(delta: { added: number; removed: number }): string | null {
  const parts: string[] = [];
  if (delta.added > 0) parts.push(`+${delta.added}`);
  if (delta.removed > 0) parts.push(`−${delta.removed}`);
  return parts.length === 0 ? null : parts.join(' ');
}
