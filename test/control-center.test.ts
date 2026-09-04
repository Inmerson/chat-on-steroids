import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestrationState } from '../src/main/orchestration/reducer.js';
import type { RunWorkflowState } from '../src/main/orchestration/workflow.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';
import type { AgentInfo, SwarmState } from '../src/shared/session.js';

const loaders = vi.hoisted(() => ({
  recover: vi.fn(),
  workflow: vi.fn(),
  runtime: vi.fn(),
  swarmForCaller: vi.fn(),
  browserPresent: vi.fn(),
  browserTelemetry: vi.fn()
}));

vi.mock('../src/main/orchestration/recovery.js', () => ({ recoverOrchestrationState: loaders.recover }));
vi.mock('../src/main/orchestration/workflow.js', () => ({ workflowStateForRun: loaders.workflow }));
vi.mock('../src/main/orchestration/manager-authority.js', () => ({ managerRuntimeForRun: loaders.runtime }));
vi.mock('../src/main/agents.js', () => ({ swarmStateForCaller: loaders.swarmForCaller }));
vi.mock('../src/main/bridge.js', () => ({
  browserPresent: loaders.browserPresent,
  browserAgentTabTelemetry: loaders.browserTelemetry
}));

import { controlCenterStatus, projectControlCenterStatus } from '../src/main/orchestration/control-center.js';

const CURRENT_REVISION = 'a'.repeat(40);
const OLD_REVISION = 'b'.repeat(40);

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    parentTaskId: null,
    title: `Task ${taskId}`,
    goal: `Complete ${taskId}`,
    allowedScope: [`src/${taskId}/**`],
    dependencies: [],
    acceptanceCriteria: ['done'],
    expectedVerification: ['npm test'],
    forbiddenActions: [],
    state: 'PLANNED',
    assignedWorkerId: null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 1,
    riskClass: 'normal',
    completionPackage: null,
    ...overrides
  };
}

function orchestration(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    runId: null,
    runStatus: 'RUNNING',
    managerAgentId: null,
    managerPlanId: null,
    managerPlanFingerprint: null,
    tasks: {},
    assignmentIntents: {},
    worktreeIntents: {},
    worktrees: {},
    ...overrides
  };
}

function workflow(runId: string, overrides: Partial<RunWorkflowState> = {}): RunWorkflowState {
  return {
    runId,
    status: 'running',
    completions: {},
    reviews: {},
    reviewHistory: {},
    integrationWorktree: null,
    integrations: {},
    verifications: {},
    verificationOperations: {},
    systemReview: null,
    ...overrides
  };
}

function agent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    role: 'worker',
    label: id,
    task: '',
    state: 'active',
    createdAt: 1,
    activatedAt: 2,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: `conversation-${id}`,
    detachedAt: null,
    lastSeenAt: 3,
    revivable: true,
    sleptAt: null,
    contextTokens: 100,
    ...overrides
  };
}

function swarm(agents: AgentInfo[] = []): SwarmState {
  return { enabled: true, running: agents.some((entry) => entry.role === 'worker' && entry.state !== 'sleeping'), agents };
}

afterEach(() => {
  loaders.recover.mockReset();
  loaders.workflow.mockReset();
  loaders.runtime.mockReset();
  loaders.swarmForCaller.mockReset();
  loaders.browserPresent.mockReset();
  loaders.browserTelemetry.mockReset();
  vi.restoreAllMocks();
});

