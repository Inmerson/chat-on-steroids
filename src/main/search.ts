/**
 * Filename and content search.
 *
 * Deliberately no index and no bundled ripgrep: a bounded walk with sensible
 * exclusions, an early exit at maxResults and a wall-clock budget keeps real source
 * trees fast enough while leaving the app a single self-contained download. Every
 * search reports whether it stopped early so the model knows to narrow the scope.
 */

import { rawCreateReadStream as createReadStream, rawPromises as fs } from './rawfs.js';
import path from 'node:path';
import { detectTextEncoding, isExcludedFolderName, sniffBinary } from './fsops.js';

/**
 * Skipped by default because they are large and rarely what anyone means. The model
 * can search them by passing an explicit exclude list (including an empty one), so
 * nothing is permanently unreachable.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.gradle',
  '.gradle-user',
  '.idea',
  '.vs',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.cache',
  '.turbo',
  '.go-build-cache',
  '.go-module-cache',
  '.go-tools',
  '.gopath',
  '.tmp',
  '.tmp-go-cache',
  '.tmp-go-path',
  // User-profile/tooling trees that are useful when explicitly opened, but extremely
  // noisy when a model recursively searches a broad root such as a home directory.
  // Because exclusions apply only to child folders, explicitly searching inside one
  // of these paths still works normally.
  '.android',
  '.bun',
  '.claude',
  '.claude-*',
  '.codex',
  '.cursor',
  '.gemini',
  '.npm',
  '.pnpm-store',
  '.yarn',
  // Packaged application output is generated and routinely contains hundreds of
  // Electron/runtime files. Source lives elsewhere and should win the default budget.
  'release',
  'release-*',
  'appdata'
];

const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 40_000;
const TIME_BUDGET_MS = 10_000;
const CONTENT_CONCURRENCY = 12;
const MAX_LINE_CHARS = 300;

export interface SearchHit {
  path: string;
  /** Present for content matches only. */
  line?: number;
  /** Trimmed matching line, for content matches only. */
  text?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  truncated: boolean;
  /** Why the search stopped early, if it did. */
  stoppedBecause: 'limit' | 'time' | 'files' | null;
  elapsedMs: number;
}

export interface SearchRequest {
  realDir: string;
  virtualDir: string;
  query: string;
  mode: 'name' | 'content';
  include?: string | undefined;
  exclude: readonly string[];
  caseSensitive: boolean;
  maxResults: number;
}

/** Translates a glob into a regex. Supports *, ?, ** and nothing else, on purpose. */
export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" spans zero or more directories; a bare "**" spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

function matchesInclude(relPath: string, pattern: string, caseSensitive: boolean): boolean {
  const re = globToRegExp(pattern, caseSensitive);
  if (re.test(relPath)) return true;
  // A pattern with no slash is conventionally matched against the file name alone.
  if (!pattern.includes('/')) return re.test(path.basename(relPath));
  return false;
}

export async function search(req: SearchRequest): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let stoppedBecause: SearchOutcome['stoppedBecause'] = null;

  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const candidates: Array<{ real: string; rel: string }> = [];

  const outOfBudget = (): boolean => {
    if (Date.now() > deadline) {
      stoppedBecause = 'time';
      return true;
    }
    if (filesScanned >= MAX_FILES_SCANNED) {
      stoppedBecause = 'files';
      return true;
    }
    return false;
  };

  const walk = async (dir: string, rel: string): Promise<boolean> => {
    if (outOfBudget()) return false;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true; // Unreadable directory: skip it, keep searching elsewhere.
    }
    for (const dirent of dirents) {
      if (outOfBudget()) return false;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (isExcludedFolderName(dirent.name, req.exclude)) continue;
        if (!(await walk(path.join(dir, dirent.name), childRel))) return false;
        continue;
      }
      if (!dirent.isFile()) continue;
      filesScanned++;
      if (req.include && !matchesInclude(childRel, req.include, req.caseSensitive)) continue;

      if (req.mode === 'name') {
        const haystack = req.caseSensitive ? dirent.name : dirent.name.toLowerCase();
        if (needle === '' || haystack.includes(needle)) {
          hits.push({ path: `${req.virtualDir}/${childRel}` });
          if (hits.length >= req.maxResults) {
            stoppedBecause = 'limit';
            return false;
          }
        }
      } else {
        candidates.push({ real: path.join(dir, dirent.name), rel: childRel });
      }
    }
    return true;
  };

  await walk(req.realDir, '');

  if (req.mode === 'content' && stoppedBecause !== 'limit') {
    await scanContents(req, candidates, hits, deadline, (reason) => {
      stoppedBecause = reason;
    });
  }

  return {
    hits,
    filesScanned,
    truncated: stoppedBecause !== null,
    stoppedBecause,
    elapsedMs: Date.now() - started
  };
}

