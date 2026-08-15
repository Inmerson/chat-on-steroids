/**
 * Path sandbox. Every filesystem tool goes through here.
 *
 * The model only ever sees virtual paths like "/project/src/main.ts". This module
 * maps them onto real Windows paths and refuses anything that would land outside an
 * approved root. Containment is decided by canonicalising with fs.realpath and then
 * comparing against the canonicalised root, which is what defeats symlinks, NTFS
 * junctions and other reparse points planted inside an approved tree: following them
 * is fine as long as the destination is still inside the root.
 *
 * Enforcement lives here, in code. It is never delegated to prompt text.
 */

import { rawPromises as fs } from './rawfs.js';
import path from 'node:path';
import type { Root } from '../shared/types.js';

const IS_WINDOWS = process.platform === 'win32';

/** Windows treats these as devices no matter which directory they appear in. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

export class SandboxError extends Error {}

export interface Resolved {
  /** Canonical absolute path on disk. */
  real: string;
  /** Normalised virtual path, always "/root/..." with forward slashes. */
  virtual: string;
  /** The root this path belongs to. */
  root: Root;
}

/** Normalises a user-supplied root name into the slug used in virtual paths. */
export function normaliseRootName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 32);
  return slug || 'folder';
}

/** Picks a root name derived from a folder that does not collide with existing ones. */
export function uniqueRootName(folderPath: string, existing: readonly Root[]): string {
  const base = normaliseRootName(path.basename(folderPath) || 'folder');
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SandboxError('Could not find a free root name');
}

/**
 * Validates one path segment. Rejects traversal, drive/UNC syntax, NTFS alternate
 * data streams, reserved device names and the trailing dot/space forms that Windows
 * silently strips (which would otherwise let "foo." address "foo").
 */
