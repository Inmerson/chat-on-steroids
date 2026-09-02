import { createHash, randomUUID } from 'node:crypto';

import {
  persistCriticalSwarmNow,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  stageMessages,
  stageSpawn,
  type Caller
} from '../agents.js';
import { primeWorkspace, type Workspace } from '../workspace.js';
import type { Root } from '../../shared/types.js';
import type { AgentInfo } from '../../shared/session.js';
import {
  assignmentEvidenceForPrime,
  bindTaskWorktree,
  brokerFreeSlotsForPrime,
  brokerWorkersForPrime,
  type AssignmentEvidence
} from './broker-assignment.js';
import { readyTaskIds } from './dag.js';
import { managerRuntimeForCaller } from './manager-authority.js';
import { recoverOrchestrationState } from './recovery.js';
import { appendOrchestrationEvent } from './store.js';
import { formatTaskContract } from './task-contract.js';
import type { AssignmentIntentRecord, TaskRecord, TaskWorktreeRecord } from './types.js';
import { ensureTaskWorktree, type WorktreeContext } from './worktree.js';
import { selectWorkerAllocation } from './worker-allocation.js';

export interface SchedulerRuntime {
  runId: string;
  managerAgentId: string;
  ownerPrimeConversationId: string;
}

export interface StagedSchedulerAssignment {
  workerId: string;
  conversationId: string | null;
  commit: () => void;
  rollback: () => void;
  publish: () => void | Promise<void>;
}

export interface SchedulerDependencies {
  primeWorkspaceForOwner(ownerPrimeConversationId: string): Workspace | null;
  ensureWorktree(context: WorktreeContext): Promise<TaskWorktreeRecord>;
  brokerWorkers(ownerPrimeConversationId: string): AgentInfo[];
  freeBrokerSlots(ownerPrimeConversationId: string): number;
  assignmentEvidence(ownerPrimeConversationId: string, operationId: string): AssignmentEvidence | null;
  stageSpawn(ownerPrimeConversationId: string, task: TaskRecord, contract: string): StagedSchedulerAssignment;
  stageReuse(ownerPrimeConversationId: string, workerId: string, contract: string): StagedSchedulerAssignment;
  persistBroker(): Promise<boolean>;
  bindWorkspace(workerId: string, conversationId: string | null, worktree: TaskWorktreeRecord): void;
  republish?(workerId: string): void | Promise<void>;
  /** Optional test diagnostic seam; production ignores it. */
  published?: string[];
}

export interface ScheduledTask {
  taskId: string;
  workerId: string;
  strategy: 'reuse' | 'spawn';
}

export interface SchedulerCycleResult {
  scheduled: ScheduledTask[];
  stillReady: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  needsWorkspace: boolean;
}

const DEFAULT_DEPS: SchedulerDependencies = {
  primeWorkspaceForOwner: (owner) => primeWorkspace(owner),
  ensureWorktree: (context) => ensureTaskWorktree(context),
  brokerWorkers: (owner) => brokerWorkersForPrime(owner),
  freeBrokerSlots: (owner) => brokerFreeSlotsForPrime(owner),
  assignmentEvidence: (owner, operationId) => assignmentEvidenceForPrime(owner, operationId),
  stageSpawn: (owner, task, contract) => {
    const staged = stageSpawn({
      caller: { conversationId: owner },
      workers: [{ label: task.title.slice(0, 80), task: contract }]
    });
    const created = staged.created[0];
    if (!created || staged.created.length !== 1) throw new Error('SCHEDULER_SPAWN_SHAPE: expected exactly one staged worker');
    return {
      workerId: created.id,
      conversationId: created.conversationId,
      commit: staged.commit,
      rollback: staged.rollback,
      publish: () => { requestWorkerBootstraps([created.id]); }
    };
  },
  stageReuse: (owner, workerId, contract) => {
    const workers = brokerWorkersForPrime(owner);
    const worker = workers.find((entry) => entry.id === workerId);
    if (!worker?.conversationId) throw new Error(`SCHEDULER_REUSE_IDENTITY: ${workerId} has no exact conversation`);
    const staged = stageMessages({ conversationId: owner }, [{ to: workerId, text: contract }]);
    return {
      workerId,
      conversationId: worker.conversationId,
      commit: staged.commit,
      rollback: staged.rollback,
      publish: () => { if (staged.waking.length > 0) requestWorkerRevivals(staged.waking); }
    };
  },
  persistBroker: () => persistCriticalSwarmNow(),
  bindWorkspace: (workerId, conversationId, worktree) => bindTaskWorktree(workerId, conversationId, worktree),
  republish: (workerId) => {
    requestWorkerBootstraps([workerId]);
    requestWorkerRevivals([workerId]);
  }
};

