import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acceptInitialManagerPlan } from '../src/main/orchestration/manager-plan.js';
import { recoverOrchestrationState } from '../src/main/orchestration/recovery.js';
import {
  appendOrchestrationEvent,
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests,
  writeOrchestrationSnapshot
} from '../src/main/orchestration/store.js';
import {
  runSchedulerCycleForRuntime,
  type SchedulerDependencies,
  type SchedulerRuntime
} from '../src/main/orchestration/scheduler.js';
import type { TaskRecord, TaskWorktreeRecord } from '../src/main/orchestration/types.js';

const cleanup: string[] = [];
const runtime: SchedulerRuntime = {
  runId: 'run-scheduler',
  managerAgentId: 'worker-1',
  ownerPrimeConversationId: 'prime-chat'
};

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-as3-scheduler-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
}

function planTask(taskId: string, dependencies: string[] = []) {
  return {
    taskId,
    parentTaskId: null,
    title: taskId,
    goal: `Implement ${taskId}`,
    allowedScope: [`src/${taskId.toLowerCase()}/**`],
    dependencies,
    acceptanceCriteria: [`${taskId} works`],
    expectedVerification: ['npm test'],
    forbiddenActions: ['push', 'deploy'],
    riskClass: 'normal' as const
  };
}

function fakeWorktree(task: TaskRecord): TaskWorktreeRecord {
  return {
    worktreeId: `wt-${task.taskId}`,
    taskId: task.taskId,
    branch: `as3/run/${task.taskId}`,
    baseRevision: 'a'.repeat(40),
    realPath: `/tmp/${task.taskId}`,
    virtualPath: `/project/${task.taskId}`
  };
}

function deps(options: { capacity?: number; persist?: boolean } = {}): SchedulerDependencies {
  let capacity = options.capacity ?? 8;
  let workerNo = 2;
  const published: string[] = [];
  return {
    primeWorkspaceForOwner: () => ({ virtual: '/project/repo', real: '/tmp/repo', at: 1 }),
    ensureWorktree: async (context) => {
      const worktree = fakeWorktree(context.task);
      const op = `wt-op-${context.task.taskId}`;
      await appendOrchestrationEvent({
        eventId: `${op}:intent`, runId: runtime.runId, time: 1, type: 'TASK_WORKTREE_INTENT', actor: 'kernel', entityId: context.task.taskId,
        payload: { intent: { ...worktree, operationId: op } }
      });
      await appendOrchestrationEvent({
        eventId: `${op}:ready`, runId: runtime.runId, time: 2, type: 'TASK_WORKTREE_READY', actor: 'kernel', entityId: context.task.taskId,
        payload: { operationId: op, worktree }
      });
      return worktree;
    },
    brokerWorkers: () => [],
    freeBrokerSlots: () => capacity,
    assignmentEvidence: () => null,
    stageSpawn: (_owner, _task, _contract) => {
      const workerId = `worker-${workerNo++}`;
      let settled = false;
      return {
        workerId,
        conversationId: null,
        commit: () => { settled = true; capacity -= 1; },
        rollback: () => { settled = true; },
        publish: async () => { if (!settled) throw new Error('published before broker commit'); published.push(workerId); }
      };
    },
    stageReuse: () => { throw new Error('reuse not expected in this fixture'); },
    persistBroker: async () => options.persist ?? true,
    bindWorkspace: () => undefined,
    published
  };
}

describe('V3 scheduler', () => {
  it('assigns every independent READY task while capacity is available and publishes only after TASK_ASSIGNED is durable', async () => {
    await tempStore();
    await acceptInitialManagerPlan({ planId: 'plan-1', runId: runtime.runId, managerAgentId: runtime.managerAgentId, tasks: [planTask('T1'), planTask('T2')] });
    const d = deps({ capacity: 2 });

    const result = await runSchedulerCycleForRuntime(runtime, [{ name: 'project', path: '/tmp' }], d);
    expect(result.scheduled.map((entry) => entry.taskId)).toEqual(['T1', 'T2']);
    expect(d.published).toHaveLength(2);
    const recovered = await recoverOrchestrationState();
    expect(recovered.state.tasks.T1?.state).toBe('ASSIGNED');
    expect(recovered.state.tasks.T2?.state).toBe('ASSIGNED');
    expect(Object.keys(recovered.state.assignmentIntents)).toHaveLength(0);
  });

  it('leaves excess READY tasks queued when execution capacity is exhausted', async () => {
    await tempStore();
    await acceptInitialManagerPlan({ planId: 'plan-2', runId: runtime.runId, managerAgentId: runtime.managerAgentId, tasks: [planTask('T1'), planTask('T2')] });
    const result = await runSchedulerCycleForRuntime(runtime, [{ name: 'project', path: '/tmp' }], deps({ capacity: 1 }));
    expect(result.scheduled).toHaveLength(1);
    expect(result.stillReady).toEqual(['T2']);
  });

  it('promotes a PLANNED task only after every dependency is VERIFIED', async () => {
    await tempStore();
    const t1: TaskRecord = {
      taskId: 'T1', parentTaskId: null, title: 'T1', goal: 'T1', allowedScope: [], dependencies: [], acceptanceCriteria: ['ok'], expectedVerification: [], forbiddenActions: [],
      state: 'VERIFIED', assignedWorkerId: 'worker-2', reviewerId: null, worktreeId: 'wt-old', reviewRound: 0, retryBudget: 2, riskClass: 'normal', completionPackage: null
    };
    const t2: TaskRecord = {
      ...t1, taskId: 'T2', title: 'T2', goal: 'T2', dependencies: ['T1'], state: 'PLANNED', assignedWorkerId: null, worktreeId: null
    };
    await writeOrchestrationSnapshot({
      version: 1,
      lastSeq: 0,
      state: {
        runId: runtime.runId,
        managerAgentId: runtime.managerAgentId,
        managerPlanId: 'plan-deps',
        managerPlanFingerprint: 'fingerprint',
        tasks: { T1: t1, T2: t2 },
        assignmentIntents: {}, worktreeIntents: {}, worktrees: {}
      }
    });

    const result = await runSchedulerCycleForRuntime(runtime, [{ name: 'project', path: '/tmp' }], deps({ capacity: 0 }));
    expect(result.scheduled).toEqual([]);
    expect(result.stillReady).toEqual(['T2']);
    expect((await recoverOrchestrationState()).state.tasks.T2?.state).toBe('READY');
  });

  it('rolls back broker staging and clears the durable assignment intent when the broker durability barrier fails', async () => {
    await tempStore();
    await acceptInitialManagerPlan({ planId: 'plan-fail', runId: runtime.runId, managerAgentId: runtime.managerAgentId, tasks: [planTask('T1')] });
    const d = deps({ capacity: 1, persist: false });
    const result = await runSchedulerCycleForRuntime(runtime, [{ name: 'project', path: '/tmp' }], d);
    expect(result.scheduled).toEqual([]);
    expect(d.published).toEqual([]);
    const recovered = await recoverOrchestrationState();
    expect(recovered.state.tasks.T1?.state).toBe('READY');
    expect(recovered.state.assignmentIntents.T1).toBeUndefined();
    expect((await readOrchestrationEvents()).some((event) => event.type === 'TASK_ASSIGNMENT_ABORTED')).toBe(true);
  });
});
