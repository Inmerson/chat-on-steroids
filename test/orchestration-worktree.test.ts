import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ensureTaskWorktree,
  planTaskWorktree,
  reconcileTaskWorktree
} from '../src/main/orchestration/worktree.js';
import {
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests
} from '../src/main/orchestration/store.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';
import type { Root } from '../src/shared/types.js';
import type { Workspace } from '../src/main/workspace.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true });
  return stdout.trim();
}

async function fixture(): Promise<{
  rootDir: string;
  repo: string;
  roots: Root[];
  workspace: Workspace;
}> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-as3-worktree-'));
  cleanup.push(rootDir);
  const repo = path.join(rootDir, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
  await git(repo, ['add', 'seed.txt']);
  await git(repo, ['-c', 'user.name=Chat On Steroids Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed']);
  initOrchestrationStore(path.join(rootDir, 'user-data'));
  return {
    rootDir,
    repo,
    roots: [{ name: 'project', path: rootDir }],
    workspace: { virtual: '/project/repo', real: repo, at: Date.now() }
  };
}

function task(taskId = 'T1'): TaskRecord {
  return {
    taskId,
    parentTaskId: null,
    title: 'Parser',
    goal: 'Implement parser support.',
    allowedScope: ['src/parser/**'],
    dependencies: [],
    acceptanceCriteria: ['Parser tests pass'],
    expectedVerification: ['npm test -- test/parser.test.ts'],
    forbiddenActions: ['push', 'deploy'],
    state: 'READY',
    assignedWorkerId: null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 2,
    riskClass: 'normal',
    completionPackage: null
  };
}

describe('V3 task worktrees', () => {
  it('creates a task worktree from the exact committed base and a dedicated branch', async () => {
    const f = await fixture();
    const record = await ensureTaskWorktree({ roots: f.roots, primeWorkspace: f.workspace, runId: 'run-12345678', task: task() });

    expect(record.taskId).toBe('T1');
    expect(record.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(record.branch).toMatch(/^as3\//);
    expect(path.resolve(record.realPath)).not.toBe(path.resolve(f.repo));
    expect(await git(record.realPath, ['rev-parse', 'HEAD'])).toBe(record.baseRevision);
    expect(await git(record.realPath, ['branch', '--show-current'])).toBe(record.branch);

    const events = await readOrchestrationEvents();
    expect(events.map((event) => event.type)).toEqual(['TASK_WORKTREE_INTENT', 'TASK_WORKTREE_READY']);
  });

  it('refuses a dirty source workspace before writing durable intent or creating a worktree', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, 'user-wip.txt'), 'uncommitted\n', 'utf8');

    await expect(
      ensureTaskWorktree({ roots: f.roots, primeWorkspace: f.workspace, runId: 'run-12345678', task: task() })
    ).rejects.toThrow(/dirty|uncommitted/i);
    expect(await readOrchestrationEvents()).toEqual([]);
  });

  it('reconciles an exact already-created path, branch, and revision after a simulated crash', async () => {
    const f = await fixture();
    const context = { roots: f.roots, primeWorkspace: f.workspace, runId: 'run-12345678', task: task() };
    const plan = await planTaskWorktree(context);

    await fs.mkdir(path.dirname(plan.record.realPath), { recursive: true });
    await git(f.repo, ['worktree', 'add', '-b', plan.record.branch, plan.record.realPath, plan.record.baseRevision]);

    expect(await reconcileTaskWorktree(plan.record, f.roots)).toBe('ready');
  });

  it('calls a mismatched existing path ambiguous and never overwrites it', async () => {
    const f = await fixture();
    const plan = await planTaskWorktree({ roots: f.roots, primeWorkspace: f.workspace, runId: 'run-12345678', task: task() });
    await fs.mkdir(plan.record.realPath, { recursive: true });
    await fs.writeFile(path.join(plan.record.realPath, 'keep-me.txt'), 'user data\n', 'utf8');

    expect(await reconcileTaskWorktree(plan.record, f.roots)).toBe('ambiguous');
    expect(await fs.readFile(path.join(plan.record.realPath, 'keep-me.txt'), 'utf8')).toBe('user data\n');
  });
});
