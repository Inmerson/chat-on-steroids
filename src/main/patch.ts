import type { LineDelta } from './diffstat.js';
import {
  MATCH_TIERS,
  joinLogicalText,
  matchingPositions,
  patternMatches,
  rstrip,
  settleEndings,
  splitLogicalText,
  type MatchTier
} from './text-match.js';

export class PatchError extends Error {}

export type PatchLineKind = 'context' | 'add' | 'delete';

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  /** Optional scope/anchor text after @@. It is used only to narrow the search. */
  header: string | null;
  lines: PatchLine[];
  endOfFile: boolean;
}

export type PatchFileOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; hunks: PatchHunk[] };

export interface AppliedTextPatch {
  text: string;
  delta: LineDelta;
  hunks: number;
  /**
   * Non-fatal notes about how a hunk was placed — a repeated context block, a relaxed
   * comparison tier. The patch applied; these exist so the caller can see what was
   * inferred without having to re-read the file to find out.
   */
  warnings: string[];
}

const MAX_PATCH_FILE_OPS = 64;
const MAX_PATCH_HUNKS = 256;

function normalisePatchInput(input: string): string[] {
  if (typeof input !== 'string' || input.trim() === '') throw new PatchError('Patch is empty');
  // This is a text/source mutation surface. A literal NUL turns an otherwise normal source
  // file into something every later read/search correctly classifies as binary, and live
  // model editing has already produced that corruption accidentally while trying to spell a
  // source-level escape. Refuse before parsing or touching any target; binary writes belong on
  // a binary-specific surface, not inside a textual patch.
  if (input.includes('\0')) throw new PatchError('Patch contains a NUL byte; text patches cannot write binary/control bytes.');
  const normalised = input.replace(/\r\n|\r/g, '\n');
  const lines = normalised.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function pathAfter(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (!value) throw new PatchError(`${prefix.trim()} requires a path`);
  if (value.includes('\0')) throw new PatchError('Patch paths may not contain null bytes');
  return value;
}

/** Every sentinel of the patch language. Order matters only for longest-prefix reading. */
const PATCH_MARKERS = [
  '*** Begin Patch',
  '*** End Patch',
  '*** End of File',
  '*** Add File:',
  '*** Delete File:',
  '*** Update File:',
  '*** Move to:'
] as const;

/**
 * Re-spells marker lines that a model indented or padded, leaving every payload byte alone.
 *
 * This runs only after a strict, column-0 parse has already failed. That ordering is the
 * whole safety argument: a well-formed patch whose hunks happen to contain a context line
 * reading `*** End of File` — this repository's own tests do — parses strictly and never
 * reaches here, so the recovery cannot reinterpret code as a sentinel in any patch that was
 * already valid. Returns null when nothing looked like a misplaced marker, so the caller can
 * report the original, more informative parse error rather than a second one from a rewrite.
 */
function relaxMarkers(lines: readonly string[]): string[] | null {
  const out: string[] = [];
  let changed = false;
  for (const line of lines) {
    // `+` and `-` lines are content, whatever they happen to spell. Rewriting one would
    // change bytes destined for the file, which is the one thing this must never do.
    if (line.startsWith('+') || line.startsWith('-')) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    const looksLikeMarker = trimmed.startsWith('@@') || PATCH_MARKERS.some((candidate) => trimmed.startsWith(candidate));
    const relaxed = looksLikeMarker ? trimmed : line;
    if (relaxed !== line) changed = true;
    out.push(relaxed);
  }
  return changed ? out : null;
}

/**
 * Parses the same small file-oriented patch language Codex teaches its coding models:
 * Begin/End Patch plus Add/Delete/Update sections and @@ hunks. Paths are left as
 * strings here; the MCP layer resolves them through CLF's approved virtual roots.
 *
 * Whitespace around the sentinels is forgiven the way Codex's parser forgives it, but by
 * retrying rather than by loosening the grammar — see relaxMarkers.
 */
export function parsePatch(input: string): PatchFileOperation[] {
  const lines = normalisePatchInput(input);
  try {
    return parseStrictPatch(lines);
  } catch (error) {
    const relaxed = relaxMarkers(lines);
    if (!relaxed) throw error;
    // If the retry fails too, its error is the one to report: the strict pass may have
    // stopped at nothing worse than an indented `*** Begin Patch`, which would name the
    // wrong problem for a patch whose real defect is further down.
    return parseStrictPatch(relaxed);
  }
}

function parseStrictPatch(lines: readonly string[]): PatchFileOperation[] {
  if (lines[0] !== '*** Begin Patch') throw new PatchError('Patch must start with *** Begin Patch');
  if (lines[lines.length - 1] !== '*** End Patch') throw new PatchError('Patch must end with *** End Patch');

  const operations: PatchFileOperation[] = [];
  let hunkCount = 0;
  let index = 1;

  const atBoundary = (line: string | undefined): boolean =>
    line === undefined ||
    line === '*** End Patch' ||
    line.startsWith('*** Add File:') ||
    line.startsWith('*** Delete File:') ||
    line.startsWith('*** Update File:');

  while (index < lines.length - 1) {
    const line = lines[index]!;
    if (operations.length >= MAX_PATCH_FILE_OPS) {
      throw new PatchError(`Patch has too many file operations (limit ${MAX_PATCH_FILE_OPS})`);
    }

    if (line.startsWith('*** Add File:')) {
      const filePath = pathAfter(line, '*** Add File:');
      index++;
      const content: string[] = [];
      while (!atBoundary(lines[index])) {
        const row = lines[index]!;
        if (!row.startsWith('+')) {
          throw new PatchError(`Add File ${filePath}: every content line must start with +`);
        }
        content.push(row.slice(1));
        index++;
      }
      operations.push({ kind: 'add', path: filePath, content: content.length === 0 ? '' : `${content.join('\n')}\n` });
      continue;
    }

    if (line.startsWith('*** Delete File:')) {
      operations.push({ kind: 'delete', path: pathAfter(line, '*** Delete File:') });
      index++;
      if (!atBoundary(lines[index])) {
        throw new PatchError('Delete File sections cannot contain hunks or content');
      }
      continue;
    }

    if (line.startsWith('*** Update File:')) {
      const filePath = pathAfter(line, '*** Update File:');
      index++;
      let moveTo: string | null = null;
      if (lines[index]?.startsWith('*** Move to:')) {
        moveTo = pathAfter(lines[index]!, '*** Move to:');
        index++;
      }
      const hunks: PatchHunk[] = [];
      while (!atBoundary(lines[index])) {
        const headerLine = lines[index]!;
        if (!headerLine.startsWith('@@')) {
          throw new PatchError(`Update File ${filePath}: expected @@ hunk header, got ${JSON.stringify(headerLine)}`);
        }
        if (++hunkCount > MAX_PATCH_HUNKS) {
          throw new PatchError(`Patch has too many hunks (limit ${MAX_PATCH_HUNKS})`);
        }
        const headerText = headerLine.slice(2).trim();
        index++;
        const hunkLines: PatchLine[] = [];
        let endOfFile = false;
        while (index < lines.length - 1) {
          const row = lines[index]!;
          if (row.startsWith('@@') || atBoundary(row)) break;
          if (row === '*** End of File') {
            endOfFile = true;
            index++;
            break;
          }
          const prefix = row[0];
          if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
            throw new PatchError(
              `Update File ${filePath}: hunk lines must start with space, + or -, got ${JSON.stringify(row)}`
            );
          }
          hunkLines.push({
            kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'delete',
            text: row.slice(1)
          });
          index++;
        }
        if (hunkLines.length === 0 && !endOfFile) {
          throw new PatchError(`Update File ${filePath}: empty hunk`);
        }
        hunks.push({ header: headerText || null, lines: hunkLines, endOfFile });
      }
      if (hunks.length === 0 && moveTo === null) {
        throw new PatchError(`Update File ${filePath}: provide at least one hunk or a Move to target`);
      }
      operations.push({ kind: 'update', path: filePath, moveTo, hunks });
      continue;
    }

    throw new PatchError(`Unexpected patch line: ${JSON.stringify(line)}`);
  }

  if (operations.length === 0) throw new PatchError('Patch contains no file operations');
  return operations;
}


