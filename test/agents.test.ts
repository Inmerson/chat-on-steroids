/**
 * The broker: what a run is, who may act in it, and what happens to messages.
 *
 * Identity itself — which conversation is which agent, and what a code may and may not do —
 * lives in swarm.test.ts. This file is about everything downstream of that answer: creating
 * a run atomically, the star topology, at-least-once delivery, terminal states, restart, and
 * the shape of all of it over the actual MCP endpoint.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/main/agents.js';

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
  PRIME_ID,
  acknowledgeOffers,
  bindConversation,
  clearAgent,
  currentRunId,
  failAgent,
  finishAgent,
  finishWorkerConversation,
  identify,
  offerMessages,
  onSpawnRequest,
  onSwarmEnd,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerSpawns,
  DETACHED_SILENCE_MS,
  endedWorkerNotice,
  failSilentDetachedWorkers,
  noteAgentAlive,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  retiredWorkerForConversation,
  persistCriticalSwarmNow,
  resetAgentsForTests,
  restoreSwarm,
  sendMessage,
  stageMessages,
  stageSpawn,
  snapshotSwarm,
  spawn,
  swarmRunning,
  swarmState,
  workerConversationGone
} = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { setAntigravityInvestigatorForTests } = await import('../src/main/antigravity/investigator.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { recordChatObservations, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

async function setEnabled(enabled: boolean, maxWorkers = 3): Promise<void> {
  const base = defaultConfig();
  await saveConfig({ ...base, multiAgent: { enabled, maxWorkers } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-agents-');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await setEnabled(true);
});

afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetAgentsForTests();
  resetRecorderForTests();
  setAntigravityInvestigatorForTests(null);
  // The real app wires the broker's immediate persistence sink during startup. MCP endpoint
  // tests exercise that production contract rather than an intentionally half-wired broker;
  // durability-specific cases below replace this no-op sink with controlled writers.
  onSwarmPersistNow(async () => undefined);
});

const PRIME_CHAT = 'c-prime';
const prime: Caller = { conversationId: PRIME_CHAT };

interface StartedSwarm {
  prime: Caller;
  spawned: Array<{ id: string; task: string }>;
}

/** Prime + n workers, without opening any browser tabs. */
function startSwarm(count = 2, caller: Caller = prime): StartedSwarm {
  const spawned: Array<{ id: string; task: string }> = [];
  onSpawnRequest((workers) => spawned.push(...workers));
  const result = spawn({
    workers: Array.from({ length: count }, (_, i) => ({ label: `Worker ${i + 1}`, task: `task ${i + 1}` })),
    caller
  });
  expect(result.becamePrime).toBe(true);
  return { prime: caller, spawned };
}

/**
 * A worker started the way the app makes it happen: the extension reports the chat it
 * opened, and that binding is the whole of it. No join, no key, nothing typed by a model.
 */
function startWorker(id: string, conversationId = `c-${id}`): { caller: Caller } {
  expect(bindConversation(id, conversationId)).toBe(true);
  return { caller: { conversationId } };
}

describe('spawning a run', () => {
  it('refuses the feature while it is switched off', async () => {
    await setEnabled(false);
    expect(() => spawn({ workers: [{ task: 'x' }], caller: prime })).toThrow(/not enabled|switched off|disabled/i);
    await setEnabled(true);
  });

  it('binds the calling conversation as prime and creates its workers', () => {
    const { spawned } = startSwarm(2);
    const state = swarmState();
    expect(state.agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1', 'worker-2']);
    expect(state.agents[0]?.conversationId).toBe(PRIME_CHAT);
    expect(spawned.map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    // Nothing about a run is a credential the state can leak: the prime has none at all,
    // and a worker's code exists only as a hash until it joins.
    expect(JSON.stringify(state)).not.toMatch(/secret|joinKey|codeHash/i);
  });

  it('uses a full UUID as the run incarnation key that fences stale worker commands', () => {
    startSwarm(1);
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('creates nothing at all when any worker in the request is invalid', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: '   ' }], caller: prime })
    ).toThrow(/Worker 2 has no task/);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rejects an over-long label before creating anything, not only an over-long task', () => {
    expect(() => spawn({ workers: [{ label: 'x'.repeat(200), task: 'fine' }], caller: prime })).toThrow(
      /label is too long/
    );
    expect(swarmRunning()).toBe(false);
  });

  it('refuses a caller whose conversation this app could not prove, and creates nothing', () => {
    expect(() => spawn({ workers: [{ task: 'fine' }], caller: {} })).toThrow(AgentError);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('enforces the configured live-worker limit', () => {
    startSwarm(3);
    expect(() => spawn({ workers: [{ task: 'one too many' }], caller: prime })).toThrow(/limit|maximum|too many/i);
  });

  it('lets only the prime conversation recruit more workers', () => {
    startSwarm(1);
    expect(() => spawn({ workers: [{ task: 'more' }], caller: { conversationId: 'c-stranger' } })).toThrow(
      /AGENTS_BUSY/
    );
    expect(swarmState().agents).toHaveLength(2);
    spawn({ workers: [{ task: 'more' }], caller: prime });
    expect(swarmState().agents.map((agent) => agent.id)).toContain('worker-2');
  });
});

