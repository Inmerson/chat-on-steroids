/**
 * Multi-agent identity, topology and delivery.
 *
 * Agent ids are labels, never authentication. A caller is identified by an MCP
 * transport binding when one exists, otherwise by the capability it was issued when it
 * became prime / joined as a worker. Messages are at-least-once: a result offers them,
 * and the next authenticated call is what acknowledges the previous offer.
 */

import http from 'node:http';
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
  AgentError,
  PRIME_ID,
  acknowledgeOffers,
  agentForConversation,
  bindConversation,
  claimFiles,
  createAgents,
  finishAgent,
  identify,
  joinAgent,
  mintPrimeHandover,
  mintWorkerJoinKey,
  offerMessages,
  onSpawnRequest,
  onSwarmPersist,
  pendingCount,
  resetAgentsForTests,
  restoreSwarm,
  sendMessage,
  snapshotSwarm,
  swarmRunning,
  swarmState
} = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { flushDurable, initDurableStore, readDurable, writeDurableSoon } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
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
});

interface StartedSwarm {
  primeKey: string;
  spawned: Array<{ id: string; task: string }>;
}

/** Prime + n invited workers, without actually opening browser tabs. */
function startSwarm(count = 2, caller: { transportKey?: string | null; secret?: string | null } = {}): StartedSwarm {
  const spawned: Array<{ id: string; task: string }> = [];
  onSpawnRequest((workers) => spawned.push(...workers));
  const result = createAgents({
    workers: Array.from({ length: count }, (_, i) => ({ label: `Worker ${i + 1}`, task: `task ${i + 1}` })),
    caller
  });
  expect(result.primeSecret).toBeTruthy();
  return { primeKey: result.primeSecret!, spawned };
}

function joinWorker(id: string, transportKey?: string): string {
  const joinKey = mintWorkerJoinKey(id);
  expect(joinKey).toBeTruthy();
  return joinAgent(joinKey!, transportKey ? { transportKey } : {}).secret;
}

const key = (secret: string) => ({ secret });

// ---------------------------------------------------------------- creation