function checkSegment(segment: string): void {
  if (segment === '' || segment === '.') {
    throw new SandboxError('Path contains an empty segment');
  }
  if (segment === '..') {
    throw new SandboxError('Path traversal ("..") is not allowed');
  }
  if (segment.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  // ":" would open an alternate data stream or a drive-relative path.
  if (segment.includes(':')) {
    throw new SandboxError('Path contains ":", which is not allowed');
  }
  if (/[<>"|?*]/.test(segment)) {
    throw new SandboxError('Path contains a character Windows does not allow');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(segment)) {
    throw new SandboxError('Path contains a control character');
  }
  if (/[. ]$/.test(segment)) {
    throw new SandboxError('Path segment ends with a dot or space');
  }
  const stem = segment.split('.')[0]!.toLowerCase();
  if (RESERVED_NAMES.has(stem)) {
    throw new SandboxError(`"${segment}" is a reserved Windows device name`);
  }
  if (segment.length > 255) {
    throw new SandboxError('Path segment is too long');
  }
}

/** Splits a virtual path into validated segments. Accepts both / and \ as separators. */
export function splitVirtualPath(input: string): string[] {
  if (typeof input !== 'string') {
    throw new SandboxError('Path must be a string');
  }
  if (input.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  if (input.length > 4096) {
    throw new SandboxError('Path is too long');
  }
  const segments = input.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new SandboxError('Path is empty. Use /<root> — call list_roots to see the roots.');
  }
  for (const segment of segments) checkSegment(segment);
  return segments;
}

/** True when `child` is `parent` or lives underneath it. Case-insensitive on Windows. */
export function isContained(parent: string, child: string): boolean {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  const norm = (s: string) => (IS_WINDOWS ? s.toLowerCase() : s);
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // The separator check stops "C:\Root" from matching "C:\RootEvil".
  const prefix = na.endsWith(path.sep) ? na : na + path.sep;
  return nb.startsWith(prefix);
}

/**
 * Canonicalises the deepest part of `absPath` that exists, returning it along with
 * the segments that do not exist yet. Used so a create/write can be checked for
 * containment before anything is written.
 */
async function realpathDeepest(absPath: string): Promise<{ real: string; missing: string[] }> {
  let current = path.resolve(absPath);
  const missing: string[] = [];
  for (;;) {
    try {
      return { real: await fs.realpath(current), missing };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SandboxError('Path has no existing parent directory');
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/** Reads the canonical path of an approved root, failing loudly if it has gone away. */
async function realRoot(root: Root): Promise<string> {
  try {
    return await fs.realpath(root.path);
  } catch {
    throw new SandboxError(`Root "/${root.name}" is not available right now`);
  }
}

export interface ResolveOptions {
  /** Allow the final path to not exist yet (for create/write). Defaults to false. */
  allowMissing?: boolean;
}

/**
 * Maps a virtual path onto a real path inside an approved root.
 *
 * Throws SandboxError for anything that is not clearly inside a root. Callers treat
 * every SandboxError as a refusal and never fall back to the raw input.
 */
export async function resolvePath(
  roots: readonly Root[],
  virtualPath: string,
  options: ResolveOptions = {}
): Promise<Resolved> {
  const segments = splitVirtualPath(virtualPath);
  const rootName = segments[0]!.toLowerCase();
  const root = roots.find((r) => r.name.toLowerCase() === rootName);
  if (!root) {
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    throw new SandboxError(`Unknown root "/${segments[0]}". Approved roots: ${names}`);
  }

  const rootReal = await realRoot(root);
  const rest = segments.slice(1);
  const candidate = rest.length === 0 ? rootReal : path.join(rootReal, ...rest);

  // Cheap structural check before touching the disk.
  if (!isContained(rootReal, candidate)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  const { real, missing } = await realpathDeepest(candidate);

  // The canonical existing part must still be inside the root. This is the check
  // that catches a symlink or junction inside the tree pointing somewhere else.
  if (!isContained(rootReal, real)) {
    throw new SandboxError('Path escapes its approved folder via a link');
  }

  if (missing.length > 0 && !options.allowMissing) {
    throw new SandboxError(`Not found: ${toVirtualPath(root, rootReal, candidate)}`);
  }

  const finalReal = missing.length === 0 ? real : path.join(real, ...missing);
  if (!isContained(rootReal, finalReal)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  return {
    real: finalReal,
    virtual: toVirtualPath(root, rootReal, finalReal),
    root
  };
}

/** Converts a real path back into the virtual path the model sees. */
export function toVirtualPath(root: Root, rootReal: string, realPath: string): string {
  const rel = path.relative(rootReal, realPath);
  if (rel === '') return `/${root.name}`;
  return `/${root.name}/${rel.split(path.sep).join('/')}`;
}

/**
 * Resolves a root by name only, for tools that operate on a whole root.
 * Returns the canonical root path.
 */
export async function resolveRoot(roots: readonly Root[], name: string): Promise<{ root: Root; real: string }> {
  const root = roots.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!root) throw new SandboxError(`Unknown root "/${name}"`);
  return { root, real: await realRoot(root) };
}

/**
 * Validates a folder the user picked in the UI before it becomes a root.
 * Rejects network paths and roots that would nest inside an existing one.
 */
export async function validateNewRoot(folderPath: string, existing: readonly Root[]): Promise<string> {
  if (!path.isAbsolute(folderPath)) {
    throw new SandboxError('Folder path must be absolute');
  }
  // UNC paths bring credential-delegation and latency surprises we do not want to
  // reason about; a mapped drive letter works and is explicit.
  if (folderPath.startsWith('\\\\')) {
    throw new SandboxError('Network (UNC) paths are not supported. Map it to a drive letter first.');
  }
  const real = await fs.realpath(folderPath);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new SandboxError('That is not a folder');
  }
  const parsed = path.parse(real);
  if (parsed.root.toLowerCase() === real.toLowerCase()) {
    throw new SandboxError('Approving an entire drive is not allowed. Pick a folder inside it.');
  }
  for (const other of existing) {
    let otherReal: string;
    try {
      otherReal = await fs.realpath(other.path);
    } catch {
      continue;
    }
    if (isContained(otherReal, real) || isContained(real, otherReal)) {
      throw new SandboxError(`That folder overlaps the existing root "/${other.name}"`);
    }
  }
  return real;
}
