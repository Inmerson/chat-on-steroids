import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: {}, shell: {}
}));
import { randomUUID } from 'node:crypto';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSecretsPath } from '../src/main/secrets.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { enqueueInput, resetInputForTests } from '../src/main/session/input.js';
import { stageInputAttachment } from '../src/main/session/input-attachments.js';
import { bridgePort, startBridge, stopBridge } from '../src/main/bridge.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let bearer = '';
async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method,
    headers: {
      'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as any };
}

beforeAll(async () => {
  directory = await makeTempDir('cos-input-bridge-22-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  await startBridge();
  const paired = await request('/pair', {});
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});
beforeEach(async () => { resetInputForTests(); await writeDurableNow('session-input', []); });
afterAll(async () => {
  await stopBridge(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('publishes, claims and acknowledges fresh input only for its exact browser owner', async () => {
  const row = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Open this chat', attachments: [], images: [] });
  const status = await request('/status');
  expect(status.body.inputs).toContainEqual({ id: row.id, conversationId: null, state: 'queued', owner: null, sendStarted: false });
  const claimed = await request('/input/claim', { id: row.id, owner: 'document-a', conversationId: null });
  expect(claimed.body.input).toMatchObject({ id: row.id, owner: 'document-a', text: row.text });
  expect((await request('/status')).body.inputs).toContainEqual({
    id: row.id,
    conversationId: null,
    state: 'browser',
    owner: 'document-a',
    sendStarted: false
  });
  expect(await request('/input/send-started', { id: row.id, owner: 'document-b' })).toMatchObject({ status: 409 });
  expect(await request('/input/send-started', { id: row.id, owner: 'document-a' })).toMatchObject({ status: 200, body: { ok: true } });
  expect(await request('/input/send-started', { id: row.id, owner: 'document-a' })).toMatchObject({ status: 200, body: { ok: true } });
  expect((await request('/status')).body.inputs).toContainEqual({
    id: row.id,
    conversationId: null,
    state: 'browser',
    owner: 'document-a',
    sendStarted: true
  });
  expect(await request('/input/release', { id: row.id, owner: 'document-a' })).toMatchObject({ status: 409 });
  const conversationId = randomUUID();
  expect((await request('/input/ack', { id: row.id, owner: 'document-b', conversationId, messageId: 'native-user' })).status).toBe(409);
  const ack = await request('/input/ack', { id: row.id, owner: 'document-a', conversationId, messageId: 'native-user' });
  expect(ack).toMatchObject({ status: 200, body: { ok: true } });
  expect(await request('/input/ack', { id: row.id, owner: 'document-a', conversationId, messageId: 'native-user' })).toMatchObject({ status: 200, body: { ok: true } });
  expect((await request('/status')).body.inputs).toEqual([]);
});

it('releases only an exact pre-send browser claim back to the queued outbox', async () => {
  const row = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Retry safely before send', attachments: [], images: [] });
  await request('/input/claim', { id: row.id, owner: 'document-a', conversationId: null });
  expect(await request('/input/release', { id: row.id, owner: 'document-b' })).toMatchObject({ status: 409 });
  expect(await request('/input/release', { id: row.id, owner: 'document-a' })).toMatchObject({ status: 200, body: { ok: true } });
  expect((await request('/status')).body.inputs).toContainEqual({
    id: row.id,
    conversationId: null,
    state: 'queued',
    owner: null,
    sendStarted: false
  });
});

it('serves staged attachment bytes only to the exact claimed input owner and member id', async () => {
  const attachment = await stageInputAttachment({ text: 'secret attachment bytes' }, new Set());
  const other = await stageInputAttachment({ text: 'other bytes' }, new Set([attachment.id]));
  const row = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Use the file', attachments: [attachment], images: [] });
  const query = { id: row.id, owner: 'document-a', conversationId: null, attachmentId: attachment.id, offset: 0 };
  expect((await request('/input/attachment', query)).status).toBe(409);
  await request('/input/claim', { id: row.id, owner: query.owner, conversationId: null });
  expect((await request('/input/attachment', { ...query, owner: 'document-b' })).status).toBe(409);
  expect((await request('/input/attachment', { ...query, attachmentId: other.id })).status).toBe(409);
  const bytes = await request('/input/attachment', query);
  expect(Buffer.from(bytes.body.chunk, 'base64').toString()).toBe('secret attachment bytes');
});