describe('creating agents', () => {
  it('refuses the feature while it is switched off', async () => {
    await setEnabled(false);
    try {
      expect(() => createAgents({ workers: [{ task: 'anything' }], caller: {} })).toThrow(AgentError);
      expect(swarmState().enabled).toBe(false);
    } finally {
      await setEnabled(true);
    }
  });

  it('establishes a prime and creates invited workers without exposing credentials in state', () => {
    const { primeKey, spawned } = startSwarm(2);
    expect(spawned.map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    expect(spawned[0]!.task).toBe('task 1');

    const state = swarmState();
    expect(state.agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1', 'worker-2']);
    expect(state.agents[0]!.role).toBe('prime');
    expect(state.agents[1]!.state).toBe('invited');
    expect(state.running).toBe(true);
    expect(JSON.stringify(state)).not.toContain(primeKey);
    expect(JSON.stringify(snapshotSwarm())).not.toContain(primeKey);
  });

  it('enforces the configured live-worker limit and validates tasks', async () => {
    await setEnabled(true, 2);
    try {
      const { primeKey } = startSwarm(2);
      expect(() => createAgents({ workers: [{ task: 'one too many' }], caller: key(primeKey) })).toThrow(
        /limit set in the app is 2/
      );
    } finally {
      resetAgentsForTests();
      await setEnabled(true, 3);
    }
    expect(() => createAgents({ workers: [], caller: {} })).toThrow(/At least one worker/);
    expect(() => createAgents({ workers: [{ task: '   ' }], caller: {} })).toThrow(/no task/);
  });

  it('allows only the authenticated prime to recruit more workers', () => {
    const { primeKey } = startSwarm(1);
    const workerKey = joinWorker('worker-1');

    expect(() => createAgents({ workers: [{ task: 'worker tries to recruit' }], caller: key(workerKey) })).toThrow(
      /Only the prime agent/
    );
    expect(() => createAgents({ workers: [{ task: 'anonymous tries to recruit' }], caller: {} })).toThrow(
      /Only the prime agent/
    );
    expect(createAgents({ workers: [{ task: 'legitimate second worker' }], caller: key(primeKey) }).created).toHaveLength(1);
  });
});

// --------------------------------------------------------------- identity

describe('capability identity and spoof prevention', () => {
  it('recognises only an issued capability, not an agent id-shaped claim', () => {
    const { primeKey } = startSwarm(1);
    const workerKey = joinWorker('worker-1');

    expect(identify(key(primeKey)).id).toBe(PRIME_ID);
    expect(identify(key(workerKey)).id).toBe('worker-1');
    expect(() => identify({ secret: 'worker-1' })).toThrow(/not registered|not valid/);
    expect(() => identify({})).toThrow(/not registered|not valid/);
  });

  it('rejects a capability that conflicts with the bound transport identity', () => {
    const { primeKey } = startSwarm(1, { transportKey: 'transport-prime' });
    const workerKey = joinWorker('worker-1', 'transport-worker');

    expect(identify({ transportKey: 'transport-prime' }).id).toBe(PRIME_ID);
    expect(identify({ transportKey: 'transport-worker' }).id).toBe('worker-1');
    expect(() => identify({ transportKey: 'transport-prime', secret: workerKey })).toThrow(/not registered|not valid/);
    expect(() => identify({ transportKey: 'transport-worker', secret: primeKey })).toThrow(/not registered|not valid/);
  });

  it('keeps two concurrent workers isolated by both capability and conversation', () => {
    const { primeKey } = startSwarm(2);
    const worker1 = joinWorker('worker-1');
    const worker2 = joinWorker('worker-2');
    bindConversation('worker-1', 'conv-worker-1');
    bindConversation('worker-2', 'conv-worker-2');

    sendMessage(key(primeKey), 'worker-1', 'only for one');
    sendMessage(key(primeKey), 'worker-2', 'only for two');

    expect(identify(key(worker1)).id).toBe('worker-1');
    expect(identify(key(worker2)).id).toBe('worker-2');
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['only for one']);
    expect(offerMessages('worker-2').map((message) => message.text)).toEqual(['only for two']);
    expect(agentForConversation('conv-worker-1')).toBe('worker-1');
    expect(agentForConversation('conv-worker-2')).toBe('worker-2');
  });
});

// ---------------------------------------------------------------- routing

describe('star topology', () => {
  let primeKey: string;
  let worker1: string;
  let worker2: string;

  beforeEach(() => {
    ({ primeKey } = startSwarm(2));
    worker1 = joinWorker('worker-1');
    worker2 = joinWorker('worker-2');
  });

  it('allows worker → prime and prime → worker', () => {
    expect(sendMessage(key(worker1), PRIME_ID, 'parser done').to).toBe(PRIME_ID);
    expect(sendMessage(key(primeKey), 'worker-2', 'use the new schema').to).toBe('worker-2');
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(pendingCount('worker-2')).toBe(1);
  });

  it('forbids worker → worker in both directions', () => {
    expect(() => sendMessage(key(worker1), 'worker-2', 'lets agree privately')).toThrow(
      /only message the prime agent/
    );
    expect(() => sendMessage(key(worker2), 'worker-1', 'agreed')).toThrow(/only message the prime agent/);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('refuses self-messages, unknown recipients, empty text and finished recipients', () => {
    expect(() => sendMessage(key(worker1), 'worker-1', 'self')).toThrow(/cannot message itself/);
    expect(() => sendMessage(key(worker1), 'worker-9', 'hello')).toThrow(/Unknown agent/);
    expect(() => sendMessage(key(worker1), PRIME_ID, '   ')).toThrow(/empty/);
    expect(() => sendMessage(key(worker1), PRIME_ID, 'x'.repeat(5000))).toThrow(/too long/);
    finishAgent(key(worker2), 'done');
    expect(() => sendMessage(key(primeKey), 'worker-2', 'one more thing')).toThrow(/no longer listening/);
  });

  it('reports file-claim clashes without pretending to lock files', () => {
    expect(claimFiles('worker-1', ['/p/src/store.ts'])).toEqual([]);
    expect(claimFiles('worker-2', ['/p/src/store.ts', '/p/src/other.ts'])).toEqual([
      '/p/src/store.ts (also claimed by worker-1)'
    ]);
  });
});

// --------------------------------------------------------------- delivery

describe('at-least-once delivery', () => {
  it('re-offers an unacknowledged message and retires it only on the next call', () => {
    const { primeKey } = startSwarm(1);
    joinWorker('worker-1');
    sendMessage(key(primeKey), 'worker-1', 'do not lose this');

    const first = offerMessages('worker-1');
    expect(first).toHaveLength(1);
    expect(first[0]!.offers).toBe(1);
    expect(pendingCount('worker-1')).toBe(1);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.awaitingAck).toBe(1);

    const repeat = offerMessages('worker-1');
    expect(repeat[0]!.id).toBe(first[0]!.id);
    expect(repeat[0]!.offers).toBe(2);
    expect(pendingCount('worker-1')).toBe(1);

    const acked = acknowledgeOffers('worker-1');
    expect(acked.map((message) => message.id)).toEqual([first[0]!.id]);
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.delivered).toBe(1);
  });

  it('survives a disconnect/restart with an offered message still deliverable', () => {
    const { primeKey } = startSwarm(1);
    const workerKey = joinWorker('worker-1');
    sendMessage(key(primeKey), 'worker-1', 'survive the restart');
    const first = offerMessages('worker-1')[0]!;
    expect(first.offers).toBe(1);

    const snapshot = snapshotSwarm();
    expect(snapshot).not.toBeNull();
    resetAgentsForTests();
    restoreSwarm(snapshot);

    // Authentication survives by hash; transport bindings deliberately do not.
    expect(identify(key(primeKey)).id).toBe(PRIME_ID);
    expect(identify(key(workerKey)).id).toBe('worker-1');
    const afterRestart = offerMessages('worker-1')[0]!;
    expect(afterRestart.id).toBe(first.id);
    expect(afterRestart.offers).toBe(2);
    expect(afterRestart.offeredAt).not.toBeNull();
  });

  it('refuses queue overflow instead of silently dropping an older message', () => {
    const { primeKey } = startSwarm(1);
    for (let i = 0; i < 200; i++) sendMessage(key(primeKey), 'worker-1', `message ${i}`);
    expect(pendingCount('worker-1')).toBe(200);
    expect(() => sendMessage(key(primeKey), 'worker-1', 'message 200')).toThrow(/QUEUE_FULL/);
    expect(pendingCount('worker-1')).toBe(200);
    const offered = offerMessages('worker-1');
    expect(offered).toHaveLength(200);
    expect(offered[0]!.text).toBe('message 0');
    expect(offered.at(-1)!.text).toBe('message 199');
  });

  it('queues a worker final report for the prime and ends the run when all workers finish', () => {
    startSwarm(1);
    const workerKey = joinWorker('worker-1');
    const finished = finishAgent(key(workerKey), 'wrote the parser, tests pass');
    expect(finished.report?.text).toContain('[worker-1 finished]');
    expect(offerMessages(PRIME_ID)[0]!.text).toContain('wrote the parser');
    expect(swarmRunning()).toBe(false);
  });
});

// ------------------------------------------------------------- persistence

describe('restart and handover persistence', () => {
  it('persists swarm identity and in-flight messages through the durable store callback', async () => {
    writeDurableSoon('swarm-test', null);
    await flushDurable();
    onSwarmPersist(() => writeDurableSoon('swarm-test', snapshotSwarm()));

    const { primeKey } = startSwarm(1);
    const workerKey = joinWorker('worker-1');
    sendMessage(key(primeKey), 'worker-1', 'survive a real durable-store restart');
    offerMessages('worker-1');
    await flushDurable();

    const saved = await readDurable<ReturnType<typeof snapshotSwarm>>('swarm-test');
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).not.toContain(primeKey);
    expect(JSON.stringify(saved)).not.toContain(workerKey);

    resetAgentsForTests();
    restoreSwarm(saved);
    expect(identify(key(primeKey)).id).toBe(PRIME_ID);
    expect(identify(key(workerKey)).id).toBe('worker-1');
    expect(offerMessages('worker-1')[0]!.text).toBe('survive a real durable-store restart');
  });

  it('replays an invited worker spawn when the bridge registers after restore', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(snapshot);

    const replayed: Array<{ id: string; task: string }> = [];
    onSpawnRequest((workers) => replayed.push(...workers));
    expect(replayed).toEqual([{ id: 'worker-1', task: 'task 1' }]);
  });

  it('rebinds prime after Compact & Resume while workers and their credentials survive', () => {
    const { primeKey } = startSwarm(1);
    const workerKey = joinWorker('worker-1');
    const handover = mintPrimeHandover();
    expect(handover).toBeTruthy();

    const resumedPrime = joinAgent(handover!).secret;
    expect(identify(key(resumedPrime)).id).toBe(PRIME_ID);
    expect(() => identify(key(primeKey))).toThrow(/not registered|not valid/);
    expect(identify(key(workerKey)).id).toBe('worker-1');

    sendMessage(key(workerKey), PRIME_ID, 'worker survived the prime move');
    expect(offerMessages(PRIME_ID)[0]!.text).toContain('survived the prime move');
  });
});

