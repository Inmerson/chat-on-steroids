import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Creates an isolated temp directory and canonicalises it. The canonical form
 * matters: on Windows the temp path often differs from what realpath returns,
 * and the sandbox compares canonical paths.
 */
export async function makeTempDir(prefix = 'clf-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  return await fs.realpath(dir);
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** Writes a map of "a/b.txt" -> contents, creating parent folders as needed. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/**
 * Directory link type that needs no administrator rights. On Windows a junction
 * is a reparse point, which is exactly the escape route the sandbox must block.
 */
export const DIR_LINK: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';

export const IS_WINDOWS = process.platform === 'win32';
