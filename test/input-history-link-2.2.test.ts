import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import {
  acknowledgeBrowserInput,
  acknowledgeToolInput,
  claimBrowserInput,
  enqueueInput,
  listInputs,
  offerToolInput,
  resetInputForTests
} from '../src/main/session/input.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-input-history-link-22-'); initDurableStore(directory); initSessionStore(directory); resetInputForTests(); });
afterEach(async () => { resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory); });

it('promotes one canonical tool-input history row from offered to confirmed', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Tool history', conversationId });
  const row = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Check this correction', attachments: [], images: [] });
  await offerToolInput(session.id, conversationId, 'request-one', 100);
  let messages = (await readEvents(session.id)).filter((event) => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ inputId: row.id, inputDelivery: 'offered', messageId: `input:${row.id}` });
  await acknowledgeToolInput(session.id, conversationId, 'request-two', 200);
  messages = (await readEvents(session.id)).filter((event) => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ inputId: row.id, inputDelivery: 'confirmed', messageId: `input:${row.id}` });
});

it('projects a fresh-chat receipt after the recorder creates the exact conversation session', async () => {
  const row = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Fresh authored message', attachments: [], images: [] });
  await claimBrowserInput(row.id, 'document-a', null);
  const conversationId = randomUUID();
  await acknowledgeBrowserInput(row.id, 'document-a', conversationId, 'native-message');
  const session = await createSession({ title: 'Fresh', conversationId });
  await listInputs();
  const messages = (await readEvents(session.id)).filter((event) => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ inputId: row.id, inputDelivery: 'confirmed', messageId: 'native-message' });
  expect((await listInputs()).find((entry) => entry.id === row.id)).toMatchObject({ deliveredSessionId: session.id, historyRecorded: true });
});
