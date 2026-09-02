import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  PRIME_ID,
  bindConversation,
  resetAgentsForTests,
  restoreSwarm,
  snapshotSwarm,
  spawn
} = await import('../src/main/agents.js');
const { initDurableStore, readDurable, resetDurableForTests } = await import('../src/main/durable.js');
const {
  assignManagerForPrime,
  managerForCaller,
  resetManagerAuthorityForTests
} = await import('../src/main/orchestration/manager-authority.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'manager-prime-chat';
const prime = { conversationId: PRIME_CHAT };
let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-manager-authority-');
  initConfigPath(dir);
  initDurableStore(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 4 } });
});

beforeEach(async () => {
  resetAgentsForTests();
  await resetManagerAuthorityForTests();
});

afterAll(async () => {
  resetAgentsForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

function startRun(): { managerId: string; ordinaryId: string } {
  const result = spawn({
    workers: [
      { label: 'Coordinator candidate', task: 'Coordinate the run.' },
      { label: 'Worker', task: 'Implement one task.' }
    ],
    caller: prime
  });
  const [manager, ordinary] = result.created;
  if (!manager || !ordinary) throw new Error('expected two workers');
  return { managerId: manager.id, ordinaryId: ordinary.id };
}

describe('broker-anchored Agent System 3.0 Manager authority', () => {
  it('lets only the proven prime designate one worker, then binds authority to that worker conversation', async () => {
    const { managerId } = startRun();

    const assigned = await assignManagerForPrime(prime, managerId);
    expect(assigned.agentId).toBe(managerId);
    expect(assigned.runId).toMatch(/^[0-9a-f-]{36}$/i);

    // Prime may designate before the browser has finished binding the new worker tab.
    expect(bindConversation(managerId, 'manager-chat')).toBe(true);
    const resolved = await managerForCaller({ conversationId: 'manager-chat' });
    expect(resolved).toEqual(assigned);

    const durable = await readDurable<{
      version: number;
      entries: Array<Record<string, unknown>>;
    }>('manager-authority');
    expect(durable?.version).toBe(1);
    expect(durable?.entries).toEqual([
      expect.objectContaining({
        managerAgentId: managerId,
        managerConversationId: 'manager-chat',
        ownerPrimeConversationId: PRIME_CHAT,
        orchestrationRunId: assigned.runId
      })
    ]);
  });

  it('refuses the prime, ordinary workers, strangers, and unidentified callers as Manager callers', async () => {
    const { managerId, ordinaryId } = startRun();
    await assignManagerForPrime(prime, managerId);
    expect(bindConversation(managerId, 'manager-chat')).toBe(true);
    expect(bindConversation(ordinaryId, 'ordinary-chat')).toBe(true);

    await expect(managerForCaller(prime)).rejects.toThrow(/manager/i);
    await expect(managerForCaller({ conversationId: 'ordinary-chat' })).rejects.toThrow(/manager/i);
    await expect(managerForCaller({ conversationId: 'stranger-chat' })).rejects.toThrow(/manager|busy/i);
    await expect(managerForCaller({})).rejects.toThrow(/identity|conversation|manager/i);
    expect(PRIME_ID).toBe('prime');
  });

  it('survives broker snapshot restore after the Manager conversation has been durably claimed', async () => {
    const { managerId } = startRun();
    const assigned = await assignManagerForPrime(prime, managerId);
    expect(bindConversation(managerId, 'manager-chat')).toBe(true);
    expect(await managerForCaller({ conversationId: 'manager-chat' })).toEqual(assigned);

    // Recovery must restore the broker membership that actually existed at the durable
    // Manager claim boundary. A pre-bind snapshot would correctly know nothing about this chat.
    const snapshot = snapshotSwarm();
    if (!snapshot) throw new Error('expected a durable swarm snapshot after Manager binding');
    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(await managerForCaller({ conversationId: 'manager-chat' })).toEqual(assigned);
  });

  it('does not let the same Prime silently replace an already-designated Manager', async () => {
    const { managerId, ordinaryId } = startRun();
    const first = await assignManagerForPrime(prime, managerId);
    const before = await readDurable('manager-authority');

    await expect(assignManagerForPrime(prime, ordinaryId)).rejects.toThrow(/manager.*already|already.*manager/i);

    expect(await readDurable('manager-authority')).toEqual(before);
    expect((await assignManagerForPrime(prime, managerId)).runId).toBe(first.runId);
  });
});
