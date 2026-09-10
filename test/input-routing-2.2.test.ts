import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  acknowledgeBrowserInput,
  acknowledgeToolInput,
  claimBrowserInput,
  enqueueInput,
  listInputs,
  offerToolInput,
  pendingBrowserInputs,
  resetInputForTests
} from '../src/main/session/input.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-input-routing-');
  initDurableStore(directory);
  initSessionStore(directory);
  resetInputForTests();
});
afterEach(async () => {
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('keeps one durable UUID bound to the exact recorded conversation across restart', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Exact target', conversationId });
  const id = randomUUID();
  const input = { id, sessionId: session.id, text: 'Inspect the current result', attachments: [], images: [] };
  expect(await enqueueInput(input)).toMatchObject({ id, sessionId: session.id, conversationId, state: 'queued' });
  await expect(enqueueInput({ ...input, text: 'Different payload' })).rejects.toThrow(/different input/i);
  resetInputForTests();
  expect(await listInputs()).toContainEqual(expect.objectContaining({ id, conversationId, state: 'queued' }));
});

it('offers existing-chat input only to its exact MCP session and retires it on a later exact call', async () => {
  const conversationId = randomUUID();
  const otherConversation = randomUUID();
  const session = await createSession({ title: 'Target', conversationId });
  const other = await createSession({ title: 'Other', conversationId: otherConversation });
  const row = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Use this correction', attachments: [], images: [] });
  expect(await offerToolInput(other.id, otherConversation, 'other-request', 100)).toEqual([]);
  expect(await offerToolInput(session.id, otherConversation, 'wrong-conversation', 100)).toEqual([]);
  expect(await offerToolInput(session.id, conversationId, 'request-one', 100)).toEqual([
    expect.objectContaining({ id: row.id, text: row.text })
  ]);
  expect(await offerToolInput(session.id, conversationId, 'request-one', 101)).toEqual([
    expect.objectContaining({ id: row.id })
  ]);
  expect(await acknowledgeToolInput(session.id, conversationId, 'request-two', 102)).toBe(true);
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: `input:${row.id}` });
  expect(await offerToolInput(session.id, conversationId, 'request-three', 103)).toEqual([]);
});

it('requires causal in-memory handout evidence before a later tool request can acknowledge input', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Causal target', conversationId });
  const row = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Causal correction', attachments: [], images: [] });

  expect(await offerToolInput(session.id, conversationId, 'request-a', 200)).toEqual([
    expect.objectContaining({ id: row.id, owner: 'request-a' })
  ]);
  // request-b was already in flight before request-a's result handed the correction out.
  expect(await acknowledgeToolInput(session.id, conversationId, 'request-b', 150)).toBe(false);
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'tool', owner: 'request-a' });

  // Its own result may safely re-offer the stable instruction, establishing new handout evidence.
  expect(await offerToolInput(session.id, conversationId, 'request-b', 250)).toEqual([
    expect.objectContaining({ id: row.id, owner: 'request-b' })
  ]);
  expect(await acknowledgeToolInput(session.id, conversationId, 'request-c', 251)).toBe(true);
});

it('loses tool handout proof across restart and re-offers instead of falsely confirming', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Restart causal target', conversationId });
  const row = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Survive a lost response', attachments: [], images: [] });

  expect(await offerToolInput(session.id, conversationId, 'request-a', 300)).toHaveLength(1);
  resetInputForTests();
  expect(await acknowledgeToolInput(session.id, conversationId, 'request-b', 400)).toBe(false);
  expect(await offerToolInput(session.id, conversationId, 'request-b', 401)).toEqual([
    expect.objectContaining({ id: row.id, owner: 'request-b' })
  ]);
  expect(await acknowledgeToolInput(session.id, conversationId, 'request-c', 402)).toBe(true);
});

it('gives a fresh-chat input to one browser owner and accepts ACK only from that owner', async () => {
  const row = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Start a new chat', attachments: [], images: [] });
  expect(await pendingBrowserInputs()).toContainEqual({
    id: row.id,
    conversationId: null,
    state: 'queued',
    owner: null,
    sendStarted: false
  });
  expect(await claimBrowserInput(row.id, 'document-a', null)).toMatchObject({ id: row.id, state: 'browser', owner: 'document-a' });
  expect(await pendingBrowserInputs()).toContainEqual({
    id: row.id,
    conversationId: null,
    state: 'browser',
    owner: 'document-a',
    sendStarted: false
  });
  expect(await claimBrowserInput(row.id, 'document-b', null)).toBeNull();
  const conversationId = randomUUID();
  expect(await acknowledgeBrowserInput(row.id, 'document-b', conversationId, 'native-user')).toBe(false);
  expect(await acknowledgeBrowserInput(row.id, 'document-a', conversationId, 'native-user')).toBe(true);
  expect(await acknowledgeBrowserInput(row.id, 'document-a', conversationId, 'native-user')).toBe(true);
  expect(await acknowledgeBrowserInput(row.id, 'document-a', conversationId, 'different-native-user')).toBe(false);
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', conversationId, messageId: 'native-user' });
});

it('fails closed and preserves a corrupt durable input outbox instead of treating it as empty', async () => {
  const stateDir = path.join(directory, 'state');
  const stateFile = path.join(stateDir, 'session-input.json');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stateFile, '{ definitely-not-json', 'utf8');
  resetInputForTests();

  await expect(listInputs()).rejects.toThrow(/outbox could not be read safely/i);
  expect(await fs.readFile(stateFile, 'utf8')).toBe('{ definitely-not-json');
});

it('retains a terminal receipt whose canonical history still needs repair', async () => {
  const conversationId = randomUUID();
  const pendingId = randomUUID();
  const pending = {
    id: pendingId, sessionId: null, text: 'History still pending', attachments: [], images: [],
    state: 'sent', owner: 'document-a', createdAt: 1, conversationId,
    deliveredAt: 2, messageId: 'native-pending', historyRecorded: false
  };
  const completed = Array.from({ length: 199 }, (_, index) => ({
    id: randomUUID(), sessionId: null, text: `Completed ${index}`, attachments: [], images: [],
    state: 'sent', owner: 'document-old', createdAt: 10 + index, conversationId: randomUUID(),
    deliveredAt: 20 + index, messageId: `native-${index}`, historyRecorded: true
  }));
  await writeDurableNow('session-input', [pending, ...completed]);
  resetInputForTests();

  await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Newest queued input', attachments: [], images: [] });
  expect((await listInputs()).some((entry) => entry.id === pendingId)).toBe(true);
});