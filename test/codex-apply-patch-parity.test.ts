import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeApplyPatch, parsePatch } from '../src/main/codex/apply-patch/index.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'clf-apply-patch-parity-'));
  roots.push(root);
  return root;
}

describe('Codex apply_patch runtime parity', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('parses the current optional Environment ID preamble', () => {
    const parsed = parsePatch(`*** Begin Patch
*** Environment ID: remote-test
*** Add File: hello.txt
+hello
*** End Patch`);

    expect(parsed.environmentId).toBe('remote-test');
    expect(parsed.hunks).toHaveLength(1);
  });

  it('preserves already-committed hunks when a later runtime filesystem operation fails', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'directory-target'));

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Add File: committed.txt
+committed
*** Delete File: directory-target
*** End Patch`
    });

    expect(result.exitCode).toBe(1);
    await expect(readFile(path.join(root, 'committed.txt'), 'utf8')).resolves.toBe('committed\n');
    expect(result.delta.changes).toEqual([
      {
        path: path.join(root, 'committed.txt'),
        change: { kind: 'add', content: 'committed\n', overwrittenContent: null }
      }
    ]);
    expect(result.delta.exact).toBe(false);
  });

  it('records overwritten destination content when a move replaces an existing file', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    await writeFile(source, 'old\n');
    await writeFile(destination, 'destination-before\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-old
+new
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(destination, 'utf8')).resolves.toBe('new\n');
    await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.delta.changes).toEqual([
      {
        path: source,
        change: {
          kind: 'update',
          movePath: destination,
          oldContent: 'old\n',
          overwrittenMoveContent: 'destination-before\n',
          newContent: 'new\n'
        }
      }
    ]);
  });

  it('matches upstream fuzzy Unicode punctuation when patch context uses ASCII', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'unicode.py');
    await writeFile(target, 'import asyncio  # local import – avoids top‑level dep\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: unicode.py
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # HELLO
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('import asyncio  # HELLO\n');
  });

  it('preserves mixed source line endings in preserve-line-endings mode', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'mixed.txt');
    await writeFile(target, 'a\r\nb\nc\r');

    const result = await executeApplyPatch({
      cwd: root,
      updateFileMode: 'preserve_line_endings',
      patch: `*** Begin Patch
*** Update File: mixed.txt
@@
 a
-b
+B
 c
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('a\r\nB\r\nc\r');
  });

  it('inserts an empty-old-lines chunk at EOF with the historical trailing newline', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'eof.txt');
    await writeFile(target, 'foo\nbar\nbaz\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: eof.txt
@@
+quux
*** End of File
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('foo\nbar\nbaz\nquux\n');
  });
});
