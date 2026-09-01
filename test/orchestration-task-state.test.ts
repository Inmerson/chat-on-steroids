import { describe, expect, it } from 'vitest';

import { transitionTask } from '../src/main/orchestration/task-state.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

function task(state: TaskRecord['state']): TaskRecord {
  return {
    taskId: 'T1',
    parentTaskId: null,
    title: 'Database schema',
    goal: 'Create schema',
    dependencies: [],
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

describe('V3 task state machine', () => {
  it('accepts the normal PLANNED -> READY transition without mutating the input', () => {
    const original = task('PLANNED');
    const next = transitionTask(original, 'READY');

    expect(next.state).toBe('READY');
    expect(original.state).toBe('PLANNED');
    expect(next).not.toBe(original);
  });

  it('rejects skipping directly from PLANNED to VERIFIED', () => {
    expect(() => transitionTask(task('PLANNED'), 'VERIFIED')).toThrow(/PLANNED.*VERIFIED/);
  });

  it('allows CHANGES_REQUESTED to return to ACTIVE', () => {
    expect(transitionTask(task('CHANGES_REQUESTED'), 'ACTIVE').state).toBe('ACTIVE');
  });
});
