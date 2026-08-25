import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  listCheckpointMetadata,
  loadCheckpointSnapshot,
  resetCheckpointStoreForTests,
  saveCheckpointSnapshot,
  type CheckpointSnapshot
} from '../src/main/checkpoints.js';

let tempDir = '';

beforeEach(async () => {
  resetDurableForTests();
  resetCheckpointStoreForTests();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-checkpoints-'));
  initDurableStore(tempDir);
});

afterEach(async () => {
  resetCheckpointStoreForTests();
  resetDurableForTests();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function snapshot(id: string, name: string, files: Record<string, string>): CheckpointSnapshot {
  return {
    id,
    name,
    timestamp: '2026-08-25T10:00:00.000Z',
    targetPath: path.join(tempDir, 'project'),
    files
  };
}

describe('checkpoint store', () => {
  it('migrates legacy inline snapshots into a small metadata index without losing restore data', async () => {
    const files = {
      'src/a.ts': 'export const a = 1;\n'.repeat(500),
      'src/b.ts': 'export const b = 2;\n'.repeat(500)
    };
    const cp1 = snapshot('cp_1', 'before-change', files);
    const cp2 = snapshot('cp_2', 'same-tree-later', files);
    const legacy = { checkpoints: { cp_1: cp1, cp_2: cp2 } };
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), 'utf8');
    await writeDurableNow('agent-checkpoints', legacy);

    const listed = await listCheckpointMetadata();

    expect(listed).toHaveLength(2);
    expect(listed.map((cp) => cp.fileCount)).toEqual([2, 2]);
    expect(listed[0]?.contentHash).toBe(listed[1]?.contentHash);

    const index = await readDurable<{
      version: number;
      checkpoints: Record<string, { files?: unknown; contentHash: string }>;
    }>('agent-checkpoints');
    expect(index?.version).toBe(2);
    expect(index?.checkpoints.cp_1?.files).toBeUndefined();
    expect(index?.checkpoints.cp_2?.files).toBeUndefined();

    const indexPath = path.join(tempDir, 'state', 'agent-checkpoints.json');
    expect((await fs.stat(indexPath)).size).toBeLessThan(legacyBytes / 4);

    const blobDir = path.join(tempDir, 'state', 'checkpoints', 'blobs');
    const blobs = await fs.readdir(blobDir);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatch(/^[a-f0-9]{64}\.json\.gz$/);

    const restored = await loadCheckpointSnapshot('cp_1');
    expect(restored).toEqual(cp1);
  });

  it('deduplicates identical new snapshots while preserving independent checkpoint metadata', async () => {
    const files = { 'main.ts': 'console.log("same tree");\n'.repeat(2000) };
    await saveCheckpointSnapshot(snapshot('cp_new_1', 'first', files));
    await saveCheckpointSnapshot(snapshot('cp_new_2', 'second', files));

    const listed = await listCheckpointMetadata();
    expect(listed.map((cp) => cp.id).sort()).toEqual(['cp_new_1', 'cp_new_2']);
    expect(new Set(listed.map((cp) => cp.contentHash)).size).toBe(1);

    const blobDir = path.join(tempDir, 'state', 'checkpoints', 'blobs');
    expect(await fs.readdir(blobDir)).toHaveLength(1);
    expect((await loadCheckpointSnapshot('cp_new_2'))?.files).toEqual(files);
  });

  it('rejects snapshot paths that escape the checkpoint target root', async () => {
    const unsafe = snapshot('cp_unsafe', 'unsafe', { '../outside.ts': 'should never be restored' });

    await expect(saveCheckpointSnapshot(unsafe)).rejects.toThrow(/relative|escape|path/i);
    const stored = await readDurable<unknown>('agent-checkpoints');
    expect(stored).toBeNull();
  });
  it('lists metadata without opening checkpoint payload blobs', async () => {
    await saveCheckpointSnapshot(snapshot('cp_meta', 'metadata-only-list', { 'a.ts': 'content' }));
    const [metadata] = await listCheckpointMetadata();
    expect(metadata).toBeDefined();

    const blob = path.join(tempDir, 'state', 'checkpoints', 'blobs', `${metadata!.contentHash}.json.gz`);
    await fs.rm(blob, { force: true });

    const listed = await listCheckpointMetadata();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('cp_meta');
    await expect(loadCheckpointSnapshot('cp_meta')).rejects.toThrow(/payload/i);
  });
});
