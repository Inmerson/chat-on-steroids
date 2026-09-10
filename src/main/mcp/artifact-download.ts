/** Resolve → fetch → bounded write → no-overwrite publish for ChatGPT native files. */
import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import type { Root } from '../../shared/types.js';
import { resolveIn } from './kernel.js';
import { ArtifactFetchError, normalizeOpenAIFileReference, openArtifactFile, validateOpenAIFileUrl, type OpenAIFileAdapterOptions } from './artifact-fetch.js';
import { ArtifactTargetError, openArtifactTarget } from './artifact-target.js';

export const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export interface SavedArtifact { virtual: string; size: number; sha256: string; }
export interface DownloadArtifactOptions extends OpenAIFileAdapterOptions { maxFileBytes: number; }

export async function downloadArtifactFile(roots: readonly Root[], requestedPath: string, file: unknown,
  options: DownloadArtifactOptions): Promise<SavedArtifact> {
  const { maxFileBytes } = options;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new ArtifactTargetError('Artifact file-size limit must be a positive integer.');
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') throw new ArtifactTargetError('Artifact destination is invalid.');
  if (/[/\\]$/.test(requestedPath.trim())) throw new ArtifactTargetError('Artifact destination must name a file, not a folder.');
  const reference = normalizeOpenAIFileReference(file);
  validateOpenAIFileUrl(reference.download_url);
  if (reference.size !== undefined && reference.size > maxFileBytes) throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
  const resolved = await resolveIn(roots as Root[], requestedPath, { allowMissing: true });
  const parentReal = nodePath.dirname(resolved.real);
  const name = nodePath.basename(resolved.real);
  const rootReal = await fs.realpath(resolved.root.path);
  const target = await openArtifactTarget({ parentReal, rootReal, name, maxFileBytes });
  let opened: Awaited<ReturnType<typeof openArtifactFile>> | undefined;
  const hash = createHash('sha256');
  let size = 0;
  try {
    opened = await openArtifactFile(file, options);
    if (opened.size !== undefined && opened.size > maxFileBytes) throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
    for await (const value of opened.stream) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
      if (size + chunk.length > maxFileBytes) throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
      await target.writeAll(chunk, size); hash.update(chunk); size += chunk.length;
    }
    if (opened.size !== undefined && opened.size !== size) throw new ArtifactFetchError('ChatGPT file metadata did not match the downloaded content.');
    await target.syncAndVerify(size); await target.publish();
    return { virtual: resolved.virtual, size, sha256: `sha256:${hash.digest('hex')}` };
  } finally {
    opened?.stream.destroy();
    await target.close().catch(() => undefined);
  }
}
