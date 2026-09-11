import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EMPTY_ORCHESTRATION_STATE } from '../src/main/orchestration/reducer.js';
import {
  resetAutonomousSchedulerForTests,
  runAutonomousSchedulerCycle,
  type AutonomousSchedulerDependencies,
  type AutonomousSchedulerWorker
} from '../src/main/orchestration/autonomous-scheduler.js';
import {
  planFairAutonomousWorkerAllocations,
  type AutonomousPrimeWorkerDemand
} from '../src/main/orchestration/worker-allocation.js';
import {
  appendOrchestrationEvent,
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests,
  writeOrchestrationSnapshot
} from '../src/main/orchestration/store.js';
import type {
  AutonomousDispatchQueueEntry,
  AutonomousSwarmRun,
  DispatchLease,
  TaskRecord
} from '../src/main/orchestration/types.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetAutonomousSchedulerForTests();
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function task(
  taskId: string,
  options: {
    state?: TaskRecord['state'];
    dependencies?: string[];
    assignedWorkerId?: string | null;
  } = {}
): TaskRecord {
  return {
    taskId,
    parentTaskId: null,
    title: taskId,
    goal: `Complete ${taskId}`,
    allowedScope: [`src/${taskId.toLowerCase()}/**`],
    dependencies: options.dependencies ?? [],
    acceptanceCriteria: [`${taskId} verified`],
    expectedVerification: ['npm test'],
    forbiddenActions: ['push', 'deploy'],
    state: options.state ?? 'READY',
    assignedWorkerId: options.assignedWorkerId ?? null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 2,
    riskClass: 'normal',
    completionPackage: null
  };
}

function run(goalRunId: string, primeConversationId: string, options: Partial<AutonomousSwarmRun> = {}): AutonomousSwarmRun {
  return {
    goalRunId,
    primeConversationId,
    bindingEpoch: `binding-${primeConversationId}`,
    objective: `Complete work for ${primeConversationId}`,
    graphVersion: 1,
    status: 'RUNNING',
    lastReason: null,
    cooldownUntil: null,
    ...options
  };
}

function queued(goalRunId: string, taskId: string, primeConversationId: string, queuedAt: number): AutonomousDispatchQueueEntry {
  return { goalRunId, taskId, primeConversationId, queuedAt, attempt: 0 };
}

async function tempStore(input: {
  tasks: TaskRecord[];
  runs: AutonomousSwarmRun[];
  queue: AutonomousDispatchQueueEntry[];
  activeLeases?: DispatchLease[];
  lastGrantedPrimeId?: string | null;
}): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-autonomous-scheduler-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
  await writeOrchestrationSnapshot({
    version: 1,
    lastSeq: 0,
    state: {
      ...EMPTY_ORCHESTRATION_STATE,
      tasks: Object.fromEntries(input.tasks.map((entry) => [entry.taskId, entry])),
      autonomousSwarm: {
        runs: Object.fromEntries(input.runs.map((entry) => [entry.goalRunId, entry])),
        queue: input.queue,
        activeLeases: Object.fromEntries((input.activeLeases ?? []).map((entry) => [entry.leaseId, entry])),
        lastGrantedPrimeId: input.lastGrantedPrimeId ?? null
      }
    }
  });
}

function worker(
  primeConversationId: string,
  workerId: string,
  options: Partial<AutonomousSchedulerWorker> = {}
): AutonomousSchedulerWorker {
  return {
    primeConversationId,
    workerId,
    workerRunId: `broker-${primeConversationId}`,
    conversationId: `chat-${primeConversationId}-${workerId}`,
    unsettled: false,
    ...options
  };
}