describe('star topology', () => {
  it('allows worker → prime and prime → worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(sendMessage(worker.caller, PRIME_ID, 'found something').to).toBe(PRIME_ID);
    expect(sendMessage(prime, 'worker-1', 'noted, carry on').to).toBe('worker-1');
  });

  it('forbids worker → worker in both directions', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    expect(() => sendMessage(one.caller, 'worker-2', 'psst')).toThrow(AgentError);
    expect(() => sendMessage(two.caller, 'worker-1', 'psst')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('refuses empty text, unknown recipients and finished recipients', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(() => sendMessage(worker.caller, PRIME_ID, '   ')).toThrow(/empty/i);
    expect(() => sendMessage(prime, 'worker-9', 'hello')).toThrow(/Unknown agent/);
    finishAgent(worker.caller, 'done');
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).toThrow(/finished/);
  });
});

describe('at-least-once delivery', () => {
  it('re-offers an unacknowledged message and retires it only on the next call', () => {
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'a correction');

    const first = offerMessages('worker-1');
    expect(first).toHaveLength(1);
    expect(first[0]?.offers).toBe(1);

    // The result never came back, so the same message is offered again rather than lost.
    const second = offerMessages('worker-1');
    expect(second).toHaveLength(1);
    expect(second[0]?.offers).toBe(2);

    // The worker's next authenticated call is the evidence the previous result arrived.
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
  });

  it('offers a bounded inbox batch so a deep queue cannot make every tool result enormous', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let index = 0; index < 20; index++) {
      sendMessage(prime, 'worker-1', `message-${index} ${'x'.repeat(3_980)}`);
    }

    const first = offerMessages('worker-1');
    // The old broker appended every waiting row in one go. Even this 20-message fixture was
    // ~80k characters; the real queue limit permits ~800k before MCP framing/tool output is
    // counted. A result too large to reach ChatGPT is then re-offered unchanged forever.
    expect(first.length).toBeLessThan(20);
    expect(first.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(32_000);

    const delivered = acknowledgeOffers('worker-1');
    expect(delivered.map((message) => message.id)).toEqual(first.map((message) => message.id));
    const second = offerMessages('worker-1');
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((message) => first.some((prior) => prior.id === message.id))).toBe(false);
  });

  it('refuses queue overflow instead of silently dropping an older message', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let i = 0; i < 200; i++) sendMessage(prime, 'worker-1', `message ${i}`);
    expect(() => sendMessage(prime, 'worker-1', 'one too many')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(200);
  });

  // A run does not end because its workers did. The prime is the run, and it is still
  // sitting there able to spawn more; only the prime chat going away ends it.
  it('queues each final report for the prime and leaves the run standing', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');

    const first = finishAgent(one.caller, 'part one done');
    expect(first.report?.to).toBe(PRIME_ID);
    expect(first.report?.text).toContain('part one done');

    finishAgent(two.caller, 'part two done');
    expect(ended).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(2);
  });

  it('releases the global run only after the prime has acknowledged every terminal worker report', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'finished safely');

    // Terminal worker is not enough: the prime still has an unseen final report.
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    // Merely putting the report in one result is still not proof that ChatGPT received it.
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    // The prime's next authenticated call proves the previous result arrived. Now no work or
    // report remains, so the single global swarm claim can disappear immediately.
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatch(/terminal|delivered/i);
  });

  it('keeps a retired lease for a finished worker after its final report releases the run', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'finished safely');

    // Drive the ordinary at-least-once report lifecycle all the way through release. The
    // active-run tombstone is what stops this worker chat using local tools after finish; once
    // the run disappears, the kernel can enforce that same boundary only through the retired
    // conversation lease.
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    expect(retiredWorkerForConversation('c-worker-1')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-1'
    });
  });

  it('does not release the run while a durability-gated message is still unpublished', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // A production agents::message call stages first, then waits for its immediate durable
    // barrier before commit publishes it to inbox readers. Keep that exact window open.
    const staged = stageMessages(worker.caller, [{ to: PRIME_ID, text: 'one last finding' }]);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    // A parallel finish can make the last worker terminal while its staged message is still in
    // that acceptance window. Retire the visible finish report exactly as two later prime calls
    // would, leaving pending=0 even though the unpublished message still exists in the queue.
    finishAgent(worker.caller, 'finished');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(pendingCount(PRIME_ID)).toBe(0);

    // Ending the run here detaches the staged message object from broker state. Its original
    // tool call can later commit and report success, but no prime inbox exists to receive it.
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    staged.commit();
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(false);
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);
  });
});

