import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { acceptInitialManagerPlan } from '../src/main/orchestration/manager-plan.js';
import { recoverOrchestrationState } from '../src/main/orchestration/recovery.js';
import { appendOrchestrationEvents, resetOrchestrationStoreForTests } from '../src/main/orchestration/store.js';
import * as workflowModule from '../src/main/orchestration/workflow.js';
import {
  resetWorkflowStateForTests,
  submitTaskCompletionForRuntime,
  submitRunReviewForRuntime,
  submitTaskReviewForRuntime,
  workflowStateForRun,
  type WorkflowDependencies,
  type WorkflowRuntime
} from '../src/main/orchestration/workflow.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function fixture(taskCount: 1 | 2 = 1) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-as3-workflow-'));
  cleanup.push(dir);
  initDurableStore(dir);
  await resetWorkflowStateForTests();

  const repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await git(dir, ['init', repo]);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const value = 1;\n');
  if (taskCount === 2) await fs.writeFile(path.join(repo, 'src', 'feature2.ts'), 'export const value2 = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  const runtime: WorkflowRuntime = {
    runId: 'run-1',
    managerAgentId: 'worker-manager',
    ownerPrimeConversationId: 'prime-chat'
  };
  await acceptInitialManagerPlan({
    planId: 'plan-1',
    runId: runtime.runId,
    managerAgentId: runtime.managerAgentId,
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const number = index + 1;
      return {
        taskId: `T${number}`, parentTaskId: null, title: `Feature ${number}`, goal: `Implement feature ${number}`,
        allowedScope: [`src/feature${number === 1 ? '' : number}.ts`], dependencies: [], acceptanceCriteria: ['works'],
        expectedVerification: ['typecheck'], forbiddenActions: ['push', 'deploy'], riskClass: 'normal' as const
      };
    })
  });

  const worktree = {
    worktreeId: 'wt-1', taskId: 'T1', branch: 'as3/test/t1', baseRevision: base,
    realPath: repo, virtualPath: '/project'
  };
  const setupEvents: Array<Parameters<typeof appendOrchestrationEvents>[0][number]> = [
    { eventId: 'wt-intent', runId: runtime.runId, time: 1, type: 'TASK_WORKTREE_INTENT', actor: 'kernel', entityId: 'T1', payload: { intent: { ...worktree, operationId: 'wt-op' } } },
    { eventId: 'wt-ready', runId: runtime.runId, time: 2, type: 'TASK_WORKTREE_READY', actor: 'kernel', entityId: 'T1', payload: { operationId: 'wt-op', worktree } },
    { eventId: 'assign-intent', runId: runtime.runId, time: 3, type: 'TASK_ASSIGNMENT_INTENT', actor: 'kernel', entityId: 'T1', payload: { intent: { operationId: 'assign-op', taskId: 'T1', strategy: 'spawn', requestedWorkerId: null, contractDigest: 'digest' } } },
    { eventId: 'assigned', runId: runtime.runId, time: 4, type: 'TASK_ASSIGNED', actor: 'kernel', entityId: 'T1', payload: { operationId: 'assign-op', workerId: 'worker-2' } },
    { eventId: 'active', runId: runtime.runId, time: 5, type: 'TASK_ACTIVATED', actor: 'kernel', entityId: 'T1', payload: {} }
  ];
  let repo2: string | null = null;
  if (taskCount === 2) {
    repo2 = path.join(dir, 'repo-t2');
    await git(repo, ['worktree', 'add', '-b', 'as3/test/t2', repo2, base]);
    const worktree2 = {
      worktreeId: 'wt-2', taskId: 'T2', branch: 'as3/test/t2', baseRevision: base,
      realPath: repo2, virtualPath: '/project-t2'
    };
    setupEvents.push(
      { eventId: 'wt2-intent', runId: runtime.runId, time: 6, type: 'TASK_WORKTREE_INTENT', actor: 'kernel', entityId: 'T2', payload: { intent: { ...worktree2, operationId: 'wt2-op' } } },
      { eventId: 'wt2-ready', runId: runtime.runId, time: 7, type: 'TASK_WORKTREE_READY', actor: 'kernel', entityId: 'T2', payload: { operationId: 'wt2-op', worktree: worktree2 } },
      { eventId: 'assign2-intent', runId: runtime.runId, time: 8, type: 'TASK_ASSIGNMENT_INTENT', actor: 'kernel', entityId: 'T2', payload: { intent: { operationId: 'assign2-op', taskId: 'T2', strategy: 'spawn', requestedWorkerId: null, contractDigest: 'digest2' } } },
      { eventId: 'assigned2', runId: runtime.runId, time: 9, type: 'TASK_ASSIGNED', actor: 'kernel', entityId: 'T2', payload: { operationId: 'assign2-op', workerId: 'worker-3' } },
      { eventId: 'active2', runId: runtime.runId, time: 10, type: 'TASK_ACTIVATED', actor: 'kernel', entityId: 'T2', payload: {} }
    );
  }
  await appendOrchestrationEvents(setupEvents);

  await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const value = 2;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'feature']);
  const revision = await git(repo, ['rev-parse', 'HEAD']);
  let revision2: string | null = null;
  if (repo2) {
    await fs.writeFile(path.join(repo2, 'src', 'feature2.ts'), 'export const value2 = 2;\n');
    await git(repo2, ['add', '.']);
    await git(repo2, ['commit', '-m', 'feature 2']);
    revision2 = await git(repo2, ['rev-parse', 'HEAD']);
  }

  const calls: string[] = [];
  const deps: WorkflowDependencies = {
    assignReviewer: async (_runtime, task, _completion, operationId) => {
      calls.push(`review:${operationId}`);
      return task.taskId === 'T1' ? 'reviewer-1' : 'reviewer-2';
    },
    sendWorkerMessage: async (_runtime, workerId, text) => {
      calls.push(`message:${workerId}:${text}`);
      return true;
    },
    notifyManager: async (_runtime, text) => { calls.push(`manager:${text}`); },
    integrateTask: async (_runtime, task) => {
      const integrationRevision = task.taskId === 'T1' ? 'integration-1' : 'integration-2';
      return { integrationRevision, integrationWorktree: { realPath: repo, virtualPath: '/project', branch: 'as3/integration', baseRevision: base, headRevision: integrationRevision } };
    },
    verifyTask: async (_runtime, task, integration) => {
      calls.push(`verify:${task.taskId}:${integration.integrationRevision}`);
      return { passed: true, records: [{ gate: 'focused', command: 'npm test -- --run', passed: true, revision: integration.integrationRevision, outputDigest: 'ok', startedAt: 1, finishedAt: 2 }] };
    },
    schedule: async () => { calls.push('schedule'); },
    assignSystemReviewer: async () => null
  };
  return { dir, repo, repo2, base, revision, revision2, runtime, deps, calls };
}

