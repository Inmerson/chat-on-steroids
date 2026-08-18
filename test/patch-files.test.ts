import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResolvedPatch } from '../src/main/patch-files.js';
import { parsePatch } from '../src/main/patch.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('clf-patch-files-');
});

afterEach(async () => {
  await removeTempDir(dir);
});

const ref = (name: string) => ({ real: path.join(dir, name), virtual: `/root/${name}` });

function resolveForTest(patch: string) {
  return parsePatch(patch).map((operation) => {
    if (operation.kind === 'add') return { ...operation, path: ref(operation.path) };
    if (operation.kind === 'delete') return { ...operation, path: ref(operation.path) };
    return {
      ...operation,
      path: ref(operation.path),
      moveTo: operation.moveTo ? ref(operation.moveTo) : null
    };
  });
}

describe('transactional patch files', () => {
  it('updates, creates, moves and deletes in one preflighted patch', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\r\nbeta\r\n');
    await fs.writeFile(path.join(dir, 'move.txt'), 'move me\n');
    await fs.writeFile(path.join(dir, 'dead.txt'), 'dead\n');

    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
 alpha
-beta
+BETA
*** Add File: fresh.txt
+fresh
*** Update File: move.txt
*** Move to: moved.txt
@@
-move me
+MOVED
*** Delete File: dead.txt
*** End Patch`);

    const results = await applyResolvedPatch(operations);
    expect(results.map((result) => result.kind)).toEqual(['update', 'add', 'move', 'delete']);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\r\nBETA\r\n');
    expect(await fs.readFile(path.join(dir, 'fresh.txt'), 'utf8')).toBe('fresh\n');
    expect(await fs.readFile(path.join(dir, 'moved.txt'), 'utf8')).toBe('MOVED\n');
    await expect(fs.stat(path.join(dir, 'move.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'dead.txt'))).rejects.toThrow();
  });

  it('preflights every hunk before touching any file', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: b.txt
@@
-missing
+BETA
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/could not find/i);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('creates the parent folders an added file needs, as the tool promises', async () => {
    const operations = resolveForTest(`*** Begin Patch
*** Add File: demo/src/main.ts
+export const demo = 1;
*** End Patch`);

    const results = await applyResolvedPatch(operations);
    expect(results.map((result) => result.kind)).toEqual(['add']);
    expect(await fs.readFile(path.join(dir, 'demo', 'src', 'main.ts'), 'utf8')).toBe('export const demo = 1;\n');
  });

  it('removes the folders it created when the patch does not land', async () => {
    const operations = resolveForTest(`*** Begin Patch
*** Add File: fresh/deep/file.txt
+content
*** End Patch`);

    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.clf-patch-stage-')) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EBUSY' });
      }
      return originalRename(from, to);
    });

    try {
      await expect(applyResolvedPatch(operations)).rejects.toThrow(/simulated rename failure/);
    } finally {
      spy.mockRestore();
    }
    // Nothing was added, so nothing this patch invented may survive it.
    await expect(fs.stat(path.join(dir, 'fresh'))).rejects.toThrow();
  });

  it('rolls back an earlier commit if a later commit fails', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: b.txt
@@
-beta
+BETA
*** End Patch`);

    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.clf-patch-stage-') && String(to) === path.join(dir, 'b.txt')) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EBUSY' });
      }
      return originalRename(from, to);
    });

    try {
      await expect(applyResolvedPatch(operations)).rejects.toThrow(/simulated rename failure/);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
  });
});