function deps(
  workers: AutonomousSchedulerWorker[],
  options: {
    ownershipRunOverride?: Record<string, string>;
    browserMissing?: Set<string>;
    beforePublish?: (lease: DispatchLease) => Promise<void>;
  } = {}
): AutonomousSchedulerDependencies & { published: DispatchLease[]; manualActiveTurns: number } {
  let leaseNo = 0;
  let commandNo = 0;
  const published: DispatchLease[] = [];
  return {
    now: () => 1_000,
    listWorkers: () => workers,
    ownershipForConversation: (conversationId) => {
      const owned = workers.find((entry) => entry.conversationId === conversationId);
      if (!owned || !owned.conversationId) return null;
      return {
        primeConversationId: owned.primeConversationId,
        workerId: owned.workerId,
        runId: options.ownershipRunOverride?.[conversationId] ?? owned.workerRunId
      };
    },
    browserConversation: (conversationId) =>
      options.browserMissing?.has(conversationId) ? null : { conversationId },
    nextLeaseId: () => `lease-${++leaseNo}`,
    nextCommandId: () => `command-${++commandNo}`,
    publish: async (lease) => {
      await options.beforePublish?.(lease);
      published.push(lease);
    },
    published,
    // Deliberately not part of the scheduler contract. Manual turns are observable elsewhere,
    // but autonomous capacity must be counted only from durable autonomous leases.
    manualActiveTurns: 99
  };
}

async function settleLease(lease: DispatchLease, browserEpoch: number): Promise<void> {
  const identity = {
    leaseId: lease.leaseId,
    goalRunId: lease.goalRunId,
    taskId: lease.taskId,
    primeConversationId: lease.primeConversationId,
    workerId: lease.workerId,
    workerRunId: lease.workerRunId,
    conversationId: lease.conversationId
  };
  await appendOrchestrationEvent({
    eventId: `browser-commit:${lease.leaseId}`,
    runId: lease.goalRunId,
    time: 1_100 + browserEpoch,
    type: 'DISPATCH_BROWSER_COMMITTED',
    actor: 'kernel',
    entityId: lease.leaseId,
    payload: { ...identity, commandId: lease.commandId, browserEpoch }
  });
  await appendOrchestrationEvent({
    eventId: `settled:${lease.leaseId}`,
    runId: lease.goalRunId,
    time: 1_200 + browserEpoch,
    type: 'DISPATCH_SETTLED',
    actor: 'kernel',
    entityId: lease.leaseId,
    payload: {
      ...identity,
      commandId: lease.commandId,
      browserEpoch,
      turnId: `turn-${lease.leaseId}`,
      evidenceRef: `evidence:${lease.taskId}`
    }
  });
}

describe('autonomous worker-chat fairness', () => {
  it('gives A/B/C/D one worker each before distributing the fifth and sixth slots', () => {
    const demands: AutonomousPrimeWorkerDemand[] = ['A', 'B', 'C', 'D'].map((primeConversationId, index) => ({
      primeConversationId,
      queuedAt: index + 1,
      ownedWorkerChats: 0,
      requestedWorkerChats: 2
    }));

    expect(planFairAutonomousWorkerAllocations(demands)).toEqual(['A', 'B', 'C', 'D', 'A', 'B']);
  });

  it('never lets one prime consume the six-chat global pool', () => {
    expect(
      planFairAutonomousWorkerAllocations([
        { primeConversationId: 'A', queuedAt: 1, ownedWorkerChats: 0, requestedWorkerChats: 6 }
      ])
    ).toEqual(['A', 'A']);
  });
});

