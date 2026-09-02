import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_TASK_CHARS } from '../src/main/agents.js';
import { acceptInitialManagerPlan } from '../src/main/orchestration/manager-plan.js';
import { EMPTY_ORCHESTRATION_STATE, type OrchestrationState } from '../src/main/orchestration/reducer.js';
import {
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests
} from '../src/main/orchestration/store.js';
import { formatTaskContract } from '../src/main/orchestration/task-contract.js';
import { selectWorkerAllocation } from '../src/main/orchestration/worker-allocation.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';
import type { AgentInfo } from '../src/shared/session.js';

const cleanup: string[] = [];
afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function task(taskId = 'T1', state: TaskRecord['state'] = 'READY', workerId: string | null = null): TaskRecord {
  return {
    taskId,
    parentTaskId: null,
    title: 'Parser',
    goal: 'Implement parser support.',
    allowedScope: ['src/parser/**'],
    dependencies: [],
    acceptanceCriteria: ['Parser tests pass'],
    expectedVerification: ['npm test -- test/parser.test.ts'],
    forbiddenActions: ['push', 'deploy'],
    state,
    assignedWorkerId: workerId,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 2,
    riskClass: 'normal',
    completionPackage: null
  };
}

function worker(id: string, options: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    role: 'worker',
    label: id,
    task: 'old work',
    state: 'sleeping',
    createdAt: 100,
    activatedAt: 110,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: `chat-${id}`,
    detachedAt: null,
    lastSeenAt: 200,
    revivable: true,
    sleptAt: 300,
    contextTokens: 1000,
    ...options
  };
}

function stateWith(tasks: TaskRecord[]): OrchestrationState {
  return {
    ...EMPTY_ORCHESTRATION_STATE,
    runId: 'run-1',
    managerAgentId: 'worker-1',
    tasks: Object.fromEntries(tasks.map((entry) => [entry.taskId, entry]))
  };
}

describe('V3 Task Contracts and worker allocation', () => {
  it('formats one bounded contract carrying the stable assignment id and every task boundary', () => {
    const text = formatTaskContract(task(), '11111111-1111-4111-8111-111111111111');
    expect(text).toContain('AS3-Assignment: 11111111-1111-4111-8111-111111111111');
    expect(text).toContain('Task: T1');
    expect(text).toContain('Allowed scope:');
    expect(text).toContain('Acceptance criteria:');
    expect(text).toContain('Expected verification:');
    expect(text).toContain('Forbidden actions:');
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
  });

  it('rejects a Manager task whose complete worker contract cannot fit the broker limit before journal mutation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-as3-contract-'));
    cleanup.push(dir);
    initOrchestrationStore(dir);
    const largeCriteria = Array.from({ length: 20 }, (_, index) => `${index}: ${'criterion '.repeat(35)}`);

    await expect(
      acceptInitialManagerPlan({
        planId: 'plan-large',
        runId: 'run-large',
        managerAgentId: 'worker-1',
        tasks: [{
          taskId: 'T1',
          parentTaskId: null,
          title: 'Large but individually bounded task',
          goal: 'Prove the whole Task Contract is bounded.',
          allowedScope: ['src/**'],
          dependencies: [],
          acceptanceCriteria: largeCriteria,
          expectedVerification: ['npm test'],
          forbiddenActions: ['push', 'deploy'],
          riskClass: 'normal'
        }]
      })
    ).rejects.toThrow(/contract.*large|too large/i);
    expect(await readOrchestrationEvents()).toEqual([]);
  });

  it('reuses the most recently sleeping eligible worker before spawning', () => {
    const decision = selectWorkerAllocation({
      task: task('T2'),
      state: stateWith([task('T1', 'VERIFIED', 'worker-2')]),
      brokerWorkers: [
        worker('worker-2', { sleptAt: 300, lastSeenAt: 250 }),
        worker('worker-3', { sleptAt: 500, lastSeenAt: 450 })
      ],
      managerAgentId: 'worker-1'
    });
    expect(decision).toMatchObject({ strategy: 'reuse', workerId: 'worker-3', conversationId: 'chat-worker-3' });
  });

  it('does not reuse the Manager or a sleeper that still owns a nonterminal task', () => {
    const decision = selectWorkerAllocation({
      task: task('T3'),
      state: stateWith([
        task('T1', 'VERIFIED', 'worker-3'),
        task('T2', 'APPROVED', 'worker-2')
      ]),
      brokerWorkers: [
        worker('worker-1', { sleptAt: 900 }),
        worker('worker-2', { sleptAt: 800 }),
        worker('worker-3', { sleptAt: 100 })
      ],
      managerAgentId: 'worker-1'
    });
    expect(decision).toMatchObject({ strategy: 'reuse', workerId: 'worker-3' });
  });

  it('returns spawn when no eligible sleeper exists', () => {
    const decision = selectWorkerAllocation({
      task: task('T2'),
      state: stateWith([task('T1', 'INTEGRATED', 'worker-2')]),
      brokerWorkers: [worker('worker-1'), worker('worker-2'), worker('worker-3', { revivable: false })],
      managerAgentId: 'worker-1'
    });
    expect(decision).toEqual({ strategy: 'spawn', workerId: null, conversationId: null });
  });
});