describe('a patch that names the same file more than once', () => {
  it('applies two update blocks for one path in order', async () => {
    // The T-118 failure: this was refused outright, so any patch that edited two distant
    // parts of a file as separate blocks had to be split into two calls by hand.
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\nmiddle\nomega\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: a.txt
@@
-omega
+OMEGA
*** End Patch`);

    const results = await applyResolvedPatch(operations);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('ALPHA\nmiddle\nOMEGA\n');
    // One row per file, whatever the block count, with the aggregate counts.
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe('/root/a.txt');
    expect(results[0]!.hunks).toBe(2);
    expect(results[0]!.delta.added).toBe(2);
    expect(results[0]!.delta.removed).toBe(2);
  });

  it('lets the second block match text the first block wrote', async () => {
    // The point of sequencing: block 2 resolves against block 1's result, exactly as a
    // second hunk inside one block does, rather than against the file on disk.
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-one
+two
*** Update File: a.txt
@@
-two
+three
*** End Patch`);

    const results = await applyResolvedPatch(operations);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('three\n');
    expect(results[0]!.delta).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports no change when later blocks undo the earlier block', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-one
+two
*** Update File: a.txt
@@
-two
+one
*** End Patch`);

    const results = await applyResolvedPatch(operations);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(results[0]!.delta).toEqual({ added: 0, removed: 0, approximate: false });
  });

  it('keeps distant large-file edits exact and preserves CRLF', async () => {
    const lines = Array.from({ length: 3200 }, (_, index) => `line-${index}`);
    await fs.writeFile(path.join(dir, 'a.txt'), `${lines.join('\r\n')}\r\n`);
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-line-10
+changed-ten
@@
-line-3000
+changed-three-thousand
*** End Patch`);

    const results = await applyResolvedPatch(operations);
    const written = await fs.readFile(path.join(dir, 'a.txt'), 'utf8');
    expect(written).toContain('changed-ten\r\n');
    expect(written).toContain('changed-three-thousand\r\n');
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(results[0]!.delta).toEqual({ added: 2, removed: 2, approximate: false });
  });

  it('writes nothing when the second block for that same path cannot be placed', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-one
+two
*** Update File: a.txt
@@
-nowhere
+four
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/could not find/i);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('still fails the whole patch when another file fails after the repeats', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\nomega\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: a.txt
@@
-omega
+OMEGA
*** Update File: b.txt
@@
-missing
+BETA
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/could not find/i);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\nomega\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('rolls the repeated file back when a later file fails at commit', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\nomega\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: a.txt
@@
-omega
+OMEGA
*** Update File: b.txt
@@
-beta
+BETA
*** End Patch`);

    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.clf-patch-stage-') && String(to) === path.join(dir, 'b.txt')) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EBUSY' });
      }
      return originalRename(from, to);
    });

    try {
      await expect(applyResolvedPatch(operations)).rejects.toThrow(/simulated rename failure/);
    } finally {
      spy.mockRestore();
    }
    // Both blocks are one commit, so the rollback restores the file whole.
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\nomega\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('keeps the file’s own line endings across repeated blocks', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\r\nmiddle\r\nomega\r\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Update File: a.txt
@@
-omega
+OMEGA
*** End Patch`);

    await applyResolvedPatch(operations);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('ALPHA\r\nmiddle\r\nOMEGA\r\n');
  });

  it('refuses to update a file the same patch already deleted', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    const operations = resolveForTest(`*** Begin Patch
*** Delete File: a.txt
*** Update File: a.txt
@@
-alpha
+ALPHA
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/deletes it/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  it('refuses to delete a file the same patch already updated', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** Delete File: a.txt
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/updates it/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  it('refuses to update a file the same patch already moved away', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\nomega\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-alpha
+ALPHA
*** Update File: a.txt
@@
-omega
+OMEGA
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/moves it away/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\nomega\n');
    await expect(fs.stat(path.join(dir, 'b.txt'))).rejects.toThrow();
  });

  it('refuses two moves onto one destination', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
*** Move to: c.txt
*** Update File: b.txt
*** Move to: c.txt
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/move destination/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('refuses to add a file the same patch already added', async () => {
    const operations = resolveForTest(`*** Begin Patch
*** Add File: fresh.txt
+one
*** Add File: fresh.txt
+two
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/adds it/);
    await expect(fs.stat(path.join(dir, 'fresh.txt'))).rejects.toThrow();
  });

  it('refuses to add onto a path the same patch is moving a file to', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    const operations = resolveForTest(`*** Begin Patch
*** Update File: a.txt
*** Move to: c.txt
*** Add File: c.txt
+collision
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/move destination/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
    await expect(fs.stat(path.join(dir, 'c.txt'))).rejects.toThrow();
  });

  it('refuses to update a file the same patch is creating', async () => {
    const operations = resolveForTest(`*** Begin Patch
*** Add File: fresh.txt
+one
*** Update File: fresh.txt
@@
-one
+two
*** End Patch`);

    await expect(applyResolvedPatch(operations)).rejects.toThrow(/adds it/);
    await expect(fs.stat(path.join(dir, 'fresh.txt'))).rejects.toThrow();
  });
});
