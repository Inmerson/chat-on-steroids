import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recoverOrchestrationState } from '../src/main/orchestration/recovery.js';
import {
  appendOrchestrationEvent,
  initOrchestrationStore,
  resetOrchestrationStoreForTests,
  writeOrchestrationSnapshot
} from '../src/main/orchestration/store.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-orchestration-recovery-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
  return dir;
}

function task(state: TaskRecord['state']): TaskRecord {
  return {
    taskId: 'T1',
    parentTaskId: null,
    title: 'Database schema',
    goal: 'Create schema',
    allowedScope: ['src/db/**'],
    dependencies: [],
    acceptanceCriteria: ['Schema is valid'],
    expectedVerification: ['npm test -- test/db'],
    forbiddenActions: ['push', 'deploy'],
    state,
    assignedWorkerId: null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 2,
    riskClass: 'normal',
    completionPackage: null
  };
}

describe('V3 orchestration recovery', () => {
  it('replays journal events after the latest snapshot', async () => {
    const dir = await tempStore();
    const readyTask = { ...task('READY'), worktreeId: 'wt-1' };
    await writeOrchestrationSnapshot({
      version: 1,
      lastSeq: 2,
      state: {
        runId: 'run-1',
        tasks: { T1: readyTask },
        worktrees: {
          'wt-1': {
            worktreeId: 'wt-1',
            taskId: 'T1',
            branch: 'as3/run-1/t1',
            baseRevision: 'abc123',
            realPath: '/safe/t1',
            virtualPath: '/project/t1'
          }
        }
      }
    });

    const intent = await appendOrchestrationEvent({
      eventId: 'assign-intent-T1',
      runId: 'run-1',
      time: 1_700_000_000_003,
      type: 'TASK_ASSIGNMENT_INTENT',
      actor: 'kernel',
      entityId: 'T1',
      payload: {
        intent: {
          operationId: 'assign-op-1',
          taskId: 'T1',
          strategy: 'spawn',
          requestedWorkerId: null,
          contractDigest: 'digest-1'
        }
      }
    });
    const assigned = await appendOrchestrationEvent({
      eventId: 'assign-T1',
      runId: 'run-1',
      time: 1_700_000_000_004,
      type: 'TASK_ASSIGNED',
      actor: 'kernel',
      entityId: 'T1',
      payload: { operationId: 'assign-op-1', workerId: 'worker-1' }
    });
    const activated = await appendOrchestrationEvent({
      eventId: 'activate-T1',
      runId: 'run-1',
      time: 1_700_000_000_005,
      type: 'TASK_ACTIVATED',
      actor: 'kernel',
      entityId: 'T1',
      payload: {}
    });

    expect([intent.seq, assigned.seq, activated.seq]).toEqual([3, 4, 5]);

    resetOrchestrationStoreForTests();
    initOrchestrationStore(dir);

    const recovered = await recoverOrchestrationState();
    expect(recovered.lastSeq).toBe(5);
    expect(recovered.state.managerAgentId).toBeNull();
    expect(recovered.state.managerPlanId).toBeNull();
    expect(recovered.state.tasks.T1?.state).toBe('ACTIVE');
    expect(recovered.state.tasks.T1?.assignedWorkerId).toBe('worker-1');
    expect(recovered.state.assignmentIntents.T1).toBeUndefined();
    expect(recovered.state.worktrees['wt-1']?.taskId).toBe('T1');
  });

  it('rejects a journal gap after the snapshot instead of guessing what happened', async () => {
    const dir = await tempStore();
    await writeOrchestrationSnapshot({
      version: 1,
      lastSeq: 2,
      state: { runId: 'run-1', tasks: { T1: task('READY') } }
    });

    const journal = path.join(dir, 'state', 'orchestration', 'journal.jsonl');
    await fs.writeFile(
      journal,
      `${JSON.stringify({
        seq: 4,
        eventId: 'activate-T1',
        runId: 'run-1',
        time: 1_700_000_000_004,
        type: 'TASK_ACTIVATED',
        actor: 'kernel',
        entityId: 'T1',
        payload: {}
      })}\n`,
      'utf8'
    );

    await expect(recoverOrchestrationState()).rejects.toThrow(/sequence.*expected 3.*got 4/i);
  });
});
