import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acceptInitialManagerPlan } from '../src/main/orchestration/manager-plan.js';
import { recoverOrchestrationState } from '../src/main/orchestration/recovery.js';
import {
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests
} from '../src/main/orchestration/store.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-orchestration-manager-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
}

function plan(planId = 'plan-1') {
  return {
    planId,
    runId: 'run-1',
    managerAgentId: 'worker-1',
    tasks: [
      {
        taskId: 'T1',
        parentTaskId: null,
        title: 'Database schema',
        goal: 'Create the schema required by the API.',
        allowedScope: ['src/db/**', 'test/db/**'],
        dependencies: [],
        acceptanceCriteria: ['Schema migration is reversible', 'Database tests pass'],
        expectedVerification: ['npm test -- test/db'],
        forbiddenActions: ['push', 'deploy', 'production data changes'],
        riskClass: 'high' as const
      },
      {
        taskId: 'T2',
        parentTaskId: null,
        title: 'API layer',
        goal: 'Expose the schema through the application API.',
        allowedScope: ['src/api/**', 'test/api/**'],
        dependencies: ['T1'],
        acceptanceCriteria: ['API uses the approved schema', 'API tests pass'],
        expectedVerification: ['npm test -- test/api'],
        forbiddenActions: ['push', 'deploy'],
        riskClass: 'normal' as const
      }
    ]
  };
}

describe('V3 Manager initial plan acceptance', () => {
  it('durably creates the run, binds one Manager, materializes task contracts, and readies root tasks', async () => {
    await tempStore();

    const accepted = await acceptInitialManagerPlan(plan());
    expect(accepted).toEqual({ repeated: false, readyTaskIds: ['T1'] });

    const events = await readOrchestrationEvents();
    expect(events.map((event) => event.type)).toEqual([
      'RUN_CREATED',
      'MANAGER_ASSIGNED',
      'TASK_CREATED',
      'TASK_CREATED',
      'TASK_READY'
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    const recovered = await recoverOrchestrationState();
    expect(recovered.state.runId).toBe('run-1');
    expect(recovered.state.managerAgentId).toBe('worker-1');
    expect(recovered.state.managerPlanId).toBe('plan-1');
    expect(recovered.state.tasks.T1).toMatchObject({
      state: 'READY',
      assignedWorkerId: null,
      reviewRound: 0,
      retryBudget: 2,
      allowedScope: ['src/db/**', 'test/db/**'],
      acceptanceCriteria: ['Schema migration is reversible', 'Database tests pass'],
      expectedVerification: ['npm test -- test/db'],
      forbiddenActions: ['push', 'deploy', 'production data changes']
    });
    expect(recovered.state.tasks.T2).toMatchObject({ state: 'PLANNED', dependencies: ['T1'] });
  });

  it('rejects a cyclic graph before writing any orchestration event', async () => {
    await tempStore();
    const cyclic = plan();
    cyclic.tasks[0]!.dependencies = ['T2'];

    await expect(acceptInitialManagerPlan(cyclic)).rejects.toThrow(/cycle/i);
    expect(await readOrchestrationEvents()).toEqual([]);
  });

  it('treats an exact planId retry as idempotent and does not duplicate events', async () => {
    await tempStore();
    await acceptInitialManagerPlan(plan());
    const before = await readOrchestrationEvents();

    const retried = await acceptInitialManagerPlan(plan());

    expect(retried).toEqual({ repeated: true, readyTaskIds: ['T1'] });
    expect(await readOrchestrationEvents()).toEqual(before);
  });

  it('refuses a different second initial plan and leaves the accepted journal unchanged', async () => {
    await tempStore();
    await acceptInitialManagerPlan(plan());
    const before = await readOrchestrationEvents();

    await expect(acceptInitialManagerPlan(plan('plan-2'))).rejects.toThrow(/already.*plan/i);
    expect(await readOrchestrationEvents()).toEqual(before);
  });
});