describe('serialized autonomous scheduler', () => {
  it('persists the exact lease before publishing browser work', async () => {
    await tempStore({
      tasks: [task('T1', { assignedWorkerId: 'worker-1' })],
      runs: [run('run-A', 'A')],
      queue: [queued('run-A', 'T1', 'A', 1)]
    });
    const d = deps([worker('A', 'worker-1')], {
      beforePublish: async (lease) => {
        const events = await readOrchestrationEvents();
        expect(events.some((event) => event.type === 'DISPATCH_LEASED' && event.entityId === lease.leaseId)).toBe(true);
      }
    });

    const result = await runAutonomousSchedulerCycle(d);

    expect(result.leased).toHaveLength(1);
    expect(result.leased[0]).toMatchObject({
      primeConversationId: 'A',
      workerId: 'worker-1',
      workerRunId: 'broker-A',
      conversationId: 'chat-A-worker-1',
      commandId: 'command-1',
      browserEpoch: null,
      turnId: null
    });
    expect(d.published).toHaveLength(1);
  });

  it('a paused run consumes no new autonomous permit', async () => {
    await tempStore({
      tasks: [task('T1')],
      runs: [run('run-A', 'A', { status: 'PAUSED' })],
      queue: [queued('run-A', 'T1', 'A', 1)]
    });
    const d = deps([worker('A', 'worker-1')]);

    expect((await runAutonomousSchedulerCycle(d)).leased).toEqual([]);
    expect(d.published).toEqual([]);
  });

  it('a waiting task consumes no permit', async () => {
    await tempStore({
      tasks: [task('T0', { state: 'ACTIVE' }), task('T1', { dependencies: ['T0'] })],
      runs: [run('run-A', 'A')],
      queue: [queued('run-A', 'T1', 'A', 1)]
    });
    const d = deps([worker('A', 'worker-1')]);

    expect((await runAutonomousSchedulerCycle(d)).leased).toEqual([]);
    expect(d.published).toEqual([]);
  });

  it('skips a cooled-down task while unrelated eligible work proceeds', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB')],
      runs: [run('run-A', 'A', { cooldownUntil: 2_000 }), run('run-B', 'B')],
      queue: [queued('run-A', 'TA', 'A', 1), queued('run-B', 'TB', 'B', 2)]
    });
    const d = deps([worker('A', 'worker-1'), worker('B', 'worker-1')]);

    expect((await runAutonomousSchedulerCycle(d)).leased.map((lease) => lease.taskId)).toEqual(['TB']);
  });

  it('an unsettled worker blocks only work assigned to that worker', async () => {
    await tempStore({
      tasks: [
        task('T1', { assignedWorkerId: 'worker-1' }),
        task('T2', { assignedWorkerId: 'worker-2' })
      ],
      runs: [run('run-A', 'A')],
      queue: [queued('run-A', 'T1', 'A', 1), queued('run-A', 'T2', 'A', 2)]
    });
    const d = deps([
      worker('A', 'worker-1', { unsettled: true }),
      worker('A', 'worker-2')
    ]);

    expect((await runAutonomousSchedulerCycle(d)).leased.map((lease) => lease.taskId)).toEqual(['T2']);
  });

  it('fails closed on ownership-incarnation drift while another prime can proceed', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB')],
      runs: [run('run-A', 'A'), run('run-B', 'B')],
      queue: [queued('run-A', 'TA', 'A', 1), queued('run-B', 'TB', 'B', 2)]
    });
    const a = worker('A', 'worker-1');
    const d = deps([a, worker('B', 'worker-1')], {
      ownershipRunOverride: { [a.conversationId as string]: 'broker-A-new-incarnation' }
    });

    const result = await runAutonomousSchedulerCycle(d);

    expect(result.leased.map((lease) => lease.taskId)).toEqual(['TB']);
    expect(result.blocked).toContainEqual(expect.objectContaining({ goalRunId: 'run-A', taskId: 'TA' }));
  });

  it('duplicate wakeups do not create a duplicate lease', async () => {
    await tempStore({
      tasks: [task('T1')],
      runs: [run('run-A', 'A')],
      queue: [queued('run-A', 'T1', 'A', 1)]
    });
    const d = deps([worker('A', 'worker-1')]);

    const first = await runAutonomousSchedulerCycle(d);
    const second = await runAutonomousSchedulerCycle(d);

    expect(first.leased).toHaveLength(1);
    expect(second.leased).toEqual([]);
    expect(d.published).toHaveLength(1);
    expect((await readOrchestrationEvents()).filter((event) => event.type === 'DISPATCH_LEASED')).toHaveLength(1);
  });

  it('serializes concurrent wakeups so no more than two autonomous permits exist', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB'), task('TC')],
      runs: [run('run-A', 'A'), run('run-B', 'B'), run('run-C', 'C')],
      queue: [
        queued('run-A', 'TA', 'A', 1),
        queued('run-B', 'TB', 'B', 2),
        queued('run-C', 'TC', 'C', 3)
      ]
    });
    const d = deps([worker('A', 'worker-1'), worker('B', 'worker-1'), worker('C', 'worker-1')]);

    await Promise.all([runAutonomousSchedulerCycle(d), runAutonomousSchedulerCycle(d)]);

    expect(d.published).toHaveLength(2);
    expect((await readOrchestrationEvents()).filter((event) => event.type === 'DISPATCH_LEASED')).toHaveLength(2);
  });

  it('rechecks broker-owned worker capacity before granting a second permit in the same cycle', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB')],
      runs: [run('run-A', 'A'), run('run-B', 'B')],
      queue: [queued('run-A', 'TA', 'A', 1), queued('run-B', 'TB', 'B', 2)]
    });
    const workers = [worker('A', 'worker-1'), worker('B', 'worker-1')];
    const d = deps(workers);
    const publish = d.publish.bind(d);
    d.publish = async (lease) => {
      await publish(lease);
      if (d.published.length !== 1) return;
      workers.push(
        worker('C', 'worker-1'),
        worker('C', 'worker-2'),
        worker('D', 'worker-1'),
        worker('D', 'worker-2'),
        worker('E', 'worker-1')
      );
    };

    const result = await runAutonomousSchedulerCycle(d);

    expect(result.leased).toHaveLength(1);
    expect(d.published).toHaveLength(1);
  });

  it('rotates fairly across primes after settled permits instead of returning immediately to A', async () => {
    await tempStore({
      tasks: ['A1', 'A2', 'B1', 'B2', 'C1', 'D1'].map((taskId) => task(taskId)),
      runs: [run('run-A', 'A'), run('run-B', 'B'), run('run-C', 'C'), run('run-D', 'D')],
      queue: [
        queued('run-A', 'A1', 'A', 1),
        queued('run-A', 'A2', 'A', 2),
        queued('run-B', 'B1', 'B', 3),
        queued('run-B', 'B2', 'B', 4),
        queued('run-C', 'C1', 'C', 5),
        queued('run-D', 'D1', 'D', 6)
      ]
    });
    const d = deps([
      worker('A', 'worker-1'),
      worker('B', 'worker-1'),
      worker('C', 'worker-1'),
      worker('D', 'worker-1')
    ]);

    const first = await runAutonomousSchedulerCycle(d);
    expect(first.leased.map((lease) => lease.primeConversationId)).toEqual(['A', 'B']);
    await Promise.all(first.leased.map((lease, index) => settleLease(lease, index + 1)));

    const second = await runAutonomousSchedulerCycle(d);
    expect(second.leased.map((lease) => lease.primeConversationId)).toEqual(['C', 'D']);
    await Promise.all(second.leased.map((lease, index) => settleLease(lease, index + 3)));

    const third = await runAutonomousSchedulerCycle(d);
    expect(third.leased.map((lease) => lease.primeConversationId)).toEqual(['A', 'B']);
  });

  it('requires an exact browser conversation and lets unrelated exact work proceed', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB')],
      runs: [run('run-A', 'A'), run('run-B', 'B')],
      queue: [queued('run-A', 'TA', 'A', 1), queued('run-B', 'TB', 'B', 2)]
    });
    const a = worker('A', 'worker-1');
    const b = worker('B', 'worker-1');
    const d = deps([a, b], { browserMissing: new Set([a.conversationId as string]) });

    expect((await runAutonomousSchedulerCycle(d)).leased.map((lease) => lease.taskId)).toEqual(['TB']);
  });

  it('manual user activity does not reduce the two autonomous permits', async () => {
    await tempStore({
      tasks: [task('TA'), task('TB')],
      runs: [run('run-A', 'A'), run('run-B', 'B')],
      queue: [queued('run-A', 'TA', 'A', 1), queued('run-B', 'TB', 'B', 2)]
    });
    const d = deps([worker('A', 'worker-1'), worker('B', 'worker-1')]);

    expect(d.manualActiveTurns).toBeGreaterThan(2);
    expect((await runAutonomousSchedulerCycle(d)).leased).toHaveLength(2);
  });
});
