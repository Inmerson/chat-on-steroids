import { describe, expect, it } from 'vitest';
import { applyTextPatch, parsePatch, PatchError } from '../src/main/patch.js';

describe('Codex-style patch parser', () => {
  it('parses add, update/move and delete operations in one patch', () => {
    const parsed = parsePatch(`*** Begin Patch
*** Add File: src/new.ts
+export const fresh = true;
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@ function value()
-  return 1;
+  return 2;
*** Delete File: src/dead.ts
*** End Patch`);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ kind: 'add', path: 'src/new.ts', content: 'export const fresh = true;\n' });
    expect(parsed[1]).toMatchObject({ kind: 'update', path: 'src/old.ts', moveTo: 'src/moved.ts' });
    expect(parsed[2]).toEqual({ kind: 'delete', path: 'src/dead.ts' });
  });

  it('refuses malformed hunk lines instead of guessing', () => {
    expect(() =>
      parsePatch(`*** Begin Patch
*** Update File: a.ts
@@
this has no prefix
*** End Patch`)
    ).toThrow(PatchError);
  });

  it('refuses literal NUL bytes before a text patch can make source look binary', () => {
    expect(() =>
      parsePatch(`*** Begin Patch\n*** Add File: bad.ts\n+const x = "a\0b";\n*** End Patch`)
    ).toThrow(/NUL byte/);
  });
});

describe('line-oriented patch application', () => {
  it('preserves CRLF while accepting LF patch context', () => {
    const source = 'function x() {\r\n  return 1;\r\n}\r\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.ts
@@ function x() {
-  return 1;
+  return 2;
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    const result = applyTextPatch(source, op.hunks);
    expect(result.text).toBe('function x() {\r\n  return 2;\r\n}\r\n');
    expect(result.delta).toMatchObject({ added: 1, removed: 1, approximate: false });
  });

  it('preserves the files indentation when trailing-whitespace fallback is used', () => {
    const source = 'function x() {\n    const keep = 1;   \n    return keep;\n}\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.ts
@@ function x() {
     const keep = 1;
-    return keep;
+    return keep + 1;
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    expect(applyTextPatch(source, op.hunks).text).toBe(
      'function x() {\n    const keep = 1;   \n    return keep + 1;\n}\n'
    );
  });

  it('uses an @@ scope for a pure addition instead of silently appending at EOF', () => {
    const source = 'class Alpha {\n}\n\nclass Beta {\n}\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.ts
@@ class Alpha {
+  method() {}
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    expect(applyTextPatch(source, op.hunks).text).toBe(
      'class Alpha {\n  method() {}\n}\n\nclass Beta {\n}\n'
    );
  });

  it('applies repeated context at the first match and says where else it matched', () => {
    // Codex's seek_sequence takes the first hit and so does this. Refusing would cost the
    // model a read and a retry to reach the same edit, so repetition is reported, not fatal.
    const source = 'const x = 1;\nconst y = 2;\nconst x = 1;\nconst y = 2;\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    const result = applyTextPatch(source, op.hunks);
    expect(result.text).toBe('const x = 1;\nconst y = 3;\nconst x = 1;\nconst y = 2;\n');
    expect(result.warnings.join(' ')).toMatch(/also matches at line 3.*first match, line 1/);
  });

  it('walks two identical blocks in order, one hunk each, without an @@ scope', () => {
    // The reason first-match is safe: searchStart moves past each applied hunk, so the
    // second hunk cannot land on the block the first one already edited.
    const source = 'a\nkeep\nb\na\nkeep\nb\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.txt
@@
 a
-keep
+first
@@
 a
-keep
+second
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    expect(applyTextPatch(source, op.hunks).text).toBe('a\nfirst\nb\na\nsecond\nb\n');
  });

  it('keeps line counts exact for tiny hunks thousands of lines apart', () => {
    const source = Array.from({ length: 4000 }, (_, index) => `line-${index}`).join('\n') + '\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: large.ts
@@
-line-10
+line-ten
@@
-line-3500
+line-three-thousand-five-hundred
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    const result = applyTextPatch(source, op.hunks);
    expect(result.delta).toEqual({ added: 2, removed: 2, approximate: false });
    expect(result.text).toContain('line-ten\n');
    expect(result.text).toContain('line-three-thousand-five-hundred\n');
  });

  it('anchors End of File hunks to the actual tail', () => {
    const source = 'alpha\nbeta\ngamma\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.txt
@@
 beta
-gamma
+delta
*** End of File
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    expect(applyTextPatch(source, op.hunks).text).toBe('alpha\nbeta\ndelta\n');
  });

  it('falls back to a normal search when End of File context is not at the end', () => {
    // The marker is a hint about where to look first, and a hunk that is valid earlier in
    // the file is still valid. Checking only the tail rejects a patch that has one home.
    const source = 'alpha\nbeta\ngamma\nomega\n';
    const op = parsePatch(`*** Begin Patch
*** Update File: x.txt
@@
 alpha
-beta
+bravo
*** End of File
*** End Patch`)[0];
    if (!op || op.kind !== 'update') throw new Error('bad fixture');

    const result = applyTextPatch(source, op.hunks);
    expect(result.text).toBe('alpha\nbravo\ngamma\nomega\n');
    expect(result.warnings.join(' ')).toMatch(/not the end of the file/);
  });
});

describe('marker whitespace the model got slightly wrong', () => {
  it('accepts indented and space-padded patch markers', () => {
    const parsed = parsePatch(`  *** Begin Patch
  *** Update File: src/a.ts
    @@ function value()
-  return 1;
+  return 2;
   *** End of File
 *** Delete File: src/dead.ts
*** End Patch  `);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: 'update', path: 'src/a.ts' });
    expect(parsed[0]).toMatchObject({ hunks: [{ header: 'function value()', endOfFile: true }] });
    expect(parsed[1]).toEqual({ kind: 'delete', path: 'src/dead.ts' });
  });

  it('leaves payload bytes alone while relaxing the markers around them', () => {
    const parsed = parsePatch(`*** Begin Patch
   *** Add File: src/indent.ts
+    const indented = true;
+\tconst tabbed = true;
*** End Patch`);

    expect(parsed[0]).toEqual({
      kind: 'add',
      path: 'src/indent.ts',
      content: '    const indented = true;\n\tconst tabbed = true;\n'
    });
  });

  it('still parses strictly when a hunk really contains a marker-shaped line', () => {
    // A well-formed patch never reaches the whitespace recovery, so a context line that
    // reads like a sentinel keeps its meaning as content.
    const parsed = parsePatch(`*** Begin Patch
*** Update File: docs/patch.md
@@
 *** End of File
-old
+new
*** End Patch`);

    if (parsed[0]?.kind !== 'update') throw new Error('bad fixture');
    expect(parsed[0].hunks[0]!.endOfFile).toBe(false);
    expect(parsed[0].hunks[0]!.lines[0]).toEqual({ kind: 'context', text: '*** End of File' });
  });

  it('reports the strict parse error when relaxing markers cannot rescue the patch', () => {
    expect(() =>
      parsePatch(`  *** Begin Patch
  *** Update File: a.ts
  @@
this has no prefix
  *** End Patch`)
    ).toThrow(/must start with space, \+ or -/);
  });
});