describe('an agent that has ended', () => {
  it('treats a repeated finish as the same finish and reports to the prime only once', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const first = finishAgent(worker.caller, 'the work, described');
    expect(first.repeat).toBe(false);
    const again = finishAgent(worker.caller, 'the work, described slightly differently');
    expect(again.repeat).toBe(true);
    expect(again.report).toBeNull();
    expect(pendingCount(PRIME_ID)).toBe(1);
  });

  it('stops a finished worker sending anything more from its own chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).toThrow(AgentError);
  });

  it('is told so on its own next tool call, instead of quietly working on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    // The chat itself does not stop when the slot does — the turn is ChatGPT's — so the
    // next call from it has to be the sentence that says the work is over.
    const notice = endedWorkerNotice(worker.caller.conversationId);
    expect(notice).toMatch(/WORKER_ENDED/);
    expect(notice).toMatch(/worker-1/);
    expect(endedWorkerNotice('c-stranger')).toBeNull();
  });

  it('refuses to finish the prime, because a run with no prime is a reset', () => {
    startSwarm(1);
    expect(() => finishAgent(prime, 'I am done')).toThrow(/prime agent does not finish/);
  });
});

describe('a worker whose chat never opened', () => {
  it('ends as failed, frees its slot, and reports to the prime', () => {
    startSwarm(1);
    expect(failAgent('worker-1', 'no ChatGPT tab could be opened')?.report?.to).toBe(PRIME_ID);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(info?.state).toBe('failed');
    expect(info?.result).toContain('no ChatGPT tab');
    expect(pendingCount(PRIME_ID)).toBe(1);
    // The slot is free again: a replacement may be created inside the same limit.
    expect(() => spawn({ workers: [{ task: 'replacement' }], caller: prime })).not.toThrow();
  });

  it('stays failed when its chat was never the reason, so no stray tab can revive the slot', () => {
    startSwarm(1);
    startWorker('worker-1');
    failAgent('worker-1', 'tab never opened');
    // A verdict about the work is final. Only a worker given up on because its *view* went
    // away may be taken back, and this one was not.
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
  });

  it('refuses to fail the prime', () => {
    startSwarm(1);
    expect(failAgent(PRIME_ID, 'whatever')).toBeNull();
    expect(swarmRunning()).toBe(true);
  });
});

describe('a worker whose chat closed', () => {
  it('detaches the exact bound worker rather than ending it: the turn is not the tab', () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    // Still live, still holding its slot, still owed a result. A ChatGPT turn runs on
    // OpenAI's servers, so a closed tab says nothing about whether the work stopped.
    expect(info?.state).toBe('detached');
    // And the prime is told nothing yet, because there is nothing it could act on.
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('takes the detachment back the moment that chat calls again', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    workerConversationGone('c-worker-1');

    expect(noteAgentAlive('c-worker-1')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // It was never out of the run, so its own finish still lands the ordinary way.
    expect(finishAgent(worker.caller, 'done')?.info.state).toBe('finished');
  });

  it('never revives a detached worker after durable completion terminalises it', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // The stale-run recovery path can observe the durable turn completion after the browser
    // view is already gone. That terminal result must supersede the detached state's
    // revivable flag rather than carrying it into `finished`.
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('finished');
    const finished = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(finished?.revivable).toBe(false);

    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('ends a detached worker only once it has also gone quiet, and reports that to prime', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // Nothing has been heard from it since the tab went, so silence is the only ending left.
    expect(failSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS + 1_000).length).toBe(1);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(() => spawn({ workers: [{ task: 'replacement after close' }], caller: prime })).not.toThrow();

    // Even that failure is not a verdict about the work: a worker that was quiet for six
    // minutes and then calls again was, evidently, not finished.
    const back = noteAgentAlive('c-worker-1');
    expect(back?.revived).toBe(true);
    expect(back?.report?.to).toBe(PRIME_ID);
  });

  it('does nothing for the prime, a stranger, or an already finished worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(workerConversationGone(PRIME_CHAT)).toBe(false);
    expect(workerConversationGone('c-stranger')).toBe(false);
    finishAgent(worker.caller, 'done');
    expect(workerConversationGone('c-worker-1')).toBe(false);
  });
});

describe('clearing one agent from the app', () => {
  it('frees a worker slot without touching its siblings, and tells the prime a person did it', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const result = clearAgent('worker-1');
    expect(result.cleared).toBe('worker');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-2')?.state).not.toBe('failed');
    const report = offerMessages(PRIME_ID).map((message) => message.text).join('\n');
    expect(report).toMatch(/user/i);
  });

  it('ends the whole run when the prime is cleared', () => {
    startSwarm(1);
    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
  });

  it('does nothing, and says so, for an agent that has already ended or never existed', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(clearAgent('worker-1').cleared).toBe('none');
    expect(clearAgent('worker-9').cleared).toBe('none');
    resetAgentsForTests();
    expect(clearAgent('worker-1').cleared).toBe('none');
  });
});

