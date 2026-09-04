import { describe, expect, it } from 'vitest';

import { readyTaskIds, validateTaskGraph } from '../src/main/orchestration/dag.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

function task(taskId: string, state: TaskRecord['state'], dependencies: string[] = []): TaskRecord {
  return {
    taskId,
    parentTaskId: null,
    title: taskId,
    goal: `Complete ${taskId}`,
    allowedScope: [`src/${taskId}/**`],
    dependencies,
    acceptanceCriteria: [`${taskId} is complete`],
    expectedVerification: [`verify ${taskId}`],
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

describe('V3 dependency scheduler primitives', () => {
  it('returns only currently ready independent tasks', () => {
    const tasks = [task('T1', 'READY'), task('T2', 'PLANNED', ['T1'])];

    expect(readyTaskIds(tasks)).toEqual(['T1']);
  });

  it('unlocks a planned task once every dependency is VERIFIED', () => {
    const tasks = [task('T1', 'VERIFIED'), task('T2', 'PLANNED', ['T1'])];

    expect(readyTaskIds(tasks)).toEqual(['T2']);
  });

  it('rejects a dependency that does not exist in the graph', () => {
    expect(() => validateTaskGraph([task('T1', 'PLANNED', ['missing'])])).toThrow(/missing dependency/i);
  });

  it('rejects cycles instead of scheduling them', () => {
    const tasks = [task('T1', 'PLANNED', ['T2']), task('T2', 'PLANNED', ['T1'])];

    expect(() => validateTaskGraph(tasks)).toThrow(/cycle/i);
  });
});
