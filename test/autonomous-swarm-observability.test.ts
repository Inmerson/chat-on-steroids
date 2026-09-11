import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { acceptInitialManagerPlan } from '../src/main/orchestration/manager-plan.js';
import { appendOrchestrationEvents, resetOrchestrationStoreForTests } from '../src/main/orchestration/store.js';
import {
  resetWorkflowStateForTests,
  submitTaskCompletionForRuntime,
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

async function completionFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-autonomous-observability-'));
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
  const baseRevision = await git(repo, ['rev-parse', 'HEAD']);

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
      taskId: 'T1',
      parentTaskId: null,
      title: 'Feature',
      goal: 'Implement feature',
      allowedScope: ['src/feature.ts'],
      dependencies: [],
      acceptanceCriteria: ['works'],
      expectedVerification: ['typecheck'],
      forbiddenActions: ['push', 'deploy'],
      riskClass: 'normal'
    }]
  });

  const worktree = {
    worktreeId: 'wt-1',
    taskId: 'T1',
    branch: 'as3/test/t1',
    baseRevision,
    realPath: repo,
    virtualPath: '/project'
  };
  await appendOrchestrationEvents([
    {
      eventId: 'wt-intent', runId: runtime.runId, time: 1, type: 'TASK_WORKTREE_INTENT', actor: 'kernel', entityId: 'T1',
      payload: { intent: { ...worktree, operationId: 'wt-op' } }
    },
    {
      eventId: 'wt-ready', runId: runtime.runId, time: 2, type: 'TASK_WORKTREE_READY', actor: 'kernel', entityId: 'T1',
      payload: { operationId: 'wt-op', worktree }
    },
    {
      eventId: 'assign-intent', runId: runtime.runId, time: 3, type: 'TASK_ASSIGNMENT_INTENT', actor: 'kernel', entityId: 'T1',
      payload: { intent: { operationId: 'assign-op', taskId: 'T1', strategy: 'spawn', requestedWorkerId: null, contractDigest: 'digest' } }
    },
    {
      eventId: 'assigned', runId: runtime.runId, time: 4, type: 'TASK_ASSIGNED', actor: 'kernel', entityId: 'T1',
      payload: { operationId: 'assign-op', workerId: 'worker-2' }
    },
    { eventId: 'active', runId: runtime.runId, time: 5, type: 'TASK_ACTIVATED', actor: 'kernel', entityId: 'T1', payload: {} }
  ]);

  await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const value = 2;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'feature']);
  const revision = await git(repo, ['rev-parse', 'HEAD']);

  const deps: WorkflowDependencies = {
    assignReviewer: async () => null,
    sendWorkerMessage: async () => false,
    messageEvidence: () => null,
    notifyManager: async () => undefined,
    integrateTask: async () => ({
      integrationRevision: revision,
      integrationWorktree: {
        realPath: repo,
        virtualPath: '/project',
        branch: worktree.branch,
        baseRevision,
        headRevision: revision
      }
    }),
    verifyTask: async () => ({ passed: false, records: [] }),
    schedule: async () => undefined,
    assignSystemReviewer: async () => null
  };
  return { runtime, revision, deps };
}

describe('Serialized Autonomous Swarms observability and persistence safety', () => {
  it('never persists credential-shaped worker completion prose verbatim', async () => {
    const f = await completionFixture();
    const fakeApiKey = 'sk-observability-test-1234567890abcdef';
    const fakeOpaqueToken = 'opaque_worker_secret_abcdefghijklmnopqrstuvwxyz0123456789';

    await submitTaskCompletionForRuntime(
      f.runtime,
      'worker-2',
      {
        taskId: 'T1',
        revision: f.revision,
        changedFiles: ['src/feature.ts'],
        verification: [{ command: `verify --token=${fakeApiKey}`, outcome: 'passed', revision: f.revision }],
        risks: [`authorization=Bearer ${fakeOpaqueToken}`],
        notes: [`debug credential ${fakeApiKey}`]
      },
      [],
      true,
      f.deps
    );

    const persisted = JSON.stringify(await workflowStateForRun(f.runtime.runId));
    expect(persisted).not.toContain(fakeApiKey);
    expect(persisted).not.toContain(fakeOpaqueToken);
    expect(persisted).toContain('***');
  });
});
