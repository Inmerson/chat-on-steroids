import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { childEnv } from '../exec.js';
import type { Workspace } from '../workspace.js';
import type { Root } from '../../shared/types.js';
import { recoverOrchestrationState } from './recovery.js';
import { appendOrchestrationEvent } from './store.js';
import type { TaskRecord, TaskWorktreeRecord, WorktreeIntentRecord } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const WORKTREE_DIR = '.chat-on-steroids-worktrees';

export interface WorktreePlan {
  operationId: string;
  record: WorktreeIntentRecord;
}

export interface WorktreeContext {
  roots: readonly Root[];
  primeWorkspace: Workspace;
  runId: string;
  task: TaskRecord;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: childEnv(),
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT
  });
  return stdout.trim();
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalExisting(target: string): Promise<string> {
  return path.resolve(await fs.realpath(target));
}

async function approvedRootFor(repoRoot: string, roots: readonly Root[]): Promise<{ root: Root; real: string }> {
  for (const root of roots) {
    try {
      const real = await canonicalExisting(root.path);
      if (inside(real, repoRoot)) return { root, real };
    } catch {
      // An inaccessible configured root is not authority for this operation.
    }
  }
  throw new Error('WORKTREE_OUTSIDE_APPROVED_ROOT: repository is not contained by an approved root');
}

function virtualFor(root: Root, rootReal: string, realPath: string): string {
  const relative = path.relative(rootReal, realPath).split(path.sep).filter(Boolean).join('/');
  return `/${root.name}${relative ? `/${relative}` : ''}`;
}

