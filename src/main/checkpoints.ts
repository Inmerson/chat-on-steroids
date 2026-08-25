import crypto from 'node:crypto';
import nodePath from 'node:path';
import { promisify } from 'node:util';
import { constants as zlibConstants, gunzip, gzip } from 'node:zlib';
import { durableStatePath, readDurable, writeDurableNow } from './durable.js';
import { rawPromises as fs } from './rawfs.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const INDEX_VERSION = 2 as const;

export interface CheckpointSnapshot {
  id: string;
  name: string;
  timestamp: string;
  targetPath: string;
  files: Record<string, string>;
}

export interface CheckpointMetadata {
  id: string;
  name: string;
  timestamp: string;
  targetPath: string;
  fileCount: number;
  contentHash: string;
  payloadChars: number;
}

interface CheckpointIndexV2 {
  version: typeof INDEX_VERSION;
  checkpoints: Record<string, CheckpointMetadata>;
}

interface LegacyCheckpointStore {
  checkpoints: Record<string, CheckpointSnapshot>;
}

let queue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation, operation);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function validateCheckpointFilePath(filePath: string): void {
  const normalized = nodePath.normalize(filePath);
  if (
    !filePath ||
    filePath.includes('\0') ||
    nodePath.isAbsolute(filePath) ||
    normalized === '..' ||
    normalized.startsWith('..' + nodePath.sep)
  ) {
    throw new Error('Checkpoint file path must be relative and stay inside the target root: ' + filePath);
  }
}

function checkpointPayload(files: Record<string, string>): Buffer {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) {
    validateCheckpointFilePath(key);
    sorted[key] = files[key] ?? '';
  }
  return Buffer.from(JSON.stringify({ files: sorted }), 'utf8');
}

function metadataFor(snapshot: CheckpointSnapshot, payload: Buffer): CheckpointMetadata {
  return {
    id: snapshot.id,
    name: snapshot.name,
    timestamp: snapshot.timestamp,
    targetPath: snapshot.targetPath,
    fileCount: Object.keys(snapshot.files).length,
    contentHash: crypto.createHash('sha256').update(payload).digest('hex'),
    payloadChars: Object.values(snapshot.files).reduce((sum, content) => sum + content.length, 0)
  };
}

function blobPath(contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid checkpoint payload hash.');
  return durableStatePath('checkpoints', 'blobs', `${contentHash}.json.gz`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function persistPayload(files: Record<string, string>): Promise<CheckpointMetadata['contentHash']> {
  const payload = checkpointPayload(files);
  const contentHash = crypto.createHash('sha256').update(payload).digest('hex');
  const target = blobPath(contentHash);
  if (await pathExists(target)) return contentHash;

  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  const compressed = await gzipAsync(payload, { level: zlibConstants.Z_BEST_COMPRESSION });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, compressed);
    try {
      await fs.rename(tmp, target);
    } catch (error) {
      // Two simultaneous snapshots with identical content may race to publish the same blob.
      if (!(await pathExists(target))) throw error;
      await fs.rm(tmp, { force: true });
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return contentHash;
}

function emptyIndex(): CheckpointIndexV2 {
  return { version: INDEX_VERSION, checkpoints: {} };
}

function isIndexV2(value: unknown): value is CheckpointIndexV2 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; checkpoints?: unknown };
  return candidate.version === INDEX_VERSION && !!candidate.checkpoints && typeof candidate.checkpoints === 'object';
}

function isLegacySnapshot(value: unknown): value is CheckpointSnapshot {
  if (!value || typeof value !== 'object') return false;
  const cp = value as Partial<CheckpointSnapshot>;
  return (
    typeof cp.id === 'string' &&
    typeof cp.name === 'string' &&
    typeof cp.timestamp === 'string' &&
    typeof cp.targetPath === 'string' &&
    !!cp.files &&
    typeof cp.files === 'object' &&
    Object.values(cp.files).every((content) => typeof content === 'string')
  );
}

async function loadIndexUnlocked(): Promise<CheckpointIndexV2> {
  const stored = await readDurable<CheckpointIndexV2 | LegacyCheckpointStore>('agent-checkpoints');
  if (!stored) return emptyIndex();
  if (isIndexV2(stored)) return stored;

  const legacy = (stored as LegacyCheckpointStore).checkpoints;
  if (!legacy || typeof legacy !== 'object') throw new Error('Checkpoint index is invalid and cannot be migrated safely.');

  const migrated = emptyIndex();
  for (const [id, value] of Object.entries(legacy)) {
    if (!isLegacySnapshot(value)) {
      throw new Error(`Checkpoint "${id}" is invalid; legacy state was left untouched.`);
    }
    const payload = checkpointPayload(value.files);
    const contentHash = await persistPayload(value.files);
    migrated.checkpoints[id] = { ...metadataFor(value, payload), contentHash };
  }

  // Blobs are published first. Only after every payload is durable do we atomically replace
  // the old all-in-one JSON with the small v2 metadata index, so a crash can safely retry.
  await writeDurableNow('agent-checkpoints', migrated);
  return migrated;
}

export async function listCheckpointMetadata(): Promise<CheckpointMetadata[]> {
  return serialize(async () => {
    const index = await loadIndexUnlocked();
    return Object.values(index.checkpoints).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  });
}

export async function saveCheckpointSnapshot(snapshot: CheckpointSnapshot): Promise<CheckpointMetadata> {
  return serialize(async () => {
    const index = await loadIndexUnlocked();
    const payload = checkpointPayload(snapshot.files);
    const contentHash = await persistPayload(snapshot.files);
    const metadata = { ...metadataFor(snapshot, payload), contentHash };
    index.checkpoints[snapshot.id] = metadata;
    await writeDurableNow('agent-checkpoints', index);
    return metadata;
  });
}

export async function loadCheckpointSnapshot(id: string): Promise<CheckpointSnapshot | null> {
  return serialize(async () => {
    const index = await loadIndexUnlocked();
    const metadata = index.checkpoints[id];
    if (!metadata) return null;

    const target = blobPath(metadata.contentHash);
    let compressed: Buffer;
    try {
      compressed = await fs.readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Checkpoint payload for "${id}" is missing.`);
      }
      throw error;
    }

    let decoded: unknown;
    try {
      const payload = await gunzipAsync(compressed);
      const actualHash = crypto.createHash('sha256').update(payload).digest('hex');
      if (actualHash !== metadata.contentHash) throw new Error('payload hash mismatch');
      decoded = JSON.parse(payload.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`Checkpoint payload for "${id}" is corrupt: ${(error as Error).message}`);
    }

    const files = (decoded as { files?: unknown })?.files;
    if (!files || typeof files !== 'object' || !Object.values(files).every((content) => typeof content === 'string')) {
      throw new Error(`Checkpoint payload for "${id}" is invalid.`);
    }

    return {
      id: metadata.id,
      name: metadata.name,
      timestamp: metadata.timestamp,
      targetPath: metadata.targetPath,
      files: files as Record<string, string>
    };
  });
}

export function resetCheckpointStoreForTests(): void {
  queue = Promise.resolve();
}