describe('Control Center projector', () => {
  it('returns a serializable idle status without projecting unrelated broker agents', () => {
    const status = projectControlCenterStatus(
      orchestration(),
      null,
      swarm([agent('worker-unrelated')]),
      1_777_777
    );

    expect(status).toEqual({
      version: 1,
      observedAt: 1_777_777,
      run: null,
      tasks: [],
      agents: [],
      edges: [],
      blockers: [],
      needsAttention: [],
      browser: {
        budget: 5,
        used: null,
        queued: null,
        status: 'unavailable',
        note: 'Agent-tab lease telemetry is unavailable; unmanaged user ChatGPT tabs are never inferred as agent usage.'
      }
    });
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });

  it('projects fresh authenticated browser lease telemetry without inferring user tabs', () => {
    const observedAt = 1_777_777;
    const status = projectControlCenterStatus(
      orchestration(),
      null,
      swarm([]),
      observedAt,
      { budget: 5, used: 3, queued: 2, observedAt: observedAt - 10, receivedAt: observedAt - 20 }
    );

    expect(status.browser).toEqual({
      budget: 5,
      used: 3,
      queued: 2,
      status: 'available',
      note: null
    });
  });

  it('keeps stale browser lease telemetry unavailable', () => {
    const observedAt = 1_777_777;
    const status = projectControlCenterStatus(
      orchestration(),
      null,
      swarm([]),
      observedAt,
      { budget: 5, used: 4, queued: 1, observedAt: observedAt - 70_000, receivedAt: observedAt - 60_001 }
    );

    expect(status.browser).toMatchObject({
      used: null,
      queued: null,
      status: 'unavailable'
    });
  });

  it('projects deterministic dependency, assignment and review edges while aggregating agent roles', () => {
    const state = orchestration({
      runId: 'run-1',
      managerAgentId: 'worker-1',
      managerPlanId: 'plan-9',
      tasks: {
        'task-b': task('task-b', {
          dependencies: ['task-a'],
          state: 'REVIEWING',
          assignedWorkerId: 'worker-2',
          worktreeId: 'wt-b',
          riskClass: 'high'
        }),
        'task-a': task('task-a', { state: 'ACTIVE', assignedWorkerId: 'worker-1' })
      },
      worktrees: {
        'wt-b': {
          worktreeId: 'wt-b',
          taskId: 'task-b',
          branch: 'as3/run/task-b',
          baseRevision: OLD_REVISION,
          realPath: 'C:\\secret\\native\\task-b',
          virtualPath: '/project/.worktrees/task-b'
        }
      }
    });
    const run = workflow('run-1', {
      completions: {
        'task-b': {
          status: 'ready_for_review',
          revision: CURRENT_REVISION,
          changedFiles: ['src/z.ts', 'src/a.ts'],
          verification: [],
          risks: [],
          notes: []
        }
      },
      reviews: {
        'task-b': { operationId: 'review-b', reviewerId: 'worker-1', round: 2, verdict: null, findings: [] }
      },
      systemReview: { operationId: 'system-1', reviewerId: 'worker-2', verdict: null, findings: [] }
    });

    const status = projectControlCenterStatus(state, run, swarm([agent('worker-2'), agent('worker-1')]), 10);

    expect(status.run).toMatchObject({
      id: 'run-1',
      planId: 'plan-9',
      managerAgentId: 'worker-1',
      orchestrationStatus: 'RUNNING',
      workflowStatus: 'running',
      progress: { verified: 0, total: 2 }
    });
    expect(status.tasks.map((entry) => entry.id)).toEqual(['task-a', 'task-b']);
    expect(status.tasks.find((entry) => entry.id === 'task-b')).toMatchObject({
      riskClass: 'high',
      assignedWorkerId: 'worker-2',
      reviewerId: 'worker-1',
      reviewRound: 2,
      dependencies: ['task-a'],
      changedFiles: ['src/a.ts', 'src/z.ts'],
      worktree: { id: 'wt-b', branch: 'as3/run/task-b', virtualPath: '/project/.worktrees/task-b' }
    });
    expect(JSON.stringify(status)).not.toContain('C:\\secret\\native\\task-b');

    expect(status.edges).toEqual([
      { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
      { kind: 'assignment', agentId: 'worker-1', taskId: 'task-a' },
      { kind: 'assignment', agentId: 'worker-2', taskId: 'task-b' },
      { kind: 'review', agentId: 'worker-1', taskId: 'task-b' }
    ]);
    expect(status.agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
      roles: ['manager', 'worker', 'reviewer'],
      boundTaskIds: ['task-a'],
      reviewedTaskIds: ['task-b']
    });
    expect(status.agents.find((entry) => entry.id === 'worker-2')).toMatchObject({
      roles: ['worker', 'system_reviewer'],
      boundTaskIds: ['task-b']
    });
  });

  it('synthesizes referenced durable agents missing from the broker without inventing liveness or counters', () => {
    const state = orchestration({
      runId: 'run-synth',
      managerAgentId: 'manager-x',
      tasks: {
        'task-1': task('task-1', { assignedWorkerId: 'worker-x' }),
        'task-2': task('task-2')
      }
    });
    const run = workflow('run-synth', {
      reviews: {
        'task-2': { operationId: 'review-2', reviewerId: 'reviewer-x', round: 1, verdict: null, findings: [] }
      },
      systemReview: { operationId: 'system', reviewerId: 'system-x', verdict: null, findings: [] }
    });

    const status = projectControlCenterStatus(state, run, swarm([]), 20);

    expect(status.agents.map((entry) => entry.id)).toEqual(['manager-x', 'reviewer-x', 'system-x', 'worker-x']);
    for (const projected of status.agents) {
      expect(projected).toMatchObject({
        state: 'unknown',
        chatBound: false,
        broker: { pending: null, awaitingAck: null, delivered: null }
      });
    }
    expect(status.agents.find((entry) => entry.id === 'manager-x')?.roles).toEqual(['manager']);
    expect(status.agents.find((entry) => entry.id === 'reviewer-x')?.roles).toEqual(['reviewer']);
    expect(status.agents.find((entry) => entry.id === 'system-x')?.roles).toEqual(['system_reviewer']);
    expect(status.agents.find((entry) => entry.id === 'worker-x')?.roles).toEqual(['worker']);
  });

  it('distinguishes none, pending, passed, failed and stale verification evidence', () => {
    const state = orchestration({
      runId: 'run-verification',
      tasks: Object.fromEntries(
        ['none', 'pending', 'passed', 'failed', 'stale'].map((id) => [id, task(id, { state: id === 'passed' ? 'VERIFIED' : 'INTEGRATED' })])
      )
    });
    const record = (gate: string, passed: boolean, revision: string, finishedAt: number) => ({
      gate,
      command: gate,
      passed,
      revision,
      outputDigest: `${gate}-digest`,
      startedAt: finishedAt - 1,
      finishedAt
    });
    const run = workflow('run-verification', {
      integrationWorktree: {
        realPath: 'C:\\secret\\integration',
        virtualPath: '/project/.worktrees/integration',
        branch: 'as3/run/integration',
        baseRevision: OLD_REVISION,
        headRevision: CURRENT_REVISION
      },
      verificationOperations: {
        pending: { operationId: 'verify-pending', revision: CURRENT_REVISION, status: 'pending', error: null },
        passed: { operationId: 'verify-passed', revision: CURRENT_REVISION, status: 'complete', error: null },
        failed: { operationId: 'verify-failed', revision: CURRENT_REVISION, status: 'failed', error: 'typecheck failed' },
        stale: { operationId: 'verify-stale', revision: OLD_REVISION, status: 'complete', error: null }
      },
      verifications: {
        passed: [record('typecheck', true, CURRENT_REVISION, 101), record('tests', true, CURRENT_REVISION, 102)],
        failed: [record('typecheck', false, CURRENT_REVISION, 103)],
        stale: [record('tests', true, OLD_REVISION, 104)]
      }
    });

    const status = projectControlCenterStatus(state, run, swarm([]), 30);
    const summaries = Object.fromEntries(status.tasks.map((entry) => [entry.id, entry.verification]));

    expect(summaries.none).toMatchObject({ status: 'none', total: 0, passed: 0, failed: 0, revision: null });
    expect(summaries.pending).toMatchObject({ status: 'pending', revision: CURRENT_REVISION });
    expect(summaries.passed).toMatchObject({ status: 'passed', total: 2, passed: 2, failed: 0, revision: CURRENT_REVISION, lastFinishedAt: 102 });
    expect(summaries.failed).toMatchObject({ status: 'failed', total: 1, passed: 0, failed: 1, error: 'typecheck failed' });
    expect(summaries.stale).toMatchObject({ status: 'stale', total: 1, passed: 1, failed: 0, revision: OLD_REVISION });
    expect(JSON.stringify(status)).not.toContain('C:\\secret\\integration');
  });

  it('reports only durable blockers and leaves needsAttention empty without explicit user-authority evidence', () => {
    const state = orchestration({
      runId: 'run-blocked',
      tasks: {
        blocked: task('blocked', { state: 'BLOCKED' }),
        verify: task('verify', { state: 'INTEGRATED' })
      }
    });
    const run = workflow('run-blocked', {
      status: 'blocked',
      reviewHistory: {
        blocked: [{ operationId: 'review-blocked', reviewerId: 'reviewer', round: 2, verdict: 'BLOCKED', findings: ['Needs an API contract decision'] }]
      },
      verificationOperations: {
        verify: { operationId: 'verify-op', revision: CURRENT_REVISION, status: 'failed', error: 'npm test failed' }
      }
    });

    const status = projectControlCenterStatus(state, run, swarm([]), 40);

    expect(status.tasks.find((entry) => entry.id === 'blocked')?.blockers).toContain('Review blocked: Needs an API contract decision');
    expect(status.tasks.find((entry) => entry.id === 'verify')?.blockers).toContain('Verification failed: npm test failed');
    expect(status.blockers).toEqual([
      { id: 'task:blocked:blocked', kind: 'task', taskId: 'blocked', summary: 'Review blocked: Needs an API contract decision' },
      { id: 'task:verify:verification', kind: 'verification', taskId: 'verify', summary: 'Verification failed: npm test failed' }
    ]);
    expect(status.needsAttention).toEqual([]);
    expect(status.run?.health).toBe('blocked');
    expect(status.browser).toMatchObject({ budget: 5, used: null, queued: null, status: 'unavailable' });
  });

  it('scrubs known native worktree paths from runtime error strings before they reach the renderer', () => {
    const taskNative = 'C:\\secret\\native\\task';
    const integrationNative = 'C:\\secret\\native\\integration';
    const state = orchestration({
      runId: 'run-path-scrub',
      tasks: { task: task('task', { state: 'INTEGRATING', worktreeId: 'wt-task' }) },
      worktrees: {
        'wt-task': {
          worktreeId: 'wt-task',
          taskId: 'task',
          branch: 'as3/run/task',
          baseRevision: OLD_REVISION,
          realPath: taskNative,
          virtualPath: '/project/.worktrees/task'
        }
      }
    });
    const run = workflow('run-path-scrub', {
      integrationWorktree: {
        realPath: integrationNative,
        virtualPath: '/project/.worktrees/integration',
        branch: 'as3/run/integration',
        baseRevision: OLD_REVISION,
        headRevision: CURRENT_REVISION
      },
      integrations: {
        task: {
          operationId: 'integrate-task',
          sourceRevision: CURRENT_REVISION,
          startingRevision: OLD_REVISION,
          integrationRevision: null,
          status: 'ambiguous',
          error: `conflict while using ${integrationNative}`
        }
      },
      verificationOperations: {
        task: {
          operationId: 'verify-task',
          revision: CURRENT_REVISION,
          status: 'failed',
          error: `verification failed in ${taskNative}`
        }
      }
    });

    const status = projectControlCenterStatus(state, run, swarm([]), 45);
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain(taskNative);
    expect(serialized).not.toContain(integrationNative);
    expect(serialized).toContain('/project/.worktrees/task');
    expect(status.blockers.map((entry) => entry.summary).join(' | ')).toContain('[native path hidden]');
  });

  it('sorts projections deterministically independent of record insertion and broker order', () => {
    const first = orchestration({
      runId: 'run-sort',
      managerAgentId: 'worker-b',
      tasks: {
        z: task('z', { dependencies: ['a'], assignedWorkerId: 'worker-b' }),
        a: task('a', { assignedWorkerId: 'worker-a' })
      }
    });
    const second = orchestration({
      ...first,
      tasks: { a: first.tasks.a!, z: first.tasks.z! }
    });

    const one = projectControlCenterStatus(first, workflow('run-sort'), swarm([agent('worker-b'), agent('worker-a')]), 50);
    const two = projectControlCenterStatus(second, workflow('run-sort'), swarm([agent('worker-a'), agent('worker-b')]), 50);

    expect(one).toEqual(two);
    expect(one.tasks.map((entry) => entry.id)).toEqual(['a', 'z']);
    expect(one.agents.map((entry) => entry.id)).toEqual(['worker-a', 'worker-b']);
  });
});