function digestContract(contract: string): string {
  return createHash('sha256').update(contract).digest('hex');
}

async function appendAssigned(
  runtime: SchedulerRuntime,
  task: TaskRecord,
  intent: AssignmentIntentRecord,
  workerId: string
): Promise<void> {
  await appendOrchestrationEvent({
    eventId: `assignment-result:${intent.operationId}`,
    runId: runtime.runId,
    time: Date.now(),
    type: 'TASK_ASSIGNED',
    actor: 'kernel',
    entityId: task.taskId,
    payload: { operationId: intent.operationId, workerId }
  });
}

async function appendAbort(runtime: SchedulerRuntime, taskId: string, intent: AssignmentIntentRecord, reason: string): Promise<void> {
  await appendOrchestrationEvent({
    eventId: `assignment-abort:${intent.operationId}`,
    runId: runtime.runId,
    time: Date.now(),
    type: 'TASK_ASSIGNMENT_ABORTED',
    actor: 'kernel',
    entityId: taskId,
    payload: { operationId: intent.operationId, reason }
  });
}

async function createAssignmentIntent(
  runtime: SchedulerRuntime,
  task: TaskRecord,
  state: Awaited<ReturnType<typeof recoverOrchestrationState>>['state'],
  deps: SchedulerDependencies
): Promise<AssignmentIntentRecord> {
  const allocation = selectWorkerAllocation({
    task,
    state,
    brokerWorkers: deps.brokerWorkers(runtime.ownerPrimeConversationId),
    managerAgentId: runtime.managerAgentId
  });
  const operationId = randomUUID();
  const contract = formatTaskContract(task, operationId);
  const intent: AssignmentIntentRecord = {
    operationId,
    taskId: task.taskId,
    strategy: allocation.strategy,
    requestedWorkerId: allocation.workerId,
    contractDigest: digestContract(contract)
  };
  await appendOrchestrationEvent({
    eventId: `assignment-intent:${operationId}`,
    runId: runtime.runId,
    time: Date.now(),
    type: 'TASK_ASSIGNMENT_INTENT',
    actor: 'kernel',
    entityId: task.taskId,
    payload: { intent }
  });
  return intent;
}

async function finishEvidenceAssignment(
  runtime: SchedulerRuntime,
  task: TaskRecord,
  intent: AssignmentIntentRecord,
  evidence: AssignmentEvidence,
  worktree: TaskWorktreeRecord,
  deps: SchedulerDependencies
): Promise<ScheduledTask> {
  if (intent.strategy === 'reuse' && intent.requestedWorkerId !== evidence.workerId) {
    throw new Error(`ASSIGNMENT_EVIDENCE_MISMATCH: ${evidence.workerId} != ${String(intent.requestedWorkerId)}`);
  }
  await appendAssigned(runtime, task, intent, evidence.workerId);
  const worker = deps.brokerWorkers(runtime.ownerPrimeConversationId).find((entry) => entry.id === evidence.workerId);
  deps.bindWorkspace(evidence.workerId, worker?.conversationId ?? null, worktree);
  if (deps.republish) await deps.republish(evidence.workerId);
  return { taskId: task.taskId, workerId: evidence.workerId, strategy: intent.strategy };
}

