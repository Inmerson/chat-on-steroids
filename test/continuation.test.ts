/**
 * The Compact & Resume transaction: moving one durable local session from chat A to chat B.
 *
 * Every test here is about the failure half of that move rather than the happy path. The
 * invariant the whole design exists to protect is that a commit either lands completely or
 * leaves the session attached to chat A — never a session on disk in B with its swarm, its
 * workspace or its recorded history still in A. So these drive the races directly: two
 * claimants, a claim arriving mid-commit, a sweep firing mid-commit, an abort mid-commit, a
 * durable write that fails, and a handover deadline crossed while the write is in flight.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  TRANSFER_TTL_MS,
  beginPrimeTransfer,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  primeConversation,
  primeConversationGone,
  resetAgentsForTests,
  spawn,
  swarmRunning,
  thawPrimeTransfer
} = await import('../src/main/agents.js');
const {
  CONTINUATION_TTL_MS,
  abortContinuation,
  attachSummary,
  claimContinuation,
  commitContinuation,
  continuationForSession,
  openContinuation,
  resetContinuationsForTests
} = await import('../src/main/session/continuation.js');
const { createSession, getSession, initSessionStore, resetSessionStoreForTests, sessionsRoot } = await import(
  '../src/main/session/store.js'
);
const store = await import('../src/main/session/store.js');
const { resetRecorderForTests, sessionForConversation } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

/** The chat this session is attached to right now. */
async function attachedChat(sessionId: string): Promise<string | null> {
  return (await getSession(sessionId))?.conversationId ?? null;
}

/** How many handoffs this session has on disk. One per continuation, ever. */
async function handoffCount(sessionId: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(sessionsRoot(), sessionId, 'handoffs'))).length;
  } catch {
    return 0;
  }
}

const CHAT_A = 'chat-a';
const CHAT_B = 'chat-b';

