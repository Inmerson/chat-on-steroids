import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HeadTailBuffer } from '../src/main/codex/head-tail-buffer.js';
import { Utf8ChunkDecoder } from '../src/main/utf8-stream.js';

const euro = Buffer.from('€', 'utf8');

describe('UTF-8 stream boundaries', () => {
  it('reassembles a three-byte code point split across arbitrary chunks', () => {
    const decoder = new Utf8ChunkDecoder();
    const text = decoder.write(euro.subarray(0, 1)) + decoder.write(euro.subarray(1)) + decoder.end();

    expect(text).toBe('€');
    expect(text).not.toContain('�');
  });

  it('does not leave a replacement character when the retained head ends inside a code point', () => {
    const buffer = new HeadTailBuffer(8);
    const input = Buffer.concat([Buffer.from('aaa'), euro, Buffer.from('0123456789')]);
    buffer.pushChunk(input);

    const text = buffer.toBytesWithOmissionMarker().toString('utf8');
    expect(buffer.totalBytes()).toBe(input.length);
    expect(buffer.omittedBytes()).toBeGreaterThan(0);
    expect(text).toContain('bytes omitted');
    expect(text).not.toContain('�');
  });

  it('does not leave a replacement character when the rolling tail starts inside a code point', () => {
    const buffer = new HeadTailBuffer(8);
    const input = Buffer.concat([Buffer.from('HEAD'), Buffer.from('discard-me'), euro, Buffer.from('xyz')]);
    buffer.pushChunk(input);

    const text = buffer.toBytesWithOmissionMarker().toString('utf8');
    expect(buffer.totalBytes()).toBe(input.length);
    expect(buffer.omittedBytes()).toBeGreaterThan(0);
    expect(text).toContain('xyz');
    expect(text).not.toContain('�');
  });

  it('preserves an inherited omission boundary when buffers are drained and merged', () => {
    const drained = new HeadTailBuffer(8);
    drained.pushChunk(Buffer.concat([Buffer.from('aaa'), euro, Buffer.from('bbbb')]));
    expect(drained.omittedBytes()).toBe(3);

    const collected = new HeadTailBuffer(8);
    collected.pushBuffer(drained);

    const text = collected.toBytesWithOmissionMarker().toString('utf8');
    expect(text).toMatch(/^aaa\n\.\.\. 3 bytes omitted \.\.\.\nbbbb$/);
    expect(text).not.toContain('�');
  });

  it('keeps arbitrary child-process stream consumers on the streaming decoder', async () => {
    for (const relative of ['../src/main/tunnel/index.ts', '../src/main/search.ts', '../src/main/computer/index.ts']) {
      const source = await readFile(new URL(relative, import.meta.url), 'utf8');
      expect(source, relative).toContain('Utf8ChunkDecoder');
      expect(source, relative).not.toContain("chunk.toString('utf8')");
    }
  });
});