async function scanContents(
  req: SearchRequest,
  candidates: Array<{ real: string; rel: string }>,
  hits: SearchHit[],
  deadline: number,
  stop: (reason: 'limit' | 'time') => void
): Promise<void> {
  let index = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        stop('time');
        return;
      }
      const item = candidates[index++];
      if (!item) return;
      if (hits.length >= req.maxResults) {
        done = true;
        stop('limit');
        return;
      }
      const found = await scanOneFile(item.real, req);
      for (const hit of found) {
        if (hits.length >= req.maxResults) {
          done = true;
          stop('limit');
          return;
        }
        hits.push({ path: `${req.virtualDir}/${item.rel}`, line: hit.line, text: hit.text });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONTENT_CONCURRENCY, candidates.length || 1) }, worker)
  );
}

export async function searchOneFile(
  realPath: string,
  virtualPath: string,
  req: Pick<SearchRequest, 'query' | 'mode' | 'include' | 'caseSensitive' | 'maxResults'>
): Promise<SearchOutcome> {
  const started = Date.now();
  const rel = path.basename(virtualPath);
  if (req.include && !matchesInclude(rel, req.include, req.caseSensitive)) {
    return { hits: [], filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  if (req.mode === 'name') {
    const haystack = req.caseSensitive ? rel : rel.toLowerCase();
    const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
    const hits = needle === '' || haystack.includes(needle) ? [{ path: virtualPath }] : [];
    return { hits, filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  const found = await scanOneFile(realPath, {
    realDir: path.dirname(realPath),
    virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'),
    query: req.query,
    mode: 'content',
    include: req.include,
    exclude: [],
    caseSensitive: req.caseSensitive,
    maxResults: req.maxResults
  });
  const limited = found.slice(0, req.maxResults);
  return {
    hits: limited.map((hit) => ({ path: virtualPath, line: hit.line, text: hit.text })),
    filesScanned: 1,
    truncated: found.length > limited.length,
    stoppedBecause: found.length > limited.length ? 'limit' : null,
    elapsedMs: Date.now() - started
  };
}

async function scanOneFile(
  realPath: string,
  req: SearchRequest
): Promise<Array<{ line: number; text: string }>> {
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return [];
  }
  if (stat.size === 0 || stat.size > MAX_CONTENT_FILE_BYTES) return [];
  try {
    if (await sniffBinary(realPath)) return [];
  } catch {
    return [];
  }

  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const results: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  let carry = '';
  const decoder = new TextDecoder(await detectTextEncoding(realPath));

  const consider = (line: string): void => {
    lineNo++;
    const haystack = req.caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(needle)) return;
    const trimmed = line.trim();
    results.push({
      line: lineNo,
      text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
    });
  };

  const stream = createReadStream(realPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      carry += decoder.decode(chunk as Buffer, { stream: true });
      let at = carry.indexOf('\n');
      while (at !== -1) {
        consider(carry.slice(0, at).replace(/\r$/, ''));
        carry = carry.slice(at + 1);
        at = carry.indexOf('\n');
      }
      // A file with no newlines would otherwise grow `carry` without bound.
      if (carry.length > MAX_CONTENT_FILE_BYTES) break;
    }
    carry += decoder.decode();
    if (carry.length > 0) consider(carry.replace(/\r$/, ''));
  } catch {
    return results;
  } finally {
    stream.destroy();
  }
  return results;
}