describe('restart', () => {
  it('persists worker binding and activation as one state transition', () => {
    startSwarm(1);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => persisted.push(snapshotSwarm()));

    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    expect(persisted).toHaveLength(1);
    const worker = persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(worker?.conversationId).toBe('c-worker-1');
    expect(worker?.state).toBe('active');
  });

  it('repairs the legacy bound-but-invited crash snapshot instead of opening a duplicate worker chat', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    // This is the exact intermediate generation the old two-step activation could put on
    // disk if the process died between its two changed() calls.
    worker.conversationId = 'c-worker-1';
    worker.state = 'invited';
    worker.activatedAt = null;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
  });

  it('repairs a legacy finished snapshot that still says the worker is revivable', () => {
    startSwarm(1);
    startWorker('worker-1');
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    worker.state = 'finished';
    worker.finishedAt = Date.now();
    worker.result = 'already done';
    worker.revivable = true;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('re-keys a pre-UUID version-4 snapshot instead of restoring its 32-bit run incarnation', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    // Version 4 predates the full-UUID run fence. Those builds wrote only the first eight hex
    // characters but the snapshot version itself did not change, so an upgrade can genuinely
    // encounter this durable shape.
    snapshot.runId = 'deadbeef';

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(currentRunId()).not.toBe('deadbeef');
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Re-keying the recovered incarnation must not throw away the durable run itself. An
    // invited worker will simply be re-bootstrapped under the new fence.
    expect(swarmState().agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1']);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);
  });

  it('separates critical broker durability from delivery telemetry and drains exact snapshots on demand', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });

    startSwarm(1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.primeConversationId).toBe(PRIME_CHAT);

    sendMessage(prime, 'worker-1', 'critical queue mutation');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);

    // Offer/ACK timestamps are delivery telemetry. They still use the debounced persistence
    // callback, but they do not manufacture another critical disk barrier revision.
    offerMessages('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    acknowledgeOffers('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
  });

  it('does not mark a newer critical generation durable when it appears during an older immediate write', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
      if (persisted.length === 1) {
        firstStarted();
        await firstGate;
      }
    });

    startSwarm(1);
    const draining = persistCriticalSwarmNow();
    await firstWriteStarted;
    sendMessage(prime, 'worker-1', 'created while generation one is on disk');
    releaseFirst();

    expect(await draining).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
  });

  it('keeps an unpublished message out of a debounced disk write while its immediate acceptance write is held and failing', async () => {
    const stateName = 'message-atomicity-race';
    startSwarm(1);
    // Drain the run-creation revision through the normal test sink so the controlled
    // immediate writer below belongs only to the message being exercised.
    expect(await persistCriticalSwarmNow()).toBe(true);

    // Production wiring snapshots synchronously into the debounced lane whenever the broker
    // says it changed. The timer may reach disk while an independent immediate acceptance
    // barrier is still waiting, so this must be a *committed-only* snapshot.
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));

    let immediateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      immediateEntered = resolve;
    });
    let releaseImmediate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseImmediate = resolve;
    });
    let targetRenames = 0;
    const realRename = fs.rename.bind(fs);
    const renameFailure = Object.assign(new Error('injected immediate swarm rename failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${stateName}.json`)) {
        targetRenames += 1;
        // Rename #1 is the debounced writer fired while the barrier is held. Rename #2 is
        // the immediate acceptance generation, which fails and therefore remains pending.
        if (targetRenames === 2) throw renameFailure;
      }
      return realRename(from, to);
    });

    onSwarmPersistNow(async (snapshot) => {
      // The immediate lane is the *only* snapshot allowed to contain unpublished messages:
      // it is exactly the generation whose fsync decides whether this send was accepted.
      expect(snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
      immediateEntered();
      await held;
      await writeDurableNow(stateName, snapshot);
    });

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'do not publish before fsync' }]);
    const barrier = persistCriticalSwarmNow();
    await entered;

    // Force the ordinary debounce to disk *before* the acceptance barrier is released. A
    // crash here must recover the pre-send queue, because the sender has not been told the
    // message was accepted yet.
    await flushDurable();
    const whileHeld = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(whileHeld?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);

    releaseImmediate();
    await expect(barrier).rejects.toMatchObject({ code: 'EBUSY' });
    staged.rollback();

    // writeDurableNow keeps its failed generation pending for retry. Rollback must enqueue a
    // *newer* committed-only snapshot, so that failed staged generation can never win later.
    rename.mockRestore();
    await flushDurable();
    const afterRollback = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(afterRollback?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
  });

  it('publishes a staged worker topology only after its exact critical snapshot is durable', async () => {
    const ordinary: Array<ReturnType<typeof snapshotSwarm>> = [];
    const critical: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => ordinary.push(snapshotSwarm()));
    onSwarmPersistNow(async (snapshot) => {
      critical.push(snapshot);
    });

    const staged = stageSpawn({ workers: [{ task: 'inspect topology' }], caller: prime });

    // The broker reserves the one global run while acceptance is in flight, but nothing that
    // can publish/open workers is allowed to see the planned topology yet.
    expect(swarmRunning()).toBe(true);
    expect(swarmState()).toMatchObject({ running: false, agents: [] });
    expect(snapshotSwarm()).toBeNull();
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(ordinary.at(-1)).toBeNull();

    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(critical.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    staged.commit();

    expect(swarmState().running).toBe(true);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([{ id: 'worker-1', task: 'inspect topology' }]);
    expect(ordinary.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
  });

  it('rolls a staged addition back to the previously accepted run without leaking it to ordinary snapshots', () => {
    spawn({ workers: [{ task: 'accepted worker' }], caller: prime });
    const before = snapshotSwarm();

    const staged = stageSpawn({ workers: [{ task: 'second worker' }], caller: prime });
    expect(staged.created.map((entry) => entry.id)).toEqual(['worker-2']);
    expect(snapshotSwarm()?.agents.some((entry) => entry.info.id === 'worker-2')).toBe(false);
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);

    staged.rollback();
    expect(swarmState().agents.some((entry) => entry.id === 'worker-2')).toBe(false);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(before?.agents.map((entry) => entry.info.id));
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);
  });

  it('carries the run, its bindings and its in-flight messages through a snapshot', () => {
    let persists = 0;
    onSwarmPersist(() => {
      persists += 1;
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'keep going, but check the parser');
    offerMessages('worker-1');

    const snapshot = snapshotSwarm()!;
    expect(persists).toBeGreaterThan(0);
    // Nothing in a snapshot can authorise a call, because nothing in this app can: an agent
    // is the conversation it runs in, and that id is recorded on purpose.
    expect(JSON.stringify(snapshot)).not.toMatch(/key|secret|hash/i);

    resetAgentsForTests();
    expect(swarmRunning()).toBe(false);
    restoreSwarm(snapshot);

    expect(swarmRunning()).toBe(true);
    // The prime is still the same chat, and the worker is still in its own.
    expect(identify(prime).id).toBe(PRIME_ID);
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
    // An offer that was in flight when the app stopped is offered again, not lost.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual([
      'keep going, but check the parser'
    ]);
  });

  it('replays a queued worker spawn when the bridge registers after the restore', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);
    const spawned: string[] = [];
    onSpawnRequest((workers) => spawned.push(...workers.map((worker) => worker.id)));
    expect(spawned).toEqual(['worker-1', 'worker-2']);
  });

  it('repairs only the exact durable prime A→B recovery transition after transfer state was lost', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
    expect(identify({ conversationId: 'c-resumed' }).id).toBe(PRIME_ID);
    // Recovery replay is idempotent, but neither a different source nor an unrelated target
    // can use this hook as a takeover mechanism.
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(repairPrimeConversationAfterRecovery('c-other', 'c-hijack')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
  });

  it('refuses recovery repair when the durable target chat is already a worker identity', () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-resumed');
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe(PRIME_CHAT);
  });
});

