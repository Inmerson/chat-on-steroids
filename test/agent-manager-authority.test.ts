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
  managerForCaller,
  resetAgentsForTests,
  restoreSwarm,
  snapshotSwarm,
  spawn,
  swarmRunning
} = await import('../src/main/agents.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'manager-prime-chat';
let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-manager-authority-');
  initConfigPath(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 4 } });
});

beforeEach(() => {
  resetAgentsForTests();
});

afterAll(async () => {
  resetAgentsForTests();
  await removeTempDir(dir);
});

function startManagerRun(): { runId: string; managerId: string; ordinaryId: string } {
  const result = spawn({
    workers: [
      { label: 'Manager', task: 'Coordinate the run.', manager: true },
      { label: 'Worker', task: 'Implement one task.' }
    ],
    caller: { conversationId: PRIME_CHAT }
  });
  const [manager, ordinary] = result.created;
  if (!manager || !ordinary) throw new Error('expected two workers');
  expect(bindConversation(manager.id, 'manager-chat')).toBe(true);
  expect(bindConversation(ordinary.id, 'ordinary-chat')).toBe(true);
  return { runId: result.runId, managerId: manager.id, ordinaryId: ordinary.id };
}

describe('broker-owned Agent System 3.0 Manager authority', () => {
  it('designates exactly one spawned worker as Manager and resolves authority from its bound conversation', () => {
    const { runId, managerId } = startManagerRun();

    expect(managerForCaller({ conversationId: 'manager-chat' })).toEqual({ runId, agentId: managerId });
  });

  it('refuses the prime and ordinary workers as Manager callers', () => {
    startManagerRun();

    expect(() => managerForCaller({ conversationId: PRIME_CHAT })).toThrow(/manager/i);
    expect(() => managerForCaller({ conversationId: 'ordinary-chat' })).toThrow(/manager/i);
    expect(() => managerForCaller({})).toThrow(/identity|conversation|manager/i);
    expect(PRIME_ID).toBe('prime');
  });

  it('persists and restores the Manager designation without re-inferring it', () => {
    const { runId, managerId } = startManagerRun();
    const snapshot = snapshotSwarm();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(6);
    expect(snapshot?.managerAgentId).toBe(managerId);

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(managerForCaller({ conversationId: 'manager-chat' })).toEqual({ runId, agentId: managerId });
    expect(() => managerForCaller({ conversationId: 'ordinary-chat' })).toThrow(/manager/i);
  });

  it('rejects two Manager designations before publishing any run topology', () => {
    expect(() =>
      spawn({
        workers: [
          { label: 'Manager A', task: 'Coordinate A.', manager: true },
          { label: 'Manager B', task: 'Coordinate B.', manager: true }
        ],
        caller: { conversationId: PRIME_CHAT }
      })
    ).toThrow(/one manager|manager.*one|multiple manager/i);

    expect(swarmRunning()).toBe(false);
    expect(snapshotSwarm()).toBeNull();
  });
});
