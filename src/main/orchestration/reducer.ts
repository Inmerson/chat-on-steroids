import { transitionTask } from './task-state.js';
import type { OrchestrationEvent, OrchestrationEventType } from './store.js';
import type {
  AssignmentIntentRecord,
  TaskRecord,
  TaskState,
  TaskWorktreeRecord,
  WorktreeIntentRecord
} from './types.js';

export interface OrchestrationState {
  runId: string | null;
  managerAgentId: string | null;
  managerPlanId: string | null;
  managerPlanFingerprint: string | null;
  tasks: Record<string, TaskRecord>;
  assignmentIntents: Record<string, AssignmentIntentRecord>;
  worktreeIntents: Record<string, WorktreeIntentRecord>;
  worktrees: Record<string, TaskWorktreeRecord>;
}

export const EMPTY_ORCHESTRATION_STATE: OrchestrationState = {
  runId: null,
  managerAgentId: null,
  managerPlanId: null,
  managerPlanFingerprint: null,
  tasks: {},
  assignmentIntents: {},
  worktreeIntents: {},
  worktrees: {}
};

const TASK_EVENT_STATES: Partial<Record<OrchestrationEventType, TaskState>> = {
  TASK_READY: 'READY',
  TASK_ACTIVATED: 'ACTIVE',
  TASK_BLOCKED: 'BLOCKED',
  TASK_REVIEW_READY: 'READY_FOR_REVIEW',
  TASK_REVIEWING: 'REVIEWING',
  TASK_CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  TASK_APPROVED: 'APPROVED',
  TASK_INTEGRATING: 'INTEGRATING',
  TASK_INTEGRATED: 'INTEGRATED',
  TASK_VERIFIED: 'VERIFIED',
  TASK_FAILED: 'FAILED',
  TASK_CANCELLED: 'CANCELLED',
  TASK_SUPERSEDED: 'SUPERSEDED'
};

function withTask(state: OrchestrationState, task: TaskRecord): OrchestrationState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [task.taskId]: task
    }
  };
}

function taskFor(state: OrchestrationState, taskId: string): TaskRecord {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown orchestration task: ${taskId}`);
  return task;
}

function requireSameRun(state: OrchestrationState, event: OrchestrationEvent): void {
  if (state.runId !== null && state.runId !== event.runId) {
    throw new Error(`Orchestration run mismatch: ${state.runId} != ${event.runId}`);
  }
}

function payloadString(event: OrchestrationEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${event.type} requires payload.${key}`);
  }
  return value;
}

function payloadRecord(event: OrchestrationEvent, key: string): Record<string, unknown> {
  const value = event.payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${event.type} requires payload.${key}`);
  }
  return value as Record<string, unknown>;
}

function recordString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} requires ${key}`);
  return value;
}

function worktreeIntentFrom(event: OrchestrationEvent): WorktreeIntentRecord {
  const record = payloadRecord(event, 'intent');
  return {
    operationId: recordString(record, 'operationId', event.type),
    taskId: recordString(record, 'taskId', event.type),
    worktreeId: recordString(record, 'worktreeId', event.type),
    branch: recordString(record, 'branch', event.type),
    baseRevision: recordString(record, 'baseRevision', event.type),
    realPath: recordString(record, 'realPath', event.type),
    virtualPath: recordString(record, 'virtualPath', event.type)
  };
}

function worktreeFrom(event: OrchestrationEvent): TaskWorktreeRecord {
  const record = payloadRecord(event, 'worktree');
  return {
    worktreeId: recordString(record, 'worktreeId', event.type),
    taskId: recordString(record, 'taskId', event.type),
    branch: recordString(record, 'branch', event.type),
    baseRevision: recordString(record, 'baseRevision', event.type),
    realPath: recordString(record, 'realPath', event.type),
    virtualPath: recordString(record, 'virtualPath', event.type)
  };
}