async function executeAssignment(
  runtime: SchedulerRuntime,
  task: TaskRecord,
  worktree: TaskWorktreeRecord,
  intent: AssignmentIntentRecord,
  deps: SchedulerDependencies
): Promise<ScheduledTask | null> {
  const contract = formatTaskContract(task, intent.operationId);
  if (digestContract(contract) !== intent.contractDigest) {
    throw new Error(`ASSIGNMENT_CONTRACT_CHANGED: task ${task.taskId} no longer matches its durable assignment intent`);
  }

  const evidence = deps.assignmentEvidence(runtime.ownerPrimeConversationId, intent.operationId);
  if (evidence) return finishEvidenceAssignment(runtime, task, intent, evidence, worktree, deps);

  const staged = intent.strategy === 'reuse'
    ? deps.stageReuse(runtime.ownerPrimeConversationId, intent.requestedWorkerId as string, contract)
    : deps.stageSpawn(runtime.ownerPrimeConversationId, task, contract);
  if (intent.strategy === 'reuse' && staged.workerId !== intent.requestedWorkerId) {
    staged.rollback();
    throw new Error(`ASSIGNMENT_WORKER_CHANGED: ${staged.workerId} != ${String(intent.requestedWorkerId)}`);
  }

  let accepted = false;
  try {
    accepted = await deps.persistBroker();
    if (!accepted) {
      staged.rollback();
      await appendAbort(runtime, task.taskId, intent, 'broker durability barrier returned false');
      return null;
    }
    staged.commit();
    // Browser publication intentionally remains after this durable orchestration result. If this
    // append fails, the intent remains and restart reconciliation finds the exact marker in the
    // already-durable broker snapshot instead of creating another worker/message.
    await appendAssigned(runtime, task, intent, staged.workerId);
    deps.bindWorkspace(staged.workerId, staged.conversationId, worktree);
    await staged.publish();
    return { taskId: task.taskId, workerId: staged.workerId, strategy: intent.strategy };
  } catch (error) {
    if (!accepted) {
      staged.rollback();
      try {
        await appendAbort(runtime, task.taskId, intent, error instanceof Error ? error.message : String(error));
      } catch {
        // Preserve the original failure; an unresolved durable intent is safer than lying that it cleared.
      }
    }
    throw error;
  }
}

async function promoteReadyTasks(runtime: SchedulerRuntime): Promise<void> {
  const recovered = await recoverOrchestrationState();
  const eligible = new Set(readyTaskIds(Object.values(recovered.state.tasks)));
  for (const task of Object.values(recovered.state.tasks)) {
    if (task.state !== 'PLANNED' || !eligible.has(task.taskId)) continue;
    await appendOrchestrationEvent({
      eventId: `scheduler-ready:${task.taskId}:${randomUUID()}`,
      runId: runtime.runId,
      time: Date.now(),
      type: 'TASK_READY',
      actor: 'kernel',
      entityId: task.taskId,
      payload: {}
    });
  }
}

async function restoreAssignedBindings(runtime: SchedulerRuntime, deps: SchedulerDependencies): Promise<void> {
  const recovered = await recoverOrchestrationState();
  const workers = deps.brokerWorkers(runtime.ownerPrimeConversationId);
  for (const task of Object.values(recovered.state.tasks)) {
    if (!task.assignedWorkerId || !task.worktreeId) continue;
    const worktree = recovered.state.worktrees[task.worktreeId];
    if (!worktree) continue;
    const worker = workers.find((entry) => entry.id === task.assignedWorkerId);
    deps.bindWorkspace(task.assignedWorkerId, worker?.conversationId ?? null, worktree);
    if (deps.republish) await deps.republish(task.assignedWorkerId);
  }
}

function worktreeErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function blockTaskIfSafe(runtime: SchedulerRuntime, taskId: string, reason: string): Promise<boolean> {
  const recovered = await recoverOrchestrationState();
  if (recovered.state.assignmentIntents[taskId] || recovered.state.worktreeIntents[taskId]) return false;
  const task = recovered.state.tasks[taskId];
  if (!task || task.state !== 'READY') return false;
  await appendOrchestrationEvent({
    eventId: `scheduler-blocked:${taskId}:${randomUUID()}`,
    runId: runtime.runId,
    time: Date.now(),
    type: 'TASK_BLOCKED',
    actor: 'kernel',
    entityId: taskId,
    payload: { reason }
  });
  return true;
}

