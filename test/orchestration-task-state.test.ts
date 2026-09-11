import { describe, expect, it } from 'vitest';

import { applyOrchestrationEvent, EMPTY_ORCHESTRATION_STATE } from '../src/main/orchestration/reducer.js';
import { transitionTask } from '../src/main/orchestration/task-state.js';
import type { OrchestrationEvent } from '../src/main/orchestration/store.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

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

function swarmEvent(
  seq: number,
  type: OrchestrationEvent['type'],
  entityId: string,
  payload: Record<string, unknown>
): OrchestrationEvent {
  return {
    seq,
    eventId: `swarm-${seq}`,
    runId: 'goal-run-1',
    time: 1_700_000_000_000 + seq,
    type,
    actor: 'kernel',
    entityId,
    payload
  };
}

describe('autonomous swarm dispatch reducer', () => {
  it('reduces queued then leased work into one exact active lease', () => {
    let state = EMPTY_ORCHESTRATION_STATE;
    state = applyOrchestrationEvent(
      state,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Fix A and verify it.',
        graphVersion: 1
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(2, 'DISPATCH_QUEUED', 'T1', {
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A'
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(3, 'DISPATCH_LEASED', 'lease-1', {
        lease: {
          leaseId: 'lease-1',
          goalRunId: 'goal-run-1',
          taskId: 'T1',
          primeConversationId: 'prime-A',
          workerId: 'worker-1',
          workerRunId: 'broker-run-1',
          conversationId: 'worker-chat-1',
          commandId: 'command-1',
          browserEpoch: null,
          turnId: null,
          createdAt: 1_700_000_000_003
        }
      })
    );

    expect(state.autonomousSwarm.activeLeases['lease-1']).toMatchObject({
      goalRunId: 'goal-run-1',
      taskId: 'T1',
      primeConversationId: 'prime-A',
      workerId: 'worker-1',
      workerRunId: 'broker-run-1',
      conversationId: 'worker-chat-1',
      commandId: 'command-1'
    });
    expect(state.autonomousSwarm.queue).toEqual([]);
  });

  it('rejects settlement without the exact durable lease', () => {
    expect(() =>
      applyOrchestrationEvent(
        EMPTY_ORCHESTRATION_STATE,
        swarmEvent(1, 'DISPATCH_SETTLED', 'lease-missing', {
          leaseId: 'lease-missing',
          goalRunId: 'goal-run-1',
          taskId: 'T1',
          primeConversationId: 'prime-A',
          workerId: 'worker-1',
          conversationId: 'worker-chat-1',
          commandId: 'command-1',
          browserEpoch: 'epoch-1',
          turnId: 'turn-1',
          evidenceRef: 'evidence:T1:1'
        })
      )
    ).toThrow(/DISPATCH_SETTLED.*lease/i);
  });

  it('rejects a lease whose prime does not own the queued dispatch', () => {
    let state = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Fix A.',
        graphVersion: 1
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(2, 'DISPATCH_QUEUED', 'T1', {
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A'
      })
    );

    expect(() =>
      applyOrchestrationEvent(
        state,
        swarmEvent(3, 'DISPATCH_LEASED', 'lease-1', {
          lease: {
            leaseId: 'lease-1',
            goalRunId: 'goal-run-1',
            taskId: 'T1',
            primeConversationId: 'prime-B',
            workerId: 'worker-1',
            workerRunId: 'broker-run-1',
            conversationId: 'worker-chat-1',
            commandId: 'command-1',
            browserEpoch: null,
            turnId: null,
            createdAt: 1_700_000_000_003
          }
        })
      )
    ).toThrow(/ownership|prime/i);
  });

  it('binds browser commit and settlement to the exact command, epoch, and turn evidence', () => {
    let state = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Fix A and verify it.',
        graphVersion: 1
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(2, 'DISPATCH_QUEUED', 'T1', {
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A'
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(3, 'DISPATCH_LEASED', 'lease-1', {
        lease: {
          leaseId: 'lease-1',
          goalRunId: 'goal-run-1',
          taskId: 'T1',
          primeConversationId: 'prime-A',
          workerId: 'worker-1',
          workerRunId: 'broker-run-1',
          conversationId: 'worker-chat-1',
          commandId: 'command-1',
          browserEpoch: null,
          turnId: null,
          createdAt: 1_700_000_000_003
        }
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(4, 'DISPATCH_BROWSER_COMMITTED', 'lease-1', {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7
      })
    );

    expect(state.autonomousSwarm.activeLeases['lease-1']).toMatchObject({
      commandId: 'command-1',
      browserEpoch: 7
    });
    expect(() =>
      applyOrchestrationEvent(
        state,
        swarmEvent(5, 'DISPATCH_SETTLED', 'lease-1', {
          leaseId: 'lease-1',
          goalRunId: 'goal-run-1',
          taskId: 'T1',
          primeConversationId: 'prime-A',
          workerId: 'worker-1',
          workerRunId: 'broker-run-1',
          conversationId: 'worker-chat-1',
          commandId: 'command-wrong',
          browserEpoch: 7,
          turnId: 'turn-1',
          evidenceRef: 'evidence:T1:1'
        })
      )
    ).toThrow(/command|identity/i);

    const settled = applyOrchestrationEvent(
      state,
      swarmEvent(6, 'DISPATCH_SETTLED', 'lease-1', {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7,
        turnId: 'turn-1',
        evidenceRef: 'evidence:T1:1'
      })
    );
    expect(settled.autonomousSwarm.activeLeases['lease-1']).toBeUndefined();
  });

  it('pauses one autonomous swarm durably without dropping its queued or in-flight work', () => {
    let state = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Fix A and verify it.',
        graphVersion: 1
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(2, 'DISPATCH_QUEUED', 'T1', {
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A'
      })
    );

    const paused = applyOrchestrationEvent(
      state,
      swarmEvent(3, 'SWARM_RUN_PAUSED', 'goal-run-1', {
        goalRunId: 'goal-run-1',
        primeConversationId: 'prime-A',
        reason: 'Paused by user'
      })
    );

    expect(paused.autonomousSwarm.runs['goal-run-1']).toMatchObject({
      status: 'PAUSED',
      lastReason: 'Paused by user'
    });
    expect(paused.autonomousSwarm.queue.map((entry) => entry.taskId)).toEqual(['T1']);
  });

  it('stops future autonomous sends while retaining an in-flight lease for observation', () => {
    let state = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Fix A and B.',
        graphVersion: 1
      })
    );
    for (const [seq, taskId] of [
      [2, 'T1'],
      [3, 'T2']
    ] as const) {
      state = applyOrchestrationEvent(
        state,
        swarmEvent(seq, 'DISPATCH_QUEUED', taskId, {
          goalRunId: 'goal-run-1',
          taskId,
          primeConversationId: 'prime-A'
        })
      );
    }
    state = applyOrchestrationEvent(
      state,
      swarmEvent(4, 'DISPATCH_LEASED', 'lease-1', {
        lease: {
          leaseId: 'lease-1',
          goalRunId: 'goal-run-1',
          taskId: 'T1',
          primeConversationId: 'prime-A',
          workerId: 'worker-1',
          workerRunId: 'broker-run-1',
          conversationId: 'worker-chat-1',
          commandId: 'command-1',
          browserEpoch: null,
          turnId: null,
          createdAt: 1_700_000_000_004
        }
      })
    );

    const stopped = applyOrchestrationEvent(
      state,
      swarmEvent(5, 'SWARM_RUN_STOPPED', 'goal-run-1', {
        goalRunId: 'goal-run-1',
        primeConversationId: 'prime-A',
        reason: 'Stopped by user'
      })
    );

    expect(stopped.autonomousSwarm.runs['goal-run-1']).toMatchObject({
      status: 'STOPPED',
      lastReason: 'Stopped by user'
    });
    expect(stopped.autonomousSwarm.queue.filter((entry) => entry.goalRunId === 'goal-run-1')).toEqual([]);
    expect(stopped.autonomousSwarm.activeLeases['lease-1']).toBeDefined();
  });

  it('completes only after the swarm has no queued or leased dispatches', () => {
    let state = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(1, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Finish verified work.',
        graphVersion: 1
      })
    );
    state = applyOrchestrationEvent(
      state,
      swarmEvent(2, 'DISPATCH_QUEUED', 'T1', {
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A'
      })
    );

    expect(() =>
      applyOrchestrationEvent(
        state,
        swarmEvent(3, 'SWARM_RUN_COMPLETED', 'goal-run-1', {
          goalRunId: 'goal-run-1',
          primeConversationId: 'prime-A'
        })
      )
    ).toThrow(/queued|lease|dispatch|outstanding/i);

    const clean = applyOrchestrationEvent(
      EMPTY_ORCHESTRATION_STATE,
      swarmEvent(4, 'SWARM_RUN_STARTED', 'goal-run-1', {
        primeConversationId: 'prime-A',
        bindingEpoch: 'epoch-A',
        objective: 'Finish verified work.',
        graphVersion: 1
      })
    );
    const completed = applyOrchestrationEvent(
      clean,
      swarmEvent(5, 'SWARM_RUN_COMPLETED', 'goal-run-1', {
        goalRunId: 'goal-run-1',
        primeConversationId: 'prime-A'
      })
    );
    expect(completed.autonomousSwarm.runs['goal-run-1']?.status).toBe('COMPLETED');
  });
});
