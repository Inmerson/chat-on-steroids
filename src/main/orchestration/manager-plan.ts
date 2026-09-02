import { createHash } from 'node:crypto';

import { readyTaskIds, validateTaskGraph } from './dag.js';
import { recoverOrchestrationState } from './recovery.js';
import { appendOrchestrationEvents, type NewOrchestrationEvent } from './store.js';
import { assertTaskContractFits } from './task-contract.js';
import type { TaskRecord, TaskRiskClass } from './types.js';

export const DEFAULT_TASK_RETRY_BUDGET = 2;
const MAX_MANAGER_TASKS = 200;
const MAX_ID_CHARS = 160;
const MAX_TEXT_CHARS = 4000;
const MAX_LIST_ITEMS = 100;

export interface ManagerTaskPlan {
  taskId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  allowedScope: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  expectedVerification: string[];
  forbiddenActions: string[];
  riskClass: TaskRiskClass;
}

export interface InitialManagerPlan {
  planId: string;
  runId: string;
  managerAgentId: string;
  tasks: ManagerTaskPlan[];
}

export interface ManagerPlanAcceptance {
  repeated: boolean;
  readyTaskIds: string[];
}

function boundedText(value: unknown, field: string, max = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must not be empty`);
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function boundedList(value: unknown, field: string, options: { allowEmpty?: boolean; maxText?: number } = {}): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (!options.allowEmpty && value.length === 0) throw new Error(`${field} must not be empty`);
  if (value.length > MAX_LIST_ITEMS) throw new Error(`${field} has too many entries`);
  return value.map((entry, index) => boundedText(entry, `${field}[${index}]`, options.maxText ?? MAX_TEXT_CHARS));
}

function normalizeTask(task: ManagerTaskPlan, index: number): TaskRecord {
  const prefix = `tasks[${index}]`;
  const taskId = boundedText(task.taskId, `${prefix}.taskId`, MAX_ID_CHARS);
  const parentTaskId =
    task.parentTaskId === null ? null : boundedText(task.parentTaskId, `${prefix}.parentTaskId`, MAX_ID_CHARS);
  const dependencies = boundedList(task.dependencies, `${prefix}.dependencies`, {
    allowEmpty: true,
    maxText: MAX_ID_CHARS
  });
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error(`Task ${taskId} repeats a dependency`);
  }
  if (task.riskClass !== 'normal' && task.riskClass !== 'high') {
    throw new Error(`Task ${taskId} has invalid risk class`);
  }
  return {
    taskId,
    parentTaskId,
    title: boundedText(task.title, `${prefix}.title`, 500),
    goal: boundedText(task.goal, `${prefix}.goal`),
    allowedScope: boundedList(task.allowedScope, `${prefix}.allowedScope`, { allowEmpty: true }),
    dependencies,
    acceptanceCriteria: boundedList(task.acceptanceCriteria, `${prefix}.acceptanceCriteria`),
    expectedVerification: boundedList(task.expectedVerification, `${prefix}.expectedVerification`, { allowEmpty: true }),
    forbiddenActions: boundedList(task.forbiddenActions, `${prefix}.forbiddenActions`, { allowEmpty: true }),
    state: 'PLANNED',
    assignedWorkerId: null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: DEFAULT_TASK_RETRY_BUDGET,
    riskClass: task.riskClass,
    completionPackage: null
  };
}

function validateParentHierarchy(tasks: readonly TaskRecord[]): void {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const task of tasks) {
    if (task.parentTaskId !== null && !byId.has(task.parentTaskId)) {
      throw new Error(`Task ${task.taskId} has missing parent: ${task.parentTaskId}`);
    }
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    let currentId: string | null = task.taskId;
    while (currentId !== null) {
      if (seen.has(currentId)) throw new Error(`Task parent cycle includes ${currentId}`);
      seen.add(currentId);
      currentId = byId.get(currentId)?.parentTaskId ?? null;
    }
  }
}

function normalizePlan(input: InitialManagerPlan): {
  planId: string;
  runId: string;
  managerAgentId: string;
  tasks: TaskRecord[];
} {
  const planId = boundedText(input.planId, 'planId', MAX_ID_CHARS);
  const runId = boundedText(input.runId, 'runId', MAX_ID_CHARS);
  const managerAgentId = boundedText(input.managerAgentId, 'managerAgentId', MAX_ID_CHARS);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error('Manager plan requires at least one task');
  if (input.tasks.length > MAX_MANAGER_TASKS) throw new Error(`Manager plan exceeds ${MAX_MANAGER_TASKS} tasks`);
  const tasks = input.tasks.map(normalizeTask);

  validateTaskGraph(tasks);
  validateParentHierarchy(tasks);
  for (const task of tasks) assertTaskContractFits(task);
  return { planId, runId, managerAgentId, tasks };
}

function fingerprint(plan: ReturnType<typeof normalizePlan>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: plan.runId,
        managerAgentId: plan.managerAgentId,
        tasks: plan.tasks.map((task) => ({
          taskId: task.taskId,
          parentTaskId: task.parentTaskId,
          title: task.title,
          goal: task.goal,
          allowedScope: task.allowedScope,
          dependencies: task.dependencies,
          acceptanceCriteria: task.acceptanceCriteria,
          expectedVerification: task.expectedVerification,
          forbiddenActions: task.forbiddenActions,
          riskClass: task.riskClass
        }))
      })
    )
    .digest('hex');
}

function rootTaskIds(tasks: readonly TaskRecord[]): string[] {
  return tasks.filter((task) => task.dependencies.length === 0).map((task) => task.taskId);
}

export async function acceptInitialManagerPlan(input: InitialManagerPlan): Promise<ManagerPlanAcceptance> {
  // Every validation and normalization step happens before the first journal mutation.
  const plan = normalizePlan(input);
  const planFingerprint = fingerprint(plan);
  const recovered = await recoverOrchestrationState();
  const current = recovered.state;

  if (current.runId !== null) {
    if (current.runId !== plan.runId) {
      throw new Error(`Orchestration run ${current.runId} is already active; cannot accept plan for ${plan.runId}`);
    }
    if (current.managerPlanId !== plan.planId) {
      throw new Error(`Orchestration run ${plan.runId} already has Manager plan ${current.managerPlanId ?? 'unversioned'}`);
    }
    if (current.managerAgentId !== plan.managerAgentId || current.managerPlanFingerprint !== planFingerprint) {
      throw new Error(`Manager plan ${plan.planId} was already accepted with different content or authority`);
    }
    return { repeated: true, readyTaskIds: rootTaskIds(Object.values(current.tasks)) };
  }

  if (Object.keys(current.tasks).length > 0 || current.managerAgentId !== null || current.managerPlanId !== null) {
    throw new Error('Orchestration state is inconsistent: unowned V3 planning state already exists');
  }

  const initialReady = readyTaskIds(plan.tasks);
  const now = Date.now();
  const actor = plan.managerAgentId;
  const events: NewOrchestrationEvent[] = [
    {
      eventId: `${plan.planId}:run-created`,
      runId: plan.runId,
      time: now,
      type: 'RUN_CREATED',
      actor: 'kernel',
      entityId: plan.runId,
      payload: { planId: plan.planId }
    },
    {
      eventId: `${plan.planId}:manager-assigned`,
      runId: plan.runId,
      time: now,
      type: 'MANAGER_ASSIGNED',
      actor: 'kernel',
      entityId: plan.managerAgentId,
      payload: {
        managerAgentId: plan.managerAgentId,
        planId: plan.planId,
        planFingerprint
      }
    },
    ...plan.tasks.map<NewOrchestrationEvent>((task) => ({
      eventId: `${plan.planId}:task:${task.taskId}:created`,
      runId: plan.runId,
      time: now,
      type: 'TASK_CREATED',
      actor,
      entityId: task.taskId,
      payload: { task }
    })),
    ...initialReady.map<NewOrchestrationEvent>((taskId) => ({
      eventId: `${plan.planId}:task:${taskId}:ready`,
      runId: plan.runId,
      time: now,
      type: 'TASK_READY',
      actor: 'kernel',
      entityId: taskId,
      payload: {}
    }))
  ];

  await appendOrchestrationEvents(events);
  return { repeated: false, readyTaskIds: initialReady };
}
