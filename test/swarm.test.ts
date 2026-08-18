/**
 * Who a caller is, in the rebuilt broker.
 *
 * Identity here is a binding and only ever a binding: a chat becomes the prime by spawning
 * from its own proven conversation, and a worker is the chat the app opened for its slot,
 * bound and started by the extension's report before the model in it has said anything. No
 * agent holds a credential, so there is nothing here about codes or keys on ordinary calls —
 * the adversarial cases are the ones where something *claims* an identity it was not given.
 *
 * `join` is the one exception, and these tests pin down what separates recovery from
 * impersonation: it may install a binding that never arrived, and it may never move one that
 * did.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  AgentError,
  AgentsBusyError,
  IdentityLostError,
  PRIME_ID,
  agentConversation,
  agentForCaller,
  agentForConversation,
  bindConversation,
  finishAgent,
  identify,
  join,
  mintWorkerJoinKey,
  pendingWorkerSpawns,
  resetAgentsForTests,
  sendMessage,
  spawn
} = await import('../src/main/agents.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'chat-prime';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-swarm-');
  initConfigPath(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 3 } });
});

afterEach(async () => {
  resetAgentsForTests();
  await removeTempDir(dir).catch(() => undefined);
});

beforeEach(() => {
  resetAgentsForTests();
});

/** A run with two workers, neither bound to a chat yet. */
function startRun(): [string, string] {
  const result = spawn({
    workers: [{ task: 'read the tests' }, { task: 'read the docs' }],
    caller: { conversationId: PRIME_CHAT }
  });
  const [first, second] = result.created.map((info) => info.id);
  if (!first || !second) throw new Error('spawn did not create the two workers it was asked for');
  return [first, second];
}

describe('binding a worker to its chat', () => {
  it('starts the worker: binding is the lifecycle transition, not a later join', () => {
    const [first] = startRun();
    expect(identifyState(first)).toBe('invited');
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toContain(first);

    expect(bindConversation(first, 'chat-1')).toBe(true);

    // Active before the model in that chat has done anything at all — which is the whole
    // invariant: an app-created worker chat is already a worker.
    expect(identifyState(first)).toBe('active');
    expect(identify({ conversationId: 'chat-1' }).activatedAt).toBeTypeOf('number');
    // And the spawn is no longer pending, so the bridge retires its command rather than
    // holding it open waiting for a join that is never coming.
    expect(pendingWorkerSpawns().map((worker) => worker.id)).not.toContain(first);
  });

  it('binds once and refuses to move', () => {
    const [first] = startRun();

    expect(bindConversation(first, 'chat-1')).toBe(true);
    // A second report naming a different chat is a mistake or someone else's tab. Honouring
    // it would point the worker's messages at a chat that is not doing the work.
    expect(bindConversation(first, 'chat-2')).toBe(false);
    expect(agentConversation(first)).toBe('chat-1');
    // Re-reporting the same chat is a no-op, not a failure.
    expect(bindConversation(first, 'chat-1')).toBe(true);
  });

  it('refuses a chat that another agent already holds', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');

    expect(bindConversation(second, 'chat-1')).toBe(false);
    expect(bindConversation(second, PRIME_CHAT)).toBe(false);
    expect(agentConversation(second)).toBeNull();
    expect(agentForConversation('chat-1')).toBe(first);
    expect(agentForConversation(PRIME_CHAT)).toBe(PRIME_ID);
  });

  it('will not bind a worker that has ended', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');
    finishAgent({ conversationId: 'chat-1' }, 'done');

    expect(bindConversation(first, 'chat-9')).toBe(false);
    expect(agentConversation(first)).toBe('chat-1');
  });
});

