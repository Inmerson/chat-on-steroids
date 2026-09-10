import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSession, initSessionStore, readEvents, resetSessionStoreForTests, upsertMessageEvent } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-input-merge-22-'); initSessionStore(directory); });
afterEach(async () => { resetSessionStoreForTests(); await removeTempDir(directory); });

it('preserves proven input metadata when the extension later echoes the same native user message sparsely', async () => {
  const session = await createSession({ title: 'Sparse echo', conversationId: randomUUID() });
  const id = randomUUID();
  const message = { text: 'Same authored message', chars: 21, truncated: false };
  await upsertMessageEvent(session.id, {
    time: 100, source: 'app', kind: 'user_message', messageId: 'native-user', message,
    inputId: id, inputDelivery: 'confirmed', authoredText: message.text,
    attachments: [{ name: '<safe-as-text>.txt', size: 10, mimeType: 'text/plain' }]
  });
  const echoed = { text: 'Same authored message ', chars: 22, truncated: false };
  await upsertMessageEvent(session.id, {
    time: 120, source: 'extension', kind: 'user_message', messageId: 'native-user', message: echoed
  });
  const rows = (await readEvents(session.id)).filter((event) => event.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    inputId: id,
    inputDelivery: 'confirmed',
    authoredText: message.text,
    attachments: [{ name: '<safe-as-text>.txt', size: 10, mimeType: 'text/plain' }]
  });
});
