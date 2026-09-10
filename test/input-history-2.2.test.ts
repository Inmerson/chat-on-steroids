import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createSession, initSessionStore, readEvents, resetSessionStoreForTests, writeAsset } from '../src/main/session/store.js';
import { recordDeliveredInput, recordedInputImage } from '../src/main/session/input-history.js';
import type { InputEntry } from '../src/main/session/input.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-input-history-22-'); initSessionStore(directory); });
afterEach(async () => { resetSessionStoreForTests(); await removeTempDir(directory); });

it('records only a proven delivery with safe attachment metadata and real image pixels', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'History', conversationId });
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp({ lossless: true }).toBuffer();
  const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
  const base = {
    id: randomUUID(), sessionId: session.id, text: 'Inspect the inputs',
    attachments: [{ id: randomUUID(), name: '<unsafe>.txt', size: 12, mimeType: 'text/plain' }],
    images: [{ name: 'pixel.webp', dataUrl }], owner: 'page', createdAt: 10, conversationId
  } as InputEntry;
  expect(await recordDeliveredInput({ ...base, state: 'queued' })).toBe(false);
  expect(await recordDeliveredInput({ ...base, state: 'sent', messageId: 'native-user', deliveredAt: 20 })).toBe(true);
  const rows = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    inputId: base.id,
    inputDelivery: 'confirmed',
    authoredText: base.text,
    attachments: [{ name: '<unsafe>.txt', size: 12, mimeType: 'text/plain' }]
  });
  expect(JSON.stringify(rows[0])).not.toContain(base.attachments[0]!.id);
  const row = rows[0]!;
  const assetId = row.kind === 'user_message' ? row.assets?.[0]?.id : undefined;
  expect(assetId).toBeTruthy();
  expect(await recordedInputImage(session.id, assetId!)).toBe(dataUrl);
  const stranger = await writeAsset(session.id, Buffer.from('not referenced'), 'application/octet-stream');
  expect(await recordedInputImage(session.id, stranger.id)).toBeNull();
});

it('records an MCP handout at offer time without pretending it was already acknowledged', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Tool input', conversationId });
  const entry = {
    id: randomUUID(), sessionId: session.id, text: 'Use this correction', attachments: [], images: [],
    state: 'tool', owner: 'request-one', createdAt: 10, offeredAt: 15, conversationId
  } as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(true);
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row).toMatchObject({ messageId: `input:${entry.id}`, inputId: entry.id, inputDelivery: 'offered', time: 15 });
});