function safeTaskId(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return safe.slice(0, 80);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalExclude(repoRoot: string, worktreeParent: string): Promise<void> {
  if (!inside(repoRoot, worktreeParent)) return;
  const common = await git(repoRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = path.resolve(repoRoot, common);
  const infoDir = path.join(commonDir, 'info');
  const exclude = path.join(infoDir, 'exclude');
  const line = `/${WORKTREE_DIR}/`;
  await fs.mkdir(infoDir, { recursive: true });
  let held = '';
  try {
    held = await fs.readFile(exclude, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = held.split(/\r?\n/).map((value) => value.trim());
  if (lines.includes(line)) return;
  const prefix = held.length > 0 && !held.endsWith('\n') ? '\n' : '';
  await fs.appendFile(exclude, `${prefix}${line}\n`, 'utf8');
}

export async function planTaskWorktree(context: WorktreeContext): Promise<WorktreePlan> {
  const workspaceReal = await canonicalExisting(context.primeWorkspace.real);
  const repoRoot = await canonicalExisting(await git(workspaceReal, ['rev-parse', '--show-toplevel']));
  const status = await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status.length > 0) {
    throw new Error('WORKTREE_SOURCE_DIRTY: source repository has uncommitted or untracked user work');
  }
  const baseRevision = await git(repoRoot, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/i.test(baseRevision)) throw new Error('WORKTREE_BASE_INVALID: Git HEAD is not a full commit id');

  const approved = await approvedRootFor(repoRoot, context.roots);
  const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
  const runShort = context.runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 8) || 'run';
  const operationId = randomUUID();
  const taskSafe = safeTaskId(context.task.taskId);
  const opShort = operationId.slice(0, 8);
  const parent = path.join(approved.real, WORKTREE_DIR, repoHash, runShort);
  const realPath = path.join(parent, `${taskSafe}-${opShort}`);
  const branch = `as3/${runShort}/${taskSafe}-${opShort}`.slice(0, 179);
  const record: WorktreeIntentRecord = {
    operationId,
    worktreeId: `wt-${operationId}`,
    taskId: context.task.taskId,
    branch,
    baseRevision: baseRevision.toLowerCase(),
    realPath,
    virtualPath: virtualFor(approved.root, approved.real, realPath)
  };
  return { operationId, record };
}

export async function reconcileTaskWorktree(
  intent: WorktreeIntentRecord,
  roots: readonly Root[]
): Promise<'ready' | 'missing' | 'ambiguous'> {
  let contained = false;
  for (const root of roots) {
    try {
      const rootReal = await canonicalExisting(root.path);
      if (inside(rootReal, path.resolve(intent.realPath))) {
        contained = true;
        break;
      }
    } catch {
      // Ignore unavailable roots; they cannot prove ownership.
    }
  }
  if (!contained) return 'ambiguous';
  if (!(await exists(intent.realPath))) return 'missing';

  try {
    const real = await canonicalExisting(intent.realPath);
    if (real !== path.resolve(intent.realPath)) return 'ambiguous';
    const top = await canonicalExisting(await git(real, ['rev-parse', '--show-toplevel']));
    const revision = (await git(real, ['rev-parse', 'HEAD'])).toLowerCase();
    const branch = await git(real, ['branch', '--show-current']);
    if (top !== real || revision !== intent.baseRevision.toLowerCase() || branch !== intent.branch) return 'ambiguous';
    return 'ready';
  } catch {
    return 'ambiguous';
  }
}

async function publishReady(context: WorktreeContext, intent: WorktreeIntentRecord): Promise<TaskWorktreeRecord> {
  const worktree: TaskWorktreeRecord = {
    worktreeId: intent.worktreeId,
    taskId: intent.taskId,
    branch: intent.branch,
    baseRevision: intent.baseRevision,
    realPath: intent.realPath,
    virtualPath: intent.virtualPath
  };
  await appendOrchestrationEvent({
    eventId: `worktree-ready:${intent.operationId}`,
    runId: context.runId,
    time: Date.now(),
    type: 'TASK_WORKTREE_READY',
    actor: 'kernel',
    entityId: context.task.taskId,
    payload: { operationId: intent.operationId, worktree }
  });
  return worktree;
}

async function executeIntent(context: WorktreeContext, intent: WorktreeIntentRecord): Promise<TaskWorktreeRecord> {
  const workspaceReal = await canonicalExisting(context.primeWorkspace.real);
  const repoRoot = await canonicalExisting(await git(workspaceReal, ['rev-parse', '--show-toplevel']));
  const parent = path.dirname(intent.realPath);
  await ensureLocalExclude(repoRoot, parent);
  await fs.mkdir(parent, { recursive: true });

  try {
    await git(repoRoot, ['worktree', 'add', '-b', intent.branch, intent.realPath, intent.baseRevision]);
  } catch (error) {
    const state = await reconcileTaskWorktree(intent, context.roots);
    if (state === 'ready') return publishReady(context, intent);
    if (state === 'ambiguous') {
      throw new Error(`WORKTREE_RECONCILIATION_AMBIGUOUS: ${intent.realPath}`);
    }
    await appendOrchestrationEvent({
      eventId: `worktree-failed:${intent.operationId}`,
      runId: context.runId,
      time: Date.now(),
      type: 'TASK_WORKTREE_FAILED',
      actor: 'kernel',
      entityId: context.task.taskId,
      payload: { operationId: intent.operationId, reason: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }

  const reconciled = await reconcileTaskWorktree(intent, context.roots);
  if (reconciled !== 'ready') {
    if (reconciled === 'ambiguous') {
      throw new Error(`WORKTREE_RECONCILIATION_AMBIGUOUS: ${intent.realPath}`);
    }
    await appendOrchestrationEvent({
      eventId: `worktree-failed:${intent.operationId}`,
      runId: context.runId,
      time: Date.now(),
      type: 'TASK_WORKTREE_FAILED',
      actor: 'kernel',
      entityId: context.task.taskId,
      payload: { operationId: intent.operationId, reason: 'Git reported success but the worktree is missing' }
    });
    throw new Error('WORKTREE_MISSING_AFTER_CREATE');
  }
  return publishReady(context, intent);
}

export async function ensureTaskWorktree(context: WorktreeContext): Promise<TaskWorktreeRecord> {
  const recovered = await recoverOrchestrationState();
  if (recovered.state.runId !== context.runId) {
    throw new Error(`WORKTREE_RUN_MISMATCH: ${String(recovered.state.runId)} != ${context.runId}`);
  }
  const current = recovered.state.tasks[context.task.taskId];
  if (!current) throw new Error(`WORKTREE_UNKNOWN_TASK: ${context.task.taskId}`);
  if (current.state !== 'READY') throw new Error(`WORKTREE_TASK_NOT_READY: ${current.state}`);
  if (current.worktreeId) {
    const existing = recovered.state.worktrees[current.worktreeId];
    if (!existing) throw new Error(`WORKTREE_RECORD_MISSING: ${current.worktreeId}`);
    return existing;
  }

  const pending = recovered.state.worktreeIntents[current.taskId];
  if (pending) {
    const reconciled = await reconcileTaskWorktree(pending, context.roots);
    if (reconciled === 'ready') return publishReady(context, pending);
    if (reconciled === 'ambiguous') throw new Error(`WORKTREE_RECONCILIATION_AMBIGUOUS: ${pending.realPath}`);
    return executeIntent(context, pending);
  }

  const plan = await planTaskWorktree({ ...context, task: current });
  await appendOrchestrationEvent({
    eventId: `worktree-intent:${plan.operationId}`,
    runId: context.runId,
    time: Date.now(),
    type: 'TASK_WORKTREE_INTENT',
    actor: 'kernel',
    entityId: current.taskId,
    payload: { intent: plan.record }
  });
  return executeIntent(context, plan.record);
}
