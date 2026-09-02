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
const { bindConversation, resetAgentsForTests, spawn } = await import('../src/main/agents.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { assignManagerForPrime, resetManagerAuthorityForTests } = await import(
  '../src/main/orchestration/manager-authority.js'
);
const { acceptManagerPlanForCaller } = await import('../src/main/orchestration/manager-surface.js');
const { recoverOrchestrationState } = await import('../src/main/orchestration/recovery.js');
const { readOrchestrationEvents, resetOrchestrationStoreForTests } = await import(
  '../src/main/orchestration/store.js'
);
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'surface-prime-chat';
const MANAGER_CHAT = 'surface-manager-chat';
const WORKER_CHAT = 'surface-worker-chat';
const prime = { conversationId: PRIME_CHAT };
let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-manager-surface-');
  initConfigPath(dir);
  initDurableStore(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 4 } });
});

beforeEach(async () => {
  resetAgentsForTests();
  resetOrchestrationStoreForTests();
  initDurableStore(dir);
  await resetManagerAuthorityForTests();
});

afterAll(async () => {
  resetAgentsForTests();
  resetOrchestrationStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

function oneTask() {
  return [
    {
      taskId: 'T1',
      parentTaskId: null,
      title: 'Build the first unit',
      goal: 'Produce one verified unit of work.',
      allowedScope: ['src/feature.ts'],
      dependencies: [],
      acceptanceCriteria: ['The unit is complete.'],
      expectedVerification: ['Run the focused test.'],
      forbiddenActions: ['Do not deploy.'],
      riskClass: 'normal' as const
    }
  ];
}

async function startDesignatedManager() {
  const spawned = spawn({
    workers: [
      { label: 'Manager candidate', task: 'Coordinate the run.' },
      { label: 'Worker', task: 'Implement one task.' }
    ],
    caller: prime
  });
  const [manager, ordinary] = spawned.created;
  if (!manager || !ordinary) throw new Error('expected Manager candidate and worker');

  const authority = await assignManagerForPrime(prime, manager.id);
  expect(bindConversation(manager.id, MANAGER_CHAT)).toBe(true);
  expect(bindConversation(ordinary.id, WORKER_CHAT)).toBe(true);
  return { authority, manager, ordinary };
}

describe('Agent System 3.0 Manager orchestration surface', () => {
  it('derives orchestration run and Manager identity from the proven broker caller', async () => {
    const { authority } = await startDesignatedManager();

    const accepted = await acceptManagerPlanForCaller(
      { conversationId: MANAGER_CHAT },
      { planId: 'plan-1', tasks: oneTask() }
    );

    expect(accepted).toMatchObject({
      runId: authority.runId,
      managerAgentId: authority.agentId,
      repeated: false,
      readyTaskIds: ['T1']
    });

    const recovered = await recoverOrchestrationState();
    expect(recovered.state.runId).toBe(authority.runId);
    expect(recovered.state.managerAgentId).toBe(authority.agentId);
    expect(recovered.state.managerPlanId).toBe('plan-1');
  });

  it('refuses Prime and ordinary-worker callers before writing orchestration events', async () => {
    await startDesignatedManager();

    await expect(
      acceptManagerPlanForCaller(prime, { planId: 'prime-forged-plan', tasks: oneTask() })
    ).rejects.toThrow(/manager/i);
    await expect(
      acceptManagerPlanForCaller(
        { conversationId: WORKER_CHAT },
        { planId: 'worker-forged-plan', tasks: oneTask() }
      )
    ).rejects.toThrow(/manager/i);

    await expect(readOrchestrationEvents()).resolves.toEqual([]);
  });
});