beforeAll(async () => {
  dir = await makeTempDir('clf-continuation-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 3 } });
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetContinuationsForTests();
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A session attached to chat A with its brief already captured, ready to be claimed. */
async function readyContinuation(): Promise<{ sessionId: string; token: string }> {
  const summary = await createSession({ title: 'work', conversationId: CHAT_A });
  const opened = openContinuation(summary.id, CHAT_A);
  await attachSummary(opened.token, 'what was happening');
  return { sessionId: summary.id, token: opened.token };
}

describe('capturing the brief', () => {
  it('answers a repeated capture with the handoff it already wrote', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = openContinuation(summary.id, CHAT_A);

    const first = await attachSummary(opened.token, 'the brief');
    // The connector loses tool results, so the page reports the same finished generation
    // again. That retry must read as the success it is, not as a failure worth another flow.
    const again = await attachSummary(opened.token, 'the brief');

    expect(first).not.toBeNull();
    expect(again?.id).toBe(first?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('writes one handoff even when two captures race', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = openContinuation(summary.id, CHAT_A);

    // Both see `awaiting-summary` before either write lands. Without a lock taken before the
    // first await, both would write, and the second brief would silently win.
    const [first, second] = await Promise.all([
      attachSummary(opened.token, 'the brief'),
      attachSummary(opened.token, 'the brief')
    ]);

    expect(first?.id).toBe(second?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('gives every waiter the same retryable answer when the write fails', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = openContinuation(summary.id, CHAT_A);
    const spy = vi.spyOn(store, 'saveHandoff').mockRejectedValueOnce(new Error('disk full'));

    // The duplicate joins the attempt already in flight. It must not receive a rejected
    // promise for a step that simply has to be done again.
    const both = await Promise.all([
      attachSummary(opened.token, 'the brief'),
      attachSummary(opened.token, 'the brief')
    ]);
    expect(both).toEqual([null, null]);

    spy.mockRestore();
    expect(await attachSummary(opened.token, 'the brief')).not.toBeNull();
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('keeps the first brief when a re-observation differs, and still reports success', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = openContinuation(summary.id, CHAT_A);
    const first = await attachSummary(opened.token, 'the brief');

    const again = await attachSummary(opened.token, 'the brief, re-rendered slightly differently');

    expect(again?.id).toBe(first?.id);
    expect(again?.text).toBe(first?.text);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('refuses an empty or interrupted answer and stays in chat A', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = openContinuation(summary.id, CHAT_A);

    expect(await attachSummary(opened.token, '   ')).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(claimContinuation(opened.token, 'tab-1')).toBeNull();
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });
});

describe('claiming', () => {
  it('serves one claimant and refuses a second', async () => {
    const { token } = await readyContinuation();

    expect(claimContinuation(token, 'tab-1')?.summary).toContain('what was happening');
    expect(claimContinuation(token, 'tab-2')).toBeNull();
    expect(claimContinuation(token, 'tab-1')?.summary).toContain('what was happening');
  });

  it('does not move the state backwards while a commit is in flight', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    // Hold the durable write open, so the commit is provably mid-flight.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    const spy = vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });

    const commit = commitContinuation(token, CHAT_B);
    await Promise.resolve();
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    // The retrying claimant wants its brief; what it must not get is the state put back to
    // `claimed`, which was the one way a second commit could enter behind the first.
    expect(claimContinuation(token, 'tab-1')?.summary).toContain('what was happening');
    expect(continuationForSession(sessionId)?.state).toBe('committing');
    const second = await commitContinuation(token, 'chat-c');
    expect(second).toBe(false);

    release();
    expect(await commit).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('committing', () => {
  it('moves the session, its history and its workspace together', async () => {
    const { sessionId, token } = await readyContinuation();
    const before = await sessionForConversation(CHAT_A);
    expect(before).toBe(sessionId);
    setWorkspaceFor(`chat:${CHAT_A}`, { virtual: '/totec/project', real: dir });
    claimContinuation(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    const moved = await getSession(sessionId);
    expect(moved?.conversationId).toBe(CHAT_B);
    // Same durable session, with chat A kept as lineage rather than replaced.
    expect(moved?.chatIds).toEqual([CHAT_A, CHAT_B]);
    // The context meter is per attached chat, or the next turn would re-compact immediately.
    expect(moved?.contextTokens).toBe(0);
    expect(await sessionForConversation(CHAT_B)).toBe(sessionId);
    expect(workspaceEntries().map((held) => held.key)).toEqual([`chat:${CHAT_B}`]);
  });

  it('refuses a chat B that is not a distinct conversation', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    expect(await commitContinuation(token, '')).toBe(false);
    expect(await commitContinuation(token, CHAT_A)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
  });

  it('leaves the session in chat A when the durable write fails, and stays retryable', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');
    const spy = vi.spyOn(store, 'rebindSession').mockResolvedValueOnce(false);

    expect(await commitContinuation(token, CHAT_B)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
    expect(continuationForSession(sessionId)?.state).toBe('claimed');
    expect(workspaceEntries()).toEqual([]);

    spy.mockRestore();
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('treats a repeated ack as the commit that already landed', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect((await getSession(sessionId))?.chatIds).toEqual([CHAT_A, CHAT_B]);
  });
});

describe('the commit lock', () => {
  /** Runs `body` while the durable write is suspended, then lets the commit finish. */
  async function duringDurableWrite(
    token: string,
    to: string,
    body: () => void | Promise<void>
  ): Promise<boolean> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const commit = commitContinuation(token, to);
    await Promise.resolve();
    await body();
    release();
    return commit;
  }

  it('cannot be aborted once the durable write has started', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      // An abort here would clear the frozen prime handover under a write that is still
      // going to land — the split this transaction exists to make impossible.
      expect(abortContinuation(token, 'user changed their mind')).toBe(false);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('is not swept away by a lookup that happens to cross the deadline', async () => {
    vi.useFakeTimers();
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS + 1_000);
      // Any passing lookup runs the sweep. It must not expire a commit already in flight.
      continuationForSession(sessionId);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('the swarm handover', () => {
  const startSwarm = (conversationId: string): void => {
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId } });
  };

  it('moves the prime with the session', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = openContinuation(summary.id, CHAT_A);
    await attachSummary(opened.token, 'what was happening');
    claimContinuation(opened.token, 'tab-1');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('survives a deadline crossed while the durable write is in flight', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = openContinuation(summary.id, CHAT_A);
    await attachSummary(opened.token, 'what was happening');
    claimContinuation(opened.token, 'tab-1');

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const commit = commitContinuation(opened.token, CHAT_B);
    await Promise.resolve();
    // The handover deadline passes while the disk write is happening. Before the freeze this
    // left the session durably in B with the swarm still bound to A.
    vi.setSystemTime(Date.now() + TRANSFER_TTL_MS + 1_000);
    release();

    expect(await commit).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('refuses the whole commit when the prime session has no usable handover', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = openContinuation(summary.id, CHAT_A);
    await attachSummary(opened.token, 'what was happening');
    claimContinuation(opened.token, 'tab-1');

    // The handover is gone while the continuation itself is still perfectly live — so the
    // refusal below can only be the swarm preflight, never generic expiry. (In production
    // this is the run ending, or being reset, between the button and the new chat.)
    cancelPrimeTransfer(CHAT_A);
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(primeConversation()).toBe(CHAT_A);
    // Refused before anything was written: still claimable, and its error says why.
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(continuationForSession(summary.id)?.error).toMatch(/handover/);
  });

  it('commits a session that owns no swarm at all', async () => {
    const { sessionId, token } = await readyContinuation();
    claimContinuation(token, 'tab-1');

    expect(freezePrimeTransfer(CHAT_A)).toBe('absent');
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('keeps the run alive while chat A is being replaced, and kills it otherwise', async () => {
    startSwarm(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(true);
    expect(swarmRunning()).toBe(false);

    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('does not let a frozen handover expire, and thaws back to an expiring one', () => {
    vi.useFakeTimers();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    vi.setSystemTime(Date.now() + TRANSFER_TTL_MS * 2);
    // Frozen means committed-to: no deadline of its own, so the move cannot decline.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(commitPrimeTransfer(CHAT_A, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    vi.setSystemTime(Date.now() + TRANSFER_TTL_MS + 1_000);
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');
  });

  it('will not hand a swarm to a chat that is not the one being replaced', () => {
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(commitPrimeTransfer('someone-else', CHAT_B)).toBe(false);
    expect(primeConversation()).toBe(CHAT_A);
  });
});
