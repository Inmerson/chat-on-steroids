import { transitionTask } from './task-state.js';
import type { OrchestrationEvent, OrchestrationEventType } from './store.js';
import type { TaskRecord, TaskState } from './types.js';

export interface OrchestrationState {
  runId: string | null;
  tasks: Record<string, TaskRecord>;
}

export const EMPTY_ORCHESTRATION_STATE: OrchestrationState = {
  runId: null,
  tasks: {}
};

const TASK_EVENT_STATES: Partial<Record<OrchestrationEventType, TaskState>> = {
  TASK_READY: 'READY',
  TASK_ASSIGNED: 'ASSIGNED',
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

export function applyOrchestrationEvent(state: OrchestrationState, event: OrchestrationEvent): OrchestrationState {
  requireSameRun(state, event);

  if (event.type === 'RUN_CREATED') {
    return state.runId === event.runId ? state : { ...state, runId: event.runId };
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

  const targetState = TASK_EVENT_STATES[event.type];
  if (!targetState) throw new Error(`Unsupported orchestration event: ${event.type}`);

  const current = taskFor(state, event.entityId);
  let next = transitionTask(current, targetState);
  if (event.type === 'TASK_ASSIGNED') {
    next = { ...next, assignedWorkerId: payloadString(event, 'workerId') };
  }
  return withTask(state, next);
}
