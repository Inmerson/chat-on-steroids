import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from '../src/main/sandbox.js';
import { readTextFile } from '../src/main/codex/read-backend.js';
import type { Root } from '../src/shared/types.js';

const base = path.join(process.cwd(), 'bughunt-2026-08-20', 'reparse-toctou-proof');
const approved = path.join(base, 'approved');
const gate = path.join(approved, 'gate');
const outside = path.join(base, 'outside');
const roots: Root[] = [{ name: 'workspace', path: approved }];

await rm(base, { recursive: true, force: true });
try {
  await mkdir(gate, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(gate, 'secret.txt'), 'inside\n');
  await writeFile(path.join(outside, 'secret.txt'), 'outside\n');

  const resolved = await resolvePath(roots, '/workspace/gate/secret.txt');
  await rename(gate, path.join(approved, 'gate-before-swap'));
  await symlink(outside, gate, 'junction');
  const read = await readTextFile(resolved.real);

  console.log(JSON.stringify({ resolved: resolved.virtual, staleReal: resolved.real, read: read.text }));
} finally {
  await rm(base, { recursive: true, force: true });
}