function assignmentIntentFrom(event: OrchestrationEvent): AssignmentIntentRecord {
  const record = payloadRecord(event, 'intent');
  const strategy = record['strategy'];
  if (strategy !== 'reuse' && strategy !== 'spawn') {
    throw new Error(`${event.type} requires intent.strategy reuse or spawn`);
  }
  const requestedWorkerId = record['requestedWorkerId'];
  if (requestedWorkerId !== null && (typeof requestedWorkerId !== 'string' || requestedWorkerId.length === 0)) {
    throw new Error(`${event.type} has invalid intent.requestedWorkerId`);
  }
  if (strategy === 'reuse' && requestedWorkerId === null) {
    throw new Error(`${event.type} reuse intent requires requestedWorkerId`);
  }
  if (strategy === 'spawn' && requestedWorkerId !== null) {
    throw new Error(`${event.type} spawn intent must not preselect a worker`);
  }
  return {
    operationId: recordString(record, 'operationId', event.type),
    taskId: recordString(record, 'taskId', event.type),
    strategy,
    requestedWorkerId,
    contractDigest: recordString(record, 'contractDigest', event.type)
  };
}

function requireNoPendingOperation(state: OrchestrationState, taskId: string, eventType: string): void {
  if (state.worktreeIntents[taskId]) {
    throw new Error(`${eventType} cannot hide pending worktree intent for ${taskId}`);
  }
  if (state.assignmentIntents[taskId]) {
    throw new Error(`${eventType} cannot hide pending assignment intent for ${taskId}`);
  }
}

function sameWorktree(left: WorktreeIntentRecord, right: TaskWorktreeRecord): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.taskId === right.taskId &&
    left.branch === right.branch &&
    left.baseRevision === right.baseRevision &&
    left.realPath === right.realPath &&
    left.virtualPath === right.virtualPath
  );
}