describe('an ordinary call from a worker', () => {
  it('routes by conversation, with nothing carried by the caller', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');
    bindConversation(second, 'chat-2');

    expect(agentForCaller({ conversationId: 'chat-1' })).toBe(first);
    expect(agentForCaller({ conversationId: 'chat-2' })).toBe(second);
    expect(agentForCaller({ conversationId: PRIME_CHAT })).toBe(PRIME_ID);
    // The worker can act at once: no join, no key, and its messages route from the start.
    expect(sendMessage({ conversationId: 'chat-1' }, 'prime', 'starting').from).toBe(first);
  });

  it('gives an unplaceable call no agent, and does not refuse it', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    // A phone, an unrelated chat, a call the page never named — none of them are worker
    // impersonation, and none of them may be filed under whichever agent was busiest.
    expect(agentForCaller({})).toBeNull();
    expect(agentForCaller({ conversationId: null })).toBeNull();
    expect(agentForCaller({ conversationId: 'chat-elsewhere' })).toBeNull();
  });

  it('refuses a control call it cannot place, by name', () => {
    startRun();

    // Two different failures with two different answers. A stranger this app *can* identify
    // learns only that agents are busy; a call it cannot place at all is told its identity
    // was lost, which is the thing recovery is documented against.
    expect(() => identify({ conversationId: 'chat-stranger' })).toThrow(AgentsBusyError);
    expect(() => identify({ conversationId: 'chat-stranger' })).toThrow(/AGENTS_BUSY/);
    expect(() => identify({})).toThrow(IdentityLostError);
    expect(() => identify({})).toThrow(/WORKER_IDENTITY_LOST/);
  });

  it('will not let a stranger send a message as a worker', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    expect(() => sendMessage({ conversationId: 'chat-elsewhere' }, 'prime', 'hi')).toThrow(AgentsBusyError);
    expect(() => sendMessage({}, 'prime', 'hi')).toThrow(IdentityLostError);
  });
});

describe('join, which is recovery and nothing else', () => {
  it('tells a bound worker it was already bound, rather than doing anything', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    // A model that reached for this has misunderstood its situation; the honest correction
    // is its own identity, and nothing changes.
    const info = join({ conversationId: 'chat-1' });
    expect(info.id).toBe(first);
    expect(info.task).toBe('read the tests');
    expect(agentConversation(first)).toBe('chat-1');
  });

  it('refuses without a key, and says where the key comes from', () => {
    startRun();

    expect(() => join({ conversationId: 'chat-nobody' })).toThrow(/not part of the active run/);
    expect(() => join({ conversationId: 'chat-nobody' })).toThrow(/join_key/);
  });

  it('accepts a key when the binding never arrived, and spends it', () => {
    const [first] = startRun();
    const key = mintWorkerJoinKey(first)!;

    const info = join({ conversationId: 'chat-1' }, key);
    expect(info.id).toBe(first);
    expect(agentConversation(first)).toBe('chat-1');
    // Recovery starts the worker for real, exactly as an ordinary binding would.
    expect(identifyState(first)).toBe('active');
    // Spent on use: a replay of the same key elsewhere cannot take the worker.
    expect(() => join({ conversationId: 'chat-2' }, key)).toThrow(AgentError);
    expect(agentConversation(first)).toBe('chat-1');
  });

  it('refuses a key presented from a chat the worker does not live in', () => {
    const [first] = startRun();
    const key = mintWorkerJoinKey(first)!;
    bindConversation(first, 'chat-1');

    // The key is recovery for a binding that never arrived, not permission to move one that
    // did — a copied opening message in another tab must not take the worker over.
    expect(() => join({ conversationId: 'chat-impostor' }, key)).toThrow(/already running in another conversation/);
    expect(agentConversation(first)).toBe('chat-1');
  });

  it('refuses a key that belongs to no waiting slot', () => {
    startRun();

    expect(() => join({ conversationId: 'chat-1' }, 'not-a-real-recovery-key')).toThrow(
      /does not match any worker slot/
    );
  });

  it('refuses a call it cannot place, key or no key', () => {
    const [first] = startRun();
    const key = mintWorkerJoinKey(first)!;

    expect(() => join({})).toThrow(IdentityLostError);
    expect(() => join({}, key)).toThrow(IdentityLostError);
    expect(agentConversation(first)).toBeNull();
  });

  it('refuses the prime', () => {
    const [first] = startRun();
    const key = mintWorkerJoinKey(first)!;

    expect(() => join({ conversationId: PRIME_CHAT })).toThrow(/prime agent/);
    expect(() => join({ conversationId: PRIME_CHAT }, key)).toThrow(/prime agent/);
    expect(agentConversation(first)).toBeNull();
  });

  it('will not revive a worker that has ended', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');
    finishAgent({ conversationId: 'chat-1' }, 'done');

    expect(() => join({ conversationId: 'chat-1' })).toThrow(/already finished|has already/);
    // And its key is destroyed with it, so a late recovery attempt cannot restart it either.
    expect(mintWorkerJoinKey(first)).toBeNull();
  });
});

/** The state of a worker, read the way any other caller would have to read it. */
function identifyState(id: string): string {
  const conversation = agentConversation(id);
  if (conversation) return identify({ conversationId: conversation }).state;
  const pending = pendingWorkerSpawns().find((worker) => worker.id === id);
  return pending ? 'invited' : 'gone';
}
