import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from '../src/main/sandbox.js';
import { friendlyError } from '../src/main/mcp/kernel.js';
import type { Root } from '../src/shared/types.js';

const base = path.join(process.cwd(), 'bughunt-2026-08-20', 'error-leak-proof');
const approved = path.join(base, 'approved');
const loop = path.join(approved, 'loop');
const roots: Root[] = [{ name: 'workspace', path: approved }];

await rm(base, { recursive: true, force: true });
try {
  await mkdir(approved, { recursive: true });
  await symlink(loop, loop, 'junction');
  try {
    await resolvePath(roots, '/workspace/loop/file.txt');
    console.log(JSON.stringify({ unexpectedlyResolved: true }));
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    console.log(JSON.stringify({ code, raw: error instanceof Error ? error.message : String(error), friendly: friendlyError(error) }));
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