function headerMatches(line: string, header: string): boolean {
  if (line === header) return true;
  if (rstrip(line) === rstrip(header)) return true;
  // Header text is an anchor only, never replacement content, so ignoring indentation
  // here cannot corrupt the file. It simply lets "@@ function foo" locate an indented scope.
  return line.trim() === header.trim();
}

function previewLine(value: string): string {
  const compact = value.replace(/\t/g, '→').trimEnd();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

/**
 * Finds where a hunk's context sits, walking exact → trailing-whitespace → indentation →
 * unicode-folded and taking the *first* position the first successful tier reports.
 *
 * Taking the first match is Codex's rule, and it is deliberate here rather than a
 * simplification. Refusing whenever identical context appears twice sounds safer, but the
 * caller is a model with no way to see the second occurrence: it re-reads, re-sends a longer
 * snippet, and burns a round trip on a patch that was going to land in the right place
 * anyway, because `searchStart` already walks forward past each applied hunk and an `@@`
 * scope narrows further. What repetition really warrants is a note, which is what the
 * returned `alternatives` becomes.
 */
function locateHunk(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endExclusive: number,
  hunkNumber: number,
  header: string | null
): { at: number; tier: MatchTier; alternatives: number[] } {
  for (const tier of MATCH_TIERS) {
    const found = matchingPositions(lines, pattern, start, endExclusive, tier);
    if (found.length > 0) return { at: found[0]!, tier, alternatives: found.slice(1) };
  }

  const first = pattern[0] ?? '';
  throw new PatchError(
    `Hunk ${hunkNumber}${header ? ` (${header})` : ''} could not find its expected context after line ${start}. ` +
      `First expected line: ${JSON.stringify(previewLine(first))}. Read around the target and retry with 3 context lines or an @@ scope.`
  );
}

/**
 * Applies update hunks to logical lines.
 *
 * Matching walks MATCH_TIERS from exact to unicode-folded and takes the first hit, as Codex
 * does. Context and deleted lines are only ever *compared*: the bytes kept are the file's
 * own, and each surviving line keeps the terminator it already had, so a relaxed match can
 * never rewrite indentation, trailing whitespace or line endings the way a matcher that
 * writes back the model's spelling of the context does.
 */
export function applyTextPatch(original: string, hunks: readonly PatchHunk[]): AppliedTextPatch {
  const logical = splitLogicalText(original);
  const warnings: string[] = [];
  const delta: LineDelta = { added: 0, removed: 0, approximate: false };
  let searchStart = 0;

  hunks.forEach((hunk, hunkIndex) => {
    const hunkNumber = hunkIndex + 1;
    let scopedStart = searchStart;
    if (hunk.header) {
      const matches: number[] = [];
      for (let at = searchStart; at < logical.lines.length; at++) {
        if (headerMatches(logical.lines[at]!, hunk.header)) matches.push(at);
      }
      if (matches.length === 0) {
        throw new PatchError(`Hunk ${hunkNumber}: @@ scope ${JSON.stringify(hunk.header)} was not found`);
      }
      // The scope header is only a navigation hint. If it repeats, take the first one
      // after the prior hunk; the actual old/context lines below still must match uniquely.
      scopedStart = matches[0]! + 1;
    }

    const sourcePattern = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text);
    let at: number;
    let tier: MatchTier = MATCH_TIERS[0]!;
    if (sourcePattern.length === 0) {
      // A hunk that only adds lines has nothing to match on, so its @@ scope *is* the
      // anchor: the additions belong at the top of that scope, not at the end of the file.
      // Falling back to EOF here — Codex still does — silently relocates an insertion the
      // patch was explicit about, and the model has no way to tell from the reply.
      at = hunk.endOfFile || !hunk.header ? logical.lines.length : scopedStart;
    } else {
      // `*** End of File` says the context is the tail of the file, and when it is, that is
      // the answer. When it is not, the documented promise is a normal search, not a
      // refusal: an otherwise valid hunk that sits earlier in the file still applies.
      const tail = logical.lines.length - sourcePattern.length;
      const anchored =
        hunk.endOfFile && tail >= scopedStart
          ? MATCH_TIERS.find((candidate) => patternMatches(logical.lines, tail, sourcePattern, candidate))
          : undefined;
      if (anchored) {
        at = tail;
        tier = anchored;
      } else {
        const found = locateHunk(logical.lines, sourcePattern, scopedStart, logical.lines.length, hunkNumber, hunk.header);
        at = found.at;
        tier = found.tier;
        if (found.alternatives.length > 0) {
          warnings.push(
            `Hunk ${hunkNumber}: its context also matches at line ` +
              `${found.alternatives.slice(0, 4).map((other) => other + 1).join(', ')}` +
              `${found.alternatives.length > 4 ? ', ...' : ''}; applied at the first match, line ${at + 1}.`
          );
        }
        if (hunk.endOfFile) {
          warnings.push(
            `Hunk ${hunkNumber}: *** End of File context is not the end of the file; applied at line ${at + 1}.`
          );
        }
      }
    }

    const replacement: string[] = [];
    const replacementEndings: string[] = [];
    let sourceOffset = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        delta.added++;
        replacement.push(line.text);
        replacementEndings.push(logical.newline);
        continue;
      }
      const actual = logical.lines[at + sourceOffset];
      if (actual === undefined) throw new PatchError(`Hunk ${hunkNumber}: source ended unexpectedly`);
      if (tier.normalize(actual) !== tier.normalize(line.text)) {
        throw new PatchError(`Hunk ${hunkNumber}: source changed while applying the patch`);
      }
      if (line.kind === 'context') {
        replacement.push(actual);
        replacementEndings.push(logical.endings[at + sourceOffset] ?? logical.newline);
      } else {
        delta.removed++;
      }
      sourceOffset++;
    }

    logical.lines.splice(at, sourceOffset, ...replacement);
    logical.endings.splice(at, sourceOffset, ...replacementEndings);
    settleEndings(logical);
    searchStart = at + replacement.length;
  });

  const text = joinLogicalText(logical);
  // Count what the patch actually changed rather than diffing the whole file after every
  // hunk. A file with two tiny edits thousands of lines apart used to leave one enormous
  // middle block after prefix/suffix trimming, trip diffstat's LCS safety limit and report
  // nonsense such as `~+2818 −2809`. Add/delete markers are already the exact semantic
  // delta of an applied hunk, cost O(patch size), and stay exact however far apart the hunks
  // are in the target file.
  return { text, delta, hunks: hunks.length, warnings };
}