// ------------------------------------------------------- through the server

describe('through the MCP endpoint', () => {
  let endpoint: Awaited<ReturnType<typeof startMcpServer>>;
  let nextId = 1;

  const post = (body: unknown): Promise<any> =>
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
            'content-length': Buffer.byteLength(payload)
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

  const callTool = async (name: string, args: unknown): Promise<string> => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  beforeEach(async () => {
    endpoint = await startMcpServer(() => ({
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: true
    }));
  });

  afterEach(async () => {
    await endpoint.stop();
  });

  it('registers exactly the six agent tools', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const names = (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names.filter((name) => name.includes('agent')).sort()).toEqual([
      'agent_inbox',
      'agent_status',
      'create_agents',
      'finish_agent',
      'join_agent',
      'send_agent_message'
    ]);
    expect(names).not.toContain('resume_session');
  });

  it('requires capability authentication over MCP and cannot be spoofed with an agent id field', async () => {
    startSwarm(1);
    const joinKey = mintWorkerJoinKey('worker-1')!;
    const joined = await callTool('join_agent', { joinKey });
    const workerKey = /Your agent key is: ([A-Za-z0-9_-]+)/.exec(joined)?.[1];
    expect(workerKey).toBeTruthy();

    const spoofed = await callTool('send_agent_message', { agent: 'worker-1', to: PRIME_ID, text: 'spoof' });
    expect(spoofed).toMatch(/not registered|not valid/);
    expect(pendingCount(PRIME_ID)).toBe(0);

    const authentic = await callTool('send_agent_message', {
      agent_key: workerKey,
      to: PRIME_ID,
      text: 'authenticated progress'
    });
    expect(authentic).toContain('Sent to prime');
    expect(pendingCount(PRIME_ID)).toBe(1);
  });

  it('pushes inbox messages on ordinary authenticated calls and acks them on the following call', async () => {
    const { primeKey } = startSwarm(1);
    const joinKey = mintWorkerJoinKey('worker-1')!;
    const joined = await callTool('join_agent', { joinKey });
    const workerKey = /Your agent key is: ([A-Za-z0-9_-]+)/.exec(joined)?.[1];
    expect(workerKey).toBeTruthy();

    sendMessage(key(primeKey), 'worker-1', 'the API changed, use v2');
    const first = await callTool('agent_status', { agent_key: workerKey });
    expect(first).toContain('the API changed, use v2');
    expect(pendingCount('worker-1')).toBe(1);

    const second = await callTool('agent_status', { agent_key: workerKey });
    expect(second).not.toContain('the API changed, use v2');
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('enforces worker-to-worker refusal over the wire even with a valid worker capability', async () => {
    startSwarm(2);
    const joinKey = mintWorkerJoinKey('worker-1')!;
    const joined = await callTool('join_agent', { joinKey });
    const workerKey = /Your agent key is: ([A-Za-z0-9_-]+)/.exec(joined)?.[1];
    const text = await callTool('send_agent_message', {
      agent_key: workerKey,
      to: 'worker-2',
      text: 'private side channel'
    });
    expect(text).toContain('Workers may only message the prime agent');
    expect(pendingCount('worker-2')).toBe(0);
  });
});
