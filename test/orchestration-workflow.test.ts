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
import {
  resetWorkflowStateForTests,
  submitTaskCompletionForRuntime,
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

async function fixture() {
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
    tasks: [{
      taskId: 'T1', parentTaskId: null, title: 'Feature', goal: 'Implement feature',
      allowedScope: ['src/**'], dependencies: [], acceptanceCriteria: ['works'],
      expectedVerification: ['typecheck'], forbiddenActions: ['push', 'deploy'], riskClass: 'normal'
    }]
  });

  const worktree = {
    worktreeId: 'wt-1', taskId: 'T1', branch: 'as3/test/t1', baseRevision: base,
    realPath: repo, virtualPath: '/project'
  };
  await appendOrchestrationEvents([
    { eventId: 'wt-intent', runId: runtime.runId, time: 1, type: 'TASK_WORKTREE_INTENT', actor: 'kernel', entityId: 'T1', payload: { intent: { ...worktree, operationId: 'wt-op' } } },
    { eventId: 'wt-ready', runId: runtime.runId, time: 2, type: 'TASK_WORKTREE_READY', actor: 'kernel', entityId: 'T1', payload: { operationId: 'wt-op', worktree } },
    { eventId: 'assign-intent', runId: runtime.runId, time: 3, type: 'TASK_ASSIGNMENT_INTENT', actor: 'kernel', entityId: 'T1', payload: { intent: { operationId: 'assign-op', taskId: 'T1', strategy: 'spawn', requestedWorkerId: null, contractDigest: 'digest' } } },
    { eventId: 'assigned', runId: runtime.runId, time: 4, type: 'TASK_ASSIGNED', actor: 'kernel', entityId: 'T1', payload: { operationId: 'assign-op', workerId: 'worker-2' } },
    { eventId: 'active', runId: runtime.runId, time: 5, type: 'TASK_ACTIVATED', actor: 'kernel', entityId: 'T1', payload: {} }
  ]);

  await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const value = 2;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'feature']);
  const revision = await git(repo, ['rev-parse', 'HEAD']);

  const calls: string[] = [];
  const deps: WorkflowDependencies = {
    assignReviewer: async (_runtime, _task, _completion, operationId) => {
      calls.push(`review:${operationId}`);
      return 'reviewer-1';
    },
    sendWorkerMessage: async (_runtime, workerId, text) => {
      calls.push(`message:${workerId}:${text}`);
      return true;
    },
    notifyManager: async (_runtime, text) => { calls.push(`manager:${text}`); },
    integrateTask: async () => ({ integrationRevision: 'integration-1', integrationWorktree: { realPath: repo, virtualPath: '/project', branch: 'as3/integration', baseRevision: base } }),
    verifyTask: async () => ({ passed: true, records: [{ gate: 'focused', passed: true, revision: 'integration-1', outputDigest: 'ok', startedAt: 1, finishedAt: 2 }] }),
    schedule: async () => { calls.push('schedule'); },
    assignSystemReviewer: async () => null
  };
  return { dir, repo, base, revision, runtime, deps, calls };
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
});
