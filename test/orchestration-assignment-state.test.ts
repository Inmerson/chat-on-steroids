import { describe, expect, it } from 'vitest';

import { applyOrchestrationEvent, EMPTY_ORCHESTRATION_STATE } from '../src/main/orchestration/reducer.js';
import type { OrchestrationEvent } from '../src/main/orchestration/store.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

const task: TaskRecord = {
  taskId: 'T1',
  parentTaskId: null,
  title: 'Parser',
  goal: 'Implement parser support.',
  allowedScope: ['src/parser/**'],
  dependencies: [],
  acceptanceCriteria: ['Parser tests pass'],
  expectedVerification: ['npm test -- test/parser.test.ts'],
  forbiddenActions: ['push', 'deploy'],
  state: 'PLANNED',
  assignedWorkerId: null,
  reviewerId: null,
  worktreeId: null,
  reviewRound: 0,
  retryBudget: 2,
  riskClass: 'normal',
  completionPackage: null
};

function event(
  seq: number,
  type: string,
  entityId: string,
  payload: Record<string, unknown> = {}
): OrchestrationEvent {
  return {
    seq,
    eventId: `e-${seq}`,
    runId: 'run-1',
    time: seq,
    type,
    actor: 'kernel',
    entityId,
    payload
  } as OrchestrationEvent;
}

function readyState(): ReturnType<typeof applyOrchestrationEvent> {
  let state = applyOrchestrationEvent(EMPTY_ORCHESTRATION_STATE, event(1, 'RUN_CREATED', 'run-1'));
  state = applyOrchestrationEvent(state, event(2, 'TASK_CREATED', 'T1', { task }));
  return applyOrchestrationEvent(state, event(3, 'TASK_READY', 'T1'));
}

const worktreeIntent = {
  operationId: 'wt-op-1',
  taskId: 'T1',
  worktreeId: 'wt-1',
  branch: 'as3/run-1/t1-wt-op-1',
  baseRevision: 'abc123',
  realPath: '/safe/worktrees/t1',
  virtualPath: '/project/.chat-on-steroids-worktrees/t1'
};

const worktree = {
  worktreeId: 'wt-1',
  taskId: 'T1',
  branch: 'as3/run-1/t1-wt-op-1',
  baseRevision: 'abc123',
  realPath: '/safe/worktrees/t1',
  virtualPath: '/project/.chat-on-steroids-worktrees/t1'
};

const assignmentIntent = {
  operationId: 'assign-op-1',
  taskId: 'T1',
  strategy: 'reuse',
  requestedWorkerId: 'worker-2',
  contractDigest: 'digest-1'
};

function worktreeReadyState(): ReturnType<typeof applyOrchestrationEvent> {
  let state = readyState();
  state = applyOrchestrationEvent(state, event(4, 'TASK_WORKTREE_INTENT', 'T1', { intent: worktreeIntent }));
  return applyOrchestrationEvent(
    state,
    event(5, 'TASK_WORKTREE_READY', 'T1', { operationId: 'wt-op-1', worktree })
  );
}

