import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { viewImage } from '../src/main/codex/view-image.js';

const image = path.join(process.cwd(), 'bughunt-2026-08-20', 'deep-garbage.webp');

try {
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]);
  const bytes = Buffer.alloc(20 + payload.length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(payload.length, 16);
  payload.copy(bytes, 20);
  await writeFile(image, bytes);

  const result = await viewImage(image, null);
  console.log(JSON.stringify({ accepted: true, mimeType: result.mimeType, bytes: result.bytes }));
} catch (error) {
  console.log(JSON.stringify({ accepted: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
} finally {
  await rm(image, { force: true });
}