export function applyOrchestrationEvent(state: OrchestrationState, event: OrchestrationEvent): OrchestrationState {
  requireSameRun(state, event);

  if (event.type === 'RUN_CREATED') {
    return state.runId === event.runId ? state : { ...state, runId: event.runId };
  }

  if (event.type === 'MANAGER_ASSIGNED') {
    if (state.runId === null) throw new Error('MANAGER_ASSIGNED requires an existing orchestration run');
    const managerAgentId = payloadString(event, 'managerAgentId');
    const managerPlanId = payloadString(event, 'planId');
    const managerPlanFingerprint = payloadString(event, 'planFingerprint');
    if (event.entityId !== managerAgentId) {
      throw new Error(`MANAGER_ASSIGNED entity mismatch: ${event.entityId} != ${managerAgentId}`);
    }
    if (state.managerAgentId !== null || state.managerPlanId !== null || state.managerPlanFingerprint !== null) {
      throw new Error('Orchestration Manager is already assigned');
    }
    return { ...state, managerAgentId, managerPlanId, managerPlanFingerprint };
  }

  if (event.type === 'TASK_CREATED') {
    const created = event.payload.task;
    if (!created || typeof created !== 'object' || Array.isArray(created)) {
      throw new Error('TASK_CREATED requires payload.task');
    }
    const task = created as unknown as TaskRecord;
    if (task.taskId !== event.entityId) {
      throw new Error(`TASK_CREATED entity mismatch: ${event.entityId} != ${task.taskId}`);
    }
    if (state.tasks[task.taskId]) throw new Error(`Duplicate orchestration task: ${task.taskId}`);
    return withTask({ ...state, runId: state.runId ?? event.runId }, task);
  }

  if (event.type === 'TASK_WORKTREE_INTENT') {
    const current = taskFor(state, event.entityId);
    if (current.state !== 'READY') throw new Error(`TASK_WORKTREE_INTENT requires READY task ${event.entityId}`);
    if (current.worktreeId !== null) throw new Error(`${event.entityId} already has worktree ${current.worktreeId}`);
    if (state.worktreeIntents[event.entityId]) throw new Error(`${event.entityId} already has a worktree intent`);
    if (state.assignmentIntents[event.entityId]) throw new Error(`${event.entityId} already has an assignment intent`);
    const intent = worktreeIntentFrom(event);
    if (intent.taskId !== event.entityId) {
      throw new Error(`TASK_WORKTREE_INTENT entity mismatch: ${event.entityId} != ${intent.taskId}`);
    }
    return {
      ...state,
      worktreeIntents: { ...state.worktreeIntents, [event.entityId]: intent }
    };
  }

  if (event.type === 'TASK_WORKTREE_READY') {
    const current = taskFor(state, event.entityId);
    const intent = state.worktreeIntents[event.entityId];
    if (!intent) throw new Error(`TASK_WORKTREE_READY requires pending worktree intent for ${event.entityId}`);
    const operationId = payloadString(event, 'operationId');
    if (operationId !== intent.operationId) throw new Error(`Worktree operation mismatch for ${event.entityId}`);
    const worktree = worktreeFrom(event);
    if (!sameWorktree(intent, worktree)) throw new Error(`Worktree result mismatch for ${event.entityId}`);
    const { [event.entityId]: _settled, ...worktreeIntents } = state.worktreeIntents;
    return {
      ...withTask(state, { ...current, worktreeId: worktree.worktreeId }),
      worktreeIntents,
      worktrees: { ...state.worktrees, [worktree.worktreeId]: worktree }
    };
  }

  if (event.type === 'TASK_WORKTREE_FAILED') {
    taskFor(state, event.entityId);
    const intent = state.worktreeIntents[event.entityId];
    if (!intent) throw new Error(`TASK_WORKTREE_FAILED requires pending worktree intent for ${event.entityId}`);
    const operationId = payloadString(event, 'operationId');
    if (operationId !== intent.operationId) throw new Error(`Worktree operation mismatch for ${event.entityId}`);
    const { [event.entityId]: _settled, ...worktreeIntents } = state.worktreeIntents;
    return { ...state, worktreeIntents };
  }

  if (event.type === 'TASK_ASSIGNMENT_INTENT') {
    const current = taskFor(state, event.entityId);
    if (current.state !== 'READY') throw new Error(`TASK_ASSIGNMENT_INTENT requires READY task ${event.entityId}`);
    if (!current.worktreeId) throw new Error(`TASK_ASSIGNMENT_INTENT requires worktree for ${event.entityId}`);
    if (state.worktreeIntents[event.entityId]) throw new Error(`${event.entityId} still has a worktree intent`);
    if (state.assignmentIntents[event.entityId]) throw new Error(`${event.entityId} already has an assignment intent`);
    const intent = assignmentIntentFrom(event);
    if (intent.taskId !== event.entityId) {
      throw new Error(`TASK_ASSIGNMENT_INTENT entity mismatch: ${event.entityId} != ${intent.taskId}`);
    }
    return {
      ...state,
      assignmentIntents: { ...state.assignmentIntents, [event.entityId]: intent }
    };
  }

  if (event.type === 'TASK_ASSIGNMENT_ABORTED') {
    taskFor(state, event.entityId);
    const intent = state.assignmentIntents[event.entityId];
    if (!intent) throw new Error(`TASK_ASSIGNMENT_ABORTED requires pending assignment intent for ${event.entityId}`);
    const operationId = payloadString(event, 'operationId');
    if (operationId !== intent.operationId) throw new Error(`Assignment operation mismatch for ${event.entityId}`);
    const { [event.entityId]: _settled, ...assignmentIntents } = state.assignmentIntents;
    return { ...state, assignmentIntents };
  }

  if (event.type === 'TASK_ASSIGNED') {
    const current = taskFor(state, event.entityId);
    if (state.worktreeIntents[event.entityId]) {
      throw new Error(`TASK_ASSIGNED cannot hide pending worktree intent for ${event.entityId}`);
    }
    const intent = state.assignmentIntents[event.entityId];
    if (!intent) throw new Error(`TASK_ASSIGNED requires pending assignment intent for ${event.entityId}`);
    const operationId = payloadString(event, 'operationId');
    if (operationId !== intent.operationId) throw new Error(`Assignment operation mismatch for ${event.entityId}`);
    const workerId = payloadString(event, 'workerId');
    if (intent.strategy === 'reuse' && workerId !== intent.requestedWorkerId) {
      throw new Error(`Assignment worker mismatch for ${event.entityId}: ${workerId} != ${intent.requestedWorkerId}`);
    }
    const { [event.entityId]: _settled, ...assignmentIntents } = state.assignmentIntents;
    return {
      ...withTask(state, { ...transitionTask(current, 'ASSIGNED'), assignedWorkerId: workerId }),
      assignmentIntents
    };
  }

  const targetState = TASK_EVENT_STATES[event.type];
  if (!targetState) throw new Error(`Unsupported orchestration event: ${event.type}`);

  requireNoPendingOperation(state, event.entityId, event.type);
  const current = taskFor(state, event.entityId);
  return withTask(state, transitionTask(current, targetState));
}
