import type { TaskRecord, TaskState } from './types.js';

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PLANNED: ['READY', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  READY: ['ASSIGNED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  ASSIGNED: ['ACTIVE', 'READY', 'FAILED', 'CANCELLED'],
  ACTIVE: ['READY_FOR_REVIEW', 'BLOCKED', 'FAILED', 'CANCELLED'],
  READY_FOR_REVIEW: ['REVIEWING', 'ACTIVE', 'FAILED', 'CANCELLED'],
  REVIEWING: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED', 'FAILED'],
  CHANGES_REQUESTED: ['ACTIVE', 'FAILED', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED', 'SUPERSEDED'],
  APPROVED: ['INTEGRATING', 'CANCELLED'],
  INTEGRATING: ['INTEGRATED', 'FAILED'],
  INTEGRATED: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  FAILED: ['READY', 'CANCELLED', 'SUPERSEDED'],
  CANCELLED: [],
  SUPERSEDED: []
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function transitionTask(task: TaskRecord, to: TaskState): TaskRecord {
  if (!canTransitionTask(task.state, to)) {
    throw new Error(`Invalid task transition: ${task.state} -> ${to}`);
  }
  return { ...task, state: to };
}