describe('Agent System 3.0 completion/review workflow', () => {
  it('accepts only the assigned worker exact clean revision and routes it to review', async () => {
    const f = await fixture();
    const result = await submitTaskCompletionForRuntime(
      f.runtime,
      'worker-2',
      { taskId: 'T1', revision: f.revision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [],
      true,
      f.deps
    );
    expect(result.reviewerId).toBe('reviewer-1');
    const recovered = await recoverOrchestrationState();
    expect(recovered.state.tasks.T1?.state).toBe('REVIEWING');
    expect((await workflowStateForRun('run-1'))?.completions.T1?.revision).toBe(f.revision);
  });

  it('rejects a completion claim that does not match Git HEAD without changing task state', async () => {
    const f = await fixture();
    await expect(submitTaskCompletionForRuntime(
      f.runtime, 'worker-2',
      { taskId: 'T1', revision: f.base, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [], true, f.deps
    )).rejects.toThrow(/head|revision/i);
    expect((await recoverOrchestrationState()).state.tasks.T1?.state).toBe('ACTIVE');
  });

  it('lets only the assigned reviewer approve, then integrates, verifies and unlocks scheduling', async () => {
    const f = await fixture();
    await submitTaskCompletionForRuntime(
      f.runtime, 'worker-2',
      { taskId: 'T1', revision: f.revision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [], true, f.deps
    );

    await expect(submitTaskReviewForRuntime(
      f.runtime, 'worker-9', { taskId: 'T1', verdict: 'APPROVED', findings: ['looks good'] }, [], true, f.deps
    )).rejects.toThrow(/reviewer/i);

    await submitTaskReviewForRuntime(
      f.runtime, 'reviewer-1', { taskId: 'T1', verdict: 'APPROVED', findings: ['looks good'] }, [], true, f.deps
    );

    expect((await recoverOrchestrationState()).state.tasks.T1?.state).toBe('VERIFIED');
    expect(f.calls).toContain('schedule');
    expect((await workflowStateForRun('run-1'))?.verifications.T1?.[0]?.revision).toBe('integration-1');
  });

  it('bounds review correction loops at three rounds instead of cycling forever', async () => {
    const f = await fixture();
    for (let round = 1; round <= 3; round++) {
      const currentRevision = await git(f.repo, ['rev-parse', 'HEAD']);
      await submitTaskCompletionForRuntime(
        f.runtime, 'worker-2',
        { taskId: 'T1', revision: currentRevision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
        [], true, f.deps
      );
      await submitTaskReviewForRuntime(
        f.runtime, 'reviewer-1', { taskId: 'T1', verdict: 'CHANGES_REQUESTED', findings: [`round ${round}`] }, [], true, f.deps
      );
      if (round < 3) {
        await fs.writeFile(path.join(f.repo, 'src', 'feature.ts'), `export const value = ${round + 2};\n`);
        await git(f.repo, ['add', '.']);
        await git(f.repo, ['commit', '-m', `fix ${round}`]);
      }
    }
    expect((await recoverOrchestrationState()).state.tasks.T1?.state).toBe('BLOCKED');
  });

  it('does not accept passed verification evidence that is bound to a different integration revision', async () => {
    const f = await fixture();
    const deps: WorkflowDependencies = {
      ...f.deps,
      verifyTask: async () => ({
        passed: true,
        records: [{
          gate: 'focused',
          command: 'npm test -- --run test/focused.test.ts',
          passed: true,
          revision: 'stale-integration-revision',
          outputDigest: 'stale',
          startedAt: 1,
          finishedAt: 2
        }]
      })
    };

    await submitTaskCompletionForRuntime(
      f.runtime, 'worker-2',
      { taskId: 'T1', revision: f.revision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [], true, deps
    );
    await submitTaskReviewForRuntime(
      f.runtime, 'reviewer-1', { taskId: 'T1', verdict: 'APPROVED', findings: [] }, [], true, deps
    );

    expect((await recoverOrchestrationState()).state.tasks.T1?.state).toBe('INTEGRATED');
    expect((await workflowStateForRun('run-1'))?.status).toBe('needs_verification');
  });

  it('records durable RUN_VERIFIED only after the assigned System Reviewer approves the fresh integrated run', async () => {
    const f = await fixture();
    const deps: WorkflowDependencies = {
      ...f.deps,
      assignSystemReviewer: async () => 'system-reviewer'
    };

    await submitTaskCompletionForRuntime(
      f.runtime, 'worker-2',
      { taskId: 'T1', revision: f.revision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [], true, deps
    );
    await submitTaskReviewForRuntime(
      f.runtime, 'reviewer-1', { taskId: 'T1', verdict: 'APPROVED', findings: [] }, [], true, deps
    );
    expect((await workflowStateForRun('run-1'))?.systemReview?.reviewerId).toBe('system-reviewer');

    await expect(submitRunReviewForRuntime(f.runtime, 'worker-9', 'APPROVED', [], deps)).rejects.toThrow(/System Reviewer/i);
    await submitRunReviewForRuntime(f.runtime, 'system-reviewer', 'APPROVED', [], deps);

    const recovered = await recoverOrchestrationState();
    expect(recovered.state.runStatus).toBe('RUN_VERIFIED');
    expect((await workflowStateForRun('run-1'))?.status).toBe('verified');
  });

  it('re-verifies earlier integrated tasks at the newest shared integration revision', async () => {
    const f = await fixture(2);
    await submitTaskCompletionForRuntime(
      f.runtime, 'worker-2',
      { taskId: 'T1', revision: f.revision, changedFiles: ['src/feature.ts'], verification: [], risks: [], notes: [] },
      [], true, f.deps
    );
    await submitTaskReviewForRuntime(
      f.runtime, 'reviewer-1', { taskId: 'T1', verdict: 'APPROVED', findings: [] }, [], true, f.deps
    );
    expect((await workflowStateForRun('run-1'))?.verifications.T1?.[0]?.revision).toBe('integration-1');

    await submitTaskCompletionForRuntime(
      f.runtime, 'worker-3',
      { taskId: 'T2', revision: f.revision2!, changedFiles: ['src/feature2.ts'], verification: [], risks: [], notes: [] },
      [], true, f.deps
    );
    await submitTaskReviewForRuntime(
      f.runtime, 'reviewer-2', { taskId: 'T2', verdict: 'APPROVED', findings: [] }, [], true, f.deps
    );

    const run = await workflowStateForRun('run-1');
    expect(run?.verifications.T1?.[0]?.revision).toBe('integration-2');
    expect(run?.verifications.T2?.[0]?.revision).toBe('integration-2');
    expect(f.calls).toContain('verify:T1:integration-2');
  });

  it('recovers the same integration operation after a crash following cherry-pick without replaying it', async () => {
    const f = await fixture();
    const integrateTaskWithGit = (workflowModule as any).integrateTaskWithGit as undefined | ((...args: any[]) => Promise<any>);
    expect(typeof integrateTaskWithGit).toBe('function');
    if (!integrateTaskWithGit) return;
    const orchestration = await recoverOrchestrationState();
    const task = orchestration.state.tasks.T1!;
    const taskWorktree = orchestration.state.worktrees['wt-1']!;
    const completion = {
      status: 'ready_for_review' as const,
      revision: f.revision,
      changedFiles: ['src/feature.ts'],
      verification: [], risks: [], notes: []
    };
    const attempt = {
      operationId: 'integration-op', sourceRevision: f.revision, startingRevision: f.base,
      integrationRevision: null, status: 'pending' as const, error: null
    };

    const first = await integrateTaskWithGit(f.runtime, task, completion, taskWorktree, null, attempt);
    const second = await integrateTaskWithGit(f.runtime, task, completion, taskWorktree, null, attempt);

    expect(second.integrationRevision).toBe(first.integrationRevision);
    const count = Number(await git(first.integrationWorktree.realPath, ['rev-list', '--count', `${f.base}..HEAD`]));
    expect(count).toBe(1);
  });
});