export async function runSchedulerCycleForRuntime(
  runtime: SchedulerRuntime,
  roots: readonly Root[],
  deps: SchedulerDependencies = DEFAULT_DEPS
): Promise<SchedulerCycleResult> {
  let recovered = await recoverOrchestrationState();
  if (recovered.state.runId !== runtime.runId || recovered.state.managerAgentId !== runtime.managerAgentId) {
    throw new Error('SCHEDULER_AUTHORITY_MISMATCH: orchestration state does not belong to this Manager runtime');
  }

  const workspace = deps.primeWorkspaceForOwner(runtime.ownerPrimeConversationId);
  if (!workspace) {
    return {
      scheduled: [],
      stillReady: Object.values(recovered.state.tasks).filter((task) => task.state === 'READY').map((task) => task.taskId),
      blocked: [],
      needsWorkspace: true
    };
  }

  await promoteReadyTasks(runtime);
  await restoreAssignedBindings(runtime, deps);
  const scheduled: ScheduledTask[] = [];
  const blocked: Array<{ taskId: string; reason: string }> = [];

  // Recover durable assignment intents before starting new work. A crash may have occurred after
  // broker fsync but before TASK_ASSIGNED; exact marker evidence settles that window safely.
  recovered = await recoverOrchestrationState();
  for (const task of Object.values(recovered.state.tasks)) {
    const intent = recovered.state.assignmentIntents[task.taskId];
    if (!intent || task.state !== 'READY' || !task.worktreeId) continue;
    const worktree = recovered.state.worktrees[task.worktreeId];
    if (!worktree) throw new Error(`SCHEDULER_WORKTREE_MISSING: ${task.worktreeId}`);
    const evidence = deps.assignmentEvidence(runtime.ownerPrimeConversationId, intent.operationId);
    if (!evidence && deps.freeBrokerSlots(runtime.ownerPrimeConversationId) <= 0) continue;
    const result = await executeAssignment(runtime, task, worktree, intent, deps);
    if (result) scheduled.push(result);
  }

  recovered = await recoverOrchestrationState();
  for (const task of Object.values(recovered.state.tasks)) {
    if (task.state !== 'READY' || recovered.state.assignmentIntents[task.taskId]) continue;
    if (deps.freeBrokerSlots(runtime.ownerPrimeConversationId) <= 0) break;
    let worktree: TaskWorktreeRecord;
    try {
      worktree = await deps.ensureWorktree({ roots, primeWorkspace: workspace, runId: runtime.runId, task });
    } catch (error) {
      const reason = worktreeErrorReason(error);
      if (await blockTaskIfSafe(runtime, task.taskId, reason)) blocked.push({ taskId: task.taskId, reason });
      continue;
    }

    const current = await recoverOrchestrationState();
    const currentTask = current.state.tasks[task.taskId];
    if (!currentTask || currentTask.state !== 'READY') continue;
    const intent = await createAssignmentIntent(runtime, currentTask, current.state, deps);
    const result = await executeAssignment(runtime, currentTask, worktree, intent, deps);
    if (result) scheduled.push(result);
  }

  recovered = await recoverOrchestrationState();
  return {
    scheduled,
    stillReady: Object.values(recovered.state.tasks).filter((task) => task.state === 'READY').map((task) => task.taskId),
    blocked,
    needsWorkspace: false
  };
}

let schedulerTail: Promise<void> = Promise.resolve();
function enqueueScheduler<T>(work: () => Promise<T>): Promise<T> {
  const queued = schedulerTail.then(work);
  schedulerTail = queued.then(() => undefined, () => undefined);
  return queued;
}

export function runManagerSchedulerCycle(
  caller: Caller,
  roots: readonly Root[]
): Promise<SchedulerCycleResult> {
  return enqueueScheduler(async () => {
    const authority = await managerRuntimeForCaller(caller);
    return runSchedulerCycleForRuntime(
      {
        runId: authority.runId,
        managerAgentId: authority.agentId,
        ownerPrimeConversationId: authority.ownerPrimeConversationId
      },
      roots,
      DEFAULT_DEPS
    );
  });
}