describe('Control Center loader', () => {
  it('loads recovered orchestration, matching workflow state and current swarm before projecting', async () => {
    const state = orchestration({ runId: 'run-loader', managerPlanId: 'plan-loader' });
    loaders.recover.mockResolvedValue({ lastSeq: 7, state });
    loaders.workflow.mockResolvedValue(workflow('run-loader'));
    loaders.runtime.mockResolvedValue({ runId: 'run-loader', agentId: 'manager', ownerPrimeConversationId: 'prime-owner' });
    loaders.swarmForCaller.mockReturnValue(swarm([]));
    loaders.browserPresent.mockReturnValue(true);
    loaders.browserTelemetry.mockReturnValue({ budget: 5, used: 2, queued: 1, observedAt: 99_980, receivedAt: 99_990 });
    vi.spyOn(Date, 'now').mockReturnValue(99_999);

    const status = await controlCenterStatus();

    expect(loaders.recover).toHaveBeenCalledTimes(1);
    expect(loaders.workflow).toHaveBeenCalledWith('run-loader');
    expect(loaders.runtime).toHaveBeenCalledWith('run-loader');
    expect(loaders.swarmForCaller).toHaveBeenCalledWith({ conversationId: 'prime-owner' });
    expect(loaders.browserPresent).toHaveBeenCalledTimes(1);
    expect(loaders.browserTelemetry).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      observedAt: 99_999,
      run: { id: 'run-loader', planId: 'plan-loader' },
      browser: { status: 'available', used: 2, queued: 1 }
    });
  });

  it('fails closed instead of borrowing same-named worker liveness when the durable owner row is missing', async () => {
    const state = orchestration({
      runId: 'run-owned',
      managerAgentId: 'worker-1',
      tasks: { task: task('task', { state: 'ACTIVE', assignedWorkerId: 'worker-1' }) }
    });
    loaders.recover.mockResolvedValue({ lastSeq: 8, state });
    loaders.workflow.mockResolvedValue(workflow('run-owned'));
    loaders.runtime.mockResolvedValue(null);

    const status = await controlCenterStatus();

    expect(loaders.swarmForCaller).not.toHaveBeenCalled();
    expect(status.agents).toEqual([
      expect.objectContaining({
        id: 'worker-1',
        state: 'unknown',
        chatBound: false,
        broker: { pending: null, awaitingAck: null, delivered: null }
      })
    ]);
  });
});