describe('through the MCP endpoint', () => {
  let endpoint: Awaited<ReturnType<typeof startMcpServer>>;
  let nextId = 1;

  const post = (body: unknown, extraHeaders: Record<string, string> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const url = new URL(endpoint.url);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
            ...extraHeaders
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
            try {
              resolve(JSON.parse(frame));
            } catch {
              resolve({ raw: text });
            }
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

  let evidenceSeq = 0;

  const callTool = async (name: string, args: unknown): Promise<string> => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const agents = (action: string, args: Record<string, unknown> = {}): Promise<string> =>
    callTool('agents', { action, ...args });

  const agentsWithRequestId = async (
    requestId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const reply = await replyWithRequestId(requestId, action, args);
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const replyWithRequestId = (requestId: string, action: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'agents', arguments: { action, ...args } } },
      { 'x-request-id': `${requestId}/relay` }
    );

  /** The evidence dance of asChat, kept, but reading the machine half of the result. */
  const structuredAsChat = async (
    conversationId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = replyWithRequestId(requestId, action, args);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return (await pending).result?.structuredContent ?? {};
  };

  /**
   * Makes a call that ChatGPT's own message model names, from one conversation.
   *
   * This is the only identity anything has now, so it is the only way to make a control
   * call as somebody. The evidence is fed *while the request is in flight*, which is one of
   * the two ways it really arrives. The other is ahead of the call — ChatGPT paints the
   * connector row while it is still composing the request — and that one is covered
   * separately below, because assuming it could not happen is exactly what made every live
   * spawn impossible.
   */
  const asChat = async (conversationId: string, action: string, args: Record<string, unknown> = {}): Promise<string> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = agentsWithRequestId(requestId, action, args);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return pending;

  };

  beforeEach(async () => {
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'workspace', path: dir }],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: true
    }));
  });

  afterEach(async () => {
    await endpoint.stop();
  });

  // One flat tool with five actions. The names it replaced are gone outright, not aliased,
  // so a chat still holding the old instructions gets an honest unknown-tool error.
  it('publishes one agents tool with exactly five actions', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const names = (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('agents');
    for (const gone of [
      'agent_inbox',
      'agent_status',
      'create_agents',
      'finish_agent',
      'join_agent',
      'revive_agent',
      'send_agent_message'
    ]) {
      expect(names).not.toContain(gone);
    }

    const schema = (reply.result.tools as Array<{ name: string; inputSchema: any }>).find(
      (tool) => tool.name === 'agents'
    )!.inputSchema;
    expect(schema.properties.action.enum.slice().sort()).toEqual(['finish', 'investigate', 'message', 'spawn', 'status']);
    expect(schema.properties.task.type).toBe('string');
    expect(schema.properties.workdir.type).toBe('string');
    // Revive is gone from the wire as well as from the broker: no field survives for it.
    expect(Object.keys(schema.properties)).not.toContain('agent');
  });

  it('delegates broad read-only investigation through the approved workspace', async () => {
    let calls = 0;
    setAntigravityInvestigatorForTests(async ({ task, cwd }) => {
      calls += 1;
      expect(task).toMatch(/stale/i);
      expect(cwd).toBe(dir);
      return {
        report: 'Likely stale bridge state.',
        observedFiles: ['src/main/bridge.ts'],
        toolErrors: [],
        toolCalls: 4,
        conversationId: 'conv-fast',
        durationSeconds: 2.4,
        totalTokens: 700,
        partial: false,
        budgetExceeded: false
      };
    });

    const reply = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: {
        name: 'agents',
        arguments: {
          action: 'investigate',
          task: 'Trace why MCP state becomes stale across multiple files.',
          workdir: '/workspace'
        }
      }
    });
    expect(reply.result?.structuredContent).toMatchObject({
      action: 'investigate',
      provider: 'antigravity',
      delegated: true,
      model: 'gemini-3.7-flash-low',
      report: 'Likely stale bridge state.',
      observed_files: ['src/main/bridge.ts']
    });
    expect(calls).toBe(1);
  });

  it('declines trivial investigate work before workspace resolution or Antigravity launch', async () => {
    let calls = 0;
    setAntigravityInvestigatorForTests(async () => {
      calls += 1;
      throw new Error('should not launch');
    });
    const reply = await post({
      jsonrpc: '2.0', id: nextId++, method: 'tools/call',
      params: { name: 'agents', arguments: { action: 'investigate', task: 'Read the npm package name from package.json.' } }
    });
    expect(reply.result?.structuredContent).toMatchObject({ action: 'investigate', provider: 'antigravity', delegated: false });
    expect(calls).toBe(0);
  });

  it('declines mutation and final-verification investigate requests without Antigravity launch', async () => {
    let calls = 0;
    setAntigravityInvestigatorForTests(async () => {
      calls += 1;
      throw new Error('should not launch');
    });
    for (const task of ['Implement the fix across src/main.', 'Run final verification and deploy it.']) {
      const reply = await post({
        jsonrpc: '2.0', id: nextId++, method: 'tools/call',
        params: { name: 'agents', arguments: { action: 'investigate', task } }
      });
      expect(reply.result?.structuredContent).toMatchObject({ action: 'investigate', provider: 'antigravity', delegated: false });
    }
    expect(calls).toBe(0);
  });

  it('is identified by exact request-id evidence that arrived before the call it names', async () => {
    // Evidence may arrive before HTTP. The timestamp is irrelevant; the normalized request
    // id is the join, so a pre-existing exact mate remains authoritative.
    await recordChatObservations('c-ahead', [
      { kind: 'turn_start', time: Date.now() - 5_500, turnId: 't-ahead' },
      {
        kind: 'tool_evidence',
        time: Date.now() - 5_500,
        turnId: 't-ahead',
        calls: [{ messageId: 'm-ahead', tool: 'agents', order: 0, answered: false, requestId: 'wfr_agents_ahead' }]
      }
    ]);

    const text = await agentsWithRequestId('wfr_agents_ahead', 'spawn', { workers: [{ task: 'read the file' }] });

    expect(text).not.toContain('UNIDENTIFIED_CALLER');
    expect(swarmRunning()).toBe(true);
    expect(identify({ conversationId: 'c-ahead' }).id).toBe(PRIME_ID);
  });

  it('refuses a spawn whose conversation this app cannot prove, and creates nothing', async () => {
    const text = await agents('spawn', { workers: [{ task: 'anything' }] });
    expect(text).toMatch(/UNIDENTIFIED_CALLER|could not/i);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rolls back a spawn whose durable acceptance barrier fails instead of resurrecting it from the debounce', async () => {
    const stateName = 'spawn-atomicity-failure';
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));
    onSwarmPersistNow(async () => {
      throw new Error('injected spawn durability failure');
    });

    const failed = await asChat(PRIME_CHAT, 'spawn', { workers: [{ task: 'audit the parser' }] });
    expect(failed).toMatch(/durable acceptance barrier|durab|injected spawn durability failure/i);

    // A failed public operation must not keep an invisible run claim in memory. More
    // importantly, spawn() already fired the ordinary debounced persistence callback before
    // the immediate barrier ran; if that callback was allowed to see the staged topology, a
    // later restart would restore it and replay pendingWorkerSpawns(), opening a worker tab for
    // a spawn ChatGPT was explicitly told had failed.
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
    await flushDurable();
    expect(await readDurable(stateName)).toBeNull();
  });

  it('exposes no key field anywhere in the agents schema', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const tools = reply.result.tools as Array<{ name: string; inputSchema: any }>;
    // Not on agents, and — the part that used to be false — not on any other tool either.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('agent_key');
    }
    const agentsSchema = tools.find((tool) => tool.name === 'agents')!.inputSchema;
    // Not a key by any spelling: the recovery action that needed one is gone entirely.
    for (const field of Object.keys(agentsSchema.properties)) {
      expect(field).not.toMatch(/key|secret|token/i);
    }
    expect(JSON.stringify(agentsSchema)).not.toMatch(/join/i);
  });

  it('tells an unrelated chat AGENTS_BUSY and nothing whatsoever about the run', async () => {
    startSwarm(1);
    const text = await asChat('c-stranger', 'status');
    expect(text).toContain('AGENTS_BUSY');
    expect(text).not.toContain('worker-1');
    expect(text).not.toContain('task 1');
    expect(text).not.toContain(PRIME_CHAT);
  });

  it('refuses a control call it cannot place at all, and says where to look', async () => {
    startSwarm(1);
    // No page evidence: this call could have come from anywhere, so it is not treated as a
    // stranger and it is certainly not given a credential to carry instead.
    const text = await agents('status');
    expect(text).toContain('WORKER_IDENTITY_LOST');
    expect(text).toMatch(/extension/i);
    expect(text).not.toContain('worker-1');
  });

  it('uses the inbound HTTP request id instead of stealing a worker’s earlier agents evidence', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    const now = Date.now();

    // The worker has an unclaimed agents request visible first. Before the HTTP-id hardening,
    // callerNow() saw this while the prime page was one poll late and authenticated the prime
    // call as worker-1, producing the live "An agent cannot message itself" failure.
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: now, turnId: 'worker-stale' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'worker-stale',
        calls: [
          {
            messageId: 'worker-stale-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_worker_stale',
            createTime: now / 1000
          }
        ]
      }
    ]);

    const pending = agentsWithRequestId('wfr_prime_current', 'message', {
      to: 'worker-1',
      text: 'prime correction'
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now + 80, turnId: 'prime-current' },
      {
        kind: 'tool_evidence',
        time: now + 80,
        turnId: 'prime-current',
        calls: [
          {
            messageId: 'prime-current-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_prime_current',
            createTime: (now + 80) / 1000
          }
        ]
      }
    ]);

    const text = await pending;
    expect(text).toContain('Queued for worker-1');
    expect(text).not.toContain('cannot message itself');
    expect(pendingCount('worker-1')).toBe(1);
  });

  it('publishes no message when its durable acceptance barrier fails, and a retry queues exactly one', async () => {
    startSwarm(1);
    const snapshots: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => snapshots.push(snapshotSwarm()));
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected disk barrier failure');
      }
    });

    const failed = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(failed).toMatch(/durable acceptance barrier|nothing was queued/i);
    // The staged queue entry was never visible to the worker while the write was in flight,
    // and rollback removed it before the failed call returned.
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(snapshotSwarm()?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);
    // rollback is itself a critical mutation and therefore emits a newer safe snapshot. This
    // supersedes durable.ts's retained failed generation instead of letting it resurrect the
    // rejected message later.
    expect(snapshots.at(-1)?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);

    const retried = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(retried).toContain('Queued for worker-1');
    expect(pendingCount('worker-1')).toBe(1);
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['check the parser']);
  });

  it('publishes no worker finish or prime report when its durable acceptance barrier fails', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected finish durability failure');
      }
    });

    const failed = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(failed).toMatch(/durable acceptance barrier|nothing was published|finish durability failure/i);
    // Old finish mutated the worker and queued its report before awaiting the disk barrier, so
    // the worker became terminal and a concurrent prime call could consume a result whose own
    // caller was being told to retry. A failed acceptance must leave no live trace instead.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    const retried = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(retried).toMatch(/finished|done/i);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
  });

  it('carries a worker through message and finish on its conversation alone', async () => {
    startSwarm(1);
    // The extension reports the chat it opened, exactly as it does in production. That is
    // the whole of the worker's startup: no join, no key, nothing typed by the model.
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);

    const sent = await asChat('c-worker-1', 'message', { to: PRIME_ID, text: 'the parser is the problem' });
    expect(sent).toContain('Queued for prime');
    expect(pendingCount(PRIME_ID)).toBe(1);

    const finished = await asChat('c-worker-1', 'finish', { result: 'fixed the parser' });
    expect(finished).toMatch(/finished|done/i);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('does not tell the prime a worker missed a message that the finish call itself confirms', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'include the parser edge case in your final result');

    // This result offers the instruction. It stays pending until the worker's *next* exact
    // call, because that next call is the broker's evidence that this result reached ChatGPT.
    const offered = await asChat('c-worker-1', 'status');
    expect(offered).toContain('include the parser edge case');
    expect(pendingCount('worker-1')).toBe(1);

    // The next call happens to be finish. Kernel acknowledgement runs after the handler so the
    // old finish planner still saw the offered row as unacked and wrote a false warning into the
    // final report, even though this exact call immediately marks that same row delivered.
    await asChat('c-worker-1', 'finish', { result: 'parser edge case included' });
    expect(pendingCount('worker-1')).toBe(0);
    const report = offerMessages(PRIME_ID).find((message) => message.text.includes('[worker-1 finished]'));
    expect(report?.text).toContain('parser edge case included');
    expect(report?.text).not.toContain('ended without ever confirming');
  });

  it('cannot be spoofed by naming an agent in the arguments', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    const spoofed = await asChat('c-outsider', 'message', { agent: 'worker-1', to: PRIME_ID, text: 'spoof' });
    // The live schema now rejects the retired `agent` field before broker identity runs. That
    // is stronger than the old AGENTS_BUSY path: caller-controlled identity is not even a
    // syntactically valid request anymore. Keep the broker invariant below as the real outcome.
    expect(spoofed).toMatch(/input validation|unrecognized key|AGENTS_BUSY|unknown/i);
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('pushes waiting messages onto a worker result and acknowledges them on the next call', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    sendMessage(prime, 'worker-1', 'stop and check the parser first');
    const withMessage = await asChat('c-worker-1', 'status');
    expect(withMessage).toContain('stop and check the parser first');

    // The next placed call is what retires it, so a lost result is re-offered.
    const after = await asChat('c-worker-1', 'status');
    expect(after).not.toContain('stop and check the parser first');
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('keeps a terminal worker tombstone only for finish retry and re-offers the lost finish inbox', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'check the parser before you stop');

    // The message is first offered on the finish result. If that result is lost, another
    // finish call is not evidence that the worker saw it and must not ACK it.
    const first = await asChat('c-worker-1', 'finish', { result: 'done' });
    expect(first).toContain('check the parser before you stop');
    expect(pendingCount('worker-1')).toBe(1);

    const retry = await asChat('c-worker-1', 'finish', { result: 'done, retry after lost result' });
    expect(retry).toMatch(/already finished|already.*done/i);
    expect(retry).toContain('check the parser before you stop');
    expect(pendingCount('worker-1')).toBe(1);

    // The tombstone is not general membership. The same terminal chat still cannot use the
    // ordinary agents surface after it has finished.
    const status = await asChat('c-worker-1', 'status');
    expect(status).toMatch(/WORKER_ENDED|AGENTS_BUSY/);
  });

  it('enforces worker-to-worker refusal over the wire', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');
    const refused = await asChat('c-worker-1', 'message', { to: 'worker-2', text: 'psst' });
    expect(refused).toMatch(/prime/i);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('messages several workers in one call, on one identity resolution', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');

    const text = await asChat(PRIME_CHAT, 'message', {
      messages: [
        { to: 'worker-1', text: 'ignore the UI' },
        { to: 'worker-2', text: 'check the README too' }
      ]
    });

    expect(text).toContain('worker-1');
    expect(text).toContain('worker-2');
    expect(pendingCount('worker-1')).toBe(1);
    expect(pendingCount('worker-2')).toBe(1);
  });

  it('refuses a message call that spells the same operation both ways at once', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const text = await asChat(PRIME_CHAT, 'message', {
      to: 'worker-1',
      text: 'one way',
      messages: [{ to: 'worker-1', text: 'the other way' }]
    });

    expect(text).toMatch(/either to\+text or messages/i);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('carries the run and every agent in machine-readable form beside the prose', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const structured = await structuredAsChat(PRIME_CHAT, 'status');
    expect(structured.action).toBe('status');
    expect(structured.self).toBe(PRIME_ID);
    expect(structured.run_id).toBeTypeOf('string');
    const worker = (structured.agents as Array<Record<string, unknown>>).find((agent) => agent.id === 'worker-1');
    expect(worker).toMatchObject({ id: 'worker-1', role: 'worker', state: 'active' });
  });
});