describe('V3 durable assignment operation state', () => {
  it('records worktree intent/result without consuming READY task state', () => {
    let state = readyState();
    state = applyOrchestrationEvent(state, event(4, 'TASK_WORKTREE_INTENT', 'T1', { intent: worktreeIntent }));

    expect(state.tasks.T1?.state).toBe('READY');
    expect((state as any).worktreeIntents.T1).toEqual(worktreeIntent);

    state = applyOrchestrationEvent(
      state,
      event(5, 'TASK_WORKTREE_READY', 'T1', { operationId: 'wt-op-1', worktree })
    );

    expect(state.tasks.T1).toMatchObject({ state: 'READY', worktreeId: 'wt-1' });
    expect((state as any).worktreeIntents.T1).toBeUndefined();
    expect((state as any).worktrees['wt-1']).toEqual(worktree);
  });

  it('requires TASK_ASSIGNED to consume the exact pending assignment operation', () => {
    let state = worktreeReadyState();
    state = applyOrchestrationEvent(
      state,
      event(6, 'TASK_ASSIGNMENT_INTENT', 'T1', { intent: assignmentIntent })
    );

    expect(state.tasks.T1?.state).toBe('READY');
    expect((state as any).assignmentIntents.T1).toEqual(assignmentIntent);

    expect(() =>
      applyOrchestrationEvent(
        state,
        event(7, 'TASK_ASSIGNED', 'T1', { operationId: 'some-other-operation', workerId: 'worker-2' })
      )
    ).toThrow(/operation|intent|mismatch/i);

    const assigned = applyOrchestrationEvent(
      state,
      event(7, 'TASK_ASSIGNED', 'T1', { operationId: 'assign-op-1', workerId: 'worker-2' })
    );
    expect(assigned.tasks.T1).toMatchObject({ state: 'ASSIGNED', assignedWorkerId: 'worker-2' });
    expect((assigned as any).assignmentIntents.T1).toBeUndefined();
  });

  it('refuses a reuse result assigned to a different worker than the durable intent', () => {
    let state = worktreeReadyState();
    state = applyOrchestrationEvent(
      state,
      event(6, 'TASK_ASSIGNMENT_INTENT', 'T1', { intent: assignmentIntent })
    );

    expect(() =>
      applyOrchestrationEvent(
        state,
        event(7, 'TASK_ASSIGNED', 'T1', { operationId: 'assign-op-1', workerId: 'worker-9' })
      )
    ).toThrow(/worker|intent|mismatch/i);
  });

  it('clears an aborted assignment without consuming READY state', () => {
    let state = worktreeReadyState();
    state = applyOrchestrationEvent(
      state,
      event(6, 'TASK_ASSIGNMENT_INTENT', 'T1', { intent: assignmentIntent })
    );
    state = applyOrchestrationEvent(
      state,
      event(7, 'TASK_ASSIGNMENT_ABORTED', 'T1', { operationId: 'assign-op-1', reason: 'broker barrier failed' })
    );

    expect(state.tasks.T1).toMatchObject({ state: 'READY', assignedWorkerId: null });
    expect((state as any).assignmentIntents.T1).toBeUndefined();
  });

  it('does not let another task-state transition hide an unresolved external-operation intent', () => {
    let worktreePending = readyState();
    worktreePending = applyOrchestrationEvent(
      worktreePending,
      event(4, 'TASK_WORKTREE_INTENT', 'T1', { intent: worktreeIntent })
    );
    expect(() => applyOrchestrationEvent(worktreePending, event(5, 'TASK_BLOCKED', 'T1', { reason: 'later' }))).toThrow(
      /worktree|intent|operation/i
    );

    let assignmentPending = worktreeReadyState();
    assignmentPending = applyOrchestrationEvent(
      assignmentPending,
      event(6, 'TASK_ASSIGNMENT_INTENT', 'T1', { intent: assignmentIntent })
    );
    expect(() =>
      applyOrchestrationEvent(assignmentPending, event(7, 'TASK_BLOCKED', 'T1', { reason: 'later' }))
    ).toThrow(/assignment|intent|operation/i);
  });

  it('requires worktree failure to settle the exact worktree operation', () => {
    let state = readyState();
    state = applyOrchestrationEvent(state, event(4, 'TASK_WORKTREE_INTENT', 'T1', { intent: worktreeIntent }));

    expect(() =>
      applyOrchestrationEvent(
        state,
        event(5, 'TASK_WORKTREE_FAILED', 'T1', { operationId: 'wrong-op', reason: 'git failed' })
      )
    ).toThrow(/operation|intent|mismatch/i);

    const settled = applyOrchestrationEvent(
      state,
      event(5, 'TASK_WORKTREE_FAILED', 'T1', { operationId: 'wt-op-1', reason: 'git failed' })
    );
    expect(settled.tasks.T1?.state).toBe('READY');
    expect((settled as any).worktreeIntents.T1).toBeUndefined();
  });
});
